/**
 * POST /api/glean/read
 *
 * Thin server-side wrapper around Glean MCP's `read_document` tool. Called
 * after the user has selected which search hits to analyze.
 *
 * Body:
 *   { urls: string[],
 *     hints?: { url: string; title?: string; caseNumber?: string }[],
 *     gleanToken?: string,
 *     gleanUrl?: string }
 *
 * Returns:
 *   { ok: true, cases: CaseDocument[], tokenSource }
 *
 * `hints` are the corresponding search hits; we use them to preserve the
 * original title / caseNumber when read_document returns a sparse doc.
 */

import { NextResponse } from "next/server";
import { callMcpTool } from "@/lib/mcp-client";
import {
  extractDocuments,
  mergeHitsAndDocs,
  toolResultToJson,
  type SearchHit,
} from "@/lib/glean-parse";
import { isUnauthorizedError, resolveGleanServer } from "@/lib/glean-server";
import type { CaseDocument } from "@/lib/case-analysis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

interface Hint {
  url: string;
  title?: string;
  caseNumber?: string;
}

interface Body {
  urls?: string[];
  hints?: Hint[];
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
  if (!body.urls || !Array.isArray(body.urls) || body.urls.length === 0) {
    return NextResponse.json(
      { ok: false, error: "Missing `urls` array" },
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

  try {
    const result = await callMcpTool(resolved.server, "read_document", {
      urls: body.urls,
    });
    const docs = extractDocuments(toolResultToJson(result));

    // Synthesize hit records from hints so titles/caseNumbers are preserved.
    const hintSrc: Hint[] =
      body.hints ?? body.urls.map((u) => ({ url: u, title: u }));
    const hints: SearchHit[] = hintSrc.map((h) => {
      const rec: SearchHit = { url: h.url, title: h.title || h.url };
      if (h.caseNumber) rec.caseNumber = h.caseNumber;
      return rec;
    });

    const cases: CaseDocument[] = mergeHitsAndDocs(hints, docs);
    return NextResponse.json({
      ok: true,
      cases,
      stats: {
        requested: body.urls.length,
        read: cases.length,
      },
      tokenSource: resolved.tokenSource,
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
