/**
 * MongoGPT URL normalization — matches PremServ / LLM Inference:
 *   apiUrl is typically `https://mongogpt.aix.prod.corp.mongodb.com` (no path).
 *   Requests go to `…/api/v1/messages` with `X-Kanopy-Authorization: Bearer <jwt>`.
 *
 * Accepts either base host or full messages URL (backward compatible with older
 * riskSi settings that stored the full path).
 */

const DEFAULT_BASE = "https://mongogpt.aix.prod.corp.mongodb.com";

/**
 * Resolve the POST …/messages endpoint used by `callMongoGpt`.
 */
export function resolveMongoGptMessagesUrl(input?: string | null): string {
  const fromEnv = typeof process !== "undefined" ? process.env.MONGOGPT_URL : undefined;
  const raw = (input?.trim() || fromEnv?.trim() || DEFAULT_BASE).replace(/\/+$/, "");

  try {
    const u = new URL(raw.includes("://") ? raw : `https://${raw}`);
    const path = u.pathname.replace(/\/+$/, "") || "";

    if (path.toLowerCase().endsWith("/messages")) {
      return `${u.origin}${path}`;
    }
    if (path.toLowerCase().endsWith("/api/v1")) {
      return `${u.origin}${path}/messages`;
    }
    if (path === "" || path === "/") {
      return `${u.origin}/api/v1/messages`;
    }
    // Unusual path: still assume standard gateway layout under origin
    return `${u.origin}/api/v1/messages`;
  } catch {
    return `${DEFAULT_BASE}/api/v1/messages`;
  }
}

/** GET …/models for model discovery. */
export function resolveMongoGptModelsUrl(input?: string | null): string {
  return resolveMongoGptMessagesUrl(input).replace(/\/messages$/i, "/models");
}
