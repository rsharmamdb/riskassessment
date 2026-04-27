/**
 * Append-only report history keyed on `salesforceId`.
 *
 * The `assessments` collection carries LATEST state (wizard draft + current
 * report). `report_versions` is the immutable log — every successful
 * generation writes one doc here so we can:
 *   - Feed the t-1 report back into the next generation (prior-aware LLM).
 *   - Track recommendation lifecycle across versions (regression detection).
 *   - Offer a future history UI.
 *
 * Endpoints:
 *   GET  ?salesforceId=<id>&latest=true         — single most recent version
 *   GET  ?salesforceId=<id>&limit=<n>           — list (default limit 20, desc)
 *   POST  body: { salesforceId, input, report, riskStatuses? }
 *                                                — append a new version
 */

import { NextResponse } from "next/server";
import type { Collection, Document } from "mongodb";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COLLECTION = "report_versions";

let _indexesEnsured = false;
async function ensureIndexes(col: Collection<Document>) {
  if (_indexesEnsured) return;
  try {
    // Non-unique — this collection is append-only history; multiple docs
    // per salesforceId is the whole point. Index supports the common
    // `find({ salesforceId }).sort({ generatedAt: -1 })` query path.
    await col.createIndex(
      { salesforceId: 1, generatedAt: -1 },
      { name: "sfId_generatedAt_desc" },
    );
    _indexesEnsured = true;
  } catch (err) {
    console.warn("[report_versions] ensureIndexes failed:", (err as Error).message);
  }
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const salesforceId = url.searchParams.get("salesforceId");
    const latest = url.searchParams.get("latest") === "true";
    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get("limit") ?? "20", 10) || 20, 1),
      100,
    );

    if (!salesforceId) {
      return NextResponse.json(
        { ok: false, error: "Missing ?salesforceId=" },
        { status: 400 },
      );
    }

    const db = await getDb();
    const col = db.collection(COLLECTION);
    await ensureIndexes(col);

    if (latest) {
      const doc = await col.findOne(
        { salesforceId },
        { sort: { generatedAt: -1 } },
      );
      return NextResponse.json({ ok: true, version: doc ?? null });
    }

    const versions = await col
      .find({ salesforceId })
      .sort({ generatedAt: -1 })
      .limit(limit)
      .project({ report: 0 }) // list view — omit report body to keep responses light
      .toArray();
    return NextResponse.json({ ok: true, versions });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      salesforceId?: string;
      input?: { accountName?: string; canonicalName?: string };
      report?: string;
      /** Snapshot of reviewer-set statuses at time of generation, so history
       *  explains how the prior report was acted on. */
      riskStatuses?: Array<{
        riskId: number;
        status: string;
        owner?: string | null;
        dueDate?: string | null;
      }>;
    };

    if (!body.salesforceId || !body.report || !body.input) {
      return NextResponse.json(
        { ok: false, error: "Missing salesforceId, report, or input" },
        { status: 400 },
      );
    }

    const db = await getDb();
    const col = db.collection(COLLECTION);
    await ensureIndexes(col);
    const now = new Date().toISOString();

    // Link to the prior version so downstream can walk the history chain.
    const prior = await col.findOne(
      { salesforceId: body.salesforceId },
      { sort: { generatedAt: -1 }, projection: { _id: 1, generatedAt: 1 } },
    );

    const result = await col.insertOne({
      salesforceId: body.salesforceId,
      accountName: body.input.accountName ?? null,
      canonicalName: body.input.canonicalName ?? null,
      generatedAt: now,
      input: body.input,
      report: body.report,
      riskStatuses: body.riskStatuses ?? [],
      priorVersionId: prior?._id ?? null,
      priorGeneratedAt: prior?.generatedAt ?? null,
    });

    return NextResponse.json({ ok: true, id: result.insertedId });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 },
    );
  }
}
