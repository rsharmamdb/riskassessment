"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CopyButton,
  Input,
  Label,
  Pill,
  Textarea,
} from "@/components/ui";
import { Stepper, StepHeading, type Step } from "@/components/Stepper";
import { DEFAULT_SETTINGS, loadSettings, type Settings } from "@/lib/storage";
import {
  buildCaseSearchArgs,
  type AggregatedRisk,
  type AnalyzeResult,
  type CaseDocument,
  type CommentSignals,
  type Confidence,
} from "@/lib/case-analysis";

const STEPS: Step[] = [
  { id: "context", title: "Context" },
  { id: "search", title: "Search" },
  { id: "read", title: "Read & Review" },
  { id: "risks", title: "Risks" },
];

const STORAGE_KEY = "risksi.caseAnalysis.v2";

interface SearchHitLite {
  url: string;
  title: string;
  caseNumber?: string;
  snippet?: string;
}

interface PersistedState {
  accountName: string;
  timeframeMonths: number;
  extraKeywords: string;
  searchArgsJson: string; // freeform editable JSON for the search tool args
  hits: SearchHitLite[];
  selectedUrls: string[];
  cases: CaseDocument[];
  result: AnalyzeResult | null;
}

const EMPTY: PersistedState = {
  accountName: "",
  timeframeMonths: 6,
  extraKeywords: "",
  searchArgsJson: "",
  hits: [],
  selectedUrls: [],
  cases: [],
  result: null,
};

function loadState(): PersistedState {
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? { ...EMPTY, ...JSON.parse(raw) } : EMPTY;
  } catch {
    return EMPTY;
  }
}

function saveState(state: PersistedState): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// ---------- component ----------

export function CaseAnalysis() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [stepIdx, setStepIdx] = useState(0);
  const [state, setState] = useState<PersistedState>(EMPTY);

  const [searching, setSearching] = useState(false);
  const [searchStatus, setSearchStatus] = useState<
    { ok: boolean; msg: string } | null
  >(null);

  const [reading, setReading] = useState(false);
  const [readStatus, setReadStatus] = useState<
    { ok: boolean; msg: string } | null
  >(null);

  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  const [gleanSso, setGleanSso] = useState<{
    hasToken: boolean;
    stale?: boolean;
  } | null>(null);

  // Bridge (paste-back) fallback.
  const [bridgeOpen, setBridgeOpen] = useState(false);
  const [bridgeSearch, setBridgeSearch] = useState("");
  const [bridgeRead, setBridgeRead] = useState("");
  const [bridgeImporting, setBridgeImporting] = useState(false);
  const [bridgeStatus, setBridgeStatus] = useState<
    { ok: boolean; msg: string; warnings?: string[] } | null
  >(null);

  const hasGlean = !!settings.gleanToken || !!gleanSso?.hasToken;

  const hasLlm =
    (settings.llmProvider === "openai" && !!settings.openaiApiKey) ||
    (settings.llmProvider === "anthropic" && !!settings.anthropicApiKey) ||
    (settings.llmProvider === "mongogpt" && !!settings.mongogptModel);

  useEffect(() => {
    setSettings(loadSettings());
    setState(loadState());
    void (async () => {
      try {
        const res = await fetch("/api/glean/login/status");
        const json = (await res.json()) as {
          ok: boolean;
          status: { hasToken: boolean; stale?: boolean };
        };
        setGleanSso(json.status);
      } catch {
        setGleanSso({ hasToken: false });
      }
    })();
  }, []);

  useEffect(() => {
    saveState(state);
  }, [state]);

  // Default args — recomputed whenever context changes, unless the user has
  // already hand-edited the JSON (non-empty searchArgsJson).
  const defaultArgs = useMemo(() => {
    if (!state.accountName.trim()) return {};
    return buildCaseSearchArgs({
      accountName: state.accountName,
      timeframeMonths: state.timeframeMonths,
      extraKeywords: state.extraKeywords || undefined,
    });
  }, [state.accountName, state.timeframeMonths, state.extraKeywords]);

  const activeArgs = useMemo(() => {
    if (state.searchArgsJson.trim()) {
      try {
        return JSON.parse(state.searchArgsJson) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return defaultArgs;
  }, [state.searchArgsJson, defaultArgs]);

  const argsPreview = useMemo(
    () => JSON.stringify(activeArgs ?? { error: "invalid JSON" }, null, 2),
    [activeArgs],
  );

  const canContext =
    state.accountName.trim().length > 0 && state.timeframeMonths > 0;
  const canSearch = canContext && !!activeArgs && hasGlean;
  const canRead = state.selectedUrls.length > 0 && hasGlean;
  const canAnalyze =
    state.cases.some((c) => c.fullText.trim().length > 0) && hasLlm;

  // ---------- step 2: search ----------

  async function runSearch() {
    if (!activeArgs) {
      setSearchStatus({ ok: false, msg: "Search args aren't valid JSON." });
      return;
    }
    setSearching(true);
    setSearchStatus({ ok: true, msg: "Calling Glean `search`…" });
    try {
      const res = await fetch("/api/glean/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          args: activeArgs,
          gleanToken: settings.gleanToken,
          gleanUrl: settings.gleanMcpUrl,
        }),
      });
      const json = (await res.json()) as {
        ok: boolean;
        hits?: SearchHitLite[];
        error?: string;
        tokenSource?: string;
      };
      if (!json.ok) {
        setSearchStatus({ ok: false, msg: json.error || "Search failed." });
        return;
      }
      const hits = json.hits ?? [];
      setState((s) => ({
        ...s,
        hits,
        selectedUrls: hits.map((h) => h.url),
        cases: [],
        result: null,
      }));
      if (hits.length === 0) {
        setSearchStatus({
          ok: false,
          msg: `No Glean hits for those args. Try broadening the query or removing filters.`,
        });
      } else {
        setSearchStatus({
          ok: true,
          msg: `Got ${hits.length} hit${hits.length === 1 ? "" : "s"} via ${json.tokenSource || "glean"}.`,
        });
      }
    } catch (err) {
      setSearchStatus({ ok: false, msg: (err as Error).message });
    } finally {
      setSearching(false);
    }
  }

  function toggleHit(url: string) {
    setState((s) => {
      const sel = new Set(s.selectedUrls);
      if (sel.has(url)) sel.delete(url);
      else sel.add(url);
      return { ...s, selectedUrls: [...sel] };
    });
  }

  function selectAll(all: boolean) {
    setState((s) => ({
      ...s,
      selectedUrls: all ? s.hits.map((h) => h.url) : [],
    }));
  }

  // ---------- step 3: read ----------

  async function runRead() {
    if (state.selectedUrls.length === 0) return;
    setReading(true);
    setReadStatus({
      ok: true,
      msg: `Calling Glean \`read_document\` on ${state.selectedUrls.length} URL${state.selectedUrls.length === 1 ? "" : "s"}…`,
    });
    try {
      const selectedHits = state.hits.filter((h) =>
        state.selectedUrls.includes(h.url),
      );
      const res = await fetch("/api/glean/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          urls: state.selectedUrls,
          hints: selectedHits.map((h) => ({
            url: h.url,
            title: h.title,
            caseNumber: h.caseNumber,
          })),
          gleanToken: settings.gleanToken,
          gleanUrl: settings.gleanMcpUrl,
        }),
      });
      const json = (await res.json()) as {
        ok: boolean;
        cases?: CaseDocument[];
        stats?: { requested: number; read: number };
        error?: string;
      };
      if (!json.ok) {
        setReadStatus({ ok: false, msg: json.error || "Read failed." });
        return;
      }
      const cases = json.cases ?? [];
      setState((s) => {
        const byUrl = new Map(s.cases.map((c) => [c.url, c]));
        for (const c of cases) byUrl.set(c.url, c);
        return { ...s, cases: [...byUrl.values()] };
      });
      setReadStatus({
        ok: cases.length > 0,
        msg:
          cases.length === 0
            ? "Glean returned no readable documents for those URLs."
            : `Loaded ${cases.length}/${json.stats?.requested ?? state.selectedUrls.length} case bodies.`,
      });
    } catch (err) {
      setReadStatus({ ok: false, msg: (err as Error).message });
    } finally {
      setReading(false);
    }
  }

  function addBlankCase() {
    setState((s) => ({
      ...s,
      cases: [
        ...s.cases,
        { url: "", title: `Manual case ${s.cases.length + 1}`, fullText: "" },
      ],
    }));
  }

  function updateCase(idx: number, patch: Partial<CaseDocument>) {
    setState((s) => ({
      ...s,
      cases: s.cases.map((c, i) => (i === idx ? { ...c, ...patch } : c)),
    }));
  }

  function removeCase(idx: number) {
    setState((s) => ({
      ...s,
      cases: s.cases.filter((_, i) => i !== idx),
    }));
  }

  // ---------- bridge (fallback) ----------

  function buildBridgePrompt(): string {
    return [
      `Run these two Glean MCP tool calls, then paste the raw JSON tool outputs back into this app.`,
      ``,
      `1) Call tool \`search\` with:`,
      "```json",
      JSON.stringify(activeArgs ?? {}, null, 2),
      "```",
      ``,
      `2) Take the \`url\` values from the results, then call tool \`read_document\` with:`,
      "```json",
      `{ "urls": ["<url-1>", "<url-2>", "..."] }`,
      "```",
      ``,
      `Reply with two JSON code blocks — the raw outputs — no commentary.`,
    ].join("\n");
  }

  async function importFromBridge() {
    if (!bridgeSearch.trim() && !bridgeRead.trim()) {
      setBridgeStatus({
        ok: false,
        msg: "Paste at least one of the tool outputs.",
      });
      return;
    }
    setBridgeImporting(true);
    setBridgeStatus(null);
    try {
      const res = await fetch("/api/cases/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          searchJson: bridgeSearch,
          readJson: bridgeRead,
        }),
      });
      const json = (await res.json()) as {
        ok: boolean;
        cases?: CaseDocument[];
        message?: string;
        warnings?: string[];
        error?: string;
      };
      if (!json.ok) {
        setBridgeStatus({ ok: false, msg: json.error || "Import failed." });
        return;
      }
      const imported = json.cases ?? [];
      setState((s) => {
        const byUrl = new Map(s.cases.map((c) => [c.url, c]));
        for (const c of imported) byUrl.set(c.url, c);
        return { ...s, cases: [...byUrl.values()] };
      });
      setBridgeStatus({
        ok: imported.length > 0,
        msg: json.message || `Imported ${imported.length} cases.`,
        warnings: json.warnings,
      });
      if (imported.length > 0) {
        setBridgeSearch("");
        setBridgeRead("");
      }
    } catch (err) {
      setBridgeStatus({ ok: false, msg: (err as Error).message });
    } finally {
      setBridgeImporting(false);
    }
  }

  // ---------- step 4: analyze ----------

  async function runAnalyze() {
    setAnalyzing(true);
    setAnalyzeError(null);
    try {
      const apiKey =
        settings.llmProvider === "openai"
          ? settings.openaiApiKey
          : settings.llmProvider === "anthropic"
            ? settings.anthropicApiKey
            : undefined;
      const model =
        settings.llmProvider === "openai"
          ? settings.openaiModel
          : settings.llmProvider === "anthropic"
            ? settings.anthropicModel
            : settings.mongogptModel;
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountName: state.accountName,
          cases: state.cases
            .filter((c) => c.fullText.trim().length > 0)
            .map((c) => ({
              url: c.url,
              title: c.title,
              caseNumber: c.caseNumber,
              fullText: c.fullText,
            })),
          provider: settings.llmProvider,
          apiKey,
          model,
          mongogptUrl:
            settings.llmProvider === "mongogpt"
              ? settings.mongogptUrl
              : undefined,
        }),
      });
      const json = await res.json();
      if (json.ok) {
        setState((s) => ({ ...s, result: json.result }));
        setStepIdx(3);
      } else {
        setAnalyzeError(json.error || "Analysis failed.");
      }
    } catch (err) {
      setAnalyzeError((err as Error).message);
    } finally {
      setAnalyzing(false);
    }
  }

  function resetAll() {
    if (!confirm("Clear this analysis? Current cases and risks will be lost."))
      return;
    setState(EMPTY);
    setAnalyzeError(null);
    setSearchStatus(null);
    setReadStatus(null);
    setBridgeStatus(null);
    setStepIdx(0);
  }

  // ---------- render ----------

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">
            Case Risk Analysis
          </h1>
          <p className="text-sm text-ink-400 mt-1 max-w-2xl">
            Surface the most important customer risks early, focus attention on
            the cases that matter most, and give internal teams a clearer basis
            for prioritization and follow-through.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!hasGlean && (
            <Link href="/settings?returnTo=/cases">
              <Pill tone="warn">Sign in to Glean →</Pill>
            </Link>
          )}
          {!hasLlm && (
            <Link href="/settings?returnTo=/cases">
              <Pill tone="warn">Configure LLM →</Pill>
            </Link>
          )}
          <Button variant="ghost" size="sm" onClick={resetAll}>
            Reset
          </Button>
        </div>
      </div>

      <Stepper steps={STEPS} currentIdx={stepIdx} onJump={setStepIdx} />

      {stepIdx === 0 && (
        <Card>
          <CardBody>
            <StepHeading
              eyebrow="Step 1"
              title="Customer Context"
              description="Sets the account scope and timeframe. Account name becomes the Glean `query`; 1 month → `updated: past_month`, longer → `after` (PremServ-style case search)."
            />
            <div className="grid sm:grid-cols-2 gap-5">
              <div className="sm:col-span-2">
                <Label>Account name</Label>
                <Input
                  value={state.accountName}
                  onChange={(e) =>
                    setState({ ...state, accountName: e.target.value })
                  }
                  placeholder="e.g. Acme Corp"
                  autoFocus
                />
              </div>
              <div>
                <Label>Timeframe (months)</Label>
                <Input
                  type="number"
                  min={1}
                  max={36}
                  value={state.timeframeMonths}
                  onChange={(e) =>
                    setState({
                      ...state,
                      timeframeMonths: Math.max(
                        1,
                        Number(e.target.value) || 1,
                      ),
                    })
                  }
                />
              </div>
              <div>
                <Label>
                  Extra keywords{" "}
                  <span className="text-ink-500 font-normal">
                    (optional; appended to query)
                  </span>
                </Label>
                <Input
                  value={state.extraKeywords}
                  onChange={(e) =>
                    setState({ ...state, extraKeywords: e.target.value })
                  }
                  placeholder="e.g. replication, oplog, sharding"
                />
              </div>
            </div>
            <div className="flex justify-end mt-8">
              <Button disabled={!canContext} onClick={() => setStepIdx(1)}>
                Continue →
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      {stepIdx === 1 && (
        <div className="space-y-6">
          <Card>
            <CardBody>
              <StepHeading
                eyebrow="Step 2"
                title="Glean search"
                description="Calls Glean MCP `search` (same defaults as PremServ ntse-case-review: app=servicecloud, exhaustive, date from Step 1). MCP URL defaults to …/mcp/default. Edit JSON to broaden."
                right={
                  <div className="flex items-center gap-2">
                    {gleanSso?.hasToken ? (
                      <Pill tone="success">SSO</Pill>
                    ) : settings.gleanToken ? (
                      <Pill>static token</Pill>
                    ) : (
                      <Pill tone="warn">no auth</Pill>
                    )}
                  </div>
                }
              />

              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <Label>
                    Search args{" "}
                    <span className="text-ink-500 font-normal">
                      (JSON, passed verbatim to Glean MCP)
                    </span>
                  </Label>
                  <Textarea
                    rows={10}
                    value={state.searchArgsJson || argsPreview}
                    onChange={(e) =>
                      setState({ ...state, searchArgsJson: e.target.value })
                    }
                    className="font-mono text-xs"
                  />
                  <div className="mt-1 text-[11px] text-ink-500">
                    Leave empty to re-derive from Step 1. `app: &quot;servicecloud&quot;`
                    scopes to Salesforce cases — change to e.g. `slack` or
                    remove it to broaden.
                  </div>
                </div>

                <div>
                  <Label>Effective args</Label>
                  <pre className="rounded-md border border-ink-800 bg-ink-950 px-3 py-2 text-[11px] leading-snug text-ink-200 whitespace-pre-wrap break-words max-h-64 overflow-auto">
                    {argsPreview}
                  </pre>
                  <div className="mt-1 text-[11px] text-ink-500">
                    This is what will be sent to Glean.
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-3 flex-wrap mt-5">
                <Button
                  onClick={runSearch}
                  loading={searching}
                  disabled={!canSearch}
                >
                  Run Glean search
                </Button>
                {state.searchArgsJson && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setState({ ...state, searchArgsJson: "" })}
                  >
                    Reset to derived args
                  </Button>
                )}
                {!hasGlean && (
                  <Link
                    href="/settings?returnTo=/cases"
                    className="text-xs text-amber-400 underline"
                  >
                    Sign in to Glean (SSO or token) →
                  </Link>
                )}
              </div>

              {searchStatus && (
                <div
                  className={`mt-3 text-xs ${searchStatus.ok ? "text-emerald-400" : "text-red-400"}`}
                >
                  {searchStatus.msg}
                </div>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title={`Hits (${state.hits.length})`}
              subtitle="Pick the cases to pull full transcripts for."
              right={
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => selectAll(true)}
                    disabled={state.hits.length === 0}
                  >
                    Select all
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => selectAll(false)}
                    disabled={state.selectedUrls.length === 0}
                  >
                    Clear
                  </Button>
                </div>
              }
            />
            <CardBody>
              {state.hits.length === 0 ? (
                <div className="text-sm text-ink-500 rounded-md border border-dashed border-ink-800 px-3 py-6 text-center">
                  No hits yet. Click{" "}
                  <span className="text-ink-200">Run Glean search</span>.
                </div>
              ) : (
                <ul className="space-y-2">
                  {state.hits.map((h) => {
                    const selected = state.selectedUrls.includes(h.url);
                    return (
                      <li
                        key={h.url}
                        className={`flex items-start gap-3 rounded-md border px-3 py-2 ${selected ? "border-accent-600/60 bg-accent-500/5" : "border-ink-800 bg-ink-950/40"}`}
                      >
                        <input
                          type="checkbox"
                          className="mt-1 accent-accent-500"
                          checked={selected}
                          onChange={() => toggleHit(h.url)}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            {h.caseNumber && (
                              <Pill tone="accent">{h.caseNumber}</Pill>
                            )}
                            <a
                              href={h.url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-sm font-medium text-ink-100 hover:text-accent-300 truncate"
                            >
                              {h.title || h.url}
                            </a>
                          </div>
                          {h.snippet && (
                            <div className="text-xs text-ink-400 mt-1 line-clamp-2">
                              {h.snippet}
                            </div>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}

              <div className="flex justify-between mt-6">
                <Button variant="ghost" onClick={() => setStepIdx(0)}>
                  ← Back
                </Button>
                <Button
                  onClick={() => setStepIdx(2)}
                  disabled={state.selectedUrls.length === 0}
                >
                  Continue with {state.selectedUrls.length} selected →
                </Button>
              </div>
            </CardBody>
          </Card>

          <BridgeCard
            open={bridgeOpen}
            onToggle={() => setBridgeOpen((o) => !o)}
            prompt={buildBridgePrompt()}
            searchVal={bridgeSearch}
            onSearch={setBridgeSearch}
            readVal={bridgeRead}
            onRead={setBridgeRead}
            importing={bridgeImporting}
            onImport={importFromBridge}
            status={bridgeStatus}
          />
        </div>
      )}

      {stepIdx === 2 && (
        <div className="space-y-6">
          <Card>
            <CardBody>
              <StepHeading
                eyebrow="Step 3"
                title="Read & review cases"
                description="Calls Glean MCP `read_document` on the selected URLs and lets you edit/remove each transcript before analysis."
              />
              <div className="flex items-center gap-3 flex-wrap">
                <Button
                  onClick={runRead}
                  loading={reading}
                  disabled={!canRead}
                >
                  Read {state.selectedUrls.length} case
                  {state.selectedUrls.length === 1 ? "" : "s"}
                </Button>
                <Button variant="ghost" size="sm" onClick={addBlankCase}>
                  + Add manual case
                </Button>
                <span className="text-[11px] text-ink-500">
                  Already loaded: {state.cases.length}
                </span>
              </div>
              {readStatus && (
                <div
                  className={`mt-3 text-xs ${readStatus.ok ? "text-emerald-400" : "text-red-400"}`}
                >
                  {readStatus.msg}
                </div>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title={`Cases (${state.cases.length})`}
              subtitle="Empty transcripts are skipped. Edit titles freely; the case number is used as the caseRef when present."
              right={
                analyzeError ? <Pill tone="danger">analyze error</Pill> : null
              }
            />
            <CardBody>
              {state.cases.length === 0 ? (
                <div className="text-sm text-ink-500 rounded-md border border-dashed border-ink-800 px-3 py-6 text-center">
                  No cases yet. Click{" "}
                  <span className="text-ink-200">Read N cases</span> above or
                  use{" "}
                  <span className="text-ink-200">+ Add manual case</span> to
                  paste a transcript.
                </div>
              ) : (
                <ul className="space-y-4">
                  {state.cases.map((c, idx) => (
                    <li
                      key={c.url || idx}
                      className="rounded-lg border border-ink-800 bg-ink-950/50 p-4 space-y-3"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2 min-w-0">
                          <Pill tone="accent">#{idx + 1}</Pill>
                          {c.caseNumber && <Pill>case {c.caseNumber}</Pill>}
                          <Input
                            value={c.title}
                            onChange={(e) =>
                              updateCase(idx, { title: e.target.value })
                            }
                            className="flex-1 min-w-0"
                          />
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => removeCase(idx)}
                        >
                          Remove
                        </Button>
                      </div>
                      <Textarea
                        rows={6}
                        value={c.fullText}
                        onChange={(e) =>
                          updateCase(idx, { fullText: e.target.value })
                        }
                        placeholder="Full case transcript (all comments, chronological)…"
                      />
                      <div className="text-xs text-ink-500">
                        {c.fullText.length.toLocaleString()} chars
                        {c.url ? (
                          <>
                            {" "}
                            ·{" "}
                            <a
                              className="underline text-accent-500"
                              href={c.url}
                              target="_blank"
                              rel="noreferrer"
                            >
                              open in Glean
                            </a>
                          </>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              {analyzeError && (
                <div className="mt-4 rounded-md bg-red-900/30 border border-red-700/40 px-4 py-3 text-sm text-red-200">
                  {analyzeError}
                </div>
              )}

              <div className="flex justify-between mt-6">
                <Button variant="ghost" onClick={() => setStepIdx(1)}>
                  ← Back
                </Button>
                <Button
                  onClick={runAnalyze}
                  loading={analyzing}
                  disabled={!canAnalyze}
                >
                  Analyze {state.cases.filter((c) => c.fullText.trim()).length}{" "}
                  {state.cases.filter((c) => c.fullText.trim()).length === 1
                    ? "case"
                    : "cases"}
                </Button>
              </div>
            </CardBody>
          </Card>
        </div>
      )}

      {stepIdx === 3 && (
        <ResultsView
          accountName={state.accountName}
          result={state.result}
          onBack={() => setStepIdx(2)}
          onRerun={runAnalyze}
          rerunning={analyzing}
        />
      )}
    </div>
  );
}

// ---------- bridge card (collapsible paste-back) ----------

function BridgeCard(props: {
  open: boolean;
  onToggle: () => void;
  prompt: string;
  searchVal: string;
  onSearch: (v: string) => void;
  readVal: string;
  onRead: (v: string) => void;
  importing: boolean;
  onImport: () => void;
  status: { ok: boolean; msg: string; warnings?: string[] } | null;
}) {
  const {
    open,
    onToggle,
    prompt,
    searchVal,
    onSearch,
    readVal,
    onRead,
    importing,
    onImport,
    status,
  } = props;
  return (
    <Card>
      <CardBody>
        <button
          type="button"
          onClick={onToggle}
          className="flex items-center justify-between w-full text-left"
        >
          <div>
            <div className="text-xs uppercase tracking-wider text-ink-400">
              Fallback · no Glean auth
            </div>
            <div className="text-base font-semibold mt-1">
              Paste-back bridge (Cursor → app)
            </div>
            <div className="text-xs text-ink-500 mt-1 max-w-2xl">
              Run the Glean MCP tool calls in Cursor chat and paste the raw
              JSON outputs here. Only needed if you can&apos;t sign in via SSO
              or provide a static token.
            </div>
          </div>
          <Pill>{open ? "Hide" : "Show"}</Pill>
        </button>

        {open && (
          <div className="mt-5 space-y-4">
            <div className="rounded-md border border-ink-800 bg-ink-950/60 p-3">
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="text-xs uppercase tracking-wider text-ink-400">
                  1. Copy this prompt into Cursor chat
                </div>
                <CopyButton text={prompt} />
              </div>
              <pre className="text-[11px] leading-snug text-ink-300 whitespace-pre-wrap break-words max-h-60 overflow-auto">
                {prompt}
              </pre>
            </div>

            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <Label>
                  2a. Raw <code>search</code> output (JSON)
                </Label>
                <Textarea
                  rows={8}
                  value={searchVal}
                  onChange={(e) => onSearch(e.target.value)}
                  placeholder='{"results":[{"url":"https://…","title":"…"}, …]}'
                  className="font-mono text-xs"
                />
              </div>
              <div>
                <Label>
                  2b. Raw <code>read_document</code> output (JSON)
                </Label>
                <Textarea
                  rows={8}
                  value={readVal}
                  onChange={(e) => onRead(e.target.value)}
                  placeholder='{"documents":[{"url":"…","content":"…transcript…"}]}'
                  className="font-mono text-xs"
                />
              </div>
            </div>

            <div className="flex items-center gap-3">
              <Button
                onClick={onImport}
                loading={importing}
                disabled={!searchVal.trim() && !readVal.trim()}
              >
                Import cases from paste
              </Button>
              <span className="text-[11px] text-ink-500">
                Pasting only <code>read_document</code> works too — URLs
                become the case refs.
              </span>
            </div>

            {status && (
              <div
                className={`text-xs ${status.ok ? "text-emerald-400" : "text-red-400"}`}
              >
                <div>{status.msg}</div>
                {status.warnings && status.warnings.length > 0 && (
                  <ul className="mt-1 list-disc pl-5 text-amber-400">
                    {status.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

// ---------- results view ----------

function ResultsView({
  accountName,
  result,
  onBack,
  onRerun,
  rerunning,
}: {
  accountName: string;
  result: AnalyzeResult | null;
  onBack: () => void;
  onRerun: () => void;
  rerunning: boolean;
}) {
  if (!result) {
    return (
      <Card>
        <CardBody>
          <div className="text-sm text-ink-400">No analysis yet.</div>
          <div className="mt-4">
            <Button variant="ghost" onClick={onBack}>
              ← Back
            </Button>
          </div>
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardBody>
          <StepHeading
            eyebrow="Step 4"
            title={`Top Risks — ${accountName}`}
            description={`Aggregated from ${result.signals.length} comment-level signals across ${result.cases.length} case${result.cases.length === 1 ? "" : "s"}.`}
            right={
              <div className="flex items-center gap-2">
                <CopyButton text={JSON.stringify(result, null, 2)} />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={onRerun}
                  loading={rerunning}
                >
                  Re-run
                </Button>
              </div>
            }
          />
          {result.risks.length === 0 ? (
            <div className="text-sm text-ink-400">
              No risks emerged from the signals. Either the cases lacked
              repeated patterns or extraction returned little. Try adding more
              cases.
            </div>
          ) : (
            <ol className="space-y-4">
              {result.risks.map((r) => (
                <RiskCard key={r.rank} risk={r} />
              ))}
            </ol>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Cases analyzed"
          subtitle="Comment counts are what extraction emitted, not the raw line counts."
        />
        <CardBody className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wider text-ink-400">
              <tr>
                <th className="text-left px-3 py-2">Case</th>
                <th className="text-left px-3 py-2">Title</th>
                <th className="text-right px-3 py-2">Comments analyzed</th>
              </tr>
            </thead>
            <tbody>
              {result.cases.map((c) => (
                <tr key={c.caseRef} className="border-t border-ink-800">
                  <td className="px-3 py-2 font-mono text-xs">{c.caseRef}</td>
                  <td className="px-3 py-2">{c.title}</td>
                  <td className="px-3 py-2 text-right">{c.commentsAnalyzed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardBody>
      </Card>

      <SignalsTable signals={result.signals} />

      <div className="flex justify-between">
        <Button variant="ghost" onClick={onBack}>
          ← Back to cases
        </Button>
      </div>
    </div>
  );
}

function confidenceTone(c: Confidence): "success" | "warn" | "danger" {
  if (c === "High") return "success";
  if (c === "Medium") return "warn";
  return "danger";
}

function RiskCard({ risk }: { risk: AggregatedRisk }) {
  return (
    <li className="rounded-lg border border-ink-800 bg-ink-950/50 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Pill tone="accent">#{risk.rank}</Pill>
          <h3 className="text-base font-semibold truncate">{risk.title}</h3>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Pill tone={confidenceTone(risk.confidence)}>
            {risk.confidence} confidence
          </Pill>
          <Pill>{risk.signalFrequency} signals</Pill>
        </div>
      </div>
      <p className="text-sm text-ink-200 leading-relaxed">{risk.description}</p>
      <div className="flex flex-wrap gap-2">
        {risk.ignoredRecommendationFlag && (
          <Pill tone="warn">recommendations not followed</Pill>
        )}
        {risk.frustrationFlag && <Pill tone="danger">customer frustration</Pill>}
      </div>
      {risk.evidence.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs uppercase tracking-wider text-ink-400 hover:text-ink-200">
            Evidence ({risk.evidence.length})
          </summary>
          <ul className="mt-2 space-y-2">
            {risk.evidence.map((e, i) => (
              <li
                key={i}
                className="text-sm rounded-md border border-ink-800 bg-ink-950 px-3 py-2"
              >
                <div className="text-[11px] font-mono text-ink-500">
                  {e.caseRef} · comment #{e.commentIndex}
                </div>
                <div className="italic text-ink-100 mt-1">“{e.quote}”</div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

function SignalsTable({ signals }: { signals: CommentSignals[] }) {
  const [open, setOpen] = useState(false);
  if (signals.length === 0) return null;
  return (
    <Card>
      <CardHeader
        title={`All comment signals (${signals.length})`}
        right={
          <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)}>
            {open ? "Hide" : "Show"}
          </Button>
        }
      />
      {open && (
        <CardBody className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-[11px] uppercase tracking-wider text-ink-400">
              <tr>
                <th className="text-left px-2 py-1.5">Case</th>
                <th className="text-left px-2 py-1.5">#</th>
                <th className="text-left px-2 py-1.5">Actor</th>
                <th className="text-left px-2 py-1.5">Type</th>
                <th className="text-left px-2 py-1.5">Sentiment</th>
                <th className="text-left px-2 py-1.5">Technical signals</th>
                <th className="text-left px-2 py-1.5">Risk indicators</th>
              </tr>
            </thead>
            <tbody>
              {signals.map((s, i) => (
                <tr key={i} className="border-t border-ink-800 align-top">
                  <td className="px-2 py-1.5 font-mono">{s.caseRef}</td>
                  <td className="px-2 py-1.5">{s.commentIndex}</td>
                  <td className="px-2 py-1.5">{s.actor}</td>
                  <td className="px-2 py-1.5">{s.messageType}</td>
                  <td className="px-2 py-1.5">{s.sentiment}</td>
                  <td className="px-2 py-1.5">
                    {s.technicalSignals.join(", ") || "—"}
                  </td>
                  <td className="px-2 py-1.5">
                    {s.riskIndicators.join(", ") || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardBody>
      )}
    </Card>
  );
}
