/**
 * GET /api/triage/sessions — list the caller's existing Auto Triage Chat
 * sessions, as known to hub.corp.mongodb.com. Useful as an integration
 * sanity check (hitting this proves token + auth work end-to-end).
 */

import { NextResponse } from "next/server";
import { listSessions } from "@/lib/auto-triage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const sessions = await listSessions();
    return NextResponse.json({ ok: true, sessions });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 502 },
    );
  }
}
