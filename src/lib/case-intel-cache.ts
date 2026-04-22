/**
 * Case intelligence cache — one document per case, with `summary` and
 * `precedents` as independent sub-fields. Keyed by caseNumber so a single
 * `find({ _id: { $in: [...cases] } })` resolves the whole report's case
 * list in one round-trip.
 *
 * Freshness is per sub-field, but driven by a doc-level `status` that
 * comes from the most recent case-summary run:
 *   - status == closed            → any present sub-field is reusable
 *   - status == open, age < 7d    → reusable
 *   - status == open, age >= 7d   → refresh
 *   - status == unknown           → treat as open
 *   - sub-field absent            → fetch
 *
 * Eviction: TTL index on `lastWriteAt` (1 year). Every write bumps
 * `lastWriteAt` so a doc evicts only after it has sat cold for a full year.
 *
 * The pipeline takes a `CaseIntelCache` adapter — tests can inject an
 * in-memory stub instead of MongoDB.
 */

import type { Collection } from "mongodb";
import { getCollection } from "./mongo";

export type CaseStatus = "closed" | "open" | "unknown";
export type CachedPromptId = "case-summary" | "precedent-research";

/** One sub-field payload inside a case doc. */
export interface PromptSlot {
  markdown: string;
  sessionId: string;
  fetchedAt: Date;
  lastReusedAt?: Date;
}

/** One document per case. */
export interface CachedCaseAnalysis {
  _id: string; // caseNumber
  salesforceId?: string;
  accountName?: string;
  caseNumber: string;
  status: CaseStatus;
  summary?: PromptSlot;
  precedents?: PromptSlot;
  lastWriteAt: Date;
}

export interface CacheKey {
  caseNumber: string;
  promptId: CachedPromptId;
}

/** Write payload — identifies which sub-field to upsert. */
export interface CachePutInput {
  caseNumber: string;
  promptId: CachedPromptId;
  salesforceId?: string;
  accountName?: string;
  markdown: string;
  sessionId: string;
  status: CaseStatus;
}

export interface CaseIntelCache {
  /** Fetch one doc per case in a single round-trip. Missing cases are
   *  simply absent from the returned Map. */
  getMany(caseNumbers: string[]): Promise<Map<string, CachedCaseAnalysis>>;
  /** Upsert one prompt sub-field into the case doc. */
  put(input: CachePutInput): Promise<void>;
  /** Bump lastReusedAt on the specified prompt slot for analytics. */
  touch(caseNumber: string, promptId: CachedPromptId): Promise<void>;
}

// ---------------------- freshness + status helpers -----------------------

/** 7 days in ms — open-case refresh window. */
export const OPEN_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Given a case doc and a prompt slot, is the cached sub-field still
 * within policy? Missing slot → not fresh. `now` injectable for tests.
 */
export function isSlotFresh(
  doc: CachedCaseAnalysis | undefined,
  promptId: CachedPromptId,
  now = Date.now(),
): boolean {
  if (!doc) return false;
  const slot = promptId === "case-summary" ? doc.summary : doc.precedents;
  if (!slot) return false;
  if (doc.status === "closed") return true;
  const age = now - slot.fetchedAt.getTime();
  return age < OPEN_REFRESH_MS;
}

/**
 * Parse the explicit `**Closed: Yes/No**` tag the prompt asks the bot to
 * emit at the end of its output. Tolerant of whitespace/asterisk variants:
 *   **Closed: Yes**    **Closed:** Yes    **Closed**: Yes    (etc.)
 * Takes the LAST match — the prompt asks for the tag as the final line.
 * Falls back to inspecting an inline `Current Status:` line; "unknown" on miss.
 */
export function inferStatusFromMarkdown(md: string): CaseStatus {
  if (!md) return "unknown";
  const re = /\*{0,2}\s*closed[\s*:]+(yes|no)\b/gi;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) last = m;
  if (last) return last[1].toLowerCase() === "yes" ? "closed" : "open";

  const statusLine = md.match(/current status[:*\s]+([^\n]+)/i);
  if (statusLine) {
    const line = statusLine[1].toLowerCase();
    if (/\b(closed|resolved|won|customer confirmed)\b/.test(line)) return "closed";
    if (/\b(open|waiting|in progress|on hold|awaiting)\b/.test(line)) return "open";
  }
  return "unknown";
}

// --------------------------- MongoDB adapter -----------------------------

const COLLECTION = "case_intelligence";
const TTL_SECONDS = 365 * 24 * 60 * 60; // 1 year

let _indexesEnsured = false;

async function ensureIndexes(
  col: Collection<CachedCaseAnalysis>,
): Promise<void> {
  if (_indexesEnsured) return;
  try {
    await col.createIndex(
      { lastWriteAt: 1 },
      { expireAfterSeconds: TTL_SECONDS, name: "ttl_lastWriteAt" },
    );
    await col.createIndex(
      { salesforceId: 1, caseNumber: 1 },
      { name: "sfId_case" },
    );
    _indexesEnsured = true;
  } catch (err) {
    // Index creation is best-effort — a permission failure shouldn't kill
    // the pipeline. Cache just won't auto-evict.
    console.warn("[case-intel-cache] ensureIndexes failed:", (err as Error).message);
  }
}

export function createMongoCaseIntelCache(): CaseIntelCache {
  return {
    async getMany(caseNumbers: string[]) {
      if (caseNumbers.length === 0) return new Map();
      const col = await getCollection<CachedCaseAnalysis>(COLLECTION);
      await ensureIndexes(col);
      const rows = await col.find({ _id: { $in: caseNumbers } }).toArray();
      const out = new Map<string, CachedCaseAnalysis>();
      for (const r of rows) out.set(r._id, r);
      return out;
    },

    async put(input: CachePutInput) {
      const col = await getCollection<CachedCaseAnalysis>(COLLECTION);
      await ensureIndexes(col);
      const now = new Date();
      const slot: PromptSlot = {
        markdown: input.markdown,
        sessionId: input.sessionId,
        fetchedAt: now,
      };
      // Only overwrite account/salesforceId when the caller provides them;
      // never clobber with undefined on a repeat write for a different run.
      const setOnInsert: Partial<CachedCaseAnalysis> = {
        _id: input.caseNumber,
        caseNumber: input.caseNumber,
      };
      const set: Record<string, unknown> = {
        lastWriteAt: now,
        status: input.status,
      };
      if (input.promptId === "case-summary") set.summary = slot;
      else set.precedents = slot;
      if (input.salesforceId) set.salesforceId = input.salesforceId;
      if (input.accountName) set.accountName = input.accountName;

      await col.updateOne(
        { _id: input.caseNumber },
        { $set: set, $setOnInsert: setOnInsert },
        { upsert: true },
      );
    },

    async touch(caseNumber: string, promptId: CachedPromptId) {
      const col = await getCollection<CachedCaseAnalysis>(COLLECTION);
      const path =
        promptId === "case-summary"
          ? "summary.lastReusedAt"
          : "precedents.lastReusedAt";
      await col.updateOne(
        { _id: caseNumber },
        { $set: { [path]: new Date() } },
      );
    },
  };
}

// ----------------------- pre-flight decision helper ----------------------

export interface JobDecision {
  caseNumber: string;
  promptId: CachedPromptId;
  decision: "fetch" | "reuse";
  /** Cached slot if reusing, present doc if refreshing. */
  cachedSlot?: PromptSlot;
  cachedDoc?: CachedCaseAnalysis;
  reason?: "miss" | "slot-missing" | "stale-open" | "unknown-status-stale";
}

export interface CacheScanResult {
  decisions: JobDecision[];
  counts: {
    hit: number;
    miss: number;
    staleRefresh: number;
  };
}

/**
 * Given every (case, prompt) pair we plan to run, consult the cache and
 * label each pair as `fetch` or `reuse`. Batches all reads into a single
 * `getMany()` (one DB round-trip regardless of case count).
 */
export async function scanCache(
  cache: CaseIntelCache,
  keys: CacheKey[],
  now = Date.now(),
): Promise<CacheScanResult> {
  const uniqueCases = [...new Set(keys.map((k) => k.caseNumber))];
  const docs = await cache.getMany(uniqueCases);

  const decisions: JobDecision[] = [];
  let hit = 0;
  let miss = 0;
  let staleRefresh = 0;

  for (const k of keys) {
    const doc = docs.get(k.caseNumber);
    if (!doc) {
      decisions.push({ ...k, decision: "fetch", reason: "miss" });
      miss++;
      continue;
    }
    const slot = k.promptId === "case-summary" ? doc.summary : doc.precedents;
    if (!slot) {
      decisions.push({
        ...k,
        decision: "fetch",
        cachedDoc: doc,
        reason: "slot-missing",
      });
      miss++;
      continue;
    }
    if (isSlotFresh(doc, k.promptId, now)) {
      decisions.push({
        ...k,
        decision: "reuse",
        cachedSlot: slot,
        cachedDoc: doc,
      });
      hit++;
      continue;
    }
    decisions.push({
      ...k,
      decision: "fetch",
      cachedDoc: doc,
      cachedSlot: slot,
      reason: doc.status === "unknown" ? "unknown-status-stale" : "stale-open",
    });
    staleRefresh++;
  }

  return { decisions, counts: { hit, miss, staleRefresh } };
}
