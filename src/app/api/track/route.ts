/**
 * POST /api/track — fire-and-forget usage event collector.
 *
 * Body: { event, account?, salesforceId?, userId?, metadata? }
 * Writes to the `events` MongoDB collection, additionally stamped with:
 *   - ts: ISO timestamp (string) for backwards-compatible queries
 *   - tsDate: Date — TTL anchor (1-year eviction, matches case-intel policy)
 *   - userEmail: resolved from the Kanopy JWT on the server so the global
 *     admin view can attribute events to real people, even though the
 *     browser-side track() only knows an opaque uid.
 *
 * GET: list events, newest first. Supports ?account=, ?since=<ISO>, ?limit=.
 */
import { NextResponse } from "next/server";
import { getCollection, getDb } from "@/lib/mongo";
import { getUserEmail } from "@/lib/auto-triage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface TrackEvent {
  event: string;
  account?: string;
  salesforceId?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}

interface StoredEvent extends TrackEvent {
  ts: string;
  tsDate: Date;
  userEmail?: string;
}

const EVENTS_TTL_SECONDS = 365 * 24 * 60 * 60; // 1 year

let _indexesEnsured = false;
async function ensureIndexes() {
  if (_indexesEnsured) return;
  try {
    const col = await getCollection<StoredEvent>("events");
    await col.createIndex(
      { tsDate: 1 },
      { expireAfterSeconds: EVENTS_TTL_SECONDS, name: "ttl_tsDate" },
    );
    await col.createIndex({ event: 1, tsDate: -1 }, { name: "event_ts" });
    await col.createIndex({ account: 1, tsDate: -1 }, { name: "account_ts" });
    _indexesEnsured = true;
  } catch (err) {
    console.warn("[track] ensureIndexes failed:", (err as Error).message);
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as TrackEvent;
    if (!body.event) {
      return NextResponse.json({ ok: false, error: "Missing event" }, { status: 400 });
    }
    await ensureIndexes();
    // Resolve user email server-side; falls back gracefully if token missing.
    let userEmail: string | undefined;
    try {
      userEmail = await getUserEmail();
    } catch {
      /* ignore — a stale token shouldn't break tracking */
    }
    const now = new Date();
    const doc: StoredEvent = {
      ...body,
      ts: now.toISOString(),
      tsDate: now,
      ...(userEmail ? { userEmail } : {}),
    };
    const db = await getDb();
    await db.collection("events").insertOne(doc);
    return NextResponse.json({ ok: true });
  } catch {
    // Tracking must never break the caller — swallow errors silently
    return NextResponse.json({ ok: true });
  }
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? "500"), 5000);
    const account = url.searchParams.get("account");
    const since = url.searchParams.get("since");
    const filter: Record<string, unknown> = {};
    if (account) filter.account = account;
    if (since) {
      const sinceDate = new Date(since);
      if (!isNaN(sinceDate.getTime())) {
        filter.tsDate = { $gte: sinceDate };
      }
    }
    const db = await getDb();
    const events = await db
      .collection("events")
      .find(filter)
      .sort({ tsDate: -1 })
      .limit(limit)
      .toArray();
    return NextResponse.json({ ok: true, events });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}
