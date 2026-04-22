"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Card, CardBody, CardHeader } from "@/components/ui";

interface EventDoc {
  _id?: string;
  event: string;
  account?: string;
  salesforceId?: string;
  userId?: string;
  userEmail?: string;
  metadata?: Record<string, unknown>;
  ts: string;
}

type Window = "30d" | "90d" | "all";

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string | number;
  sub?: string;
}) {
  return (
    <div
      className="border border-ink-700 bg-accent-900 px-4 py-3"
      style={{ borderRadius: "8px" }}
    >
      <div className="text-[22px] font-semibold tabular-nums text-ink-100">
        {value}
      </div>
      <div className="mt-1 text-[11px] text-ink-400">{label}</div>
      {sub && <div className="mt-0.5 text-[10px] text-ink-500">{sub}</div>}
    </div>
  );
}

const EVENT_LABELS: Record<string, string> = {
  account_opened: "Account opened",
  artifacts_gathered: "Artifacts gathered",
  triage_pipeline_run: "Auto Triage pipeline",
  report_generated: "Report generated (LLM)",
  report_viewed_cached: "Report viewed (cache)",
  report_page_viewed: "Report page viewed",
  report_downloaded_md: ".md downloaded",
  pdf_exported: "PDF exported",
  risk_status_changed: "Risk status changed",
  lgtm_approved: "LGTM approved",
};

/** Number of ms for a given window. `all` maps to Infinity. */
const windowMs = (w: Window) =>
  w === "30d" ? 30 * 86400_000 : w === "90d" ? 90 * 86400_000 : Infinity;

export default function UsagePage() {
  const [events, setEvents] = useState<EventDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [windowSel, setWindowSel] = useState<Window>("30d");

  useEffect(() => {
    setLoading(true);
    fetch("/api/track?limit=5000")
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) setEvents(j.events ?? []);
        else setError(j.error ?? "Failed to load");
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const cutoff = Date.now() - windowMs(windowSel);
    if (!isFinite(cutoff)) return events;
    return events.filter((e) => new Date(e.ts).getTime() >= cutoff);
  }, [events, windowSel]);

  // ---------- aggregate metrics ----------
  const total = filtered.length;
  const reportsGenerated = filtered.filter(
    (e) => e.event === "report_generated",
  ).length;
  const reportsViewed = filtered.filter(
    (e) => e.event === "report_page_viewed" || e.event === "report_viewed_cached",
  ).length;
  const pdfDownloads = filtered.filter((e) => e.event === "pdf_exported").length;
  const mdDownloads = filtered.filter(
    (e) => e.event === "report_downloaded_md",
  ).length;
  const uniqueAccounts = new Set(
    filtered.map((e) => e.account).filter(Boolean),
  ).size;
  const uniqueUsers = new Set(
    filtered.map((e) => e.userEmail || e.userId).filter(Boolean),
  ).size;

  // Auto Triage cache savings — the big new number from the cache layer.
  const triageRuns = filtered.filter((e) => e.event === "triage_pipeline_run");
  const triageCacheReused = triageRuns.reduce((sum, e) => {
    const m = e.metadata ?? {};
    const v = (m as { promptsReused?: number }).promptsReused ?? 0;
    return sum + v;
  }, 0);
  const triageCacheFetched = triageRuns.reduce((sum, e) => {
    const m = e.metadata ?? {};
    const v = (m as { promptsFetched?: number }).promptsFetched ?? 0;
    return sum + v;
  }, 0);
  const triageCachePct =
    triageCacheReused + triageCacheFetched > 0
      ? Math.round(
          (triageCacheReused / (triageCacheReused + triageCacheFetched)) * 100,
        )
      : null;

  // ---------- per-report table ----------
  interface AccountAgg {
    account: string;
    lastGenerated?: string;
    reports: number;
    views: number;
    pdfs: number;
    mds: number;
    triageRuns: number;
    triageReused: number;
    triageFetched: number;
  }
  const byAccount: Record<string, AccountAgg> = {};
  for (const e of filtered) {
    if (!e.account) continue;
    const a = (byAccount[e.account] ??= {
      account: e.account,
      reports: 0,
      views: 0,
      pdfs: 0,
      mds: 0,
      triageRuns: 0,
      triageReused: 0,
      triageFetched: 0,
    });
    if (e.event === "report_generated") {
      a.reports++;
      if (!a.lastGenerated || e.ts > a.lastGenerated) a.lastGenerated = e.ts;
    } else if (
      e.event === "report_page_viewed" ||
      e.event === "report_viewed_cached"
    ) {
      a.views++;
    } else if (e.event === "pdf_exported") {
      a.pdfs++;
    } else if (e.event === "report_downloaded_md") {
      a.mds++;
    } else if (e.event === "triage_pipeline_run") {
      a.triageRuns++;
      const m = (e.metadata ?? {}) as {
        promptsReused?: number;
        promptsFetched?: number;
      };
      a.triageReused += m.promptsReused ?? 0;
      a.triageFetched += m.promptsFetched ?? 0;
    }
  }
  const accountRows = Object.values(byAccount).sort((a, b) => {
    if (a.lastGenerated && b.lastGenerated) {
      return b.lastGenerated.localeCompare(a.lastGenerated);
    }
    if (a.lastGenerated) return -1;
    if (b.lastGenerated) return 1;
    return b.reports + b.views - (a.reports + a.views);
  });

  // ---------- 30-day daily trend ----------
  const dailyReports = useMemo(() => {
    const bucket: Record<string, number> = {};
    const cutoff = Date.now() - 30 * 86400_000;
    for (const e of events) {
      if (e.event !== "report_generated") continue;
      const t = new Date(e.ts).getTime();
      if (t < cutoff) continue;
      const k = new Date(e.ts).toISOString().slice(0, 10);
      bucket[k] = (bucket[k] ?? 0) + 1;
    }
    const days: { date: string; count: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
      days.push({ date: d, count: bucket[d] ?? 0 });
    }
    return days;
  }, [events]);
  const maxDaily = Math.max(1, ...dailyReports.map((d) => d.count));

  // ---------- events-by-type ----------
  const byEvent = Object.entries(
    filtered.reduce<Record<string, number>>((acc, e) => {
      acc[e.event] = (acc[e.event] ?? 0) + 1;
      return acc;
    }, {}),
  ).sort((a, b) => b[1] - a[1]);

  // ---------- stale accounts (for planning) ----------
  const lastReportByAccount: Record<string, number> = {};
  for (const e of events) {
    if (e.event === "report_generated" && e.account) {
      const t = new Date(e.ts).getTime();
      if (!lastReportByAccount[e.account] || t > lastReportByAccount[e.account]) {
        lastReportByAccount[e.account] = t;
      }
    }
  }
  const staleCutoff = Date.now() - 30 * 86400_000;
  const staleAccounts = Object.entries(lastReportByAccount)
    .filter(([, t]) => t < staleCutoff)
    .map(([a]) => a)
    .sort();

  const recent = filtered.slice(0, 50);

  if (loading) {
    return (
      <div className="text-ink-400 text-sm py-16 text-center">
        Loading usage data…
      </div>
    );
  }
  if (error) {
    return (
      <div
        className="border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger"
        style={{ borderRadius: "8px" }}
      >
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-ink-100">
            Usage Dashboard
          </h1>
          <p className="mt-2 text-[13px] text-ink-400">
            Global view across all users · {uniqueUsers} unique{" "}
            {uniqueUsers === 1 ? "user" : "users"} · {uniqueAccounts} unique
            accounts
          </p>
        </div>
        <div className="flex gap-1 border border-ink-700 p-1" style={{ borderRadius: "8px" }}>
          {(["30d", "90d", "all"] as Window[]).map((w) => (
            <button
              key={w}
              onClick={() => setWindowSel(w)}
              className={`px-3 py-1 text-[12px] rounded transition-colors ${
                windowSel === w
                  ? "bg-accent-700 text-ink-100"
                  : "text-ink-400 hover:bg-accent-900"
              }`}
            >
              {w === "30d" ? "Last 30d" : w === "90d" ? "Last 90d" : "All time"}
            </button>
          ))}
        </div>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard label="Reports generated" value={reportsGenerated} />
        <StatCard label="Report views" value={reportsViewed} />
        <StatCard label="PDF downloads" value={pdfDownloads} />
        <StatCard label=".md downloads" value={mdDownloads} />
        <StatCard
          label="Triage calls saved"
          value={triageCacheReused}
          sub={triageCachePct !== null ? `${triageCachePct}% cache rate` : "—"}
        />
        <StatCard label="Total events" value={total} />
      </div>

      {/* 30-day trend */}
      <Card>
        <CardHeader
          title="Reports per day — last 30 days"
          subtitle={`${dailyReports.reduce((s, d) => s + d.count, 0)} reports over the window`}
        />
        <CardBody>
          <svg viewBox="0 0 620 120" className="w-full h-[120px]">
            {dailyReports.map((d, i) => {
              const x = (i * 620) / dailyReports.length;
              const w = 620 / dailyReports.length - 2;
              const h = d.count > 0 ? (d.count / maxDaily) * 100 : 0;
              const y = 100 - h;
              return (
                <g key={d.date}>
                  <rect
                    x={x}
                    y={y}
                    width={w}
                    height={h}
                    fill="#3B82F6"
                    opacity={d.count > 0 ? 0.9 : 0.15}
                    rx={2}
                  >
                    <title>{`${d.date}: ${d.count} report${d.count === 1 ? "" : "s"}`}</title>
                  </rect>
                </g>
              );
            })}
            {/* Axis labels: start, middle, end date */}
            <text x="0" y="116" fontSize="9" fill="#6B7280">
              {dailyReports[0]?.date.slice(5)}
            </text>
            <text x="300" y="116" fontSize="9" fill="#6B7280" textAnchor="middle">
              {dailyReports[15]?.date.slice(5)}
            </text>
            <text x="620" y="116" fontSize="9" fill="#6B7280" textAnchor="end">
              {dailyReports[29]?.date.slice(5)}
            </text>
          </svg>
        </CardBody>
      </Card>

      {/* Per-report table */}
      <Card>
        <CardHeader
          title="Per-account activity"
          subtitle={`${accountRows.length} account${accountRows.length === 1 ? "" : "s"} in window`}
        />
        <CardBody>
          {accountRows.length === 0 ? (
            <div className="text-ink-500 text-[13px]">No activity in window.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="border-b border-ink-700 text-ink-400">
                    <th className="text-left pb-2 pr-4">Account</th>
                    <th className="text-left pb-2 pr-4">Last generated</th>
                    <th className="text-right pb-2 pr-4">Reports</th>
                    <th className="text-right pb-2 pr-4">Views</th>
                    <th className="text-right pb-2 pr-4">PDF</th>
                    <th className="text-right pb-2 pr-4">.md</th>
                    <th className="text-right pb-2 pr-4">Triage runs</th>
                    <th className="text-right pb-2">Triage cache %</th>
                  </tr>
                </thead>
                <tbody>
                  {accountRows.map((a) => {
                    const total = a.triageReused + a.triageFetched;
                    const pct = total > 0 ? Math.round((a.triageReused / total) * 100) : null;
                    return (
                      <tr
                        key={a.account}
                        className="border-b border-ink-700/50 hover:bg-accent-900"
                      >
                        <td className="py-2 pr-4 text-ink-200">
                          <Link
                            href={`/reports/${encodeURIComponent(a.account)}`}
                            className="hover:text-accent-400"
                          >
                            {a.account}
                          </Link>
                        </td>
                        <td className="py-2 pr-4 text-ink-400 whitespace-nowrap">
                          {a.lastGenerated
                            ? new Date(a.lastGenerated).toLocaleDateString("en-US", {
                                month: "short",
                                day: "numeric",
                                year: "numeric",
                              })
                            : "—"}
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums text-ink-200">{a.reports}</td>
                        <td className="py-2 pr-4 text-right tabular-nums text-ink-200">{a.views}</td>
                        <td className="py-2 pr-4 text-right tabular-nums text-ink-300">{a.pdfs}</td>
                        <td className="py-2 pr-4 text-right tabular-nums text-ink-300">{a.mds}</td>
                        <td className="py-2 pr-4 text-right tabular-nums text-ink-300">{a.triageRuns}</td>
                        <td className="py-2 text-right tabular-nums text-ink-300">
                          {pct !== null ? `${pct}%` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Event breakdown */}
        <Card>
          <CardHeader title="Events by type" />
          <CardBody>
            <div className="space-y-2">
              {byEvent.length === 0 && <div className="text-ink-500 text-xs">No events.</div>}
              {byEvent.map(([evt, count]) => {
                const pct = total ? Math.round((count / total) * 100) : 0;
                return (
                  <div key={evt}>
                    <div className="flex justify-between text-[12px] mb-1">
                      <span className="text-ink-200">
                        {EVENT_LABELS[evt] ?? evt}
                      </span>
                      <span className="text-ink-400 tabular-nums">
                        {count} ({pct}%)
                      </span>
                    </div>
                    <div
                      className="w-full bg-ink-700 h-1"
                      style={{ borderRadius: "9999px" }}
                    >
                      <div
                        className="bg-accent-500 h-1"
                        style={{ width: `${pct}%`, borderRadius: "9999px" }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </CardBody>
        </Card>

        {/* Stale accounts */}
        <Card>
          <CardHeader
            title="No report in 30+ days"
            subtitle="(all-time, not filtered by window)"
          />
          <CardBody>
            {staleAccounts.length === 0 ? (
              <div className="text-success text-[13px]">
                All accounts have a report within the last 30 days ✓
              </div>
            ) : (
              <div className="space-y-1 max-h-[200px] overflow-y-auto">
                {staleAccounts.map((a) => (
                  <Link
                    key={a}
                    href={`/reports/${encodeURIComponent(a)}`}
                    className="flex items-center gap-2 text-[13px] hover:text-accent-400"
                  >
                    <span className="w-2 h-2 rounded-full bg-warn flex-shrink-0" />
                    <span className="text-ink-200">{a}</span>
                  </Link>
                ))}
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      {/* Recent events */}
      <Card>
        <CardHeader title="Recent events" subtitle="Last 50 events in window" />
        <CardBody>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="border-b border-ink-700 text-ink-400">
                  <th className="text-left pb-2 pr-4">Time</th>
                  <th className="text-left pb-2 pr-4">Event</th>
                  <th className="text-left pb-2 pr-4">Account</th>
                  <th className="text-left pb-2 pr-4">User</th>
                  <th className="text-left pb-2">Metadata</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((e, i) => (
                  <tr
                    key={i}
                    className="border-b border-ink-700/50 hover:bg-accent-900"
                  >
                    <td className="py-1.5 pr-4 text-ink-400 whitespace-nowrap">
                      {new Date(e.ts).toLocaleString("en-US", {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                    <td className="py-1.5 pr-4 text-ink-200 whitespace-nowrap">
                      {EVENT_LABELS[e.event] ?? e.event}
                    </td>
                    <td className="py-1.5 pr-4 text-ink-300 truncate max-w-[140px]">
                      {e.account ?? "—"}
                    </td>
                    <td className="py-1.5 pr-4 text-ink-500 truncate max-w-[160px]">
                      {e.userEmail ?? (e.userId ? e.userId.slice(0, 12) : "—")}
                    </td>
                    <td className="py-1.5 text-ink-500 truncate max-w-[240px] font-mono">
                      {e.metadata ? JSON.stringify(e.metadata).slice(0, 120) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
