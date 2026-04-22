"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CopyButton,
  Input,
  Label,
  Select,
  Textarea,
} from "@/components/ui";
import { Stepper, StepHeading, type Step } from "@/components/Stepper";
import {
  clearAssessment,
  DEFAULT_SETTINGS,
  loadAssessment,
  loadSettings,
  saveAssessment,
  type Settings,
} from "@/lib/storage";
import {
  buildGleanChatQueries,
  buildGleanQueries,
} from "@/lib/risk-skill";
import { track } from "@/lib/track";
import { exportPdf } from "@/lib/pdf-export";
import type {
  AssessmentInput,
  AssessmentState,
  GatheredArtifact,
} from "@/lib/types";

/**
 * Event shape from POST /api/agent/run SSE stream. Narrower than the server
 * type so the Wizard can render each event without defensive checks.
 */
type AgentEvent =
  | { type: "status"; message: string }
  | {
      type: "step_start";
      step: number;
      toolCalls: { id: string; name: string; argsPreview: string }[];
    }
  | {
      type: "tool_result";
      id: string;
      name: string;
      summary: string;
      ok: boolean;
    }
  | { type: "final"; report: string }
  | { type: "error"; error: string };

/** Per-prompt row shown in the Auto Triage pipeline progress panel. */
interface TriageLogEntry {
  key: string;
  label: string;
  status: "pending" | "running" | "ok" | "error";
  detail?: string;
  durationMs?: number;
  /** Whether the markdown came from the DB cache or from a fresh Hub call. */
  source?: "cached" | "fresh";
  /** Parsed case status (case-summary / precedent-research only). */
  caseStatus?: "closed" | "open" | "unknown";
}

interface TriageCacheCounts {
  hit: number;
  miss: number;
  staleRefresh: number;
}

const STEPS: Step[] = [
  { id: "context", title: "Account Context" },
  { id: "gather", title: "Auto-Gather" },
  { id: "report", title: "Draft Report" },
  { id: "review", title: "Review & Export" },
];

/** Named progress stages shown while one-shot LLM generation is running.
 *  `ms` = milliseconds after the fetch starts before jumping to that stage. */
const GEN_STAGES = [
  { pct: 5,  label: "Preparing artifacts for LLM",  ms: 0 },
  { pct: 15, label: "Sending to LLM",               ms: 2_000 },
  { pct: 35, label: "Analyzing support cases",       ms: 8_000 },
  { pct: 55, label: "Identifying risk patterns",     ms: 28_000 },
  { pct: 72, label: "Drafting recommendations",      ms: 55_000 },
  { pct: 86, label: "Formatting report structure",   ms: 80_000 },
  { pct: 94, label: "Finalizing",                    ms: 105_000 },
] as const;

const EMPTY_INPUT: AssessmentInput = {
  accountName: "",
  motivation: "",
  timeframeMonths: 6,
  knownConcerns: "",
};

/** Days before a cached artifact is considered stale and re-fetched. */
const FRESHNESS_DAYS = 30;

/** Persist current wizard state to MongoDB (returns true on success). */
async function dbSave(state: {
  input: AssessmentInput | null;
  artifacts: GatheredArtifact[];
  report: string;
}): Promise<boolean> {
  if (!state.input?.accountName) return false;
  try {
    const res = await fetch("/api/db/assessments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Load previously saved assessment from MongoDB for a given account.
 *  Prefers salesforceId lookup when available; falls back to account name. */
async function dbLoad(account: string | null, salesforceId?: string): Promise<AssessmentState | null> {
  try {
    const param = salesforceId
      ? `salesforceId=${encodeURIComponent(salesforceId)}`
      : account
        ? `account=${encodeURIComponent(account)}`
        : null;
    if (!param) return null;
    const res = await fetch(`/api/db/assessments?${param}`);
    const json = await res.json();
    return json.ok && json.assessment ? (json.assessment as AssessmentState) : null;
  } catch {
    return null;
  }
}

/** Load cached artifacts from MongoDB, returning only fresh ones.
 *  Prefers salesforceId lookup when available; falls back to account name. */
async function dbLoadArtifacts(
  account: string | null,
  salesforceId?: string,
): Promise<(GatheredArtifact & { fetchedAt?: string })[]> {
  try {
    const param = salesforceId
      ? `salesforceId=${encodeURIComponent(salesforceId)}`
      : account
        ? `account=${encodeURIComponent(account)}`
        : null;
    if (!param) return [];
    const res = await fetch(`/api/db/artifacts?${param}`);
    const json = await res.json();
    if (!json.ok) return [];
    // Server already purges artifacts older than 30 days;
    // anything returned is fresh enough to reuse.
    return json.artifacts ?? [];
  } catch {
    return [];
  }
}

/** Persist artifacts to MongoDB for future delta re-use.
 *  Includes salesforceId so future lookups can use it as the key. */
async function dbSaveArtifacts(
  account: string,
  artifacts: GatheredArtifact[],
  salesforceId?: string,
) {
  try {
    await fetch("/api/db/artifacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account, salesforceId, artifacts }),
    });
  } catch {
    /* silent */
  }
}

/** Ping the DB to confirm it is reachable. */
async function dbPing(): Promise<boolean> {
  try {
    const res = await fetch("/api/db/assessments", { method: "GET" });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Ask Glean to resolve a Salesforce ID and canonical account name for a
 * user-supplied query (name or raw SF ID). Returns null if Glean cannot
 * find a match or the request fails.
 */
async function gleanLookupAccount(
  query: string,
  gleanToken?: string,
  gleanUrl?: string,
): Promise<{ salesforceId: string; canonicalName: string } | null> {
  const sfIdRe = /\b(001[A-Za-z0-9]{12,15})\b/;
  const isSfId = sfIdRe.test(query.trim());

  /** Extract SF ID + canonical name from any blob of text + citations. */
  function extractFromText(
    text: string,
    citations: Array<{ url?: string; title?: string; snippet?: string }>,
    fallbackName: string,
  ): { salesforceId: string; canonicalName: string } | null {
    // 1. Structured JSON in response body
    const jsonMatch = text.match(
      /\{[^{}]*"salesforceId"\s*:\s*"(001[A-Za-z0-9]{12,15})"[^{}]*"canonicalName"\s*:\s*"([^"]+)"[^{}]*\}/,
    );
    if (jsonMatch) return { salesforceId: jsonMatch[1], canonicalName: jsonMatch[2].trim() };

    // 2. SF ID anywhere in text or citation URLs
    let salesforceId = sfIdRe.exec(text)?.[1];
    if (!salesforceId) {
      for (const cit of citations) {
        const urlMatch = (cit.url ?? "").match(/\/account\/(001[A-Za-z0-9]{12,15})\//);
        if (urlMatch) { salesforceId = urlMatch[1]; break; }
        const m = sfIdRe.exec(cit.url ?? "");
        if (m) { salesforceId = m[1]; break; }
      }
    }
    if (!salesforceId) return null;

    // 3. Canonical name from Hub citation titles, then JSON field, then fallback
    let canonicalName = "";
    for (const cit of citations) {
      const hubMatch = (cit.title ?? "").match(/^(.+?)\s*[-–—]\s*MongoDB\s*Hub/i);
      if (hubMatch) { canonicalName = hubMatch[1].trim(); break; }
      const sfMatch = (cit.title ?? "").match(/Account:\s*(.+)/i);
      if (sfMatch) { canonicalName = sfMatch[1].trim(); break; }
    }
    if (!canonicalName) {
      const m = text.match(/"canonicalName"\s*:\s*"([^"]+)"/);
      canonicalName = m ? m[1].trim() : "";
    }
    // 4. Extract the name from Hub URL title patterns in plain text
    if (!canonicalName) {
      const hubInText = text.match(/hub\.corp\.mongodb\.com\/account\/[A-Za-z0-9]+\/overview.*?[(\[]([^\])\n]+)[)\]]/i);
      if (hubInText) canonicalName = hubInText[1].trim();
    }

    return { salesforceId, canonicalName: canonicalName || fallbackName };
  }

  try {
    const chatMessage = isSfId
      ? `I have a Salesforce account ID: ${query.trim()}. What is the official account name for this ID? ` +
        `Search MongoDB Hub (hub.corp.mongodb.com/account/${query.trim()}/overview) and Salesforce. ` +
        `Return: {"salesforceId":"${query.trim()}","canonicalName":"<official name>"}`
      : `Find the Salesforce account ID for MongoDB customer "${query}". ` +
        `Search MongoDB Hub (hub.corp.mongodb.com), Salesforce account pages, and internal docs. ` +
        `The ID starts with 001 and is 15 or 18 characters. ` +
        `Return: {"salesforceId":"<001...>","canonicalName":"<official Salesforce name>"}`;

    // Stage 1: Glean chat
    const chatRes = await fetch("/api/glean/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: chatMessage, gleanToken, gleanUrl }),
    });
    const chatJson = await chatRes.json();
    const chatText = (typeof chatJson.answer === "string" ? chatJson.answer : "") +
      " " + JSON.stringify(chatJson.citations ?? []);
    const chatResult = extractFromText(chatText, chatJson.citations ?? [], query);
    if (chatResult) return chatResult;

    // Stage 2: Glean search — Hub pages embed the SF ID in the URL
    const searchRes = await fetch("/api/glean/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        args: { query: `${query} site:hub.corp.mongodb.com OR salesforce`, pageSize: 8 },
        gleanToken,
        gleanUrl,
      }),
    });
    const searchJson = await searchRes.json();
    const hits: Array<{ url?: string; title?: string; snippet?: string }> = searchJson.hits ?? [];
    const searchText = hits.map((h) => `${h.url ?? ""} ${h.title ?? ""} ${h.snippet ?? ""}`).join(" ");
    const searchResult = extractFromText(searchText, hits, query);
    if (searchResult) return searchResult;

    return null;
  } catch {
    return null;
  }
}

/**
 * Scan Glean artifacts for a Salesforce account ID and the canonical
 * account name (the official name Salesforce knows, e.g. "Zomato Limited").
 * Salesforce IDs are 15 or 18 alphanumeric chars starting with "001".
 */
function extractSalesforceInfo(artifacts: GatheredArtifact[]): {
  salesforceId?: string;
  canonicalName?: string;
} {
  const sfIdRe = /\b(001[A-Za-z0-9]{12,15})\b/;
  // Heuristic: look for "account:" or "Account Name:" followed by the name
  const nameRe = /(?:account\s*(?:name)?\s*[:=]\s*["']?)([A-Z][^"'\n,]{2,60}?)(?:["'\s,\n]|$)/i;
  let salesforceId: string | undefined;
  let canonicalName: string | undefined;
  for (const a of artifacts) {
    const text = typeof a.data === "string" ? a.data : JSON.stringify(a.data);
    if (!salesforceId) {
      const m = sfIdRe.exec(text);
      if (m) salesforceId = m[1];
    }
    // Try to grab the official account name from Glean citations or body
    if (!canonicalName) {
      // Check citations for Salesforce / Hub titles that often carry the canonical name
      for (const cit of a.citations ?? []) {
        const title = cit.title ?? "";
        // Hub pages: "Zomato Limited - MongoDB Hub"
        const hubMatch = title.match(/^(.+?)\s*[-–—]\s*MongoDB\s*Hub/i);
        if (hubMatch) { canonicalName = hubMatch[1].trim(); break; }
        // Salesforce: "Account: Zomato Limited"
        const sfMatch = title.match(/Account:\s*(.+)/i);
        if (sfMatch) { canonicalName = sfMatch[1].trim(); break; }
      }
    }
    if (!canonicalName) {
      const nm = nameRe.exec(text);
      if (nm) canonicalName = nm[1].trim();
    }
    if (salesforceId && canonicalName) break;
  }
  return { salesforceId, canonicalName };
}

const cleanLabel = (s: string) => s.replace(/^Glean (chat|search)\s*[—\-]\s*/i, "");

function StatusDot({
  status,
}: {
  status: "pending" | "ok" | "error" | "queued" | "cached";
}) {
  const color =
    status === "ok"
      ? "#10B981"
      : status === "error"
        ? "#EF4444"
        : status === "queued"
          ? "#F59E0B"
          : "#3B82F6";

  return (
    <span
      aria-hidden="true"
      className="inline-block h-2 w-2 rounded-full"
      style={{ backgroundColor: color }}
    />
  );
}

export function Wizard() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [stepIdx, setStepIdx] = useState(0);
  const [input, setInput] = useState<AssessmentInput>(EMPTY_INPUT);
  const [artifacts, setArtifacts] = useState<GatheredArtifact[]>([]);
  const [report, setReport] = useState("");

  const router = useRouter();
  const searchParams = useSearchParams();
  const [checkingReport, setCheckingReport] = useState(false);
  const [gathering, setGathering] = useState(false);
  const [gatherLog, setGatherLog] = useState<
    { label: string; status: "pending" | "ok" | "error"; detail?: string }[]
  >([]);
  const [triageRunning, setTriageRunning] = useState(false);
  const [triageLog, setTriageLog] = useState<TriageLogEntry[]>([]);
  const [triageResolvedCases, setTriageResolvedCases] = useState<string[]>([]);
  const [triageSkipReason, setTriageSkipReason] = useState<string | null>(null);
  const [triageCacheCounts, setTriageCacheCounts] =
    useState<TriageCacheCounts | null>(null);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [agentEvents, setAgentEvents] = useState<AgentEvent[]>([]);
  const [pdfExporting, setPdfExporting] = useState(false);
  const [reportFromCache, setReportFromCache] = useState(false);
  const [genProgress, setGenProgress] = useState<{ pct: number; label: string } | null>(null);
  const [dbOnline, setDbOnline] = useState<boolean | null>(null); // null = checking
  const [artifactsFreshlyGathered, setArtifactsFreshlyGathered] = useState(false);
  const [reportGeneratedAt, setReportGeneratedAt] = useState<string | null>(null);
  const [gatherTriggered, setGatherTriggered] = useState(false);
  const [forceRefreshOnGather, setForceRefreshOnGather] = useState(false);
  const forceRefreshOnGatherRef = useRef(false);

  // Step 1 — account lookup state
  const [lookupQuery, setLookupQuery] = useState(""); // raw user input (name or SF ID)
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupResult, setLookupResult] = useState<{ salesforceId: string; canonicalName: string } | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);

  /** 30-day TTL for cached reports and PDFs. */
  const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

  // Load from MongoDB first, fall back to localStorage
  useEffect(() => {
    setSettings(loadSettings());

    // Read URL params synchronously before any async work
    const urlForce = searchParams.get("forceRefresh") === "true";
    const urlSfId = searchParams.get("sfId") ?? undefined;
    if (urlForce) {
      forceRefreshOnGatherRef.current = true;
      setForceRefreshOnGather(true);
    }

    (async () => {
      // Boot-up DB connectivity check
      const online = await dbPing();
      setDbOnline(online);

      // Try localStorage first for instant load
      const prior = loadAssessment<AssessmentState>();
      if (prior?.input?.accountName) {
        setInput(prior.input);
        setArtifacts(prior.artifacts ?? []);
        setReport(prior.report ?? "");
        setLookupQuery(prior.input.canonicalName || prior.input.accountName);
        if (prior.input.salesforceId && prior.input.canonicalName) {
          setLookupResult({ salesforceId: prior.input.salesforceId, canonicalName: prior.input.canonicalName });
        }
        track({ event: "account_opened", account: prior.input.accountName, salesforceId: prior.input.salesforceId });
        // Then try MongoDB for potentially more recent data
        const dbState = await dbLoad(prior.input.accountName, prior.input.salesforceId);
        if (dbState?.input?.accountName) {
          const dbTime = (dbState as unknown as Record<string, unknown>).updatedAt as string | undefined;
          if (dbTime) {
            setInput(dbState.input!);
            setArtifacts(dbState.artifacts ?? []);
            setReport(dbState.report ?? "");
            setReportGeneratedAt(dbTime);
          }
        }
        const freshArts = await dbLoadArtifacts(prior.input.accountName, prior.input.salesforceId);
        if (freshArts.length > 0) setArtifactsFreshlyGathered(true);

        // Jump to Step 2 if forceRefresh requested and we have an account loaded
        if (urlForce) {
          setStepIdx(1);
        }
      } else if (urlForce && urlSfId) {
        // localStorage empty/stale but we have ?sfId= — load account from DB directly
        const dbState = await dbLoad(null, urlSfId);
        if (dbState?.input?.accountName) {
          setInput(dbState.input!);
          setArtifacts(dbState.artifacts ?? []);
          setReport(dbState.report ?? "");
          setLookupQuery(dbState.input.canonicalName || dbState.input.accountName);
          if (dbState.input.salesforceId && dbState.input.canonicalName) {
            setLookupResult({ salesforceId: dbState.input.salesforceId, canonicalName: dbState.input.canonicalName });
          }
          const dbTime = (dbState as unknown as Record<string, unknown>).updatedAt as string | undefined;
          if (dbTime) setReportGeneratedAt(dbTime);
          const freshArts = await dbLoadArtifacts(null, urlSfId);
          if (freshArts.length > 0) setArtifactsFreshlyGathered(true);
          track({ event: "account_opened", account: dbState.input.accountName, salesforceId: dbState.input.salesforceId });
          setStepIdx(1);
        }
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist to localStorage immediately for instant page-refresh recovery.
  // MongoDB writes happen only at explicit action points (gather, generate)
  // to avoid keystroke-debris records ("A","Ad","Ado"…).
  useEffect(() => {
    const state: AssessmentState = {
      input: input.accountName ? input : null,
      artifacts,
      report,
    };
    saveAssessment<AssessmentState>(state);
  }, [input, artifacts, report]);

  const canProceedFromContext =
    !!input.salesforceId &&
    input.motivation.trim().length > 0 &&
    input.timeframeMonths > 0;

  // Always use the canonical name in Glean queries
  const gleanAccountName = input.canonicalName || input.accountName || "{account}";

  const gleanQueries = useMemo(
    () => buildGleanQueries(gleanAccountName),
    [gleanAccountName],
  );
  const gleanChatPrompts = useMemo(
    () =>
      buildGleanChatQueries(
        gleanAccountName,
        input.timeframeMonths,
        input.knownConcerns,
      ),
    [gleanAccountName, input.timeframeMonths, input.knownConcerns],
  );

  // Auto-trigger gather when Step 2 is entered for the first time
  useEffect(() => {
    if (stepIdx === 1 && !gatherTriggered && !gathering) {
      setGatherTriggered(true);
      // Use ref so we always get the latest value even if state hasn't flushed yet
      const force = forceRefreshOnGatherRef.current;
      forceRefreshOnGatherRef.current = false;
      setForceRefreshOnGather(false);
      runGather(force);
    }
  }, [stepIdx]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleLookup() {
    const q = lookupQuery.trim();
    if (!q) return;
    setLookupLoading(true);
    setLookupError(null);
    setLookupResult(null);
    const result = await gleanLookupAccount(q, settings.gleanToken || undefined, settings.gleanMcpUrl || undefined);
    setLookupLoading(false);
    if (result) {
      setLookupResult(result);
    } else {
      setLookupError("Could not resolve a Salesforce ID for this account. Check the name and try again, or enter the SF ID directly.");
    }
  }

  function confirmLookup() {
    if (!lookupResult) return;
    setInput((prev) => ({
      ...prev,
      accountName: lookupResult.canonicalName,
      canonicalName: lookupResult.canonicalName,
      salesforceId: lookupResult.salesforceId,
    }));
  }

  /** Build a stable URL to the report page, always including sfId so the
   *  report page can find the record even if the account name changed. */
  function reportUrl(inp: AssessmentInput): string {
    const slug = encodeURIComponent(inp.canonicalName || inp.accountName);
    return inp.salesforceId
      ? `/reports/${slug}?sfId=${encodeURIComponent(inp.salesforceId)}`
      : `/reports/${slug}`;
  }

  async function runGather(forceRefresh = false) {
    setGathering(true);
    setGatherLog([]);
    const collected: GatheredArtifact[] = [];

    // ── Delta fetch: load cached artifacts from MongoDB (skip if force refresh) ──
    let cachedKeys = new Set<string>();
    if (!forceRefresh) {
      const cached = await dbLoadArtifacts(input.accountName, input.salesforceId);
      cachedKeys = new Set(
        cached.map((a) => `${a.kind}::${a.label}`),
      );
      // Reuse fresh cached artifacts
      for (const a of cached) {
        collected.push({
          source: a.source ?? ("glean" as const),
          kind: a.kind,
          query: a.query,
          label: a.label,
          data: a.data,
          citations: a.citations,
        });
        setGatherLog((log) => [
          ...log,
          { label: `${a.label}`, status: "ok", detail: "cached" },
        ]);
      }
    }

    // Glean chat — only fetch prompts NOT already cached
    const chatToFetch = gleanChatPrompts.filter(
      (c) => !cachedKeys.has(`chat::${c.label}`),
    );
    await Promise.all(
      chatToFetch.map(async (c) => {
        const label = c.label;
        setGatherLog((log) => [...log, { label, status: "pending" }]);
        try {
          const res = await fetch("/api/glean/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message: c.message,
              gleanToken: settings.gleanToken || undefined,
              gleanUrl: settings.gleanMcpUrl || undefined,
            }),
          });
          const json = await res.json();
          if (json.ok && (json.answer || (json.citations ?? []).length > 0)) {
            collected.push({
              source: "glean",
              kind: "chat",
              query: c.message,
              label: c.label,
              data: json.answer || "(empty answer)",
              citations: json.citations ?? [],
            });
            setGatherLog((log) =>
              log.map((l) => (l.label === label ? { ...l, status: "ok" } : l)),
            );
          } else {
            setGatherLog((log) =>
              log.map((l) =>
                l.label === label
                  ? {
                      ...l,
                      status: "error",
                      detail: json.error || "empty response",
                    }
                  : l,
              ),
            );
          }
        } catch (err) {
          setGatherLog((log) =>
            log.map((l) =>
              l.label === label
                ? { ...l, status: "error", detail: (err as Error).message }
                : l,
            ),
          );
        }
      }),
    );

    // Glean search — only fetch queries NOT already cached.
    const searchToFetch = gleanQueries.filter(
      (q) => !cachedKeys.has(`search::${q.label}`),
    );
    await Promise.all(
      searchToFetch.map(async (q) => {
        const label = q.label;
        setGatherLog((log) => [...log, { label, status: "pending" }]);
        try {
          const args: Record<string, unknown> = { query: q.query, pageSize: 5 };
          if (q.app) args.app = q.app;
          const res = await fetch("/api/glean/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              args,
              gleanToken: settings.gleanToken || undefined,
              gleanUrl: settings.gleanMcpUrl || undefined,
            }),
          });
          const json = await res.json();
          if (json.ok) {
            collected.push({
              source: "glean",
              kind: "search",
              query: q.query,
              label: q.label,
              data: json.hits ?? [],
            });
            setGatherLog((log) =>
              log.map((l) => (l.label === label ? { ...l, status: "ok" } : l)),
            );
          } else {
            setGatherLog((log) =>
              log.map((l) =>
                l.label === label
                  ? { ...l, status: "error", detail: json.error }
                  : l,
              ),
            );
          }
        } catch (err) {
          setGatherLog((log) =>
            log.map((l) =>
              l.label === label
                ? { ...l, status: "error", detail: (err as Error).message }
                : l,
            ),
          );
        }
      }),
    );

    setArtifacts(collected);
    // Persist all gathered artifacts to MongoDB (both delta and force paths)
    // Extract Salesforce ID + canonical name from artifacts before saving
    const sfInfo = extractSalesforceInfo(collected);
    const sfId = sfInfo.salesforceId;
    await dbSaveArtifacts(input.accountName, collected, sfId ?? input.salesforceId);

    // Update input with SF ID and canonical name
    const updatedInput = { ...input };
    if (sfId && sfId !== input.salesforceId) {
      updatedInput.salesforceId = sfId;
    }
    if (sfInfo.canonicalName && sfInfo.canonicalName !== input.canonicalName) {
      updatedInput.canonicalName = sfInfo.canonicalName;
    }
    if (updatedInput !== input) setInput(updatedInput);

    // Persist assessment (input + artifacts, no report yet) so data survives
    // tab close / page refresh without creating keystroke-debris records.
    await dbSave({ input: updatedInput, artifacts: collected, report });

    // Mark artifacts as freshly gathered so step 3 knows to force a fresh LLM call
    setArtifactsFreshlyGathered(true);
    track({
      event: "artifacts_gathered",
      account: input.accountName,
      salesforceId: sfId ?? input.salesforceId,
      metadata: { forceRefresh, artifactCount: collected.length },
    });
    setGathering(false);

    // Phase 2 — Auto Triage case intelligence. Runs case-summary +
    // precedent-research per extracted case, then account-support-health.
    // Kept in runGather's lifecycle so a single Step 2 completion gate
    // covers both Glean + Auto Triage before proceeding to Step 3.
    const accountForTriage =
      updatedInput.canonicalName || updatedInput.accountName;
    const enrichedArtifacts = await runTriagePipeline(
      accountForTriage,
      collected,
      forceRefresh,
    );
    if (enrichedArtifacts !== collected) {
      setArtifacts(enrichedArtifacts);
      await dbSaveArtifacts(
        input.accountName,
        enrichedArtifacts,
        sfId ?? input.salesforceId,
      );
      await dbSave({
        input: updatedInput,
        artifacts: enrichedArtifacts,
        report,
      });
    }
  }

  /**
   * Run the Auto Triage pipeline for the cases referenced in `artifacts`.
   * Streams progress events into `triageLog`, appends a `case-intelligence`
   * artifact on success. No-op if no case numbers found or if an intelligence
   * artifact is already present (unless `forceRefresh`).
   */
  async function runTriagePipeline(
    accountName: string,
    artifacts: GatheredArtifact[],
    forceRefresh: boolean,
  ): Promise<GatheredArtifact[]> {
    setTriageSkipReason(null);
    setTriageLog([]);
    setTriageResolvedCases([]);
    setTriageCacheCounts(null);

    // Note: even if an artifact-level case-intelligence entry already
    // exists, we still re-run. The per-(case, prompt) MongoDB cache will
    // skip actual Hub calls for closed / fresh cases and only delta-fetch
    // the open/stale ones.
    setTriageRunning(true);
    try {
      const res = await fetch("/api/triage/pipeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountName,
          salesforceId: input.salesforceId,
          artifacts: artifacts.filter((a) => a.kind !== "case-intelligence"),
          forceRefresh,
        }),
      });

      if (!res.ok && !res.body) {
        const err = await res.text().catch(() => "");
        setTriageSkipReason(`Pipeline unreachable (HTTP ${res.status}) ${err.slice(0, 120)}`);
        return artifacts;
      }
      const reader = res.body?.getReader();
      if (!reader) {
        setTriageSkipReason("Pipeline produced no stream");
        return artifacts;
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let intelligence: unknown = null;
      let fatalError: string | null = null;

      const keyOf = (promptId: string, caseNumber?: string, batchLabel?: string) =>
        caseNumber
          ? `${promptId}:${caseNumber}`
          : `${promptId}:${batchLabel ?? "all"}`;
      const labelOf = (promptId: string, caseNumber?: string, batchLabel?: string) => {
        if (promptId === "case-summary") return `Case ${caseNumber} — summary`;
        if (promptId === "precedent-research") return `Case ${caseNumber} — precedents`;
        if (promptId === "account-support-health")
          return `Account health${batchLabel ? ` (${batchLabel})` : ""}`;
        return promptId;
      };

      const processEvent = (json: string) => {
        let evt: { type?: string; [k: string]: unknown };
        try {
          evt = JSON.parse(json);
        } catch {
          return;
        }
        if (evt.type === "cases_resolved") {
          const cases = (evt.cases as string[]) ?? [];
          setTriageResolvedCases(cases);
          if (cases.length === 0) {
            fatalError = "No case numbers found in Glean artifacts";
          }
        } else if (evt.type === "cache_scan") {
          const counts = evt.cacheCounts as TriageCacheCounts | undefined;
          if (counts) setTriageCacheCounts(counts);
        } else if (evt.type === "prompt_start") {
          const run = evt.run as {
            promptId: string;
            caseNumber?: string;
            batchLabel?: string;
            source?: "cached" | "fresh";
          };
          const key = keyOf(run.promptId, run.caseNumber, run.batchLabel);
          setTriageLog((log) => {
            if (log.some((l) => l.key === key)) {
              return log.map((l) =>
                l.key === key
                  ? { ...l, status: "running", source: run.source }
                  : l,
              );
            }
            return [
              ...log,
              {
                key,
                label: labelOf(run.promptId, run.caseNumber, run.batchLabel),
                status: "running",
                source: run.source,
              },
            ];
          });
        } else if (evt.type === "prompt_done") {
          const run = evt.run as {
            promptId: string;
            caseNumber?: string;
            batchLabel?: string;
            status: "ok" | "error";
            error?: string;
            durationMs?: number;
            source?: "cached" | "fresh";
            caseStatus?: "closed" | "open" | "unknown";
          };
          const key = keyOf(run.promptId, run.caseNumber, run.batchLabel);
          setTriageLog((log) =>
            log.map((l) =>
              l.key === key
                ? {
                    ...l,
                    status: run.status,
                    detail: run.error,
                    durationMs: run.durationMs,
                    source: run.source ?? l.source,
                    caseStatus: run.caseStatus,
                  }
                : l,
            ),
          );
        } else if (evt.type === "final") {
          intelligence = evt.intelligence;
        } else if (evt.type === "error") {
          fatalError = (evt.error as string) ?? "Pipeline error";
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep = buffer.indexOf("\n\n");
        while (sep !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const dataLines = frame
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim());
          if (dataLines.length > 0) processEvent(dataLines.join("\n"));
          sep = buffer.indexOf("\n\n");
        }
      }

      if (fatalError) {
        setTriageSkipReason(fatalError);
        return artifacts;
      }
      if (!intelligence) {
        setTriageSkipReason("Pipeline finished without producing intelligence");
        return artifacts;
      }

      const intelArtifact: GatheredArtifact = {
        source: "auto-triage",
        kind: "case-intelligence",
        label: "Auto Triage case intelligence",
        data: intelligence,
      };
      const intel = intelligence as {
        cases?: string[];
        stats?: {
          caseCount?: number;
          promptsRun?: number;
          promptsReused?: number;
          promptsFailed?: number;
          durationMs?: number;
        };
      };
      track({
        event: "triage_pipeline_run",
        account: accountName,
        salesforceId: input.salesforceId,
        metadata: {
          cases: intel.cases?.length ?? 0,
          promptsFetched: intel.stats?.promptsRun ?? 0,
          promptsReused: intel.stats?.promptsReused ?? 0,
          promptsFailed: intel.stats?.promptsFailed ?? 0,
          durationMs: intel.stats?.durationMs ?? 0,
          forceRefresh,
        },
      });
      return [
        ...artifacts.filter((a) => a.kind !== "case-intelligence"),
        intelArtifact,
      ];
    } catch (err) {
      setTriageSkipReason((err as Error).message);
      return artifacts;
    } finally {
      setTriageRunning(false);
    }
  }

  async function runGenerate(forceGenerate = false) {
    setGenerating(true);
    setGenError(null);
    setAgentEvents([]);
    // Do NOT reset genProgress here — runOneShot sets it immediately on entry

    // Fresh artifacts always bypass cache so report matches current evidence
    const shouldForce = forceGenerate || artifactsFreshlyGathered;

    try {
      if (!shouldForce) {
        // 1. In-memory report — fastest, no network call needed
        if (report) {
          setReportFromCache(true);
          router.push(reportUrl(input));
          setGenerating(false);
          return;
        }
        // 2. DB cache (< 30 days)
        const cached = await dbLoad(input.accountName, input.salesforceId);
        if (cached?.report) {
          const updatedAt = (cached as unknown as Record<string, unknown>).updatedAt as string | undefined;
          if (updatedAt && Date.now() - new Date(updatedAt).getTime() < CACHE_TTL_MS) {
            setReport(cached.report);
            setReportFromCache(true);
            setReportGeneratedAt(updatedAt);
            track({ event: "report_viewed_cached", account: input.accountName, salesforceId: input.salesforceId });
            router.push(reportUrl(input));
            setGenerating(false);
            return;
          }
        }
      }

      setReportFromCache(false);
      if (settings.llmProvider === "mongogpt" && artifacts.length === 0) {
        await runAgent();
      } else {
        await runOneShot();
      }
    } catch (err) {
      setGenError((err as Error).message);
    } finally {
      setGenerating(false);
      setGenProgress(null);
    }
  }

  /** One-shot generation — pre-gathered artifacts fed to
   * /api/generate. Works for all providers (OpenAI, Anthropic, MongoGPT). */
  async function runOneShot() {
    const provider = settings.llmProvider;
    const apiKey =
      provider === "openai"
        ? settings.openaiApiKey
        : provider === "anthropic"
          ? settings.anthropicApiKey
          : "";
    const model =
      provider === "openai"
        ? settings.openaiModel
        : provider === "anthropic"
          ? settings.anthropicModel
          : settings.mongogptModel;

    // Kick off timer-driven progress stages
    const timers = GEN_STAGES.map(({ pct, label, ms }) =>
      setTimeout(() => setGenProgress({ pct, label }), ms),
    );

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input,
          artifacts,
          provider,
          apiKey,
          model,
          mongogptUrl: provider === "mongogpt" ? settings.mongogptUrl || undefined : undefined,
        }),
      });
      timers.forEach(clearTimeout);
      const json = await res.json();
      if (json.ok) {
        setGenProgress({ pct: 100, label: "Report ready!" });
        const now = new Date().toISOString();
        setReport(json.report);
        setReportGeneratedAt(now);
        setArtifactsFreshlyGathered(false);
        track({
          event: "report_generated",
          account: input.accountName,
          salesforceId: input.salesforceId,
          metadata: { provider, model, artifactCount: artifacts.length, generatedAt: now },
        });
        await dbSave({ input, artifacts, report: json.report });
        router.push(reportUrl(input));
      } else {
        setGenProgress(null);
        setGenError(json.error || "Generation failed.");
      }
    } catch (err) {
      timers.forEach(clearTimeout);
      setGenProgress(null);
      throw err;
    }
  }

  /** Agentic run for MongoGPT — streams SSE events from /api/agent/run so
   * the user sees each tool call as it happens. The model calls glean_chat /
   * glean_search / glean_read_document itself; we only feed it the account
   * context upfront. */
  async function runAgent() {
    const res = await fetch("/api/agent/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input,
        artifacts,
        model: settings.mongogptModel,
        mongogptUrl: settings.mongogptUrl || undefined,
        gleanToken: settings.gleanToken || undefined,
        gleanUrl: settings.gleanMcpUrl || undefined,
      }),
    });

    if (!res.ok && !res.body) {
      setGenError(`Agent run failed: HTTP ${res.status}`);
      return;
    }

    const reader = res.body?.getReader();
    if (!reader) {
      setGenError("Agent run produced no stream.");
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let finalReport = "";
    let sawError: string | null = null;

    const processEvent = (json: string) => {
      let evt: AgentEvent;
      try {
        evt = JSON.parse(json) as AgentEvent;
      } catch {
        return;
      }
      if (evt.type === "final") {
        finalReport = evt.report;
      } else if (evt.type === "error") {
        sawError = evt.error;
      } else {
        setAgentEvents((prev) => [...prev, evt]);
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line (\n\n). Each frame may
      // carry multiple `data:` lines; we concatenate them before parsing.
      let sepIdx = buffer.indexOf("\n\n");
      while (sepIdx !== -1) {
        const frame = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx + 2);
        const dataLines = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim());
        if (dataLines.length > 0) processEvent(dataLines.join("\n"));
        sepIdx = buffer.indexOf("\n\n");
      }
    }

    if (sawError) {
      setGenError(sawError);
      return;
    }
    if (!finalReport) {
      setGenError("Agent finished without producing a report.");
      return;
    }
    const now = new Date().toISOString();
    setReport(finalReport);
    setReportGeneratedAt(now);
    setArtifactsFreshlyGathered(false);
    await dbSave({ input, artifacts, report: finalReport });
    router.push(reportUrl(input));
  }

  async function handleDownloadPdf() {
    setPdfExporting(true);
    try {
      await exportPdf({
        markdown: report,
        accountName: input.accountName,
        timeframeMonths: input.timeframeMonths,
        motivation: input.motivation,
      });
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setPdfExporting(false);
    }
  }

  function resetAll() {
    if (!confirm("Start a fresh report? Current draft will be cleared.")) return;
    clearAssessment();
    setInput(EMPTY_INPUT);
    setArtifacts([]);
    setReport("");
    setGatherLog([]);
    setAgentEvents([]);
    setStepIdx(0);
  }

  const hasSettings =
    !!settings.gleanToken &&
    ((settings.llmProvider === "openai" && !!settings.openaiApiKey) ||
      (settings.llmProvider === "anthropic" && !!settings.anthropicApiKey) ||
      (settings.llmProvider === "mongogpt" && !!settings.mongogptModel));

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-ink-100">
            Case Risk Analysis
          </h1>
          <p className="mt-2 max-w-2xl text-[13px] text-ink-400">
            Analyze support history, gather account evidence, identify risk patterns,
            and produce a draft your internal reviewers can act on.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!hasSettings && (
            <Link href="/settings?returnTo=/">
              <Button variant="secondary" size="sm">Configure tokens</Button>
            </Link>
          )}
          <Button variant="ghost" size="sm" onClick={resetAll}>
            Reset
          </Button>
        </div>
      </div>

      <Stepper steps={STEPS} currentIdx={stepIdx} onJump={setStepIdx} />

      {/* DB offline banner — shown after boot-up ping fails */}
      {dbOnline === false && (
        <div className="flex items-start gap-2 border border-warn/35 bg-warn/10 px-4 py-3 text-sm text-[#FCD34D]" style={{ borderRadius: "8px" }}>
          <span className="mt-0.5 flex-shrink-0">⚠</span>
          <span>
            <strong>Persistence unavailable.</strong> Cannot reach the local MongoDB instance. Artifacts and reports will not be saved between sessions. Start MongoDB to enable caching.
          </span>
        </div>
      )}

      {stepIdx === 0 && (
        <Card>
          <CardBody>
            <StepHeading
              eyebrow="Step 1"
              title="Account Context"
              description="Capture the inputs the risk-assessment skill expects. Timeframe default is 6 months."
            />

            {/* ── Phase A: Account lookup ── */}
            {!input.salesforceId ? (
              <div className="space-y-4">
                <div>
                  <Label>Account name or Salesforce ID</Label>
                  <div className="flex gap-2 mt-1">
                    <Input
                      value={lookupQuery}
                      onChange={(e) => { setLookupQuery(e.target.value); setLookupResult(null); setLookupError(null); }}
                      onKeyDown={(e) => e.key === "Enter" && handleLookup()}
                      placeholder="e.g. Zomato  or  001A000001KMWEpIAP"
                      autoFocus
                    />
                    <Button onClick={handleLookup} loading={lookupLoading} disabled={!lookupQuery.trim() || lookupLoading}>
                      Look up
                    </Button>
                  </div>
                  <p className="mt-1.5 text-[12px] text-ink-500">
                    We'll resolve the official Salesforce account name and ID via Glean before gathering data.
                  </p>
                </div>

                {lookupLoading && (
                  <div className="flex items-center gap-3 border border-ink-700 bg-accent-900 px-4 py-3 text-sm text-ink-300" style={{ borderRadius: "8px" }}>
                    <svg className="animate-spin h-4 w-4 text-accent-400 flex-shrink-0" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                    </svg>
                    Searching…
                  </div>
                )}

                {lookupError && (
                  <div className="border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger" style={{ borderRadius: "8px" }}>
                    {lookupError}
                  </div>
                )}

                {lookupResult && (
                  <div className="border border-success/40 bg-success/10 px-4 py-4 space-y-3" style={{ borderRadius: "8px" }}>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.05em] text-success">Account found</div>
                    <div className="flex items-start justify-between gap-4">
                      <div className="space-y-1">
                        <div className="text-[18px] font-semibold text-ink-100">{lookupResult.canonicalName}</div>
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[12px] text-ink-400">{lookupResult.salesforceId}</span>
                          <a
                            href={`https://hub.corp.mongodb.com/account/${lookupResult.salesforceId}/overview`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[12px] text-accent-400 hover:underline"
                          >
                            View in Hub ↗
                          </a>
                        </div>
                      </div>
                      <div className="flex gap-2 flex-shrink-0">
                        <Button variant="ghost" size="sm" onClick={() => { setLookupResult(null); setLookupQuery(""); }}>
                          Edit
                        </Button>
                        <Button size="sm" onClick={() => { confirmLookup(); }}>
                          Confirm →
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              /* ── Phase B: Confirmed account + assessment details ── */
              <div className="space-y-5">
                {/* Confirmed account banner */}
                <div className="flex items-center justify-between border border-ink-700 bg-accent-900 px-4 py-3" style={{ borderRadius: "8px" }}>
                  <div className="space-y-0.5">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.05em] text-success">Account confirmed</div>
                    <div className="flex items-center gap-3">
                      <span className="font-semibold text-ink-100">{input.canonicalName}</span>
                      <span className="font-mono text-[12px] text-ink-500">{input.salesforceId}</span>
                      <a
                        href={`https://hub.corp.mongodb.com/account/${input.salesforceId}/overview`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[12px] text-accent-400 hover:underline"
                      >
                        Hub ↗
                      </a>
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => {
                    setInput((prev) => ({ ...prev, accountName: "", canonicalName: undefined, salesforceId: undefined }));
                    setLookupQuery("");
                    setLookupResult(null);
                    setLookupError(null);
                  }}>
                    Change
                  </Button>
                </div>

                <div className="grid sm:grid-cols-2 gap-5">
                  <div className="sm:col-span-2">
                    <Label>What prompted this assessment?</Label>
                    <Select
                      value={input.motivation}
                      onChange={(e) => setInput({ ...input, motivation: e.target.value })}
                    >
                      <option value="">Select…</option>
                      <option value="proactive-health-check">Proactive health check</option>
                      <option value="reactive-to-incident">Reactive to incidents</option>
                      <option value="renewal-preparation">Renewal preparation</option>
                      <option value="escalation">Escalation</option>
                    </Select>
                  </div>
                  <div>
                    <Label>Timeframe (months)</Label>
                    <Input
                      type="number"
                      min={1}
                      max={36}
                      value={input.timeframeMonths}
                      onChange={(e) => setInput({ ...input, timeframeMonths: Math.max(1, Number(e.target.value) || 1) })}
                    />
                  </div>
                  <div>
                    <Label>Known concerns (optional)</Label>
                    <Input
                      value={input.knownConcerns ?? ""}
                      onChange={(e) => setInput({ ...input, knownConcerns: e.target.value })}
                      placeholder="e.g. recurring shard key issues"
                    />
                  </div>
                </div>

                <div className="flex justify-end mt-2">
                  <Button
                    disabled={!canProceedFromContext || checkingReport}
                    loading={checkingReport}
                    onClick={async () => {
                      setCheckingReport(true);
                      const existing = await dbLoad(input.accountName, input.salesforceId);
                      setCheckingReport(false);
                      if (existing?.report) {
                        const updatedAt = (existing as unknown as Record<string, unknown>).updatedAt as string | undefined;
                        const age = updatedAt ? Date.now() - new Date(updatedAt).getTime() : Infinity;
                        if (age < 30 * 24 * 60 * 60 * 1000) {
                          // Fresh report — use the record's own account name for the URL
                          const recInput = (existing as unknown as { input?: AssessmentInput }).input ?? input;
                          router.push(reportUrl({ ...recInput, salesforceId: recInput.salesforceId ?? input.salesforceId, canonicalName: recInput.canonicalName ?? input.canonicalName }));
                          return;
                        }
                      }
                      setStepIdx(1);
                    }}
                  >
                    Continue →
                  </Button>
                </div>
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {stepIdx === 1 && (
        <Card>
          <CardBody>
            <StepHeading
              eyebrow="Step 2"
              title="Gathering Data Sources"
              description="Pulling case history, escalations, product signals, and account activity in parallel."
              right={
                !gathering && gatherLog.length > 0 ? (
                  <div className="flex items-center gap-2">
                    <Button variant="secondary" size="sm" onClick={() => { setGatherTriggered(false); runGather(true); }} loading={gathering || triageRunning}>
                      Force re-fetch
                    </Button>
                    {!gatherLog.some((l) => l.status === "pending") && !triageRunning && (
                      <Button onClick={() => setStepIdx(2)}>Continue →</Button>
                    )}
                  </div>
                ) : undefined
              }
            />

            <div className="space-y-5">
              {/* ── Circular progress (while gathering) ── */}
              {gathering && (() => {
                const total   = gleanChatPrompts.length + gleanQueries.length;
                const done    = gatherLog.filter((l) => l.status !== "pending").length;
                const pct     = total > 0 ? Math.round((done / total) * 100) : 0;
                const current = gatherLog.findLast?.((l) => l.status === "pending")
                  ?? gatherLog[gatherLog.length - 1];
                const r = 36;
                const circ = 2 * Math.PI * r;
                const dash = circ - (pct / 100) * circ;
                return (
                  <div className="flex flex-col items-center gap-6 py-8">
                    {/* Circular dial */}
                    <div className="relative h-[120px] w-[120px]">
                      <svg className="h-[120px] w-[120px] -rotate-90" viewBox="0 0 88 88">
                        {/* Track */}
                        <circle cx="44" cy="44" r={r} fill="none" stroke="#1E2D3D" strokeWidth="6" />
                        {/* Progress arc */}
                        <circle
                          cx="44" cy="44" r={r}
                          fill="none"
                          stroke="#3B82F6"
                          strokeWidth="6"
                          strokeLinecap="round"
                          strokeDasharray={circ}
                          strokeDashoffset={dash}
                          style={{ transition: "stroke-dashoffset 0.5s ease-out", filter: "drop-shadow(0 0 12px rgba(59,130,246,0.3))" }}
                        />
                      </svg>
                      {/* Pct in centre */}
                      <div className="absolute inset-0 flex items-center justify-center">
                        <span className="font-semibold tabular-nums text-ink-100 text-[24px]">{pct}<span className="text-[13px] text-ink-400">%</span></span>
                      </div>
                    </div>

                    {/* Source tiles */}
                    <div className="w-full">
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                        {gatherLog.map((l, i) => {
                          const status = l.status === "ok" ? "ok" : l.status === "error" ? "error" : "pending";
                          return (
                            <div key={i} className={`border border-ink-700 bg-accent-900 px-3 py-2 ${l.status === "pending" ? "animate-pulse" : ""}`} style={{ borderRadius: "8px" }}>
                              <div className="flex items-center gap-2 text-[13px] text-ink-200">
                                <StatusDot status={status} />
                                <span className="truncate">{cleanLabel(l.label)}</span>
                              </div>
                              <div className="mt-1 text-[11px] text-ink-400">
                                {l.status === "ok" && l.detail === "cached" ? "Cached artifact" :
                                 l.status === "ok" ? "Completed" :
                                 l.status === "error" ? "Failed to fetch" : "In progress"}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    <div className="text-[13px] text-ink-400">
                      {current ? cleanLabel(current.label) : "Starting…"}
                    </div>
                  </div>
                );
              })()}

              {/* ── Idle state — auto-gather will start momentarily ── */}
              {!gathering && gatherLog.length === 0 && (
                <div className="py-12 flex flex-col items-center gap-3">
                  <div className="flex h-[120px] w-[120px] items-center justify-center rounded-full border border-dashed border-ink-700 bg-accent-900 animate-pulse">
                    <span className="text-[13px] text-ink-400">Starting…</span>
                  </div>
                </div>
              )}

              {/* ── Summary after run ── */}
              {!gathering && gatherLog.length > 0 && (() => {
                const ok     = gatherLog.filter((l) => l.status === "ok").length;
                const errors = gatherLog.filter((l) => l.status === "error").length;
                const cached = gatherLog.filter((l) => l.detail === "cached").length;
                const total  = gatherLog.length;
                return (
                  <div className="space-y-4">
                    {/* KPI row */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      {[
                        { value: ok,     label: "fetched",     color: "text-success" },
                        { value: cached, label: "from cache",  color: "text-accent-400" },
                        { value: errors, label: "not covered", color: errors > 0 ? "text-danger" : "text-ink-500" },
                        { value: total,  label: "total",       color: "text-ink-200" },
                      ].map((k) => (
                        <div key={k.label} className="border border-ink-700 bg-accent-900 px-3 py-3" style={{ borderRadius: "8px" }}>
                          <div className={`text-[22px] font-semibold tabular-nums ${k.color}`}>{k.value}</div>
                          <div className="mt-1 text-[11px] text-ink-400">{k.label}</div>
                        </div>
                      ))}
                    </div>

                    {/* Source grid */}
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      {gatherLog.map((l, i) => {
                        const status = l.detail === "cached"
                          ? "cached"
                          : l.status === "ok"
                            ? "ok"
                            : l.status === "error"
                              ? "error"
                              : "queued";
                        return (
                          <div key={i} className="border border-ink-700 bg-accent-900 px-3 py-2" style={{ borderRadius: "8px" }}>
                            <div className="flex items-center gap-2 text-[13px] text-ink-200">
                              <StatusDot status={status} />
                              <span className="truncate">{cleanLabel(l.label)}</span>
                            </div>
                            <div className="mt-1 text-[11px] text-ink-400">
                              {l.detail === "cached" ? "Cached artifact" :
                               l.status === "ok" ? "Completed" :
                               l.status === "error" ? (l.detail ?? "Failed") : "Queued"}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}

              {/* ── Not-covered list ── */}
              {!gathering && gatherLog.some((l) => l.status === "error") && (
                <div className="space-y-1 border-l-2 border-danger pl-3">
                  <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-danger">
                    Not covered
                  </div>
                  {gatherLog
                    .filter((l) => l.status === "error")
                    .map((l, i) => (
                      <div key={i} className="text-[12px] text-ink-300">
                        {cleanLabel(l.label)}{l.detail ? <span className="ml-2 text-ink-400">{l.detail}</span> : null}
                      </div>
                    ))}
                </div>
              )}
            </div>

            {/* ── Auto Triage pipeline progress ── */}
            {(triageRunning || triageLog.length > 0 || triageSkipReason) && (
              <div className="mt-6 space-y-3 border-t border-ink-700 pt-5">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.05em] text-ink-300">
                      Auto Triage Case Intelligence
                    </div>
                    <div className="mt-1 text-[12px] text-ink-400">
                      {triageResolvedCases.length > 0
                        ? `Analyzing ${triageResolvedCases.length} case${triageResolvedCases.length === 1 ? "" : "s"} — case summary + precedent research per case, plus cross-case pattern analysis.`
                        : triageRunning
                          ? "Extracting case numbers from Glean artifacts…"
                          : "Enrichment complete."}
                    </div>
                  </div>
                  {triageRunning && (
                    <svg className="animate-spin h-4 w-4 text-accent-400" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                    </svg>
                  )}
                </div>

                {triageCacheCounts && (triageCacheCounts.hit > 0 || triageCacheCounts.miss > 0 || triageCacheCounts.staleRefresh > 0) && (
                  <div className="grid grid-cols-3 gap-2">
                    <div className="border border-ink-700 bg-accent-900 px-3 py-3" style={{ borderRadius: "8px" }}>
                      <div className="text-[22px] font-semibold tabular-nums text-accent-400">{triageCacheCounts.hit}</div>
                      <div className="mt-1 text-[11px] text-ink-400">from cache</div>
                    </div>
                    <div className="border border-ink-700 bg-accent-900 px-3 py-3" style={{ borderRadius: "8px" }}>
                      <div className="text-[22px] font-semibold tabular-nums text-ink-200">{triageCacheCounts.miss}</div>
                      <div className="mt-1 text-[11px] text-ink-400">fetched fresh</div>
                    </div>
                    <div className="border border-ink-700 bg-accent-900 px-3 py-3" style={{ borderRadius: "8px" }}>
                      <div className="text-[22px] font-semibold tabular-nums text-warn">{triageCacheCounts.staleRefresh}</div>
                      <div className="mt-1 text-[11px] text-ink-400">refreshed (open &gt;7d)</div>
                    </div>
                  </div>
                )}

                {triageLog.length > 0 && (
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {triageLog.map((l) => {
                      const status = l.status === "ok" ? "ok" : l.status === "error" ? "error" : "pending";
                      const sub =
                        l.status === "error"
                          ? (l.detail?.slice(0, 80) ?? "Failed")
                          : l.status === "running"
                            ? l.source === "cached" ? "Loading from cache…" : "Calling Auto Triage…"
                            : l.status === "ok"
                              ? [
                                  l.source === "cached" ? "From cache" : l.durationMs ? `Fresh · ${Math.round(l.durationMs / 1000)}s` : "Fresh",
                                  l.caseStatus === "closed" ? "closed" : l.caseStatus === "open" ? "open" : null,
                                ].filter(Boolean).join(" · ")
                              : "Queued";
                      return (
                        <div
                          key={l.key}
                          className={`border border-ink-700 bg-accent-900 px-3 py-2 ${l.status === "running" && l.source !== "cached" ? "animate-pulse" : ""}`}
                          style={{ borderRadius: "8px" }}
                        >
                          <div className="flex items-center gap-2 text-[13px] text-ink-200">
                            <StatusDot status={status} />
                            <span className="truncate">{l.label}</span>
                            {l.source === "cached" && l.status === "ok" && (
                              <span className="ml-auto text-[10px] px-1.5 py-0.5 bg-accent-700 text-accent-300 rounded">cached</span>
                            )}
                          </div>
                          <div className="mt-1 text-[11px] text-ink-400">{sub}</div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {triageSkipReason && !triageRunning && (
                  <div className="text-[12px] text-warn border-l-2 border-warn pl-3">
                    Skipped Auto Triage: {triageSkipReason}
                  </div>
                )}
              </div>
            )}

            <div className="flex justify-between mt-8">
              <Button variant="ghost" onClick={() => { setGatherTriggered(false); setStepIdx(0); }}>
                ← Back
              </Button>
              {!gathering && !triageRunning && gatherLog.length > 0 && !gatherLog.some((l) => l.status === "pending") && (
                <Button onClick={() => setStepIdx(2)}>Continue →</Button>
              )}
            </div>
          </CardBody>
        </Card>
      )}

      {stepIdx === 2 && (
        <Card>
          <CardBody>
            <StepHeading
              eyebrow="Step 3"
              title="Draft the Report"
              description={
                settings.llmProvider === "mongogpt" && artifacts.length === 0
                  ? "No Step 2 artifacts found — MongoGPT will run an agentic tool-calling loop to gather evidence from Glean before drafting the report."
                  : `The LLM synthesizes the Risk Register from ${artifacts.length} pre-gathered artifact${artifacts.length === 1 ? "" : "s"}. No additional Glean calls needed.`
              }
            />

            {/* Existing report notice — shown above stats when a cached report exists */}
            {report && !generating && (
              <div className="mb-4 flex items-center justify-between gap-4 border border-ink-700 bg-accent-900 px-4 py-3 text-sm text-ink-200" style={{ borderRadius: "8px" }}>
                <span>
                  Report already exists
                  {reportGeneratedAt
                    ? ` — generated on ${new Date(reportGeneratedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`
                    : ""}.
                  {" "}Need a fresh one?
                </span>
                <Button variant="secondary" size="sm" onClick={() => runGenerate(true)} loading={generating}>
                  Regenerate
                </Button>
              </div>
            )}

            <div className="grid sm:grid-cols-2 gap-4 mb-6">
              <Stat label="Account" value={input.canonicalName || input.accountName || "—"} />
              <Stat
                label="Timeframe"
                value={`last ${input.timeframeMonths} months`}
              />
              <Stat label="Artifacts" value={String(artifacts.length)} />
            </div>

            {genError && (
              <div className="mb-4 border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger" style={{ borderRadius: "8px" }}>
                {genError}
              </div>
            )}

            {/* Progress bar — visible during any one-shot LLM generation (initial or force) */}
            {generating && genProgress && !(settings.llmProvider === "mongogpt" && artifacts.length === 0) && (
              <div className="mb-6 space-y-2">
                <div className="flex justify-end text-xs tabular-nums text-ink-400">
                  {genProgress.pct}%
                </div>
                <div className="h-1.5 w-full overflow-hidden bg-ink-700" style={{ borderRadius: "9999px" }}>
                  <div
                    className="bg-accent-500 h-1.5 transition-all duration-700 ease-out"
                    style={{ width: `${genProgress.pct}%`, borderRadius: "9999px" }}
                  />
                </div>
              </div>
            )}

            {(generating || agentEvents.length > 0) &&
              settings.llmProvider === "mongogpt" &&
              artifacts.length === 0 && (
                <AgentEventLog events={agentEvents} />
              )}

            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => setStepIdx(1)}>
                ← Back
              </Button>
              <div className="flex items-center gap-2">
                <Button onClick={() => runGenerate(false)} loading={generating} disabled={generating}>
                  {settings.llmProvider === "mongogpt" && artifacts.length === 0
                    ? "Run agent"
                    : "Generate report"}
                </Button>
              </div>
            </div>
          </CardBody>
        </Card>
      )}

      {stepIdx === 3 && (
        <Card>
          <CardBody>
            <StepHeading
              eyebrow="Step 4"
              title="Review & Export"
              description="Review the draft, copy or download as markdown, and take it to high-context reviewers for LGTM before delivery."
              right={
                <div className="flex items-center gap-2">
                  <CopyButton text={report} />
                  {input.accountName && (
                    <Link href={`/reports/${encodeURIComponent(input.canonicalName || input.accountName)}`}>
                      <Button variant="secondary" size="sm">
                        View report page →
                      </Button>
                    </Link>
                  )}
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      const blob = new Blob([report], {
                        type: "text/markdown",
                      });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = `${input.canonicalName || input.accountName || "account"}-risk-register.md`;
                      a.click();
                      URL.revokeObjectURL(url);
                      track({
                        event: "report_downloaded_md",
                        account: input.accountName,
                        salesforceId: input.salesforceId,
                      });
                    }}
                  >
                    Download .md
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={pdfExporting}
                    onClick={() => handleDownloadPdf()}
                  >
                    Download PDF
                  </Button>
                </div>
              }
            />

            {!report ? (
              <div className="text-sm text-ink-400">No draft yet.</div>
            ) : (
              <>
                {reportFromCache && (
                  <div className="mb-4 border border-success/35 bg-success/10 px-4 py-3 text-sm text-success" style={{ borderRadius: "8px" }}>
                    Report loaded from cache (generated within the last 30 days). Use &ldquo;Regenerate&rdquo; to call GPT fresh.
                  </div>
                )}
                <div className="grid lg:grid-cols-2 gap-6">
                <div>
                  <div className="mb-2 text-[12px] font-semibold uppercase tracking-[0.05em] text-ink-300">
                    Preview
                  </div>
                  <div className="border border-ink-700 bg-accent-900 p-6 report-prose" style={{ borderRadius: "8px" }}>
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {report}
                    </ReactMarkdown>
                  </div>
                </div>
                <div>
                  <div className="mb-2 text-[12px] font-semibold uppercase tracking-[0.05em] text-ink-300">
                    Markdown source
                  </div>
                  <Textarea
                    className="font-mono"
                    rows={28}
                    value={report}
                    onChange={(e) => setReport(e.target.value)}
                  />
                </div>
              </div>
              </>
            )}

            <div className="flex justify-between mt-8">
              <Button variant="ghost" onClick={() => setStepIdx(2)}>
                ← Back
              </Button>
              <Button variant="secondary" onClick={() => runGenerate(true)} loading={generating}>
                Regenerate
              </Button>
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-ink-700 bg-accent-900 px-4 py-3" style={{ borderRadius: "8px" }}>
      <div className="text-[12px] font-semibold uppercase tracking-[0.05em] text-ink-300">
        {label}
      </div>
      <div className="mt-1 truncate text-[13px] font-medium text-ink-200">{value}</div>
    </div>
  );
}

function AgentEventLog({ events }: { events: AgentEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="mb-4 border border-dashed border-ink-700 px-3 py-6 text-center text-sm text-ink-500" style={{ borderRadius: "8px" }}>
        Waiting for agent to start…
      </div>
    );
  }
  return (
    <div className="mb-4 max-h-[420px] overflow-y-auto border border-ink-700 bg-accent-900 p-4" style={{ borderRadius: "8px" }}>
      <div className="mb-3 text-[12px] font-semibold uppercase tracking-[0.05em] text-ink-300">
        Agent activity
      </div>
      <ul className="space-y-1.5 text-sm">
        {events.map((e, i) => {
          if (e.type === "status") {
            return (
              <li key={i} className="flex items-center gap-2 text-ink-300">
                <StatusDot status="pending" />
                <span>{e.message}</span>
              </li>
            );
          }
          if (e.type === "step_start") {
            return (
              <li key={i} className="text-ink-100">
                <div className="flex items-center gap-2">
                  <StatusDot status="pending" />
                  <span className="text-[13px] font-medium text-ink-200">Step {e.step}</span>
                  <span className="text-xs text-ink-400">
                    {e.toolCalls.length} tool call
                    {e.toolCalls.length === 1 ? "" : "s"}
                  </span>
                </div>
                <ul className="ml-4 mt-1 space-y-0.5">
                  {e.toolCalls.map((t) => (
                    <li key={t.id} className="text-xs text-ink-300">
                      <span className="font-mono text-ink-100">{t.name}</span>
                      {t.argsPreview && (
                        <span className="text-ink-400">
                          {" "}
                          — {t.argsPreview}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            );
          }
          if (e.type === "tool_result") {
            return (
              <li
                key={i}
                className="flex items-start gap-2 text-xs text-ink-300"
              >
                <StatusDot status={e.ok ? "ok" : "error"} />
                <span className="font-mono text-ink-100">{e.name}</span>
                <span className="text-ink-400">{e.summary}</span>
              </li>
            );
          }
          return null;
        })}
      </ul>
    </div>
  );
}
