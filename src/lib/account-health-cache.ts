/**
 * Account-health cache — persists the `account-support-health` prompt
 * output per `(salesforceId, batchLabel)` with a 7-day TTL on reuse.
 *
 * Unlike the per-case cache (which keys on case number and has a closed-case
 * "forever fresh" rule), account-health summaries are about *account-level*
 * patterns that don't swing week-to-week. Re-running the same Hub prompt
 * daily produces near-identical output and wastes Hub round-trips, so we
 * reuse any entry younger than 7 days.
 *
 * Key shape: one document per `(salesforceId, label)` where `label` is
 * the pipeline's batchLabel — "all" when cases fit in one batch (<=10),
 * or "batch 1/N" / "batch 2/N" etc. for longer lists. A case-count change
 * alone does NOT invalidate the cached entry (the user's stated intent is
 * to save cost: "nothing major will change"). Reviewers can click Regenerate
 * / Force re-fetch to bypass.
 */

import type { Collection } from "mongodb";
import { getCollection } from "./mongo";

/** 7 days — reuse window for account-health summaries. */
export const ACCOUNT_HEALTH_FRESH_MS = 7 * 24 * 60 * 60 * 1000;

export interface CachedAccountHealth {
  _id: string; // `${salesforceId}::${label}`
  salesforceId: string;
  label: string; // batchLabel, e.g. "all", "batch 1/2"
  accountName?: string;
  cases: string[]; // the case list covered by this batch — for diagnostics only
  markdown: string;
  sessionId: string;
  fetchedAt: Date;
  lastReusedAt?: Date;
}

export interface AccountHealthCache {
  get(
    salesforceId: string,
    label: string,
  ): Promise<CachedAccountHealth | null>;
  put(input: {
    salesforceId: string;
    label: string;
    accountName?: string;
    cases: string[];
    markdown: string;
    sessionId: string;
  }): Promise<void>;
  touch(salesforceId: string, label: string): Promise<void>;
}

export function isAccountHealthFresh(
  entry: CachedAccountHealth | null | undefined,
  now = Date.now(),
): boolean {
  if (!entry) return false;
  return now - entry.fetchedAt.getTime() < ACCOUNT_HEALTH_FRESH_MS;
}

// --------------------------- MongoDB adapter -----------------------------

const COLLECTION = "account_health_cache";

let _indexesEnsured = false;
async function ensureIndexes(
  col: Collection<CachedAccountHealth>,
): Promise<void> {
  if (_indexesEnsured) return;
  try {
    await col.createIndex(
      { salesforceId: 1, label: 1 },
      { name: "sfId_label", unique: true },
    );
    _indexesEnsured = true;
  } catch (err) {
    console.warn(
      "[account-health-cache] ensureIndexes failed:",
      (err as Error).message,
    );
  }
}

const keyFor = (salesforceId: string, label: string): string =>
  `${salesforceId}::${label}`;

export function createMongoAccountHealthCache(): AccountHealthCache {
  return {
    async get(salesforceId: string, label: string) {
      const col = await getCollection<CachedAccountHealth>(COLLECTION);
      await ensureIndexes(col);
      return col.findOne({ salesforceId, label });
    },

    async put(input) {
      const col = await getCollection<CachedAccountHealth>(COLLECTION);
      await ensureIndexes(col);
      const now = new Date();
      await col.updateOne(
        { _id: keyFor(input.salesforceId, input.label) },
        {
          $set: {
            salesforceId: input.salesforceId,
            label: input.label,
            accountName: input.accountName,
            cases: input.cases,
            markdown: input.markdown,
            sessionId: input.sessionId,
            fetchedAt: now,
          },
          $setOnInsert: {
            _id: keyFor(input.salesforceId, input.label),
          },
        },
        { upsert: true },
      );
    },

    async touch(salesforceId: string, label: string) {
      const col = await getCollection<CachedAccountHealth>(COLLECTION);
      await ensureIndexes(col);
      await col.updateOne(
        { _id: keyFor(salesforceId, label) },
        { $set: { lastReusedAt: new Date() } },
      );
    },
  };
}
