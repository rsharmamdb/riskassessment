/**
 * GET  /api/db/risks?account=<name>  — fetch all risk statuses for an account
 * POST /api/db/risks                 — upsert a single risk status update
 *
 * Body: { account, riskId, status, owner?, dueDate? }
 */
import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import type { RiskStatus } from "@/lib/parse-risks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const account = url.searchParams.get("account");
    if (!account) {
      return NextResponse.json({ ok: false, error: "Missing ?account=" }, { status: 400 });
    }
    const db = await getDb();
    const risks = await db.collection("risk_statuses").find({ account }).toArray();
    return NextResponse.json({ ok: true, risks });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const { account, riskId, status, owner, dueDate } = (await req.json()) as {
      account: string;
      riskId: number;
      status: RiskStatus;
      owner?: string;
      dueDate?: string;
    };
    if (!account || riskId === undefined || !status) {
      return NextResponse.json({ ok: false, error: "Missing required fields" }, { status: 400 });
    }
    const db = await getDb();
    const now = new Date().toISOString();
    await db.collection("risk_statuses").updateOne(
      { account, riskId },
      {
        $set: { status, owner: owner ?? null, dueDate: dueDate ?? null, updatedAt: now },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}
