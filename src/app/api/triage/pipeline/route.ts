/**
 * POST /api/triage/pipeline — run the full case-intelligence pipeline
 * (per-case summary + precedent research + account-support-health) and
 * stream progress back as Server-Sent Events.
 *
 * Body:
 *   {
 *     accountName: string;
 *     userEmail?: string;          // used to generate sessionIds
 *     cases?: string[];            // 8-digit case numbers; if omitted, extracted from `artifacts`
 *     artifacts?: GatheredArtifact[]; // Glean artifacts to mine for case numbers
 *     concurrency?: number;        // default 3
 *   }
 *
 * SSE event shape (all nested under `data: {...}`):
 *   { type: "status",       message }
 *   { type: "cases_resolved", cases: string[], source: "provided" | "artifacts" }
 *   { type: "prompt_start", run: PromptRun }
 *   { type: "prompt_done",  run: PromptRun }
 *   { type: "phase_start",  phase: "per-case" | "account-health" }
 *   { type: "phase_done",   phase: "per-case" | "account-health" }
 *   { type: "final",        intelligence: CaseIntelligence }
 *   { type: "error",        error }
 */

import {
  runCaseIntelligence,
  extractCasesFromArtifacts,
  type PipelineEvent,
} from "@/lib/auto-triage-pipeline";
import { getUserEmail } from "@/lib/auto-triage";
import { createMongoCaseIntelCache } from "@/lib/case-intel-cache";
import type { GatheredArtifact } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Pipeline can take 3-5 min for 7-10 cases; Next.js allows up to 600s on node.
export const maxDuration = 600;

interface Body {
  accountName?: string;
  salesforceId?: string;
  userEmail?: string;
  cases?: string[];
  artifacts?: GatheredArtifact[];
  concurrency?: number;
  /** When true, bypass the cache entirely (forces fresh Hub calls). */
  forceRefresh?: boolean;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return sseError("Invalid JSON body", 400);
  }

  if (!body.accountName) return sseError("Missing accountName", 400);

  const userEmail = body.userEmail || (await getUserEmail());

  // Resolve case list: prefer explicit `cases`, fall back to extracting
  // from Glean artifacts — the "Glean-first" strategy the user picked.
  const casesFromArtifacts = body.artifacts
    ? extractCasesFromArtifacts(body.artifacts)
    : [];
  const cases =
    body.cases && body.cases.length > 0 ? body.cases : casesFromArtifacts;
  const caseSource: "provided" | "artifacts" =
    body.cases && body.cases.length > 0 ? "provided" : "artifacts";

  if (cases.length === 0) {
    return sseError(
      "No case numbers found. Pass `cases` explicitly or provide Glean `artifacts` that cite hub.corp.mongodb.com/case/<number>.",
      400,
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: PipelineEvent | { type: string; [k: string]: unknown }) => {
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          /* controller may be closed */
        }
      };

      send({
        type: "cases_resolved",
        cases,
        source: caseSource,
      });

      // MongoDB-backed cache is always attached so write-back runs; the
      // `forceRefresh` flag controls whether we honor cached hits.
      const cache = createMongoCaseIntelCache();

      try {
        await runCaseIntelligence({
          cases,
          accountName: body.accountName!,
          salesforceId: body.salesforceId,
          userEmail,
          concurrency: body.concurrency,
          notify: send,
          cache,
          forceRefresh: body.forceRefresh,
        });
      } catch (err) {
        send({
          type: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

function sseError(message: string, status: number): Response {
  const body = `data: ${JSON.stringify({ type: "error", error: message })}\n\n`;
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/event-stream; charset=utf-8" },
  });
}
