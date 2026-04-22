/**
 * GET  /api/db/lgtm?account=<name>  — fetch LGTM status for an account
 * POST /api/db/lgtm                 — upsert a reviewer approval
 *
 * Body: { account, role: "AE"|"CSM"|"PS", reviewerName, approved: boolean }
 */
import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const account = url.searchParams.get("account");
    if (!account) {
      return NextResponse.json({ ok: false, error: "Missing ?account= param" }, { status: 400 });
    }
    const db = await getDb();
    const doc = await db.collection("lgtm").findOne({ account });
    return NextResponse.json({ ok: true, lgtm: doc ?? null });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const { account, role, reviewerName, approved } = await req.json() as {
      account: string;
      role: "AE" | "CSM" | "PS";
      reviewerName?: string;
      approved: boolean;
    };
    if (!account || !role) {
      return NextResponse.json({ ok: false, error: "Missing account or role" }, { status: 400 });
    }
    const db = await getDb();
    const now = new Date().toISOString();
    await db.collection("lgtm").updateOne(
      { account },
      {
        $set: {
          [`roles.${role}`]: { approved, reviewerName: reviewerName ?? null, updatedAt: now },
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}
