/**
 * GET /api/glean/login/callback?code=...&state=...&returnTo=<path>
 *
 * OAuth 2.1 redirect_uri target. Exchanges the authorization code for
 * access+refresh tokens using the PKCE verifier stashed during /start, caches
 * them to ~/.risksi/glean-oauth.json, then 302s the browser back to
 * `returnTo` (defaults to /settings) with a ?gleanLogin=success flag.
 */

import { NextResponse } from "next/server";
import { completeLogin } from "@/lib/glean-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const returnTo = url.searchParams.get("returnTo") || "/settings";
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  const dest = new URL(returnTo, url.origin);

  if (oauthError) {
    dest.searchParams.set("gleanLogin", "error");
    dest.searchParams.set(
      "gleanLoginError",
      `${oauthError}: ${url.searchParams.get("error_description") || ""}`.slice(0, 400),
    );
    return NextResponse.redirect(dest.toString());
  }

  if (!code || !state) {
    dest.searchParams.set("gleanLogin", "error");
    dest.searchParams.set(
      "gleanLoginError",
      "Missing code or state in OAuth callback.",
    );
    return NextResponse.redirect(dest.toString());
  }

  try {
    const rec = await completeLogin({ code, state });
    dest.searchParams.set("gleanLogin", "success");
    dest.searchParams.set("gleanExpiresAt", String(rec.expiresAt));
    return NextResponse.redirect(dest.toString());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    dest.searchParams.set("gleanLogin", "error");
    dest.searchParams.set("gleanLoginError", message.slice(0, 400));
    return NextResponse.redirect(dest.toString());
  }
}
