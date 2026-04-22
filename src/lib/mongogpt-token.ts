/**
 * MongoGPT (Kanopy OIDC) token lifecycle.
 *
 * Replicates the manual setup from the Kanopy docs:
 *   1. mkdir -p ~/kanopy && tar -xvf kanopy-oidc-<os>-<arch>-v*.tgz -C ~/kanopy
 *   2. mkdir -p ~/.kanopy && write ~/.kanopy/config.yaml
 *   3. kanopy-oidc login   → stdout is a JWT
 *
 * getValidToken() performs any of the above steps that are missing, caches
 * the resulting JWT in ~/.kanopy/risksi-token.json keyed by its `exp`
 * claim, and returns the cached value on subsequent calls until expiry
 * (with a 60s safety margin). Concurrent callers share a single in-flight
 * login via `inFlight`.
 *
 * Node-only: uses child_process, fs, os.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { arch as osArch, homedir, platform as osPlatform } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);

const KANOPY_DIR = () => join(homedir(), "kanopy");
const KANOPY_BIN_DIR = () => join(KANOPY_DIR(), "bin");
const KANOPY_CONFIG_DIR = () => join(homedir(), ".kanopy");
const KANOPY_CONFIG_FILE = () => join(KANOPY_CONFIG_DIR(), "config.yaml");
const TOKEN_CACHE_FILE = () => join(KANOPY_CONFIG_DIR(), "risksi-token.json");

const CONFIG_YAML = `---
domain: corp.mongodb.com
issuer: dex
login:
  connector: oidc
`;

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
  mintedAt: number; // epoch ms
}

export interface TokenResult {
  token: string;
  expiresAt: number;
  mintedAt: number;
  binaryPath: string;
  actions: Array<
    "used-cached" | "installed-binary" | "wrote-config" | "ran-login"
  >;
}

export interface TokenStatus {
  cached: boolean;
  expiresAt: number | null;
  minutesRemaining: number | null;
  binaryPath: string | null;
  configured: boolean;
}

// ---------------------------- asset resolution ----------------------------

/** Produces the OS/arch suffix used in release asset names, e.g. "macos-arm64". */
function currentAssetSuffix(): string {
  const p = osPlatform();
  const a = osArch();
  const os =
    p === "darwin" ? "macos" : p === "linux" ? "linux" : p === "win32" ? "windows" : p;
  const goarch =
    a === "x64" ? "amd64" : a === "arm64" ? "arm64" : a === "arm" ? "arm" : a;
  return `${os}-${goarch}`;
}

function findBinary(): string | null {
  const dir = KANOPY_BIN_DIR();
  if (!existsSync(dir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const matches = entries
    .filter((e) => e.startsWith("kanopy-oidc-") || e === "kanopy-oidc")
    .map((e) => join(dir, e))
    .filter((p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    })
    .sort()
    .reverse();
  return matches[0] ?? null;
}

// ------------------------------- JWT parsing ------------------------------

function decodeJwtExp(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = Buffer.from(padded, "base64").toString("utf-8");
    const parsed = JSON.parse(json) as { exp?: number };
    return typeof parsed.exp === "number" ? parsed.exp * 1000 : null;
  } catch {
    return null;
  }
}

// --------------------------------- cache ---------------------------------

function readCache(): CachedToken | null {
  try {
    const raw = readFileSync(TOKEN_CACHE_FILE(), "utf-8");
    const parsed = JSON.parse(raw) as CachedToken;
    if (typeof parsed.token !== "string") return null;
    if (typeof parsed.expiresAt !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(entry: CachedToken): void {
  mkdirSync(KANOPY_CONFIG_DIR(), { recursive: true });
  writeFileSync(TOKEN_CACHE_FILE(), JSON.stringify(entry, null, 2), "utf-8");
}

function isValid(entry: CachedToken | null, safetyMs = 60_000): boolean {
  if (!entry) return false;
  return entry.expiresAt > Date.now() + safetyMs;
}

// ---------------------------- ensure helpers -----------------------------

function ensureConfig(): boolean {
  mkdirSync(KANOPY_CONFIG_DIR(), { recursive: true });
  if (existsSync(KANOPY_CONFIG_FILE())) return false;
  writeFileSync(KANOPY_CONFIG_FILE(), CONFIG_YAML, "utf-8");
  return true;
}

const KANOPY_REPO = process.env.KANOPY_OIDC_REPO || "kanopy-platform/kanopy-oidc";

/**
 * Download the latest kanopy-oidc release tarball matching `suffix` into
 * `destDir`. The repo is private so we try auth-capable channels in order:
 *   1. An explicit KANOPY_OIDC_DOWNLOAD_URL pointing at a tarball (mirror).
 *   2. The local `gh` CLI (already authenticated against corp GitHub on most
 *      MongoDB-issued laptops).
 *   3. The GitHub REST API with GITHUB_TOKEN.
 *
 * Returns the filesystem path of the downloaded tarball.
 */
async function downloadReleaseTarball(
  suffix: string,
  destDir: string,
): Promise<string> {
  const errors: string[] = [];

  // --- Channel 1: explicit mirror ---
  const mirror = process.env.KANOPY_OIDC_DOWNLOAD_URL;
  if (mirror) {
    try {
      const res = await fetch(mirror);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const out = join(destDir, `kanopy-oidc.tgz`);
      writeFileSync(out, buf);
      return out;
    } catch (err) {
      errors.push(`mirror (${mirror}): ${(err as Error).message}`);
    }
  }

  // --- Channel 2: gh CLI ---
  try {
    await run("gh", ["--version"], { timeout: 5_000 });
    // `gh release download` picks the latest release when no tag is given,
    // filters assets via --pattern, and writes them into --dir.
    await run(
      "gh",
      [
        "release",
        "download",
        "--repo",
        KANOPY_REPO,
        "--pattern",
        `*${suffix}*.tgz`,
        "--dir",
        destDir,
        "--clobber",
      ],
      { timeout: 90_000, maxBuffer: 16 * 1024 * 1024 },
    );
    const entries = readdirSync(destDir).filter(
      (f) => f.includes(suffix) && f.endsWith(".tgz"),
    );
    if (entries.length > 0) return join(destDir, entries[0]);
    errors.push("gh download succeeded but no matching .tgz appeared");
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    errors.push(
      `gh CLI: ${e.code === "ENOENT" ? "not installed" : (e.stderr || e.message || String(err)).slice(0, 300)}`,
    );
  }

  // --- Channel 3: REST API with token ---
  try {
    const headers: Record<string, string> = {
      "User-Agent": "risksi-app",
      Accept: "application/vnd.github+json",
    };
    if (process.env.GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }
    const res = await fetch(
      `https://api.github.com/repos/${KANOPY_REPO}/releases/latest`,
      { headers },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const release = (await res.json()) as {
      assets?: Array<{ name: string; url: string; browser_download_url: string }>;
    };
    const match = (release.assets ?? []).find(
      (a) => a.name.includes(suffix) && /\.(tgz|tar\.gz)$/.test(a.name),
    );
    if (!match) {
      throw new Error(
        `no asset matches "${suffix}" (have: ${(release.assets ?? []).map((a) => a.name).join(", ") || "none"})`,
      );
    }
    // For private repos, hit the assets API with Accept: octet-stream.
    const dlHeaders = { ...headers, Accept: "application/octet-stream" };
    const dl = await fetch(match.url, { headers: dlHeaders, redirect: "follow" });
    if (!dl.ok) throw new Error(`asset HTTP ${dl.status}`);
    const buf = Buffer.from(await dl.arrayBuffer());
    const out = join(destDir, match.name);
    writeFileSync(out, buf);
    return out;
  } catch (err) {
    errors.push(`REST API: ${(err as Error).message}`);
  }

  throw new Error(
    `Unable to download kanopy-oidc for ${suffix}. Tried: ${errors.join(" | ")}. ` +
      `Fix by (a) running \`gh auth login\`, (b) setting GITHUB_TOKEN in .env.local, ` +
      `or (c) setting KANOPY_OIDC_DOWNLOAD_URL to a pre-fetched tarball.`,
  );
}

async function ensureBinary(): Promise<{ path: string; installed: boolean }> {
  const existing = findBinary();
  if (existing) return { path: existing, installed: false };

  const suffix = currentAssetSuffix();
  mkdirSync(KANOPY_DIR(), { recursive: true });

  const tgzPath = await downloadReleaseTarball(suffix, KANOPY_DIR());

  try {
    await run("tar", ["-xvf", tgzPath, "-C", KANOPY_DIR()], {
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } finally {
    try {
      unlinkSync(tgzPath);
    } catch {
      /* ignore */
    }
  }

  const installed = findBinary();
  if (!installed) {
    throw new Error(
      `Extracted tarball but no kanopy-oidc-* binary appeared under ${KANOPY_BIN_DIR()}.`,
    );
  }
  try {
    chmodSync(installed, 0o755);
  } catch {
    /* best-effort */
  }
  return { path: installed, installed: true };
}

async function runLogin(binaryPath: string): Promise<string> {
  const { stdout, stderr } = await run(binaryPath, ["login"], {
    timeout: 170_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env },
  });
  const token = stdout.trim().split("\n")[0].trim();
  if (!token) {
    throw new Error(
      `kanopy-oidc produced no token on stdout. stderr: ${(stderr || "").slice(0, 500) || "(empty)"}`,
    );
  }
  return token;
}

// ------------------------------ public API ------------------------------

let inFlight: Promise<TokenResult> | null = null;

export function getTokenStatus(): TokenStatus {
  const cached = readCache();
  const bin = findBinary();
  if (isValid(cached) && cached) {
    return {
      cached: true,
      expiresAt: cached.expiresAt,
      minutesRemaining: Math.max(
        0,
        Math.floor((cached.expiresAt - Date.now()) / 60_000),
      ),
      binaryPath: bin,
      configured: existsSync(KANOPY_CONFIG_FILE()),
    };
  }
  return {
    cached: false,
    expiresAt: cached?.expiresAt ?? null,
    minutesRemaining: null,
    binaryPath: bin,
    configured: existsSync(KANOPY_CONFIG_FILE()),
  };
}

export async function getValidToken(opts?: {
  force?: boolean;
}): Promise<TokenResult> {
  if (!opts?.force) {
    const cached = readCache();
    if (isValid(cached) && cached) {
      return {
        token: cached.token,
        expiresAt: cached.expiresAt,
        mintedAt: cached.mintedAt,
        binaryPath: findBinary() ?? "",
        actions: ["used-cached"],
      };
    }
  }

  // Dedupe concurrent mint requests — one SSO window is enough.
  if (inFlight && !opts?.force) return inFlight;

  inFlight = (async () => {
    const actions: TokenResult["actions"] = [];

    const { path: binary, installed } = await ensureBinary();
    if (installed) actions.push("installed-binary");

    if (ensureConfig()) actions.push("wrote-config");

    actions.push("ran-login");
    const token = await runLogin(binary);

    const expMs = decodeJwtExp(token);
    const expiresAt = expMs ?? Date.now() + 8 * 3600 * 1000; // 8h safety fallback
    const entry: CachedToken = { token, expiresAt, mintedAt: Date.now() };
    writeCache(entry);

    return {
      token,
      expiresAt,
      mintedAt: entry.mintedAt,
      binaryPath: binary,
      actions,
    };
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/**
 * Invalidate the cached token (e.g. after a 401 from MongoGPT). Best-effort.
 */
export function invalidateToken(): void {
  try {
    unlinkSync(TOKEN_CACHE_FILE());
  } catch {
    /* file already absent */
  }
}
