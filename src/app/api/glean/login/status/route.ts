/**
 * GET  /api/glean/login/status  → current Glean OAuth token status (sanitized)
 * POST /api/glean/login/status  → { action: "logout" | "resetClient" }
 *
 * Never returns the access_token itself; only expiry, scope, resource and
 * signed-in state. Logout clears the token; resetClient additionally clears
 * the cached DCR record so the next login re-registers the app.
 */

import { NextResponse } from "next/server";
import {
  getTokenStatus,
  invalidateClient,
  invalidateToken,
} from "@/lib/glean-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ok: true, status: getTokenStatus() });
}

export async function POST(req: Request) {
  let body: { action?: string } = {};
  try {
    body = (await req.json()) as { action?: string };
  } catch {
    /* empty body treated as logout */
  }
  const action = body.action || "logout";
  if (action === "logout") {
    invalidateToken();
  } else if (action === "resetClient") {
    invalidateClient();
  } else {
    return NextResponse.json(
      { ok: false, error: `Unknown action: ${action}` },
      { status: 400 },
    );
  }
  return NextResponse.json({ ok: true, status: getTokenStatus() });
}
