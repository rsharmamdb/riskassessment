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
  discoverCasesViaBot,
  type PipelineEvent,
} from "@/lib/auto-triage-pipeline";
import { getUserEmail } from "@/lib/auto-triage";
import { createMongoCaseIntelCache } from "@/lib/case-intel-cache";
import { createMongoAccountHealthCache } from "@/lib/account-health-cache";
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
  /** Lookback window used by the Auto Triage bot's case-discovery call.
   *  Defaults to 6 months when omitted. */
  timeframeMonths?: number;
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
  const timeframeMonths = body.timeframeMonths ?? 6;

  // Glean artifacts are always mined (cheap, synchronous). Bot discovery is
  // a second source — kicks off inside the stream below so the client sees
  // a "discovering…" event.
  const casesFromArtifacts = body.artifacts
    ? extractCasesFromArtifacts(body.artifacts)
    : [];

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

      // Bot-driven case discovery — authoritative source when the Hub bot
      // can enumerate by account. Failures are non-fatal; we'll union with
      // Glean extraction and fall back to Glean-only if the bot returned
      // nothing.
      let caseSource: "provided" | "bot+glean" | "bot" | "artifacts" = "artifacts";
      let bot: { cases: string[]; reason: string | null } = { cases: [], reason: null };
      if (body.cases && body.cases.length > 0) {
        caseSource = "provided";
      } else {
        send({
          type: "status",
          message: "Discovering cases via the Hub Auto Triage bot…",
        });
        bot = await discoverCasesViaBot({
          accountName: body.accountName!,
          salesforceId: body.salesforceId,
          timeframeMonths,
          userEmail,
        });
        send({
          type: "discovery_done",
          botCases: bot.cases.length,
          gleanCases: casesFromArtifacts.length,
          botReason: bot.reason,
        });
      }

      // Union: bot ∪ glean, preserving 8-digit 0-leading case numbers only.
      // Hard safety cap at MAX_CASES_PER_RUN so a bot that ignores the
      // discovery prompt's "at most 25" instruction can't drive the pipeline
      // into a 100+ case run. Sort is lexicographic (case numbers are
      // monotonic-ish with opening time) so a truncation slice is stable.
      const MAX_CASES_PER_RUN = 15;
      let merged: string[];
      if (body.cases && body.cases.length > 0) {
        merged = body.cases;
      } else {
        merged = [...new Set<string>([...bot.cases, ...casesFromArtifacts])]
          .filter((c) => /^0\d{7}$/.test(c))
          // Most recent first — case numbers grow monotonically, so descending sort = newest first.
          .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
          .slice(0, MAX_CASES_PER_RUN);
      }

      if (caseSource !== "provided") {
        caseSource = bot.cases.length > 0
          ? casesFromArtifacts.length > 0
            ? "bot+glean"
            : "bot"
          : "artifacts";
      }

      if (merged.length === 0) {
        send({
          type: "error",
          error:
            "No case numbers found. Bot discovery returned 0 and no Glean artifacts cite `hub.corp.mongodb.com/case/<number>`." +
            (bot.reason ? ` Bot reason: ${bot.reason}` : ""),
        });
        controller.close();
        return;
      }

      send({
        type: "cases_resolved",
        cases: merged,
        source: caseSource,
        sources: {
          bot: bot.cases.length,
          glean: casesFromArtifacts.length,
          merged: merged.length,
        },
      });
      const cases = merged;

      // MongoDB-backed caches are always attached so write-back runs; the
      // `forceRefresh` flag controls whether we honor cached hits.
      const cache = createMongoCaseIntelCache();
      const accountHealthCache = createMongoAccountHealthCache();

      try {
        await runCaseIntelligence({
          cases,
          accountName: body.accountName!,
          salesforceId: body.salesforceId,
          userEmail,
          concurrency: body.concurrency,
          notify: send,
          cache,
          accountHealthCache,
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
