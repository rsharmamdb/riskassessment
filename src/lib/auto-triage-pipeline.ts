/**
 * Case Intelligence pipeline.
 *
 * Phase A (fan-out): for each case number, run `case-summary` and
 *   `precedent-research` prompts against Auto Triage Chat, concurrency-capped.
 *   Each prompt gets its own session (so the bot's own conversational context
 *   doesn't bleed between cases or prompt types).
 *
 * Phase B (fan-in): run `account-support-health` over the full case list.
 *   If the list exceeds MAX_CASES_PER_HEALTH_BATCH, split into chunks and
 *   return multiple partial reports — the final MongoGPT synthesis step
 *   reads them all and produces one Risk Register.
 *
 * Callers (the SSE route) pass a `notify` callback to stream progress.
 */

import { callAutoTriage, generateSessionId } from "./auto-triage";
import { renderPrompt } from "./auto-triage-prompts";
import type { GatheredArtifact } from "./types";
import {
  inferStatusFromMarkdown,
  scanCache,
  type CacheKey,
  type CachedPromptId,
  type CaseIntelCache,
  type CacheScanResult,
  type JobDecision,
} from "./case-intel-cache";

const CASE_NUMBER_RE = /\b0\d{7}\b/;
const HUB_CASE_URL_RE = /hub\.corp\.mongodb\.com\/case\/(0\d{7})/gi;

/** Max cases to cram into one `account-support-health` prompt. */
const MAX_CASES_PER_HEALTH_BATCH = 7;
/** Threshold above which we batch instead of sending one big prompt. */
const BATCH_THRESHOLD = 10;

export type PromptRunStatus = "pending" | "running" | "ok" | "error";

export interface PromptRun {
  promptId: "case-summary" | "precedent-research" | "account-support-health";
  sessionId: string;
  status: PromptRunStatus;
  caseNumber?: string;
  batchLabel?: string;
  markdown?: string;
  error?: string;
  durationMs?: number;
  /** "fresh" (hit the bot) vs "cached" (reused from DB). */
  source?: "fresh" | "cached";
  /** Status parsed from markdown (only meaningful for per-case prompts). */
  caseStatus?: "closed" | "open" | "unknown";
}

export interface CaseIntelligence {
  cases: string[];
  accountName: string;
  perCase: Record<
    string,
    { summary?: string; precedents?: string; errors?: string[] }
  >;
  accountHealth: Array<{ label: string; markdown: string; error?: string }>;
  stats: {
    caseCount: number;
    promptsRun: number;
    promptsReused?: number;
    promptsFailed: number;
    durationMs: number;
  };
}

export interface PipelineEvent {
  type:
    | "start"
    | "cache_scan"
    | "prompt_start"
    | "prompt_done"
    | "phase_start"
    | "phase_done"
    | "final"
    | "error";
  message?: string;
  run?: PromptRun;
  phase?: "per-case" | "account-health";
  intelligence?: CaseIntelligence;
  error?: string;
  cacheCounts?: CacheScanResult["counts"];
}

export interface RunPipelineOpts {
  cases: string[];
  accountName: string;
  userEmail: string;
  /** Salesforce account ID — stored on cache entries for account-scoped
   *  queries. Optional; fallback is the account name. */
  salesforceId?: string;
  /** Parallel upstream requests. Hub is not documented to rate-limit but
   *  concurrency > 4 has caused 502s in testing. Default 3. */
  concurrency?: number;
  notify?: (event: PipelineEvent) => void;
  /** Optional cache adapter. When provided, the pipeline skips Hub calls
   *  for cached-fresh (case, prompt) pairs and writes new results back. */
  cache?: CaseIntelCache;
  /** When true, ignore cache hits and re-fetch every (case, prompt) from
   *  Hub. Write-back still happens so the new results become the cache. */
  forceRefresh?: boolean;
}

// -------------------------- case-number extraction -----------------------

/**
 * Scan already-gathered Glean artifacts for MongoDB Hub case URLs and
 * return a de-duplicated, sorted list of 8-digit case numbers. Citation
 * URLs are checked first (most reliable), then the free-text body.
 */
export function extractCasesFromArtifacts(
  artifacts: GatheredArtifact[],
): string[] {
  const found = new Set<string>();
  for (const a of artifacts) {
    // Citation URLs — most trustworthy signal
    for (const c of a.citations ?? []) {
      const url = c.url ?? "";
      let m: RegExpExecArray | null;
      const re = new RegExp(HUB_CASE_URL_RE.source, "gi");
      while ((m = re.exec(url)) !== null) found.add(m[1]);
    }
    // Free text fallback (Glean chat answers often embed case numbers inline)
    const text =
      typeof a.data === "string" ? a.data : JSON.stringify(a.data ?? "");
    const re = new RegExp(HUB_CASE_URL_RE.source, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) found.add(m[1]);
    // Last-ditch: bare "Case 01234567" mentions with no URL
    const bareRe = /Case\s+(0\d{7})\b/gi;
    while ((m = bareRe.exec(text)) !== null) found.add(m[1]);
  }
  return [...found].filter((c) => CASE_NUMBER_RE.test(c)).sort();
}

// -------------------------------- phase A --------------------------------

async function runPromptForCase(
  promptId: "case-summary" | "precedent-research",
  caseNumber: string,
  userEmail: string,
): Promise<{ markdown: string; sessionId: string; durationMs: number }> {
  const input = renderPrompt(promptId, { "case-number": caseNumber });
  const sessionId = generateSessionId(
    userEmail,
    `${promptId}-${caseNumber}`,
  );
  const started = Date.now();
  const res = await callAutoTriage({
    input,
    sessionId,
    pathname: `/case/${caseNumber}`,
    label: `Case: ${caseNumber}`,
  });
  if (!res.text.trim()) {
    throw new Error(
      `Empty response (${res.eventCount} SSE events) from ${promptId} for case ${caseNumber}`,
    );
  }
  return {
    markdown: res.text,
    sessionId,
    durationMs: Date.now() - started,
  };
}

/**
 * Map a list of tasks through a worker pool of size `limit`. Preserves
 * the input order in the returned array and never throws — errors are
 * captured on the item so a single failed case doesn't kill the run.
 */
async function pMapSettled<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<
  Array<{ ok: true; value: R } | { ok: false; error: Error }>
> {
  const out: Array<
    { ok: true; value: R } | { ok: false; error: Error }
  > = new Array(items.length);
  let cursor = 0;
  const runOne = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        out[i] = { ok: true, value: await worker(items[i], i) };
      } catch (err) {
        out[i] = { ok: false, error: err as Error };
      }
    }
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, runOne);
  await Promise.all(workers);
  return out;
}

// -------------------------------- phase B --------------------------------

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function runAccountHealth(
  cases: string[],
  accountName: string,
  userEmail: string,
  batchLabel: string,
): Promise<{ markdown: string; sessionId: string; durationMs: number }> {
  const input = renderPrompt("account-support-health", {
    "account-name": accountName,
    "case-list": cases.join(", "),
  });
  const sessionId = generateSessionId(userEmail, `health-${batchLabel}`);
  const started = Date.now();
  // Account-health can take longer — full tool chain of summaries +
  // clustering + precedent validation. Give it 5 minutes.
  const res = await callAutoTriage({
    input,
    sessionId,
    pathname: "/",
    label: `Account health: ${accountName} (${batchLabel})`,
    timeoutMs: 300_000,
  });
  if (!res.text.trim()) {
    throw new Error(
      `Empty response (${res.eventCount} SSE events) from account-support-health for ${batchLabel}`,
    );
  }
  return {
    markdown: res.text,
    sessionId,
    durationMs: Date.now() - started,
  };
}

// --------------------------------- main ----------------------------------

export async function runCaseIntelligence(
  opts: RunPipelineOpts,
): Promise<CaseIntelligence> {
  const {
    cases,
    accountName,
    salesforceId,
    userEmail,
    concurrency = 3,
    notify = () => {},
    cache,
    forceRefresh = false,
  } = opts;

  const started = Date.now();
  let promptsRun = 0;
  let promptsFailed = 0;
  let promptsReused = 0;

  notify({
    type: "start",
    message: `Running case intelligence for ${cases.length} case${cases.length === 1 ? "" : "s"}`,
  });

  const perCase: CaseIntelligence["perCase"] = {};
  for (const c of cases) perCase[c] = {};

  // ----- Phase A: per-case summary + precedents ----------------------
  notify({ type: "phase_start", phase: "per-case" });

  const keys: CacheKey[] = cases.flatMap((c) => [
    { caseNumber: c, promptId: "case-summary" as CachedPromptId },
    { caseNumber: c, promptId: "precedent-research" as CachedPromptId },
  ]);

  // Cache pre-flight: decide which keys to fetch vs reuse. When
  // `forceRefresh` is set we still pass through the cache (for write-back)
  // but mark every job as `fetch` so the Hub is hit regardless.
  let decisions: JobDecision[];
  if (cache && !forceRefresh) {
    const scan = await scanCache(cache, keys);
    decisions = scan.decisions;
    notify({ type: "cache_scan", cacheCounts: scan.counts });
  } else {
    decisions = keys.map((k) => ({ ...k, decision: "fetch", reason: "miss" }));
    if (cache) {
      // Announce a zero-hit scan so the UI knows cache was consulted.
      notify({
        type: "cache_scan",
        cacheCounts: { hit: 0, miss: keys.length, staleRefresh: 0 },
      });
    }
  }

  // Fan out: all `reuse` entries are instant (no Hub call), all `fetch`
  // entries flow through the worker pool.
  await pMapSettled(decisions, concurrency, async (job) => {
    const run: PromptRun = {
      promptId: job.promptId,
      sessionId: job.cachedSlot?.sessionId ?? "",
      status: "running",
      caseNumber: job.caseNumber,
    };

    if (job.decision === "reuse" && job.cachedSlot && job.cachedDoc) {
      // Fast path — skip Hub entirely.
      notify({ type: "prompt_start", run: { ...run, source: "cached" } });
      const slot = job.cachedSlot;
      const doc = job.cachedDoc;
      if (job.promptId === "case-summary") {
        perCase[job.caseNumber].summary = slot.markdown;
      } else {
        perCase[job.caseNumber].precedents = slot.markdown;
      }
      promptsReused++;
      // Best-effort: bump lastReusedAt for analytics. Don't fail the job if it errors.
      if (cache) {
        cache.touch(doc.caseNumber, job.promptId).catch(() => {});
      }
      notify({
        type: "prompt_done",
        run: {
          ...run,
          status: "ok",
          sessionId: slot.sessionId,
          markdown: slot.markdown,
          source: "cached",
          caseStatus: doc.status,
        },
      });
      return;
    }

    // Slow path — fetch from Hub.
    notify({ type: "prompt_start", run: { ...run, source: "fresh" } });
    try {
      const r = await runPromptForCase(
        job.promptId,
        job.caseNumber,
        userEmail,
      );
      promptsRun++;
      const status = inferStatusFromMarkdown(r.markdown);

      if (job.promptId === "case-summary") {
        perCase[job.caseNumber].summary = r.markdown;
      } else {
        perCase[job.caseNumber].precedents = r.markdown;
      }

      // Write-back. Cache failures must not fail the pipeline job.
      if (cache) {
        cache
          .put({
            caseNumber: job.caseNumber,
            promptId: job.promptId,
            salesforceId,
            accountName,
            markdown: r.markdown,
            sessionId: r.sessionId,
            status,
          })
          .catch((err) =>
            console.warn(
              `[pipeline] cache.put failed for ${job.caseNumber}:${job.promptId}:`,
              (err as Error).message,
            ),
          );
      }

      notify({
        type: "prompt_done",
        run: {
          ...run,
          sessionId: r.sessionId,
          status: "ok",
          markdown: r.markdown,
          durationMs: r.durationMs,
          source: "fresh",
          caseStatus: status,
        },
      });
    } catch (err) {
      promptsFailed++;
      const message = (err as Error).message;
      (perCase[job.caseNumber].errors ??= []).push(
        `${job.promptId}: ${message}`,
      );
      notify({
        type: "prompt_done",
        run: { ...run, status: "error", error: message, source: "fresh" },
      });
    }
  });

  notify({ type: "phase_done", phase: "per-case" });

  // ----- Phase B: account-support-health (batched if needed) ---------
  notify({ type: "phase_start", phase: "account-health" });

  const accountHealth: CaseIntelligence["accountHealth"] = [];
  const batches =
    cases.length <= BATCH_THRESHOLD
      ? [cases]
      : chunk(cases, MAX_CASES_PER_HEALTH_BATCH);

  for (let i = 0; i < batches.length; i++) {
    const batchLabel =
      batches.length === 1 ? "all" : `batch ${i + 1}/${batches.length}`;
    const run: PromptRun = {
      promptId: "account-support-health",
      sessionId: "",
      status: "running",
      batchLabel,
    };
    notify({ type: "prompt_start", run });
    try {
      const r = await runAccountHealth(
        batches[i],
        accountName,
        userEmail,
        batchLabel.replace(/\s+/g, "-"),
      );
      promptsRun++;
      accountHealth.push({ label: batchLabel, markdown: r.markdown });
      notify({
        type: "prompt_done",
        run: {
          ...run,
          sessionId: r.sessionId,
          status: "ok",
          markdown: r.markdown,
          durationMs: r.durationMs,
        },
      });
    } catch (err) {
      promptsFailed++;
      const message = (err as Error).message;
      accountHealth.push({ label: batchLabel, markdown: "", error: message });
      notify({
        type: "prompt_done",
        run: { ...run, status: "error", error: message },
      });
    }
  }

  notify({ type: "phase_done", phase: "account-health" });

  const intelligence: CaseIntelligence = {
    cases,
    accountName,
    perCase,
    accountHealth,
    stats: {
      caseCount: cases.length,
      promptsRun,
      promptsFailed,
      durationMs: Date.now() - started,
    },
  };

  // Expose reuse count for observability — stuffed into stats until we
  // formalize a wider shape.
  (intelligence.stats as unknown as { promptsReused?: number }).promptsReused =
    promptsReused;

  notify({ type: "final", intelligence });
  return intelligence;
}

// -------------------------- artifact serialization -----------------------

/**
 * Shape the pipeline output into a single `GatheredArtifact` that can be
 * persisted alongside Glean artifacts and rendered by the final-synthesis
 * prompt. Using the existing artifact system lets the rest of the pipeline
 * (report cache, MongoDB persistence, final prompt) stay untouched.
 */
export function intelligenceToArtifact(
  intel: CaseIntelligence,
): GatheredArtifact {
  return {
    source: "auto-triage",
    kind: "case-intelligence",
    label: "Auto Triage case intelligence",
    data: intel,
  };
}
