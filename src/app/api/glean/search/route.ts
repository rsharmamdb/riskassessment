/**
 * POST /api/glean/search
 *
 * Thin server-side wrapper around Glean MCP's `search` tool. Lets the Case
 * Analysis UI preview the exact args and run just the search step, so the
 * user can pick which hits to read before we hit `read_document`.
 *
 * Body:
 *   { args: Record<string, unknown>,   // Glean search args (query, app, ...)
 *     gleanToken?: string,
 *     gleanUrl?: string }
 *
 * Returns:
 *   { ok: true, hits: SearchHit[], raw: unknown, tokenSource: 'static'|'oauth' }
 */

import { NextResponse } from "next/server";
import { callMcpTool } from "@/lib/mcp-client";
import { extractSearchHits, toolResultToJson } from "@/lib/glean-parse";
import { isUnauthorizedError, resolveGleanServer } from "@/lib/glean-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface Body {
  args?: Record<string, unknown>;
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
  if (!body.args || typeof body.args !== "object") {
    return NextResponse.json(
      { ok: false, error: "Missing `args` (Glean search arguments)" },
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
          "Not signed in to Glean. Open Settings → Glean (MCP) → Sign in via SSO, paste an MCP API token, or use the paste-back bridge. (" +
          (err instanceof Error ? err.message : String(err)) +
          ")",
      },
      { status: 401 },
    );
  }

  try {
    const result = await callMcpTool(resolved.server, "search", body.args);
    const raw = toolResultToJson(result);
    const hits = extractSearchHits(raw);
    return NextResponse.json({
      ok: true,
      hits,
      stats: { returned: hits.length },
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
