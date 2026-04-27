/**
 * GET  /api/db/risks?salesforceId=<id>  — fetch all risk statuses for an account
 * POST /api/db/risks                    — upsert a single risk status update
 *
 * Body: { salesforceId, riskId, status, owner?, dueDate? }
 */
import { NextResponse } from "next/server";
import type { Collection, Document } from "mongodb";
import { getDb } from "@/lib/mongo";
import type { RiskStatus } from "@/lib/parse-risks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let _indexesEnsured = false;
async function ensureIndexes(col: Collection<Document>) {
  if (_indexesEnsured) return;
  try {
    // One status doc per (salesforceId, riskId).
    await col.createIndex(
      { salesforceId: 1, riskId: 1 },
      { name: "sfId_riskId_unique", unique: true },
    );
    _indexesEnsured = true;
  } catch (err) {
    console.warn("[risks] ensureIndexes failed:", (err as Error).message);
  }
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const salesforceId = url.searchParams.get("salesforceId");
    if (!salesforceId) {
      return NextResponse.json({ ok: false, error: "Missing ?salesforceId=" }, { status: 400 });
    }
    const db = await getDb();
    const col = db.collection("risk_statuses");
    await ensureIndexes(col);
    const risks = await col.find({ salesforceId }).toArray();
    return NextResponse.json({ ok: true, risks });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const { salesforceId, riskId, status, owner, dueDate } = (await req.json()) as {
      salesforceId: string;
      riskId: number;
      status: RiskStatus;
      owner?: string;
      dueDate?: string;
    };
    if (!salesforceId || riskId === undefined || !status) {
      return NextResponse.json({ ok: false, error: "Missing required fields" }, { status: 400 });
    }
    const db = await getDb();
    const col = db.collection("risk_statuses");
    await ensureIndexes(col);
    const now = new Date().toISOString();
    await col.updateOne(
      { salesforceId, riskId },
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
