/**
 * POST /api/cases/fetch
 *
 * One-shot convenience: runs Glean `search` then `read_document` and returns
 * ready-to-analyze CaseDocument[]. The new UI drives search + read as
 * separate steps (/api/glean/search, /api/glean/read); this endpoint
 * remains for scripts and backwards compatibility.
 *
 * Body:
 *   { accountName: string,
 *     timeframeMonths?: number,   // default 6
 *     limit?: number,             // default 10
 *     gleanToken?: string,
 *     gleanUrl?: string }
 */

import { NextResponse } from "next/server";
import { callMcpTool } from "@/lib/mcp-client";
import { buildCaseSearchArgs, type CaseDocument } from "@/lib/case-analysis";
import {
  extractDocuments,
  extractSearchHits,
  mergeHitsAndDocs,
  toolResultToJson,
} from "@/lib/glean-parse";
import { isUnauthorizedError, resolveGleanServer } from "@/lib/glean-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

interface Body {
  accountName: string;
  timeframeMonths?: number;
  limit?: number;
  gleanToken?: string;
  gleanUrl?: string;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.accountName || !body.accountName.trim()) {
    return NextResponse.json(
      { ok: false, error: "Missing accountName" },
      { status: 400 },
    );
  }

  let resolved;
  try {
    resolved = await resolveGleanServer({
      bodyToken: body.gleanToken,
      bodyUrl: body.gleanUrl,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Not signed in to Glean. Open Settings → Glean (MCP) → Sign in via SSO. (" +
          (err instanceof Error ? err.message : String(err)) +
          ")",
      },
      { status: 401 },
    );
  }

  const limit = Math.min(Math.max(body.limit ?? 10, 1), 25);
  const months = Math.min(Math.max(body.timeframeMonths ?? 6, 1), 36);
  const searchArgs = buildCaseSearchArgs({
    accountName: body.accountName.trim(),
    timeframeMonths: months,
  });

  try {
    const searchResult = await callMcpTool(
      resolved.server,
      "search",
      searchArgs,
    );
    const hits = extractSearchHits(toolResultToJson(searchResult)).slice(0, limit);
    if (hits.length === 0) {
      return NextResponse.json({
        ok: true,
        cases: [] as CaseDocument[],
        stats: {
          searched: 0,
          read: 0,
          limit,
          months,
          tokenSource: resolved.tokenSource,
          searchArgs,
        },
        message: `Glean search returned no cases for "${body.accountName}" in the last ${months} months.`,
      });
    }

    const urls = hits.map((h) => h.url);
    const readResult = await callMcpTool(resolved.server, "read_document", { urls });
    const docs = extractDocuments(toolResultToJson(readResult));
    const cases = mergeHitsAndDocs(hits, docs);

    return NextResponse.json({
      ok: true,
      cases,
      stats: {
        searched: hits.length,
        read: cases.length,
        limit,
        months,
        tokenSource: resolved.tokenSource,
        searchArgs,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isUnauthorizedError(err) && resolved.tokenSource === "oauth") {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Glean rejected the SSO token. Open Settings → Glean (MCP) → Sign in via SSO. (" +
            message +
            ")",
        },
        { status: 401 },
      );
    }
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
