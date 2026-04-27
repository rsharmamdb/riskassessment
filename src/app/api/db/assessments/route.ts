/**
 * GET  /api/db/assessments?account=<name>  — load latest assessment for account
 * GET  /api/db/assessments                 — list all saved assessments
 * POST /api/db/assessments                 — upsert (save) an assessment
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
    // One assessment per Salesforce ID. Sparse so older name-only docs
    // (if any) don't conflict with the unique constraint.
    await col.createIndex(
      { "input.salesforceId": 1 },
      { name: "sfId_unique", unique: true, sparse: true },
    );
    await col.createIndex({ updatedAt: -1 }, { name: "updatedAt_desc" });
    _indexesEnsured = true;
  } catch (err) {
    console.warn("[assessments] ensureIndexes failed:", (err as Error).message);
  }
}

export async function GET(req: Request) {
  try {
    const db = await getDb();
    const col = db.collection("assessments");
    const url = new URL(req.url);
    const sfId = url.searchParams.get("salesforceId");
    const account = url.searchParams.get("account");
    if (sfId || account) {
      // Prefer salesforceId lookup; fall back to name
      const filter = sfId
        ? { "input.salesforceId": sfId }
        : { "input.accountName": account };
      const doc = await col.findOne(filter, { sort: { updatedAt: -1 } });
      return NextResponse.json({ ok: true, assessment: doc });
    }
    // List distinct accounts with latest update time.
    // `report` is included so the client can parse the Overall Risk Rating
    // tag (RED / YELLOW / GREEN) without a second round-trip. If we later
    // need to keep responses lean, switch to a server-side parse + a single
    // `rating` field.
    const list = await col
      .aggregate([
        { $sort: { updatedAt: -1 } },
        {
          $group: {
            _id: "$input.accountName",
            updatedAt: { $first: "$updatedAt" },
            artifactCount: { $first: "$artifactCount" },
            hasReport: { $first: "$hasReport" },
            salesforceId: { $first: "$input.salesforceId" },
            canonicalName: { $first: "$input.canonicalName" },
            report: { $first: "$report" },
          },
        },
        { $sort: { updatedAt: -1 } },
      ])
      .toArray();
    return NextResponse.json({ ok: true, assessments: list });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { input, artifacts, triagePaste, report } = body;
    if (!input?.accountName) {
      return NextResponse.json(
        { ok: false, error: "Missing input.accountName" },
        { status: 400 },
      );
    }
    const db = await getDb();
    const col = db.collection("assessments");
    await ensureIndexes(col);
    const now = new Date().toISOString();

    await col.updateOne(
      // Prefer salesforceId as the canonical key; fall back to account name
      input.salesforceId
        ? { "input.salesforceId": input.salesforceId }
        : { "input.accountName": input.accountName },
      {
        $set: {
          input,
          artifacts: artifacts ?? [],
          triagePaste: triagePaste ?? "",
          report: report ?? "",
          artifactCount: (artifacts ?? []).length,
          hasReport: !!report,
          updatedAt: now,
          ...(input.salesforceId ? { salesforceId: input.salesforceId } : {}),
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 },
    );
  }
}
