/**
 * GET  /api/db/artifacts?account=<name>  — load cached artifacts for an account
 * POST /api/db/artifacts                 — upsert artifacts (with per-query timestamps)
 */
import { NextResponse } from "next/server";
import type { Collection, Document } from "mongodb";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let _indexesEnsured = false;
async function ensureIndexes(col: Collection<Document>) {
  if (_indexesEnsured) return;
  try {
    // One artifact per (salesforceId, label, kind). Sparse so legacy
    // name-only rows don't violate.
    await col.createIndex(
      { salesforceId: 1, label: 1, kind: 1 },
      { name: "sfId_label_kind_unique", unique: true, sparse: true },
    );
    // Lookup-by-account index for callers that only have a name.
    await col.createIndex({ account: 1, label: 1, kind: 1 }, { name: "account_label_kind" });
    _indexesEnsured = true;
  } catch (err) {
    console.warn("[artifacts] ensureIndexes failed:", (err as Error).message);
  }
}

export async function GET(req: Request) {
  try {
    const db = await getDb();
    const col = db.collection("artifacts");
    await ensureIndexes(col);
    const url = new URL(req.url);
    const sfId = url.searchParams.get("salesforceId");
    const account = url.searchParams.get("account");
    if (!sfId && !account) {
      return NextResponse.json(
        { ok: false, error: "Missing ?salesforceId= or ?account= param" },
        { status: 400 },
      );
    }
    // Prefer salesforceId lookup; fall back to account name
    const filter = sfId ? { salesforceId: sfId } : { account };

    // Artifacts are retained indefinitely for historical analysis; the
    // Wizard decides when to refresh them on an explicit user action.
    const docs = await col.find(filter).toArray();
    return NextResponse.json({ ok: true, artifacts: docs });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
    const { account, salesforceId, artifacts } = await req.json();
    if ((!account && !salesforceId) || !Array.isArray(artifacts)) {
      return NextResponse.json(
        { ok: false, error: "Missing account/salesforceId or artifacts array" },
        { status: 400 },
      );
    }
    const db = await getDb();
    const col = db.collection("artifacts");
    await ensureIndexes(col);
    const now = new Date().toISOString();
    // Use salesforceId as the canonical key when available
    const keyFilter = salesforceId
      ? { salesforceId }
      : { account };
    const ops = artifacts.map((a: Record<string, unknown>) => ({
      updateOne: {
        filter: { ...keyFilter, label: a.label, kind: a.kind },
        update: {
          $set: { ...a, account, ...(salesforceId ? { salesforceId } : {}), fetchedAt: now },
          $setOnInsert: { createdAt: now },
        },
        upsert: true,
      },
    }));
    if (ops.length > 0) {
      await col.bulkWrite(ops);
    }
    return NextResponse.json({ ok: true, count: ops.length });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 },
    );
  }
}
