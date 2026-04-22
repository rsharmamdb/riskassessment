/**
 * Auto Triage Chat (MongoDB Customer Hub AI) client.
 *
 * Target API: https://hub.corp.mongodb.com/api/ai/autoTriageChat/*
 *
 * Auth: `Authorization: Bearer <kanopy-jwt>`. The JWT is minted by the user's
 * own `kanopy-oidc login` run and cached under `~/.kanopy/` — our
 * `getValidToken()` in mongogpt-token.ts just reads/refreshes it. Hub accepts
 * the same JWT that MongoGPT does (issuer `dex.prod.corp.mongodb.com`,
 * audience `login`).
 *
 * Endpoints exercised:
 *   GET  /api/ai/autoTriageChat/session                        → list sessions
 *   GET  /api/ai/autoTriageChat/history?sessionId=…            → read history
 *   GET  /api/ai/autoTriageChat?sessionId&input&pathname&label → SSE chat stream
 *
 * Session creation is implicit: the first chat message with a never-seen
 * sessionId creates the session server-side. The extension convention is
 * `${email}-${Date.now()}` and we preserve it.
 */

import { getValidToken, invalidateToken } from "./mongogpt-token";

const API_BASE = "https://hub.corp.mongodb.com";

// --------------------------------- types ---------------------------------

export interface AutoTriageSession {
  sessionId: string;
  createdAt: string;
  updatedAt?: string;
  lastPathname?: string;
  label?: string;
}

export interface AutoTriageResult {
  /** Concatenated text from SSE text/delta events. */
  text: string;
  /** tool_call events the bot emitted along the way (for observability). */
  toolCalls: unknown[];
  /** Count of SSE events parsed — useful to detect empty streams. */
  eventCount: number;
}

export interface CallAutoTriageOpts {
  /** User message / prompt body. */
  input: string;
  /** Session to attach the message to. Defaults to a fresh session. */
  sessionId?: string;
  /** `/case/XYZ` or `/`. Hub uses this as context hint for the agent. */
  pathname?: string;
  /** Short display label (extension uses e.g. `Case: 01234567`). */
  label?: string;
  /** Wall-clock limit; SSE streams can run 60–120s. */
  timeoutMs?: number;
  /** Optional pre-existing token; otherwise getValidToken() is called. */
  token?: string;
}

// ------------------------------ helpers ----------------------------------

function authHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "User-Agent": "risksi-app" };
}

/** Hub's session format is `${email}-${epochMs}`. Match the extension. */
export function generateSessionId(email: string, suffix?: string): string {
  const base = `${email}-${Date.now()}`;
  return suffix ? `${base}-${suffix}` : base;
}

/**
 * Decode the cached Kanopy JWT's `email` claim so callers don't need to
 * pass their mongodb.com address manually. Falls back to env or a generic
 * default if the token can't be read.
 */
export async function getUserEmail(): Promise<string> {
  try {
    const { token } = await getValidToken();
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("not a JWT");
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const claims = JSON.parse(
      Buffer.from(padded, "base64").toString("utf-8"),
    ) as { email?: string };
    if (claims.email) return claims.email;
  } catch {
    /* fall through */
  }
  return process.env.USER_EMAIL || "user@mongodb.com";
}

/**
 * Hub's SSE stream occasionally drops the first 5–8 chars of the assistant's
 * reply (observed in PremServ). If what we get back starts with a telltale
 * broken-label fragment, prepend `**Status:** `. Lifted from the PremServ
 * background worker to keep output quality parity.
 */
function fixTruncatedText(text: string): string {
  const patterns = [
    /^:\*\*\s*/, /^s:\*\*\s*/, /^us:\*\*\s*/, /^tus:\*\*\s*/, /^atus:\*\*\s*/,
    /^e:\*\*\s*/, /^te:\*\*\s*/, /^ate:\*\*\s*/,
    /^n:\*\*\s*/, /^on:\*\*\s*/, /^ion:\*\*\s*/, /^tion:\*\*\s*/,
    /^:\s+/, /^s:\s+/, /^us:\s+/, /^tus:\s+/, /^atus:\s+/,
  ];
  for (const p of patterns) {
    if (p.test(text)) return "**Status:** " + text.replace(p, "");
  }
  return text;
}

/**
 * Parse a full SSE body (multiple `event:` + `data:` lines separated by blank
 * lines) into `{ text, toolCalls, eventCount }`. Tolerant of:
 *   - `data: {"type":"text","data":"..."}`
 *   - `data: {"type":"content_block_delta","delta":{"text":"..."}}`
 *   - `data: "...raw string..."`
 */
function parseAutoTriageSSE(raw: string): AutoTriageResult {
  const events: Array<{ event?: string; data?: unknown }> = [];
  let cur: { event?: string; data?: unknown } = {};
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      const payload = line.slice(5).trimStart();
      try {
        cur.data = JSON.parse(payload);
      } catch {
        cur.data = payload;
      }
    } else if (line.startsWith("event:")) {
      cur.event = line.slice(6).trim();
    } else if (line === "" && Object.keys(cur).length > 0) {
      events.push(cur);
      cur = {};
    }
  }
  if (Object.keys(cur).length > 0) events.push(cur);

  let text = "";
  const toolCalls: unknown[] = [];
  for (const e of events) {
    const d = e.data as Record<string, unknown> | string | undefined;
    if (!d) continue;
    if (typeof d === "string") {
      text += d;
      continue;
    }
    if (d.type === "tool_call") {
      toolCalls.push(d.data ?? d);
      continue;
    }
    if (typeof d.data === "string") {
      text += d.data;
      continue;
    }
    const delta = d.delta as Record<string, unknown> | undefined;
    if (delta && typeof delta.text === "string") {
      text += delta.text;
      continue;
    }
    if (typeof d.text === "string") {
      text += d.text;
    }
  }

  return { text: fixTruncatedText(text), toolCalls, eventCount: events.length };
}

/** Run a fetch + retry once on 401 by force-refreshing the token. */
async function hubFetch(
  path: string,
  init: RequestInit & { tokenOverride?: string } = {},
): Promise<Response> {
  const { tokenOverride, ...rest } = init;
  let token = tokenOverride ?? (await getValidToken()).token;
  let res = await fetch(`${API_BASE}${path}`, {
    ...rest,
    headers: { ...authHeader(token), ...(rest.headers ?? {}) },
  });
  if (res.status === 401 || res.status === 403) {
    invalidateToken();
    token = (await getValidToken({ force: true })).token;
    res = await fetch(`${API_BASE}${path}`, {
      ...rest,
      headers: { ...authHeader(token), ...(rest.headers ?? {}) },
    });
  }
  return res;
}

// -------------------------------- public ---------------------------------

export async function listSessions(): Promise<AutoTriageSession[]> {
  const res = await hubFetch("/api/ai/autoTriageChat/session", { method: "GET" });
  if (!res.ok) {
    throw new Error(
      `listSessions HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`,
    );
  }
  const json = (await res.json()) as { sessions?: AutoTriageSession[] };
  return json.sessions ?? [];
}

export async function getHistory(sessionId: string): Promise<unknown[]> {
  const qs = new URLSearchParams({ sessionId }).toString();
  const res = await hubFetch(`/api/ai/autoTriageChat/history?${qs}`, {
    method: "GET",
  });
  if (!res.ok) {
    throw new Error(
      `getHistory HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`,
    );
  }
  return (await res.json()) as unknown[];
}

/**
 * Send one prompt and wait for the full SSE stream to finish. Returns the
 * concatenated assistant text. Used by the pipeline; the browser-facing
 * streaming route uses `streamAutoTriage()` instead.
 */
export async function callAutoTriage(
  opts: CallAutoTriageOpts,
): Promise<AutoTriageResult> {
  const { input, sessionId, pathname = "/", label = "", timeoutMs = 180_000 } = opts;
  if (!input.trim()) throw new Error("auto-triage: empty input");
  if (!sessionId) throw new Error("auto-triage: sessionId required");

  const qs = new URLSearchParams({ sessionId, input, pathname, label }).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await hubFetch(`/api/ai/autoTriageChat?${qs}`, {
      method: "GET",
      signal: controller.signal,
      tokenOverride: opts.token,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `autoTriageChat HTTP ${res.status}: ${body.slice(0, 500)}`,
    );
  }

  const raw = await res.text();
  return parseAutoTriageSSE(raw);
}

/**
 * Open the SSE stream and return the raw body reader for pipe-through to a
 * browser-side consumer. Caller owns closing the stream.
 */
export async function streamAutoTriage(
  opts: CallAutoTriageOpts,
): Promise<{ body: ReadableStream<Uint8Array>; response: Response }> {
  const { input, sessionId, pathname = "/", label = "" } = opts;
  if (!input.trim()) throw new Error("auto-triage: empty input");
  if (!sessionId) throw new Error("auto-triage: sessionId required");

  const qs = new URLSearchParams({ sessionId, input, pathname, label }).toString();
  const res = await hubFetch(`/api/ai/autoTriageChat?${qs}`, {
    method: "GET",
    tokenOverride: opts.token,
  });
  if (!res.ok || !res.body) {
    const body = res.body ? (await res.text()).slice(0, 500) : "(no body)";
    throw new Error(`autoTriageChat HTTP ${res.status}: ${body}`);
  }
  return { body: res.body, response: res };
}

// Exported for unit testing + pipeline merge step.
export const __test = { parseAutoTriageSSE, fixTruncatedText };
