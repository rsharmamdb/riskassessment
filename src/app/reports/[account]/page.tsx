"use client";

import React, { useEffect, useState, useCallback } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button, Card, CardBody, CardHeader } from "@/components/ui";
import { track } from "@/lib/track";
import { exportPdf } from "@/lib/pdf-export";
import {
  parseRisks,
  SEVERITY_WEIGHT,
  CONFIDENCE_WEIGHT,
  SEVERITY_COLOR,
  STATUS_COLORS,
  ALL_STATUSES,
  type ParsedRisk,
  type RiskStatus,
  type Severity,
  type Confidence,
} from "@/lib/parse-risks";

// ─── Types ────────────────────────────────────────────────────────────────────
interface LgtmRole {
  approved: boolean;
  reviewerName?: string | null;
  updatedAt?: string;
}
interface LgtmDoc {
  account: string;
  roles?: { AE?: LgtmRole; CSM?: LgtmRole; PS?: LgtmRole };
  updatedAt?: string;
}
interface RiskStatusDoc { riskId: number; status: RiskStatus; owner?: string; dueDate?: string }

const ROLES = ["AE", "CSM", "PS"] as const;
type Role = (typeof ROLES)[number];

const ROLE_LABELS: Record<Role, string> = {
  AE: "Account Executive",
  CSM: "Customer Success Manager",
  PS: "Professional Services",
};

const SEVERITY_ORDER: Severity[] = ["Critical", "Significant", "Roadmap Planning"];
const CONFIDENCE_ORDER: Confidence[] = ["High", "Medium", "Low"];

// ─── Risk Matrix ──────────────────────────────────────────────────────────────
function RiskMatrix({
  risks,
  onSelect,
}: {
  risks: ParsedRisk[];
  onSelect: (id: number) => void;
}) {
  // Heat intensity per cell: severity × confidence → 1–9
  const heat = (sev: Severity, conf: Confidence) =>
    SEVERITY_WEIGHT[sev] * CONFIDENCE_WEIGHT[conf];

  const heatBg = (h: number) =>
    h >= 9 ? "bg-danger/20"
    : h >= 6 ? "bg-danger/10"
    : h >= 4 ? "bg-warn/10"
    : h >= 3 ? "bg-warn/5"
    : "bg-transparent";

  const heatGlow = (h: number) =>
    h >= 9
      ? "shadow-[inset_0_0_24px_rgba(239,68,68,0.12)]"
      : h >= 6
        ? "shadow-[inset_0_0_16px_rgba(239,68,68,0.06)]"
        : "";

  const chipColor = (sev: Severity) =>
    sev === "Critical"
      ? "border-danger/50 text-danger hover:bg-danger/20 hover:border-danger"
      : sev === "Significant"
        ? "border-warn/50 text-warn hover:bg-warn/20 hover:border-warn"
        : "border-ink-600 text-ink-300 hover:bg-ink-800 hover:border-ink-400";

  return (
    <div>
      <div className="text-xs text-ink-400 mb-3 font-medium uppercase tracking-wider">Risk Matrix</div>
      <div className="overflow-x-auto">
        <div className="grid grid-cols-4 gap-px rounded-lg overflow-hidden text-xs min-w-[420px]"
             style={{ background: "rgba(30,45,61,0.6)" }}>
          {/* Corner */}
          <div className="bg-ink-900/80 backdrop-blur px-3 py-2.5 text-ink-500 text-center text-[11px]">
            Severity ↓ / Confidence →
          </div>
          {/* Confidence headers */}
          {CONFIDENCE_ORDER.map((c) => (
            <div key={c} className="bg-ink-900/80 backdrop-blur px-3 py-2.5 text-ink-300 text-center font-semibold tracking-wide">
              {c}
            </div>
          ))}
          {/* Rows */}
          {SEVERITY_ORDER.map((sev) => (
            <React.Fragment key={sev}>
              {/* Severity label */}
              <div className="bg-ink-900/80 backdrop-blur px-3 py-3 text-ink-300 font-semibold flex items-center text-[12px] tracking-wide">
                <span
                  className="mr-2 inline-block h-2 w-2 rounded-full flex-shrink-0"
                  style={{
                    backgroundColor:
                      sev === "Critical" ? "#EF4444" : sev === "Significant" ? "#F59E0B" : "#6B7280",
                  }}
                />
                {sev}
              </div>
              {/* Data cells */}
              {CONFIDENCE_ORDER.map((conf) => {
                const cell = risks.filter(
                  (r) => r.severity === sev && r.confidence === conf,
                );
                const h = heat(sev, conf);
                return (
                  <div
                    key={`${sev}-${conf}`}
                    className={`${heatBg(h)} ${heatGlow(h)} px-2.5 py-2.5 min-h-[56px] flex flex-wrap gap-1.5 items-start content-start transition-colors duration-300`}
                  >
                    {cell.map((r) => (
                      <button
                        key={r.id}
                        onClick={() => onSelect(r.id)}
                        title={r.title}
                        className={`inline-flex items-center justify-center w-8 h-7 text-[11px] font-mono font-semibold
                          border rounded-md ${chipColor(sev)}
                          transition-all duration-200 hover:scale-110 hover:shadow-lg
                          active:scale-95`}
                      >
                        {r.id}
                      </button>
                    ))}
                  </div>
                );
              })}
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Risk Row ──────────────────────────────────────────────────────────────────
function RiskRow({
  risk,
  onStatusChange,
  highlighted,
  execMode,
}: {
  risk: ParsedRisk;
  onStatusChange: (id: number, status: RiskStatus) => void;
  highlighted: boolean;
  execMode: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const leftBorder =
    risk.severity === "Critical"         ? "border-l-2 border-danger" :
    risk.severity === "Significant"       ? "border-l-2 border-warn" :
    risk.severity === "Roadmap Planning"  ? "border-l-2 border-ink-500" :
    "border-l-2 border-ink-700";

  const dueMs = risk.dueDate ? new Date(risk.dueDate).getTime() - Date.now() : null;
  const dueDays = dueMs !== null ? Math.ceil(dueMs / 86_400_000) : null;

  return (
    <div
      id={`risk-${risk.id}`}
      className={`border-y border-r transition-all ${leftBorder} ${
        highlighted ? "border-accent-500/40 bg-ink-900" : "border-ink-700 bg-ink-800"
      }`}
      style={{ borderRadius: '3px' }}
    >
      <button
        className="w-full text-left px-3 py-2.5 flex items-start gap-3"
        onClick={() => setExpanded((e) => !e)}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-ink-500 font-mono">#{risk.id}</span>
            <span className="text-sm text-ink-100 font-medium">{risk.title}</span>
          </div>
          {!execMode && (
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <span className={`inline-flex items-center text-[11px] font-mono ${SEVERITY_COLOR[risk.severity]}`}>
                {risk.severity}
              </span>
              <span className="text-xs text-ink-500">Confidence: {risk.confidence}</span>
              {dueDays !== null && (
                <span className={`text-xs font-medium ${dueDays < 0 ? "text-danger" : dueDays <= 3 ? "text-warn" : "text-ink-400"}`}>
                  {dueDays < 0 ? `${Math.abs(dueDays)}d overdue` : `Due in ${dueDays}d`}
                </span>
              )}
            </div>
          )}
          {/* Always-visible 1-line impact preview */}
          {risk.impact && (
            <p className="text-xs text-ink-500 mt-1.5 line-clamp-1">{risk.impact}</p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
          <a
            href="#report-full"
            className="text-xs text-ink-600 hover:text-accent-400 transition-colors"
            title="Jump to full report"
          >
            ↓
          </a>
          <select
            value={risk.status ?? "Open"}
            onChange={(e) => onStatusChange(risk.id, e.target.value as RiskStatus)}
            className={`text-[11px] font-mono rounded border px-2 py-0.5 bg-ink-800 text-ink-100 cursor-pointer ${STATUS_COLORS[risk.status ?? "Open"]}`}
            style={{ borderRadius: '3px' }}
          >
            {ALL_STATUSES.map((s) => (
              <option key={s} value={s} className="bg-ink-900 text-ink-50">{s}</option>
            ))}
          </select>
        </div>
      </button>
      {expanded && (
        <div className="px-4 pb-4 border-t border-ink-800 pt-3">
          <div className="text-xs text-ink-400 font-medium mb-1">Impact of taking no action</div>
          <div className="text-xs text-ink-300">{risk.impact || "—"}</div>
        </div>
      )}
    </div>
  );
}

export default function ReportPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const accountSlug = decodeURIComponent(String(params.account ?? ""));
  // sfId passed as ?sfId= from Wizard — use it for direct, name-independent lookup
  const sfIdParam = searchParams.get("sfId") ?? undefined;

  const [showRefreshDialog, setShowRefreshDialog] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  const [reportDate, setReportDate] = useState<string | null>(null);
  const [artifactsUpdatedAt, setArtifactsUpdatedAt] = useState<string | null>(null);
  const [lgtm, setLgtm] = useState<LgtmDoc | null>(null);
  const [risks, setRisks] = useState<ParsedRisk[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState<Role | null>(null);
  const [reviewerName, setReviewerName] = useState("");
  const [highlightedRisk, setHighlightedRisk] = useState<number | null>(null);
  const [execMode, setExecMode] = useState(false);
  const [pdfExporting, setPdfExporting] = useState(false);
  const [assessmentMeta, setAssessmentMeta] = useState<{ timeframeMonths?: number; motivation?: string }>({});
  const [salesforceId, setSalesforceId] = useState<string | null>(null);
  const [canonicalName, setCanonicalName] = useState<string | null>(null);

  // Email draft
  const [emailDraft, setEmailDraft] = useState<string | null>(null);
  const [draftingEmail, setDraftingEmail] = useState(false);
  const [showEmail, setShowEmail] = useState(false);

  useEffect(() => {
    if (!accountSlug) return;
    // Prefer sfId lookup (stable across name changes); fall back to account name slug
    const assessParam = sfIdParam
      ? `salesforceId=${encodeURIComponent(sfIdParam)}`
      : `account=${encodeURIComponent(accountSlug)}`;
    Promise.all([
      fetch(`/api/db/assessments?${assessParam}`).then((r) => r.json()),
      fetch(`/api/db/lgtm?account=${encodeURIComponent(accountSlug)}`).then((r) => r.json()),
      fetch(`/api/db/risks?account=${encodeURIComponent(accountSlug)}`).then((r) => r.json()),
    ])
      .then(([assessJson, lgtmJson, risksJson]) => {
        if (assessJson.ok && assessJson.assessment?.report) {
          const md = assessJson.assessment.report as string;
          setReport(md);
          setReportDate((assessJson.assessment as Record<string, unknown>).updatedAt as string ?? null);
          setAssessmentMeta({
            timeframeMonths: assessJson.assessment?.input?.timeframeMonths as number | undefined,
            motivation: assessJson.assessment?.input?.motivation as string | undefined,
          });
          const sfId = assessJson.assessment?.input?.salesforceId as string | undefined;
          if (sfId) setSalesforceId(sfId);
          const cName = assessJson.assessment?.input?.canonicalName as string | undefined;
          if (cName) setCanonicalName(cName);

          // Detect newest artifact fetch time for stale check
          const arts = ((assessJson.assessment as Record<string, unknown>).artifacts ?? []) as Array<{ fetchedAt?: string }>;
          const newest = arts.reduce((max, a) => {
            const t = a.fetchedAt ? new Date(a.fetchedAt).getTime() : 0;
            return t > max ? t : max;
          }, 0);
          if (newest) setArtifactsUpdatedAt(new Date(newest).toISOString());

          // Parse risks + merge saved statuses
          const parsed = parseRisks(md);
          const statusMap: Record<number, RiskStatusDoc> = {};
          for (const r of (risksJson.risks ?? []) as RiskStatusDoc[]) statusMap[r.riskId] = r;
          setRisks(parsed.map((r) => ({
            ...r,
            status: statusMap[r.id]?.status ?? "Open",
            owner: statusMap[r.id]?.owner,
            dueDate: statusMap[r.id]?.dueDate,
          })));

          track({
            event: "report_page_viewed",
            account: accountSlug,
            salesforceId: assessJson.assessment?.input?.salesforceId as string | undefined,
          });
        } else {
          setError("No report found for this account.");
        }
        if (lgtmJson.ok) setLgtm(lgtmJson.lgtm);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [accountSlug, sfIdParam]);

  const handleStatusChange = useCallback(async (riskId: number, status: RiskStatus) => {
    setRisks((prev) => prev.map((r) => r.id === riskId ? { ...r, status } : r));
    await fetch("/api/db/risks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account: accountSlug, riskId, status }),
    });
    track({ event: "risk_status_changed", account: accountSlug, metadata: { riskId, status } });
  }, [accountSlug]);

  const handleMatrixSelect = (id: number) => {
    setHighlightedRisk(id);
    setTimeout(() => {
      document.getElementById(`risk-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 50);
    setTimeout(() => setHighlightedRisk(null), 3000);
  };

  async function handleApprove(role: Role) {
    setApproving(role);
    try {
      await fetch("/api/db/lgtm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: accountSlug, role, reviewerName: reviewerName || null, approved: true }),
      });
      const j = await fetch(`/api/db/lgtm?account=${encodeURIComponent(accountSlug)}`).then((r) => r.json());
      if (j.ok) setLgtm(j.lgtm);
      track({ event: "lgtm_approved", account: accountSlug, metadata: { role } });
    } finally {
      setApproving(null);
    }
  }

  async function handleRevoke(role: Role) {
    setApproving(role);
    try {
      await fetch("/api/db/lgtm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: accountSlug, role, approved: false }),
      });
      const j = await fetch(`/api/db/lgtm?account=${encodeURIComponent(accountSlug)}`).then((r) => r.json());
      if (j.ok) setLgtm(j.lgtm);
    } finally {
      setApproving(null);
    }
  }

  async function handleDraftEmail() {
    setDraftingEmail(true);
    setShowEmail(true);
    try {
      const res = await fetch("/api/email-draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountName: accountSlug, risks }),
      });
      const j = await res.json();
      setEmailDraft(j.ok ? j.draft : `Error: ${j.error}`);
    } finally {
      setDraftingEmail(false);
    }
  }

  async function handleDownloadPdf() {
    if (!report) return;
    setPdfExporting(true);
    try {
      await exportPdf({
        markdown: report,
        accountName: accountSlug,
        timeframeMonths: assessmentMeta.timeframeMonths,
        motivation: assessmentMeta.motivation,
      });
    } catch (err) {
      window.alert((err as Error).message);
    } finally {
      setPdfExporting(false);
    }
  }

  if (loading) {
      return <div className="flex items-center justify-center py-24 text-ink-500 text-sm">Loading report…</div>;
  }

  if (error || !report) {
    return (
      <div className="border-l-2 border-danger pl-3 py-2.5 text-[12px] text-danger bg-danger/10" style={{ borderRadius: "8px" }}>
        {error ?? "Report not found."}
      </div>
    );
  }

  const allApproved = ROLES.every((r) => lgtm?.roles?.[r]?.approved);
  const isStale = artifactsUpdatedAt
    ? Date.now() - new Date(artifactsUpdatedAt).getTime() > 30 * 24 * 60 * 60 * 1000
    : false;
  const openCritical = risks.filter((r) => r.severity === "Critical" && r.status !== "Mitigated").length;

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <div className="text-xs text-ink-400 uppercase tracking-wider mb-1">Risk Register Report</div>
          <h1 className="text-2xl font-semibold tracking-tight capitalize">
            {salesforceId ? (
              <a
                href={`https://hub.corp.mongodb.com/account/${salesforceId}/overview`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-ink-100 hover:text-accent-400 transition-colors"
                title={`Open ${canonicalName || accountSlug} in Hub (${salesforceId})`}
              >
                {canonicalName || accountSlug}
                <svg className="inline-block ml-1.5 w-4 h-4 text-ink-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
              </a>
            ) : (canonicalName || accountSlug)}
          </h1>
          {reportDate && (
            <div className="text-xs text-ink-500 mt-1">
              Generated {new Date(reportDate).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {allApproved && (
            <span className="inline-flex items-center gap-1.5 text-[11px] font-mono text-success border-l-2 border-success pl-2">
              All LGTM
            </span>
          )}
          {/* Internal / Exec toggle */}
          <div className="flex border border-ink-800 overflow-hidden text-xs" style={{ borderRadius: '3px' }}>
            <button
              onClick={() => setExecMode(false)}
              className={`px-3 py-1.5 transition-colors ${!execMode ? "bg-accent-500 text-white" : "bg-ink-900 text-ink-500 hover:text-ink-300"}`}
            >
              Internal
            </button>
            <button
              onClick={() => setExecMode(true)}
              className={`px-3 py-1.5 transition-colors ${execMode ? "bg-accent-500 text-white" : "bg-ink-900 text-ink-500 hover:text-ink-300"}`}
            >
              Exec summary
            </button>
          </div>
          <Button variant="secondary" size="sm" onClick={handleDownloadPdf} loading={pdfExporting}>
            Export PDF
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setShowRefreshDialog(true)}>
            Refresh report
          </Button>
        </div>
      </div>

      {/* ── Refresh confirmation dialog ── */}
      {showRefreshDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-md bg-ink-900 border border-ink-700 p-6 space-y-4" style={{ borderRadius: "12px" }}>
            <div className="text-[11px] font-semibold uppercase tracking-[0.05em] text-warn">Caution</div>
            <h2 className="text-[18px] font-semibold text-ink-100">Refresh this report?</h2>
            <p className="text-[13px] text-ink-400 leading-relaxed">
              This will re-fetch all Glean data and regenerate the report from scratch,
              replacing the current version. If the existing report is less than 30 days old,
              you're unlikely to see significant new findings.
            </p>
            <div className="flex gap-3 justify-end pt-2">
              <Button variant="ghost" size="sm" onClick={() => setShowRefreshDialog(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  setShowRefreshDialog(false);
                  router.push(`/?forceRefresh=true${salesforceId ? `&sfId=${encodeURIComponent(salesforceId)}` : ""}`);
                }}
              >
                Yes, refresh everything
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Stale data watermark ── */}
      {isStale && (
        <div className="flex items-start justify-between gap-4 border-l-2 border-warn pl-3 py-2 text-[12px] text-warn bg-warn/10" style={{ borderRadius: "8px" }}>
          <div className="flex items-start gap-2">
            <span className="mt-0.5">⚑</span>
            <span>
              <strong>Sources may be outdated.</strong> Artifacts last fetched{" "}
              {artifactsUpdatedAt
                ? new Date(artifactsUpdatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
                : "over 30 days ago"}
              .
            </span>
          </div>
          <Button variant="secondary" size="sm" onClick={() => setShowRefreshDialog(true)} className="flex-shrink-0">
            Refresh report
          </Button>
        </div>
      )}

      {/* ── KPI strip (internal only) ── */}
      {!execMode && risks.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "Total risks", value: risks.length },
            { label: "Critical open", value: openCritical, danger: openCritical > 0 },
            { label: "Open", value: risks.filter((r) => r.status === "Open").length },
            { label: "Mitigated", value: risks.filter((r) => r.status === "Mitigated").length, good: true },
          ].map((k) => (
            <div key={k.label} className="border border-ink-800 bg-ink-900 px-4 py-3" style={{ borderRadius: '3px' }}>
              <div className={`text-2xl font-semibold tabular-nums ${k.danger ? "text-danger" : k.good ? "text-success" : "text-ink-100"}`}>
                {k.value}
              </div>
              <div className="text-xs text-ink-400 mt-0.5">{k.label}</div>
            </div>
          ))}
        </div>
      )}

      <div className="grid lg:grid-cols-4 gap-6">
        {/* ── Main column ── */}
        <div className="lg:col-span-3 space-y-6">
          {execMode ? (
            /* Exec summary: just critical risks as cards */
            <div className="space-y-4">
              <div className="bg-ink-900 border border-ink-800 px-4 py-3 text-sm text-ink-300" style={{ borderRadius: '3px' }}>
                <strong className="text-ink-100">Executive Summary</strong> — {risks.length} risks identified.
                {openCritical > 0 && (
                  <span className="text-danger ml-1">{openCritical} critical open.</span>
                )}
              </div>
              {risks.filter((r) => r.severity === "Critical").map((r) => (
                  <div key={r.id} className="border border-ink-800 bg-ink-900 px-4 py-3 space-y-1" style={{ borderRadius: '3px' }}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-medium text-danger">Critical</span>
                    <span className="text-sm font-medium text-ink-100">{r.title}</span>
                    <span className={`inline-flex text-[11px] font-mono border-l-2 pl-2 ${STATUS_COLORS[r.status ?? "Open"]}`}>
                      {r.status ?? "Open"}
                    </span>
                  </div>
                  <div className="text-xs text-ink-400">{r.impact}</div>
                </div>
              ))}
              {risks.filter((r) => r.severity === "Critical").length === 0 && (
                <div className="text-sm text-ink-400">No critical risks identified.</div>
              )}
            </div>
          ) : (
            <>
              {/* Risk matrix */}
              {risks.length > 0 && (
                <Card>
                  <CardBody>
                    <RiskMatrix risks={risks} onSelect={handleMatrixSelect} />
                  </CardBody>
                </Card>
              )}

              {/* Risk register */}
              {risks.length > 0 && (
                <div>
                  <div className="text-xs text-ink-400 mb-2 font-medium uppercase tracking-wider">Risk Register</div>
                  <div className="space-y-2">
                    {risks.map((r) => (
                      <RiskRow
                        key={r.id}
                        risk={r}
                        onStatusChange={handleStatusChange}
                        highlighted={highlightedRisk === r.id}
                        execMode={false}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Email draft panel */}
              {showEmail && (
                <Card>
                  <CardHeader
                    title="Stakeholder email draft"
                    subtitle="Editable — copy and send via your email client"
                    right={
                      <button className="text-xs text-ink-400 hover:text-ink-200 px-1" onClick={() => setShowEmail(false)}>✕</button>
                    }
                  />
                  <CardBody>
                    {draftingEmail ? (
                      <div className="flex items-center gap-2 text-sm text-ink-400">
                        <span className="w-3.5 h-3.5 rounded-full border-2 border-white/40 border-t-white animate-spin" />
                        Drafting…
                      </div>
                    ) : (
                      <>
                        <textarea
                          value={emailDraft ?? ""}
                          onChange={(e) => setEmailDraft(e.target.value)}
                          rows={12}
                          className="w-full bg-ink-900 border border-ink-800 px-3 py-2 text-sm text-ink-100 font-mono focus:outline-none focus:ring-1 focus:ring-accent-500 resize-y"
                  style={{ borderRadius: '3px' }}
                        />
                        {emailDraft && (
                          <button
                            onClick={() => navigator.clipboard.writeText(emailDraft)}
                            className="mt-2 text-xs text-accent-400 hover:text-accent-300"
                          >
                            Copy to clipboard
                          </button>
                        )}
                      </>
                    )}
                  </CardBody>
                </Card>
              )}

              {/* Full markdown report */}
              <div id="report-full">
              <Card>
                <CardHeader title="Full Report" />
                <CardBody>
                  <div className="report-prose">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{report}</ReactMarkdown>
                  </div>
                </CardBody>
              </Card>
              </div>
            </>
          )}
        </div>

        {/* ── Right rail ── */}
        <div className="space-y-4">
          {/* Quick actions */}
          <Card>
            <CardHeader title="Actions" />
            <CardBody>
              <div className="space-y-2">
                <Button
                  variant="secondary"
                  size="sm"
                  className="w-full justify-start"
                  onClick={handleDraftEmail}
                  loading={draftingEmail}
                >
                  ✉ Draft stakeholder email
                </Button>
                <button
                  onClick={() => navigator.clipboard.writeText(window.location.href)}
                  className="w-full text-left text-xs text-ink-500 hover:text-ink-200 px-3 py-2 hover:bg-ink-900 transition-colors"
                  style={{ borderRadius: '3px' }}
                >
                  🔗 Copy share link
                </button>
                <button
                  onClick={handleDownloadPdf}
                  className="w-full text-left text-xs text-ink-500 hover:text-ink-200 px-3 py-2 hover:bg-ink-900 transition-colors"
                  style={{ borderRadius: '3px' }}
                >
                  🖨 Export PDF
                </button>
              </div>
            </CardBody>
          </Card>

          {/* LGTM panel */}
          <Card>
            <CardHeader title="LGTM" subtitle="Reviewer sign-off" />
            <CardBody>
              <div className="mb-4">
                <label className="block text-xs text-ink-400 mb-1">Your name</label>
                <input
                  type="text"
                  value={reviewerName}
                  onChange={(e) => setReviewerName(e.target.value)}
                  placeholder="e.g. Carol Issadore"
                  className="w-full border border-ink-700 bg-accent-900 px-3 py-1.5 text-sm text-ink-100 placeholder:text-ink-500 focus:outline-none focus:ring-1 focus:ring-accent-500"
                  style={{ borderRadius: '3px' }}
                />
              </div>
              <div className="space-y-3">
                {ROLES.map((role) => {
                  const state = lgtm?.roles?.[role];
                  const approved = state?.approved ?? false;
                  return (
                    <div
                      key={role}
                      className={`border px-3 py-3 ${
                      approved ? "border-success/40 bg-success/10" : "border-ink-700 bg-ink-800"
                    }`}
                    style={{ borderRadius: '3px' }}
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="text-xs font-medium text-ink-200">{role}</div>
                          <div className="text-xs text-ink-500">{ROLE_LABELS[role]}</div>
                          {approved && state?.reviewerName && (
                            <div className="text-xs text-success mt-0.5">{state.reviewerName}</div>
                          )}
                        </div>
                        {approved ? (
                          <button
                            onClick={() => handleRevoke(role)}
                            disabled={approving === role}
                            className="text-xs text-ink-500 hover:text-danger transition-colors"
                          >
                            {approving === role ? "…" : "Revoke"}
                          </button>
                        ) : (
                          <Button size="sm" onClick={() => handleApprove(role)} loading={approving === role}>
                            Approve
                          </Button>
                        )}
                      </div>
                      {approved && state?.updatedAt && (
                        <div className="text-xs text-ink-600 mt-1">
                          {new Date(state.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}
