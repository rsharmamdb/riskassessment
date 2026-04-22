/**
 * POST /api/glean/chat
 *
 * Server-side wrapper around Glean MCP's `chat` tool. Unlike `search`, which
 * returns document snippets, `chat` invokes Glean's agentic synthesis — it
 * explores multiple sources (cases, Slack, PS reports, JIRA, docs) and
 * produces a cited, synthesized answer. This is what gives the auto-gather
 * step the rich Ubuy-style recap shown in the product screenshot.
 *
 * Body:
 *   { message: string,
 *     gleanToken?: string,
 *     gleanUrl?: string }
 *
 * Returns:
 *   { ok: true, answer: string, citations: GleanChatCitation[],
 *     raw: unknown, tokenSource: 'static'|'oauth' }
 */

import { NextResponse } from "next/server";
import { callMcpTool } from "@/lib/mcp-client";
import { extractChatAnswer, toolResultToJson } from "@/lib/glean-parse";
import { isUnauthorizedError, resolveGleanServer } from "@/lib/glean-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

interface Body {
  message?: string;
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
  const message = body.message?.trim();
  if (!message) {
    return NextResponse.json(
      { ok: false, error: "Missing `message` (Glean chat prompt)" },
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
    const result = await callMcpTool(resolved.server, "chat", { message });
    const raw = toolResultToJson(result);
    const { answer, citations } = extractChatAnswer(raw);
    return NextResponse.json({
      ok: true,
      answer,
      citations,
      tokenSource: resolved.tokenSource,
    });
  } catch (err) {
    const messageOut = err instanceof Error ? err.message : String(err);
    if (isUnauthorizedError(err) && resolved.tokenSource === "oauth") {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Glean rejected the SSO token. Open Settings → Glean (MCP) → Sign in via SSO. (" +
            messageOut +
            ")",
        },
        { status: 401 },
      );
    }
    return NextResponse.json({ ok: false, error: messageOut }, { status: 502 });
  }
}
