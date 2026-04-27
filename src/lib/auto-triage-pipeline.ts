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
import {
  isAccountHealthFresh,
  type AccountHealthCache,
} from "./account-health-cache";

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
  /** Optional account-health cache. When provided, the pipeline reuses
   *  account-support-health output younger than 7 days for the same
   *  (salesforceId, batchLabel) instead of hitting the Hub. */
  accountHealthCache?: AccountHealthCache;
  /** When true, ignore cache hits and re-fetch every (case, prompt) from
   *  Hub. Write-back still happens so the new results become the cache. */
  forceRefresh?: boolean;
}

// -------------------------- case-number extraction -----------------------

/**
 * Ask the Auto Triage bot to list every case for an account. Returns a
 * de-duplicated, sorted list of 8-digit case numbers. Returns an empty
 * array on any failure — the caller is expected to union with the
 * Glean-extracted list, so a bot outage is not fatal.
 *
 * The prompt forces a single fenced JSON block; this parser is
 * intentionally forgiving (handles `"cases": [...]`, finds the first JSON
 * object with a `cases` array, and also falls back to scraping bare
 * 8-digit numbers if the bot went off-script).
 */
export async function discoverCasesViaBot(opts: {
  accountName: string;
  salesforceId: string | undefined;
  timeframeMonths: number;
  userEmail: string;
}): Promise<{ cases: string[]; reason: string | null; raw: string }> {
  const input = renderPrompt("discover-account-cases", {
    "account-name": opts.accountName,
    "salesforce-id": opts.salesforceId ?? "(not provided)",
    "timeframe-months": String(opts.timeframeMonths),
  });
  const sessionId = generateSessionId(opts.userEmail, "discover-cases");
  try {
    const r = await callAutoTriage({
      input,
      sessionId,
      pathname: "/",
      label: `Discover cases: ${opts.accountName}`,
    });
    return parseBotCaseList(r.text);
  } catch (err) {
    return { cases: [], reason: (err as Error).message, raw: "" };
  }
}

/** Parse `{"cases": ["...", ...], "reason"?: "..."}` out of a bot reply. */
export function parseBotCaseList(text: string): {
  cases: string[];
  reason: string | null;
  raw: string;
} {
  const out = { cases: [] as string[], reason: null as string | null, raw: text };
  if (!text) return out;

  // Try explicit JSON parse — prefer the first `{...}` block that contains
  // a "cases" key.
  const jsonCandidates: string[] = [];
  // Fenced ```json ... ``` first
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/gi) ?? [];
  for (const f of fenced) {
    jsonCandidates.push(f.replace(/```(?:json)?\s*|\s*```$/gi, ""));
  }
  // Any raw `{...}` containing "cases"
  const rawObj = text.match(/\{[\s\S]*?"cases"[\s\S]*?\}/);
  if (rawObj) jsonCandidates.push(rawObj[0]);

  for (const candidate of jsonCandidates) {
    try {
      const parsed = JSON.parse(candidate.trim()) as {
        cases?: unknown;
        reason?: unknown;
      };
      if (Array.isArray(parsed.cases)) {
        const nums = parsed.cases
          .filter((v): v is string => typeof v === "string")
          .filter((s) => /^0\d{7}$/.test(s));
        if (nums.length > 0 || typeof parsed.reason === "string") {
          out.cases = [...new Set(nums)].sort();
          if (typeof parsed.reason === "string") out.reason = parsed.reason;
          return out;
        }
      }
    } catch {
      /* try next */
    }
  }

  // Last-ditch: scrape bare 8-digit 0-leading numbers from the body. The
  // prompt tries hard to keep the bot on the JSON path, but this catches
  // well-formed but un-JSON'd replies.
  const bare = [...text.matchAll(/\b(0\d{7})\b/g)].map((m) => m[1]);
  out.cases = [...new Set(bare)].sort();
  return out;
}

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
    // Bare 8-digit case numbers (distinctive 0-prefixed Hub shape). Catches
    // numbers in comma-separated lists and table cells where the word "Case"
    // isn't immediately adjacent — common in Glean chat answers.
    const bareRe = /\b(0\d{7})\b/g;
    while ((m = bareRe.exec(text)) !== null) found.add(m[1]);
  }
  return [...found].filter((c) => CASE_NUMBER_RE.test(c)).sort();
}

// -------------------------------- phase A --------------------------------

/**
 * Split the merged `case-analysis` response into the two sub-outputs that
 * the cache's `summary` and `precedents` slots expect.
 *
 * The prompt enforces `## Case Summary` and `## Precedent Research` H2
 * headings and a final `**Closed: Yes|No**` tag. Appends the closed tag
 * to BOTH halves so status inference works on either slot independently.
 */
export function splitCaseAnalysis(text: string): {
  summary: string;
  precedents: string;
} {
  // Pull the closed-tag line off the end so we can re-append it to each half.
  const closedTagRe = /\*{0,2}\s*closed[\s*:]+(yes|no)\b[^\n]*$/gim;
  let closedLine = "";
  const closedMatches = [...text.matchAll(closedTagRe)];
  if (closedMatches.length > 0) {
    closedLine = closedMatches[closedMatches.length - 1][0].trim();
  }

  // Find the Precedent Research H2 header — case-insensitive, tolerant of
  // trailing punctuation.
  const precedentHeaderRe = /^##\s*precedent[s]?[^\n]*$/im;
  const m = text.match(precedentHeaderRe);
  if (!m || m.index === undefined) {
    // Fallback — no clear split. Put the whole thing in summary, leave
    // precedents empty so the caller can downgrade gracefully.
    return { summary: text.trim(), precedents: "" };
  }
  const summaryBody = text.slice(0, m.index).trim();
  const precedentsBody = text.slice(m.index).trim();

  const appendClosed = (body: string): string => {
    if (!closedLine) return body;
    // Don't double-append if the tag is already in this half.
    if (/\*{0,2}\s*closed[\s*:]+(yes|no)/i.test(body)) return body;
    return `${body}\n\n${closedLine}`;
  };

  return {
    summary: appendClosed(summaryBody),
    precedents: appendClosed(precedentsBody),
  };
}

/**
 * Merged per-case call — runs `case-analysis` (summary + precedents in one
 * prompt) and returns the split outputs. Used instead of two separate
 * `runPromptForCase` calls when both slots of a case need fetching.
 */
async function runMergedCaseAnalysis(
  caseNumber: string,
  userEmail: string,
): Promise<{
  summary: string;
  precedents: string;
  sessionId: string;
  durationMs: number;
}> {
  const input = renderPrompt("case-analysis", { "case-number": caseNumber });
  const sessionId = generateSessionId(userEmail, `case-analysis-${caseNumber}`);
  const started = Date.now();
  const res = await callAutoTriage({
    input,
    sessionId,
    pathname: `/case/${caseNumber}`,
    label: `Case: ${caseNumber}`,
  });
  if (!res.text.trim()) {
    throw new Error(
      `Empty response (${res.eventCount} SSE events) from case-analysis for case ${caseNumber}`,
    );
  }
  const { summary, precedents } = splitCaseAnalysis(res.text);
  return {
    summary,
    precedents,
    sessionId,
    durationMs: Date.now() - started,
  };
}

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
    accountHealthCache,
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

  // Cache pre-flight: decide which keys to fetch vs reuse.
  //
  // Policy (updated):
  //   - If a case's (summary or precedents) slot exists in the cache,
  //     REUSE IT regardless of status (closed/open/unknown) or age. The
  //     user's mental model is: "we already have the data, there's no
  //     point hitting the Hub again." Force-refresh does NOT invalidate
  //     per-case slots — its job is to bring in newly-surfaced cases and
  //     refresh account-health, not to re-fetch data we already have.
  //   - If a slot is missing (never fetched, or only one of the two
  //     prompts was cached), fetch it.
  //
  // Net effect on a force-refresh over 10 cases where 7 are already cached:
  //   → 0 Hub calls for the 7 cached cases (both prompts reused)
  //   → 6 Hub calls for the 3 new cases (summary + precedents each)
  //   → 1 fresh Hub call for account-health (that cache is always bypassed
  //     on force-refresh; see the Phase-B loop).
  let decisions: JobDecision[];
  if (cache) {
    const scan = await scanCache(cache, keys);
    // Upgrade ANY fetch-with-cached-slot (scan's "stale-open" /
    // "unknown-status-stale" fetches) back to reuse — we don't want
    // freshness-based re-fetches either; cached is cached.
    decisions = scan.decisions.map((d) => {
      if (d.decision === "reuse") return d;
      if (d.cachedSlot) {
        return { ...d, decision: "reuse", reason: undefined };
      }
      return d;
    });
    // Diagnostic: dump per-(case,prompt) decision to the server log so we
    // can tell why a case that "should be cached" ended up fetched.
    // Compact one-liner keyed by salesforceId for grep-ability.
    console.log(
      `[cache-scan] sfId=${salesforceId ?? "?"} cases=${cases.length} decisions:`,
      decisions
        .map(
          (d) =>
            `${d.caseNumber}/${d.promptId === "case-summary" ? "sum" : "prec"}=${d.decision}${d.reason ? `(${d.reason})` : ""}`,
        )
        .join(" "),
    );
    const counts = {
      hit: decisions.filter((d) => d.decision === "reuse").length,
      miss: decisions.filter(
        (d) => d.decision === "fetch" && d.reason === "miss",
      ).length,
      // `staleRefresh` would only be non-zero if a cached-slot-missing doc
      // existed, which can't happen after the upgrade above. Kept at 0 so
      // the UI contract stays stable.
      staleRefresh: 0,
    };
    notify({ type: "cache_scan", cacheCounts: counts });
  } else {
    decisions = keys.map((k) => ({ ...k, decision: "fetch", reason: "miss" }));
  }

  // Group decisions by case so we can coalesce "both slots need fetch" into
  // a single merged Hub call (case-analysis prompt). Mixed cases (one slot
  // cached, one slot missing — rare) fall back to the single-prompt path
  // for the missing one.
  type CaseJob = {
    caseNumber: string;
    summary?: JobDecision;
    precedents?: JobDecision;
  };
  const perCaseJobs = new Map<string, CaseJob>();
  for (const d of decisions) {
    const job = perCaseJobs.get(d.caseNumber) ?? {
      caseNumber: d.caseNumber,
    };
    if (d.promptId === "case-summary") job.summary = d;
    else job.precedents = d;
    perCaseJobs.set(d.caseNumber, job);
  }

  /** Emit prompt_start + prompt_done for a single cached slot. */
  const emitReuse = (d: JobDecision) => {
    const run: PromptRun = {
      promptId: d.promptId,
      sessionId: d.cachedSlot?.sessionId ?? "",
      status: "running",
      caseNumber: d.caseNumber,
    };
    notify({ type: "prompt_start", run: { ...run, source: "cached" } });
    const slot = d.cachedSlot!;
    const doc = d.cachedDoc!;
    if (d.promptId === "case-summary") {
      perCase[d.caseNumber].summary = slot.markdown;
    } else {
      perCase[d.caseNumber].precedents = slot.markdown;
    }
    promptsReused++;
    if (cache) cache.touch(doc.caseNumber, d.promptId).catch(() => {});
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
  };

  /** Fallback — fetch a single slot via the legacy per-prompt path. */
  const fetchSingle = async (d: JobDecision) => {
    const run: PromptRun = {
      promptId: d.promptId,
      sessionId: "",
      status: "running",
      caseNumber: d.caseNumber,
    };
    notify({ type: "prompt_start", run: { ...run, source: "fresh" } });
    try {
      const r = await runPromptForCase(
        d.promptId,
        d.caseNumber,
        userEmail,
      );
      promptsRun++;
      const status = inferStatusFromMarkdown(r.markdown);
      if (d.promptId === "case-summary") {
        perCase[d.caseNumber].summary = r.markdown;
      } else {
        perCase[d.caseNumber].precedents = r.markdown;
      }
      if (cache) {
        cache
          .put({
            caseNumber: d.caseNumber,
            promptId: d.promptId,
            salesforceId,
            accountName,
            markdown: r.markdown,
            sessionId: r.sessionId,
            status,
          })
          .catch(() => {});
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
      (perCase[d.caseNumber].errors ??= []).push(`${d.promptId}: ${message}`);
      notify({
        type: "prompt_done",
        run: { ...run, status: "error", error: message, source: "fresh" },
      });
    }
  };

  await pMapSettled(
    [...perCaseJobs.values()],
    concurrency,
    async (job) => {
      const s = job.summary;
      const p = job.precedents;
      const summaryReuse = s && s.decision === "reuse";
      const precedentsReuse = p && p.decision === "reuse";
      const summaryFetch = s && s.decision === "fetch";
      const precedentsFetch = p && p.decision === "fetch";

      // Case A: both slots cached — 2 reuse events, no Hub call.
      if (summaryReuse && precedentsReuse) {
        emitReuse(s);
        emitReuse(p);
        return;
      }

      // Case B: both slots need fetching — ONE merged Hub call.
      if (summaryFetch && precedentsFetch) {
        const summaryRun: PromptRun = {
          promptId: "case-summary",
          sessionId: "",
          status: "running",
          caseNumber: job.caseNumber,
        };
        const precedentsRun: PromptRun = {
          promptId: "precedent-research",
          sessionId: "",
          status: "running",
          caseNumber: job.caseNumber,
        };
        notify({ type: "prompt_start", run: { ...summaryRun, source: "fresh" } });
        notify({ type: "prompt_start", run: { ...precedentsRun, source: "fresh" } });
        try {
          const merged = await runMergedCaseAnalysis(job.caseNumber, userEmail);
          // `promptsRun` represents Hub round-trips, so count the merged
          // call ONCE even though it populates two slots.
          promptsRun++;
          // Status is parsed from the combined response (either half carries
          // the closed tag because splitCaseAnalysis appends it to both).
          const status = inferStatusFromMarkdown(
            `${merged.summary}\n\n${merged.precedents}`,
          );
          perCase[job.caseNumber].summary = merged.summary;
          perCase[job.caseNumber].precedents = merged.precedents;
          if (cache) {
            // Write both slots with the same sessionId so downstream
            // status inference + analytics attribute them together.
            cache
              .put({
                caseNumber: job.caseNumber,
                promptId: "case-summary",
                salesforceId,
                accountName,
                markdown: merged.summary,
                sessionId: merged.sessionId,
                status,
              })
              .catch(() => {});
            cache
              .put({
                caseNumber: job.caseNumber,
                promptId: "precedent-research",
                salesforceId,
                accountName,
                markdown: merged.precedents,
                sessionId: merged.sessionId,
                status,
              })
              .catch(() => {});
          }
          notify({
            type: "prompt_done",
            run: {
              ...summaryRun,
              sessionId: merged.sessionId,
              status: "ok",
              markdown: merged.summary,
              durationMs: merged.durationMs,
              source: "fresh",
              caseStatus: status,
            },
          });
          notify({
            type: "prompt_done",
            run: {
              ...precedentsRun,
              sessionId: merged.sessionId,
              status: "ok",
              markdown: merged.precedents,
              durationMs: merged.durationMs,
              source: "fresh",
              caseStatus: status,
            },
          });
        } catch (err) {
          promptsFailed += 2;
          const message = (err as Error).message;
          (perCase[job.caseNumber].errors ??= []).push(
            `case-analysis: ${message}`,
          );
          notify({
            type: "prompt_done",
            run: { ...summaryRun, status: "error", error: message, source: "fresh" },
          });
          notify({
            type: "prompt_done",
            run: { ...precedentsRun, status: "error", error: message, source: "fresh" },
          });
        }
        return;
      }

      // Case C (rare mixed case): one slot cached, one slot missing. Fall
      // back to the legacy per-prompt path for each slot independently.
      if (s) {
        if (s.decision === "reuse") emitReuse(s);
        else await fetchSingle(s);
      }
      if (p) {
        if (p.decision === "reuse") emitReuse(p);
        else await fetchSingle(p);
      }
    },
  );

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

    // Cache read — 7-day freshness window. Skip when forceRefresh is set.
    if (!forceRefresh && accountHealthCache && salesforceId) {
      const cached = await accountHealthCache.get(salesforceId, batchLabel);
      if (isAccountHealthFresh(cached)) {
        notify({ type: "prompt_start", run: { ...run, source: "cached" } });
        accountHealth.push({ label: batchLabel, markdown: cached!.markdown });
        promptsReused++;
        // Best-effort touch for analytics; swallow errors.
        accountHealthCache.touch(salesforceId, batchLabel).catch(() => {});
        notify({
          type: "prompt_done",
          run: {
            ...run,
            sessionId: cached!.sessionId,
            status: "ok",
            markdown: cached!.markdown,
            source: "cached",
          },
        });
        continue;
      }
    }

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
      // Write-back — independent of forceRefresh so a fresh run always
      // updates the cache with the latest output.
      if (accountHealthCache && salesforceId) {
        accountHealthCache
          .put({
            salesforceId,
            label: batchLabel,
            accountName,
            cases: batches[i],
            markdown: r.markdown,
            sessionId: r.sessionId,
          })
          .catch(() => {});
      }
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
