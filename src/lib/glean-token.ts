/**
 * Glean MCP OAuth 2.1 token lifecycle.
 *
 * Glean's hosted MCP endpoint (e.g. https://mongodb-be.glean.com/mcp/<path>)
 * is OAuth-gated. This module implements the same flow Cursor uses:
 *
 *   1. Discovery: GET /.well-known/oauth-protected-resource/<path>
 *      → returns the authorization_servers URL.
 *   2. GET /.well-known/oauth-authorization-server on that URL
 *      → returns registration_endpoint, authorization_endpoint, token_endpoint,
 *        supported scopes, code_challenge_methods.
 *   3. Dynamic Client Registration (RFC 7591) — we POST our redirect_uri and
 *      get back a public `client_id`. Result is cached to disk so subsequent
 *      logins reuse it.
 *   4. PKCE (S256) + authorization code flow. We stash the verifier+state to
 *      disk so the /callback route can pick them up.
 *   5. Token exchange → cache { access_token, refresh_token, expires_at,
 *      scope, client_id, resource, authServer } to disk.
 *   6. getValidToken() returns a live access_token, refreshing via
 *      refresh_token when expired (60s safety margin). Concurrent callers
 *      share one in-flight refresh.
 *
 * Node-only — uses fs, crypto, os.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------- paths ----------

const CFG_DIR = () => join(homedir(), ".risksi");
const CLIENT_FILE = () => join(CFG_DIR(), "glean-client.json");
const TOKEN_FILE = () => join(CFG_DIR(), "glean-oauth.json");
const PENDING_FILE = () => join(CFG_DIR(), "glean-oauth-pending.json");

// ---------- types ----------

export interface AuthServerMeta {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  grant_types_supported?: string[];
}

interface ClientRecord {
  clientId: string;
  redirectUri: string;
  authServer: string; // issuer url
  resource: string; // MCP URL
  scope: string;
  registeredAt: number;
}

interface TokenRecord {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // epoch ms
  scope: string;
  clientId: string;
  authServer: string;
  resource: string;
  issuedAt: number;
}

interface PendingRecord {
  state: string;
  codeVerifier: string;
  clientId: string;
  redirectUri: string;
  authServer: string;
  resource: string;
  scope: string;
  createdAt: number;
}

export interface GleanTokenStatus {
  hasToken: boolean;
  expiresAt?: number;
  expiresInSeconds?: number;
  scope?: string;
  resource?: string;
  authServer?: string;
  clientId?: string;
  hasRefreshToken?: boolean;
  stale?: boolean;
}

export interface BeginLoginResult {
  authorizeUrl: string;
  state: string;
  clientId: string;
  authServer: string;
  resource: string;
  scope: string;
  redirectUri: string;
}

// ---------- fs helpers ----------

function ensureCfgDir(): void {
  const dir = CFG_DIR();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function readJson<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(path: string, data: unknown): void {
  ensureCfgDir();
  writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function rm(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* ignore */
  }
}

// ---------- discovery ----------

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `HTTP ${res.status} ${res.statusText} for ${url}: ${body.slice(0, 400)}`,
    );
  }
  return (await res.json()) as T;
}

/**
 * Given an MCP resource URL like https://host/mcp/foo, resolve which OAuth
 * authorization server protects it.
 */
async function discoverAuthServer(resourceUrl: string): Promise<string> {
  const url = new URL(resourceUrl);
  // Per RFC 9728 (Protected Resource Metadata), the well-known document lives
  // at the server root, optionally with the resource path suffixed for
  // path-scoped resources. Try the path-scoped form first, then the root.
  const candidates = [
    `${url.origin}/.well-known/oauth-protected-resource${url.pathname}`,
    `${url.origin}/.well-known/oauth-protected-resource`,
  ];
  for (const c of candidates) {
    try {
      const meta = await fetchJson<{ authorization_servers?: string[] }>(c);
      const servers = meta.authorization_servers;
      if (Array.isArray(servers) && servers.length > 0) return servers[0];
    } catch {
      /* try next */
    }
  }
  throw new Error(
    `No oauth-protected-resource metadata found at ${url.origin}. Glean may not have OAuth enabled for this MCP URL.`,
  );
}

async function discoverAuthServerMeta(
  authServerUrl: string,
): Promise<AuthServerMeta> {
  const url = new URL(authServerUrl);
  // The RFC 8414 metadata usually lives at origin-level; try a couple of forms.
  const candidates = [
    `${url.origin}${url.pathname.replace(/\/$/, "")}/.well-known/oauth-authorization-server`,
    `${url.origin}/.well-known/oauth-authorization-server${url.pathname.replace(/\/$/, "")}`,
    `${url.origin}/.well-known/oauth-authorization-server`,
  ];
  let lastErr: unknown;
  for (const c of candidates) {
    try {
      return await fetchJson<AuthServerMeta>(c);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    `Failed to load OAuth authorization server metadata: ${(lastErr as Error)?.message || "unknown"}`,
  );
}

// ---------- PKCE ----------

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makePkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

// ---------- DCR ----------

const DEFAULT_SCOPES = ["mcp", "search", "documents"];

async function registerClient(params: {
  meta: AuthServerMeta;
  redirectUri: string;
  resource: string;
}): Promise<ClientRecord> {
  const { meta, redirectUri, resource } = params;
  if (!meta.registration_endpoint) {
    throw new Error(
      `Authorization server ${meta.issuer} does not advertise a registration_endpoint (dynamic client registration unavailable).`,
    );
  }

  const scope = pickScopes(meta.scopes_supported).join(" ");

  const body = {
    client_name: "RiskSI (local)",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope,
  };

  const resp = await fetch(meta.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(
      `DCR failed: HTTP ${resp.status} ${resp.statusText}. ${txt.slice(0, 400)}`,
    );
  }
  const json = (await resp.json()) as {
    client_id: string;
    scope?: string;
  };
  const rec: ClientRecord = {
    clientId: json.client_id,
    redirectUri,
    authServer: meta.issuer,
    resource,
    scope: json.scope || scope,
    registeredAt: Date.now(),
  };
  writeJson(CLIENT_FILE(), rec);
  return rec;
}

function pickScopes(supported: string[] | undefined): string[] {
  if (!supported || supported.length === 0) return DEFAULT_SCOPES;
  const wanted = new Set(DEFAULT_SCOPES);
  // refresh_token grant doesn't require offline_access for OAuth 2.1, but if
  // the server advertises it, request it — some IdPs gate refresh tokens on it.
  if (supported.includes("offline_access")) wanted.add("offline_access");
  return [...wanted].filter((s) => supported.includes(s));
}

function loadClient(): ClientRecord | null {
  return readJson<ClientRecord>(CLIENT_FILE());
}

async function ensureClient(params: {
  resource: string;
  redirectUri: string;
}): Promise<{ client: ClientRecord; meta: AuthServerMeta }> {
  const { resource, redirectUri } = params;
  const authServerUrl = await discoverAuthServer(resource);
  const meta = await discoverAuthServerMeta(authServerUrl);

  const existing = loadClient();
  const reusable =
    existing &&
    existing.authServer === meta.issuer &&
    existing.resource === resource &&
    existing.redirectUri === redirectUri;
  if (reusable) return { client: existing!, meta };

  const client = await registerClient({ meta, redirectUri, resource });
  return { client, meta };
}

// ---------- login start ----------

export async function beginLogin(params: {
  resource: string;
  redirectUri: string;
}): Promise<BeginLoginResult> {
  const { client, meta } = await ensureClient(params);
  const { verifier, challenge } = makePkce();
  const state = b64url(randomBytes(16));

  const scope = client.scope;
  const authUrl = new URL(meta.authorization_endpoint);
  authUrl.searchParams.set("client_id", client.clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", params.redirectUri);
  authUrl.searchParams.set("scope", scope);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  // RFC 8707 resource indicator — some AS require it, Glean accepts it.
  authUrl.searchParams.set("resource", params.resource);

  const pending: PendingRecord = {
    state,
    codeVerifier: verifier,
    clientId: client.clientId,
    redirectUri: params.redirectUri,
    authServer: meta.issuer,
    resource: params.resource,
    scope,
    createdAt: Date.now(),
  };
  writeJson(PENDING_FILE(), pending);

  return {
    authorizeUrl: authUrl.toString(),
    state,
    clientId: client.clientId,
    authServer: meta.issuer,
    resource: params.resource,
    scope,
    redirectUri: params.redirectUri,
  };
}

// ---------- login complete ----------

export async function completeLogin(params: {
  code: string;
  state: string;
}): Promise<TokenRecord> {
  const pending = readJson<PendingRecord>(PENDING_FILE());
  if (!pending)
    throw new Error("No pending Glean login. Start the flow again.");
  if (pending.state !== params.state)
    throw new Error("OAuth state mismatch — possible CSRF, aborting.");
  // 10 minute TTL on the pending record.
  if (Date.now() - pending.createdAt > 10 * 60_000) {
    rm(PENDING_FILE());
    throw new Error("Pending Glean login expired. Start the flow again.");
  }

  const meta = await discoverAuthServerMeta(pending.authServer);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: pending.redirectUri,
    code_verifier: pending.codeVerifier,
    client_id: pending.clientId,
    resource: pending.resource,
  });
  const resp = await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(
      `Token exchange failed: HTTP ${resp.status} ${resp.statusText}. ${txt.slice(0, 400)}`,
    );
  }
  const json = (await resp.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };

  const now = Date.now();
  const rec: TokenRecord = {
    accessToken: json.access_token,
    expiresAt: now + Math.max(60, json.expires_in ?? 3600) * 1000,
    scope: json.scope || pending.scope,
    clientId: pending.clientId,
    authServer: pending.authServer,
    resource: pending.resource,
    issuedAt: now,
  };
  if (json.refresh_token) rec.refreshToken = json.refresh_token;
  writeJson(TOKEN_FILE(), rec);
  rm(PENDING_FILE());
  return rec;
}

// ---------- refresh ----------

let refreshInFlight: Promise<TokenRecord> | null = null;

async function refresh(rec: TokenRecord): Promise<TokenRecord> {
  if (!rec.refreshToken) {
    throw new Error(
      "Glean access token expired and no refresh token is available. Sign in again.",
    );
  }
  const meta = await discoverAuthServerMeta(rec.authServer);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: rec.refreshToken,
    client_id: rec.clientId,
    scope: rec.scope,
    resource: rec.resource,
  });
  const resp = await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(
      `Refresh failed: HTTP ${resp.status} ${resp.statusText}. ${txt.slice(0, 400)}`,
    );
  }
  const json = (await resp.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  const now = Date.now();
  const next: TokenRecord = {
    ...rec,
    accessToken: json.access_token,
    expiresAt: now + Math.max(60, json.expires_in ?? 3600) * 1000,
    scope: json.scope || rec.scope,
    issuedAt: now,
  };
  if (json.refresh_token) next.refreshToken = json.refresh_token;
  else delete next.refreshToken;
  writeJson(TOKEN_FILE(), next);
  return next;
}

// ---------- public API ----------

export function getTokenStatus(): GleanTokenStatus {
  const rec = readJson<TokenRecord>(TOKEN_FILE());
  if (!rec) return { hasToken: false };
  const now = Date.now();
  const expiresInSeconds = Math.floor((rec.expiresAt - now) / 1000);
  return {
    hasToken: true,
    expiresAt: rec.expiresAt,
    expiresInSeconds,
    scope: rec.scope,
    resource: rec.resource,
    authServer: rec.authServer,
    clientId: rec.clientId,
    hasRefreshToken: !!rec.refreshToken,
    stale: expiresInSeconds < 60,
  };
}

export async function getValidToken(): Promise<{
  accessToken: string;
  resource: string;
  expiresAt: number;
  refreshed: boolean;
}> {
  const rec = readJson<TokenRecord>(TOKEN_FILE());
  if (!rec) {
    throw new Error(
      "Not signed in to Glean. Open Settings → Glean (MCP) and click Sign in via SSO.",
    );
  }
  const margin = 60_000; // 60s safety margin
  if (Date.now() + margin < rec.expiresAt) {
    return {
      accessToken: rec.accessToken,
      resource: rec.resource,
      expiresAt: rec.expiresAt,
      refreshed: false,
    };
  }
  // Expired / about to expire → refresh (deduped).
  const refreshed = await (refreshInFlight ??= refresh(rec).finally(() => {
    refreshInFlight = null;
  }));
  return {
    accessToken: refreshed.accessToken,
    resource: refreshed.resource,
    expiresAt: refreshed.expiresAt,
    refreshed: true,
  };
}

export function invalidateToken(): void {
  rm(TOKEN_FILE());
  rm(PENDING_FILE());
}

export function invalidateClient(): void {
  rm(CLIENT_FILE());
  invalidateToken();
}

export function getResource(): string | null {
  const rec = readJson<TokenRecord>(TOKEN_FILE());
  return rec?.resource ?? null;
}
