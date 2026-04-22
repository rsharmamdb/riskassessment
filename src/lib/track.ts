/**
 * Client-side usage tracking helper.
 * Fire-and-forget — never throws, never blocks the caller.
 */

export interface TrackPayload {
  event: string;
  account?: string;
  salesforceId?: string;
  metadata?: Record<string, unknown>;
}

/** Stable anonymous user ID persisted in localStorage. */
function getUserId(): string {
  if (typeof window === "undefined") return "server";
  const key = "risksi_uid";
  let uid = localStorage.getItem(key);
  if (!uid) {
    uid = `u_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
    localStorage.setItem(key, uid);
  }
  return uid;
}

export function track(payload: TrackPayload): void {
  try {
    fetch("/api/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, userId: getUserId() }),
    }).catch(() => {/* silent */});
  } catch {
    /* silent */
  }
}
