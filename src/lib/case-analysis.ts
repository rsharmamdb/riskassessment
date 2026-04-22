/**
 * Types and prompt builders for the Risk Intelligence / Case Analysis flow.
 *
 * The flow is:
 *   1. Find Salesforce support cases for an account (via Glean `search`,
 *      app=servicecloud).
 *   2. Fetch the full case content (via Glean `read_document`).
 *   3. LLM pass 1 — extract structured signals for every comment.
 *   4. LLM pass 2 — aggregate the signals into top risks with evidence.
 *
 * Everything downstream of step 2 is the concern of /api/analyze.
 */

export type ActorRole = "TS" | "Customer" | "Internal" | "Unknown";

export type MessageType =
  | "problem"
  | "observation"
  | "recommendation"
  | "action-taken"
  | "action-requested"
  | "status-update"
  | "escalation"
  | "other";

export type Sentiment =
  | "neutral"
  | "frustrated"
  | "urgent"
  | "positive"
  | "escalating";

export type Confidence = "High" | "Medium" | "Low";

/** A single hit from the Glean case search. */
export interface CaseSearchHit {
  url: string;
  title: string;
  snippet?: string;
  updatedAt?: string;
  caseNumber?: string;
}

/** A case document after we've fetched its full content. */
export interface CaseDocument {
  url: string;
  title: string;
  caseNumber?: string;
  fullText: string;
}

/** Structured signals extracted for a single comment. */
export interface CommentSignals {
  caseRef: string;
  caseTitle?: string;
  commentIndex: number;
  actor: ActorRole;
  messageType: MessageType;
  technicalSignals: string[];
  actions: {
    recommended?: string[];
    requested?: string[];
    taken?: string[];
  };
  sentiment: Sentiment;
  riskIndicators: string[];
  quote?: string;
}

/** Aggregated risk across comments / cases. */
export interface AggregatedRisk {
  rank: number;
  title: string;
  description: string;
  evidence: { caseRef: string; commentIndex: number; quote: string }[];
  signalFrequency: number;
  ignoredRecommendationFlag: boolean;
  frustrationFlag: boolean;
  confidence: Confidence;
}

export interface AnalyzeResult {
  cases: { caseRef: string; title: string; commentsAnalyzed: number }[];
  signals: CommentSignals[];
  risks: AggregatedRisk[];
}

/**
 * Build a Glean `search` query for Salesforce support cases for an account.
 * Using `app=servicecloud` keeps the result set tight to support cases
 * (vs generic account/opportunity records in salescloud).
 *
 * Aligned with Glean MCP `search` schema + premserv playbooks:
 * - Prefer short `query` (no stuffing).
 * - Prefer `updated: "past_month"` for a 1-month window (same as ntse-case-review default).
 * - For longer windows use `after` (YYYY-MM-DD). Glean treats `after` as *exclusive*,
 *   so we subtract one calendar day from the cutoff so the boundary week still qualifies.
 * - Omit `sort_by_recency` by default — relevance tends to surface case matches better
 *   than forcing recency (Glean marks sort_by_recency as high-risk).
 */
export function buildCaseSearchArgs(params: {
  accountName: string;
  timeframeMonths: number;
  extraKeywords?: string;
}): Record<string, unknown> {
  const query = [params.accountName, params.extraKeywords]
    .filter(Boolean)
    .join(" ")
    .trim();

  const m = Math.min(Math.max(params.timeframeMonths, 1), 36);

  const args: Record<string, unknown> = {
    query,
    app: "servicecloud",
    exhaustive: true,
  };

  if (m === 1) {
    args.updated = "past_month";
  } else {
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - m);
    cutoff.setDate(cutoff.getDate() - 1);
    args.after = cutoff.toISOString().slice(0, 10);
  }

  return args;
}

/** Minimal query: account only, servicecloud, no date filter — for debugging / broad discovery. */
export function buildBroadCaseSearchArgs(params: {
  accountName: string;
  extraKeywords?: string;
}): Record<string, unknown> {
  const query = [params.accountName, params.extraKeywords]
    .filter(Boolean)
    .join(" ")
    .trim();
  return {
    query,
    app: "servicecloud",
    exhaustive: true,
  };
}

/** Same as broad but drops `app` so Glean searches all indexed sources. */
export function buildGlobalSearchArgs(params: {
  accountName: string;
  extraKeywords?: string;
}): Record<string, unknown> {
  const query = [params.accountName, params.extraKeywords]
    .filter(Boolean)
    .join(" ")
    .trim();
  return {
    query,
    exhaustive: true,
  };
}

/** System prompt for the per-comment extraction pass. */
export const EXTRACTION_SYSTEM_PROMPT = `You are a Risk Intelligence analyst for MongoDB Technical Services. You read raw support-case transcripts and produce a STRUCTURED JSON signal for EACH comment in the case.

Strict rules:
- Output MUST be a single JSON object with key "signals" whose value is an array.
- Do NOT hallucinate comments that are not in the input text.
- If the transcript is not clearly delimited, do your best to segment it into chronological comments. Prefer under-segmentation over over-segmentation.
- Every signal entry must be justified by a short verbatim "quote" (≤ 200 chars) copied from the transcript.
- Only set "riskIndicators" when evidence is present in this specific comment. Examples: "customer frustration", "recommendation unimplemented", "repeated issue", "escalation tone".
- "technicalSignals" are short noun-phrases like "replication lag", "missing index on orders.user_id", "oplog window < 24h", "primary election storm".
- Use these enum values exactly:
  - actor: "TS" | "Customer" | "Internal" | "Unknown"
  - messageType: "problem" | "observation" | "recommendation" | "action-taken" | "action-requested" | "status-update" | "escalation" | "other"
  - sentiment: "neutral" | "frustrated" | "urgent" | "positive" | "escalating"

Schema for each signal entry:
{
  "caseRef": string,          // the caseRef passed in
  "commentIndex": number,     // 0-based, chronological
  "actor": ActorRole,
  "messageType": MessageType,
  "technicalSignals": string[],
  "actions": {
    "recommended": string[] | undefined,
    "requested":   string[] | undefined,
    "taken":       string[] | undefined
  },
  "sentiment": Sentiment,
  "riskIndicators": string[],
  "quote": string
}

Return ONLY JSON. No prose, no code fences.`;

/** User prompt for extraction — feed in a single case at a time. */
export function buildExtractionUserPrompt(doc: CaseDocument): string {
  const body = doc.fullText.slice(0, 60_000); // safety cap
  return [
    `caseRef: ${doc.caseNumber ?? doc.url}`,
    `caseTitle: ${doc.title}`,
    `--- BEGIN CASE TRANSCRIPT ---`,
    body,
    `--- END CASE TRANSCRIPT ---`,
    "",
    `Emit {"signals": [...]} covering every comment in this case.`,
  ].join("\n");
}

/** System prompt for the aggregation pass. */
export const AGGREGATION_SYSTEM_PROMPT = `You are a Risk Intelligence analyst summarizing many comment-level signals into the TOP actionable risks for a support engineer.

Strict rules:
- Work ONLY from the signals provided. Do not invent evidence.
- Prioritise repeated patterns across comments/cases over isolated incidents.
- A risk qualifies as High confidence only when supported by multiple distinct comments (ideally across multiple cases).
- "ignoredRecommendationFlag" = true when there is at least one "recommendation" signal from TS followed later by continued "problem" signals with the same technicalSignals and no matching "action-taken" from Customer.
- "frustrationFlag" = true when sentiment trends to "frustrated", "urgent", or "escalating" in later comments, or when multiple riskIndicators mention frustration/escalation.
- Keep risk "title" short (≤ 80 chars) and technical where possible (e.g. "Unresolved replication lag under peak write load").
- Keep risk "description" 1–3 sentences, actionable, specific.
- Provide 1–5 evidence items per risk, each referencing a real {caseRef, commentIndex} pair from the input and a short quote.
- Return AT MOST 6 risks, ranked by importance (rank = 1 is most important).

Output a single JSON object with key "risks" (array). Return ONLY JSON — no prose, no code fences.

Schema:
{
  "risks": [
    {
      "rank": number,
      "title": string,
      "description": string,
      "evidence": [{ "caseRef": string, "commentIndex": number, "quote": string }],
      "signalFrequency": number,
      "ignoredRecommendationFlag": boolean,
      "frustrationFlag": boolean,
      "confidence": "High" | "Medium" | "Low"
    }
  ]
}`;

export function buildAggregationUserPrompt(
  accountName: string,
  signals: CommentSignals[],
): string {
  return [
    `Account: ${accountName}`,
    `Total signals: ${signals.length}`,
    "",
    "Signals JSON:",
    JSON.stringify(signals).slice(0, 120_000),
    "",
    "Return the top risks as described.",
  ].join("\n");
}
