/**
 * Shared server-side Glean helpers used by the Case Analysis routes.
 *
 * Keeps the token resolution logic in one place:
 *   1. explicit body.gleanToken (static MCP-scoped token)
 *   2. GLEAN_API_TOKEN env
 *   3. cached OAuth access_token from ~/.risksi/glean-oauth.json
 */

import { getValidToken as getValidGleanToken } from "@/lib/glean-token";
import type { MCPServerConfig } from "@/lib/types";

export interface ResolvedGleanServer {
  server: MCPServerConfig;
  tokenSource: "static" | "oauth";
}

export async function resolveGleanServer(params: {
  bodyToken?: string;
  bodyUrl?: string;
}): Promise<ResolvedGleanServer> {
  let token = params.bodyToken || process.env.GLEAN_API_TOKEN || "";
  let url =
    params.bodyUrl ||
    process.env.GLEAN_MCP_URL ||
    "https://mongodb-be.glean.com/mcp/default";
  let tokenSource: "static" | "oauth" = "static";

  if (!token) {
    const oauth = await getValidGleanToken();
    token = oauth.accessToken;
    url = params.bodyUrl || oauth.resource || url;
    tokenSource = "oauth";
  }

  return {
    server: {
      id: "glean",
      name: "Glean",
      url,
      headers: { Authorization: `Bearer ${token}` },
    },
    tokenSource,
  };
}

/** Normalize an error message to a user-friendly 401 if the token was rejected. */
export function isUnauthorizedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b(401|403|unauthor|forbidden|invalid.?token)\b/i.test(msg);
}
