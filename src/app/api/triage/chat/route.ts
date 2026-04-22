/**
 * POST /api/triage/chat — run one Auto Triage prompt against
 * hub.corp.mongodb.com and stream the raw SSE body back to the caller.
 *
 * Body:
 *   {
 *     input:     string;              // required — the message body
 *     sessionId?: string;              // defaults to `${email}-${now}`
 *     pathname?:  string;              // e.g. `/case/01234567`
 *     label?:     string;              // e.g. `Case: 01234567`
 *     // OR supply { promptId, variables } to render one of the named PremServ templates:
 *     promptId?:  PromptId;
 *     variables?: Record<string, string>;
 *     userEmail?: string;              // used when generating a sessionId
 *   }
 *
 * Returns: text/event-stream (raw hub SSE — the caller is responsible for
 * parsing `data:` lines). The server does not buffer.
 */

import { NextResponse } from "next/server";
import {
  streamAutoTriage,
  generateSessionId,
  getUserEmail,
} from "@/lib/auto-triage";
import {
  renderPrompt,
  type PromptId,
  getPromptById,
} from "@/lib/auto-triage-prompts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface Body {
  input?: string;
  sessionId?: string;
  pathname?: string;
  label?: string;
  promptId?: PromptId;
  variables?: Record<string, string>;
  userEmail?: string;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  let input = body.input?.trim() ?? "";
  if (!input && body.promptId) {
    if (!getPromptById(body.promptId)) {
      return NextResponse.json(
        { ok: false, error: `Unknown promptId: ${body.promptId}` },
        { status: 400 },
      );
    }
    try {
      input = renderPrompt(body.promptId, body.variables ?? {});
    } catch (err) {
      return NextResponse.json(
        { ok: false, error: (err as Error).message },
        { status: 400 },
      );
    }
  }

  if (!input) {
    return NextResponse.json(
      { ok: false, error: "Provide either `input` or `{ promptId, variables }`." },
      { status: 400 },
    );
  }

  const email = body.userEmail || (await getUserEmail());
  const sessionId = body.sessionId || generateSessionId(email);

  try {
    const { body: upstream } = await streamAutoTriage({
      input,
      sessionId,
      pathname: body.pathname ?? "/",
      label: body.label ?? "",
    });

    return new Response(upstream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Triage-Session": sessionId,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 502 },
    );
  }
}
