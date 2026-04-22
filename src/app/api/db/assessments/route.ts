/**
 * GET  /api/db/assessments?account=<name>  — load latest assessment for account
 * GET  /api/db/assessments                 — list all saved assessments
 * POST /api/db/assessments                 — upsert (save) an assessment
 */
import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    // List distinct accounts with latest update time
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
