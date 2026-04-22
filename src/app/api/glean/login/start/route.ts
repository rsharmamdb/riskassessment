/**
 * GET /api/glean/login/start?resource=<mcp-url>&returnTo=<path>
 *
 * Kicks off the Glean OAuth 2.1 login flow. Discovers the authorization
 * server for the given MCP resource URL, registers the app as a public
 * OAuth client (DCR, cached on disk), generates PKCE + state, and 302s the
 * browser to Glean's /authorize endpoint.
 *
 * `returnTo` lets the caller hop back to a specific page after /callback
 * finishes; defaults to "/settings".
 */

import { NextResponse } from "next/server";
import { beginLogin } from "@/lib/glean-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_RESOURCE =
  process.env.GLEAN_MCP_URL ||
  "https://mongodb-be.glean.com/mcp/default";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const resource = url.searchParams.get("resource") || DEFAULT_RESOURCE;
  const returnTo = url.searchParams.get("returnTo") || "/settings";

  const callbackUrl = new URL("/api/glean/login/callback", url.origin);
  callbackUrl.searchParams.set("returnTo", returnTo);
  const redirectUri = callbackUrl.toString();

  try {
    const result = await beginLogin({
      resource,
      redirectUri,
    });
    return NextResponse.redirect(result.authorizeUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failUrl = new URL(returnTo, url.origin);
    failUrl.searchParams.set("gleanLogin", "error");
    failUrl.searchParams.set("gleanLoginError", message.slice(0, 400));
    return NextResponse.redirect(failUrl.toString());
  }
}
