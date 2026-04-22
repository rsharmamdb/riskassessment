/**
 * POST /api/cases/parse
 *
 * Paste-back bridge: Cursor (this IDE) has the Glean MCP installed via OAuth,
 * but the bearer token lives in Cursor's encrypted safeStorage and is not
 * extractable by other processes. Until users configure a Glean API token in
 * Settings, they can run the MCP calls in Cursor chat and paste the raw JSON
 * tool outputs here. This endpoint parses them into CaseDocument[] using the
 * same helpers as /api/cases/fetch.
 *
 * Body:
 *   { searchJson?: string,   // raw text or JSON from a Glean `search` call
 *     readJson?: string }    // raw text or JSON from a Glean `read_document` call
 *
 * At least one field must be provided. If only `readJson` is supplied, cases
 * are synthesized from the document URLs alone (case numbers, if any, are
 * extracted from the URLs).
 */

import { NextResponse } from "next/server";
import type { CaseDocument } from "@/lib/case-analysis";
import {
  coercePasteToJson,
  extractDocuments,
  extractSearchHits,
  mergeHitsAndDocs,
} from "@/lib/glean-parse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  searchJson?: string;
  readJson?: string;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const searchRaw = (body.searchJson || "").trim();
  const readRaw = (body.readJson || "").trim();
  if (!searchRaw && !readRaw) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Paste the raw JSON output from at least one of Glean's `search` or `read_document` tool calls.",
      },
      { status: 400 },
    );
  }

  const warnings: string[] = [];

  let hits: ReturnType<typeof extractSearchHits> = [];
  if (searchRaw) {
    const parsed = coercePasteToJson(searchRaw);
    if (parsed == null) {
      warnings.push("Could not parse `search` paste as JSON — ignored.");
    } else {
      hits = extractSearchHits(parsed);
      if (hits.length === 0) {
        warnings.push(
          "`search` paste parsed, but no hits with URLs were found in it.",
        );
      }
    }
  }

  let docs: ReturnType<typeof extractDocuments> = [];
  if (readRaw) {
    const parsed = coercePasteToJson(readRaw);
    if (parsed == null) {
      warnings.push("Could not parse `read_document` paste as JSON — ignored.");
    } else {
      docs = extractDocuments(parsed);
      if (docs.length === 0) {
        warnings.push(
          "`read_document` paste parsed, but no documents with text bodies were found.",
        );
      }
    }
  }

  const cases: CaseDocument[] = mergeHitsAndDocs(hits, docs);

  return NextResponse.json({
    ok: true,
    cases,
    stats: {
      hitsParsed: hits.length,
      docsParsed: docs.length,
      casesBuilt: cases.length,
    },
    warnings,
    message:
      cases.length === 0
        ? "No cases could be built from the paste. Check that you pasted the raw tool output (JSON), not the assistant's prose summary."
        : `Imported ${cases.length} case${cases.length === 1 ? "" : "s"} from pasted output.`,
  });
}
