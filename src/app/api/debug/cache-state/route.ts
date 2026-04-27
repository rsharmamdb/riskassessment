/**
 * GET /api/debug/cache-state?salesforceId=<id>
 *
 * Diagnostic endpoint — returns the current cache state for one account:
 *   - which cases are present in `case_intelligence`
 *   - which slots (summary / precedents) each case has
 *   - case status + last-write timestamps
 *   - presence in `account_health_cache`
 *
 * Intended for operator debugging when "reused vs fetched" numbers look
 * wrong. Not exposed anywhere in the UI.
 */

import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import {
  scanCache,
  createMongoCaseIntelCache,
  type CacheKey,
  type CachedPromptId,
} from "@/lib/case-intel-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const sfId = url.searchParams.get("salesforceId");
    if (!sfId) {
      return NextResponse.json(
        { ok: false, error: "Missing ?salesforceId=" },
        { status: 400 },
      );
    }

    const db = await getDb();

    const caseDocs = await db
      .collection("case_intelligence")
      .find({ salesforceId: sfId })
      .project({
        _id: 1,
        caseNumber: 1,
        status: 1,
        lastWriteAt: 1,
        "summary.fetchedAt": 1,
        "summary.lastReusedAt": 1,
        "precedents.fetchedAt": 1,
        "precedents.lastReusedAt": 1,
      })
      .toArray();

    const cases = caseDocs
      .map((d) => ({
        caseNumber: d.caseNumber ?? d._id,
        status: d.status,
        hasSummary: !!(d as Record<string, unknown>).summary,
        hasPrecedents: !!(d as Record<string, unknown>).precedents,
        lastWriteAt: d.lastWriteAt,
      }))
      .sort((a, b) => String(a.caseNumber).localeCompare(String(b.caseNumber)));

    const accountHealthDocs = await db
      .collection("account_health_cache")
      .find({ salesforceId: sfId })
      .project({ label: 1, fetchedAt: 1, cases: 1 })
      .toArray();

    // Optional: simulate scanCache() for a supplied case list so we can
    // see exactly what decision each (case, prompt) pair would get.
    //   /api/debug/cache-state?salesforceId=X&simulate=01493794,01530272,...
    const simulateStr = url.searchParams.get("simulate");
    let simulation: unknown = undefined;
    if (simulateStr) {
      const caseList = simulateStr
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const cache = createMongoCaseIntelCache();
      const keys: CacheKey[] = caseList.flatMap((c) => [
        { caseNumber: c, promptId: "case-summary" as CachedPromptId },
        { caseNumber: c, promptId: "precedent-research" as CachedPromptId },
      ]);
      const scan = await scanCache(cache, keys);
      simulation = {
        input: caseList,
        counts: scan.counts,
        decisions: scan.decisions.map((d) => ({
          case: d.caseNumber,
          prompt: d.promptId,
          decision: d.decision,
          reason: d.reason,
          cachedSlotPresent: !!d.cachedSlot,
          cachedDocStatus: d.cachedDoc?.status,
        })),
      };
    }

    return NextResponse.json({
      ok: true,
      salesforceId: sfId,
      caseIntelligence: {
        count: cases.length,
        cases,
      },
      accountHealth: {
        count: accountHealthDocs.length,
        entries: accountHealthDocs.map((d) => ({
          label: d.label,
          fetchedAt: d.fetchedAt,
          casesCovered: Array.isArray(d.cases) ? d.cases.length : 0,
        })),
      },
      simulation,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 },
    );
  }
}
