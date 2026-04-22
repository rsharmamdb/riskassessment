/**
 * GET  /api/mongogpt/token  — cheap status probe. Never triggers SSO.
 * POST /api/mongogpt/token  — ensures binary, config, and a valid JWT. May
 *                              spawn `kanopy-oidc login` (opens browser for
 *                              SSO). Returns the token on success.
 *
 * The server transparently:
 *   1. downloads the kanopy-oidc release matching the host OS/arch into
 *      ~/kanopy/bin/ if it's not already there,
 *   2. writes ~/.kanopy/config.yaml if missing,
 *   3. runs `kanopy-oidc login` and caches the JWT in
 *      ~/.kanopy/risksi-token.json until its `exp` claim elapses.
 *
 * This route only listens on localhost during `next dev` / `next start`.
 * Do not expose it on a public network.
 */

import { NextResponse } from "next/server";
import { getTokenStatus, getValidToken, invalidateToken } from "@/lib/mongogpt-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 200;

export async function GET() {
  return NextResponse.json({ ok: true, ...getTokenStatus() });
}

interface PostBody {
  /** Force a fresh login even if a valid token is cached. */
  force?: boolean;
  /** Invalidate the cached token before re-minting. Implies `force`. */
  invalidate?: boolean;
}

export async function POST(req: Request) {
  let body: PostBody = {};
  try {
    body = (await req.json()) as PostBody;
  } catch {
    /* empty body is fine */
  }

  try {
    if (body.invalidate) invalidateToken();
    const result = await getValidToken({ force: !!(body.force || body.invalidate) });
    return NextResponse.json({
      ok: true,
      token: result.token,
      expiresAt: result.expiresAt,
      mintedAt: result.mintedAt,
      binaryPath: result.binaryPath,
      actions: result.actions,
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === "ENOENT") {
      return NextResponse.json(
        {
          ok: false,
          error:
            "System binary missing (likely `tar`). Install Xcode Command Line Tools or equivalent and retry.",
        },
        { status: 500 },
      );
    }
    const message = (e.stderr || e.message || String(err)).slice(0, 1000);
    return NextResponse.json(
      { ok: false, error: message },
      { status: 502 },
    );
  }
}
