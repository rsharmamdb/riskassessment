/**
 * POST /api/analyze — Risk Intelligence / Case Analysis pipeline.
 *
 * Two LLM passes:
 *  1. Per-case extraction:  raw case transcript → array of CommentSignals.
 *  2. Aggregation:          all signals → top AggregatedRisks.
 *
 * Glean MCP calls are intentionally out-of-band here. The UI collects
 * raw case text (pasted back from Cursor's Glean MCP) and posts it here.
 * This route never needs a Glean token.
 */

import { NextResponse } from "next/server";
import {
  AGGREGATION_SYSTEM_PROMPT,
  buildAggregationUserPrompt,
  buildExtractionUserPrompt,
  EXTRACTION_SYSTEM_PROMPT,
  type AggregatedRisk,
  type AnalyzeResult,
  type CaseDocument,
  type CommentSignals,
} from "@/lib/case-analysis";
import { callMongoGpt } from "@/lib/mongogpt";
import { resolveMongoGptMessagesUrl } from "@/lib/mongogpt-url";
import { getValidToken, invalidateToken } from "@/lib/mongogpt-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 200;

interface Body {
  accountName: string;
  cases: CaseDocument[];
  provider?: "openai" | "anthropic" | "mongogpt";
  apiKey?: string;
  model?: string;
  mongogptUrl?: string;
}

// ---------- LLM plumbing (JSON-only) ----------

async function callOpenAiJson(
  apiKey: string,
  model: string,
  system: string,
  user: string,
): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenAI HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI response had no content");
  return content;
}

async function callAnthropicJson(
  apiKey: string,
  model: string,
  system: string,
  user: string,
): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 8_000,
      temperature: 0.1,
      system: `${system}\n\nReturn ONLY a single JSON object — no prose, no code fences.`,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Anthropic HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  const json = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const content = json.content
    ?.filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
  if (!content) throw new Error("Anthropic response had no text content");
  return content;
}

/** Strip markdown code fences if a model decides to wrap JSON in them. */
function parseJsonLoose(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/);
  const body = fenced ? fenced[1] : trimmed;
  return JSON.parse(body);
}

type LlmCaller = (system: string, user: string) => Promise<string>;

const JSON_ENFORCEMENT_SUFFIX =
  "\n\nReturn ONLY a single JSON object matching the schema described above. No prose, no markdown code fences.";

function makeLlmCaller(body: Body): LlmCaller {
  const provider = body.provider ?? "mongogpt";

  if (provider === "anthropic") {
    const apiKey = body.apiKey || process.env.ANTHROPIC_API_KEY || "";
    const model =
      body.model || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
    if (!apiKey) {
      throw new Error("Missing Anthropic API key (set in Settings).");
    }
    return (system, user) => callAnthropicJson(apiKey, model, system, user);
  }

  if (provider === "mongogpt") {
    const url = resolveMongoGptMessagesUrl(body.mongogptUrl);
    const model = body.model || process.env.MONGOGPT_MODEL || "";
    if (!model) {
      throw new Error(
        "No MongoGPT model selected. Open Settings → MongoGPT and pick a model from the dropdown.",
      );
    }
    return async (system, user) => {
      const messages = [
        {
          role: "system" as const,
          content: system + JSON_ENFORCEMENT_SUFFIX,
          name: "risksi",
        },
        { role: "user" as const, content: user, name: "risksi" },
      ];
      const tokenInfo = await getValidToken();
      try {
        return await callMongoGpt({ url, token: tokenInfo.token, model, messages });
      } catch (err) {
        const msg = (err as Error).message;
        // If the gateway rejects our token, force a refresh and retry once.
        if (/\b(401|403|unauthori[sz]ed|forbidden)\b/i.test(msg)) {
          invalidateToken();
          const refreshed = await getValidToken({ force: true });
          return callMongoGpt({
            url,
            token: refreshed.token,
            model,
            messages,
          });
        }
        throw err;
      }
    };
  }

  const apiKey = body.apiKey || process.env.OPENAI_API_KEY || "";
  const model = body.model || process.env.OPENAI_MODEL || "gpt-4o";
  if (!apiKey) {
    throw new Error("Missing OpenAI API key (set in Settings).");
  }
  return (system, user) => callOpenAiJson(apiKey, model, system, user);
}

// ---------- Pipeline ----------

async function extractSignalsForCase(
  call: LlmCaller,
  doc: CaseDocument,
): Promise<CommentSignals[]> {
  const raw = await call(
    EXTRACTION_SYSTEM_PROMPT,
    buildExtractionUserPrompt(doc),
  );
  let parsed: unknown;
  try {
    parsed = parseJsonLoose(raw);
  } catch (err) {
    throw new Error(
      `Extraction returned non-JSON for case ${doc.caseNumber ?? doc.url}: ${(err as Error).message}. First 200 chars: ${raw.slice(0, 200)}`,
    );
  }
  const signals = (parsed as { signals?: CommentSignals[] }).signals;
  if (!Array.isArray(signals)) {
    throw new Error(
      `Extraction JSON missing "signals" array for case ${doc.caseNumber ?? doc.url}.`,
    );
  }
  const caseRef = doc.caseNumber ?? doc.url;
  return signals.map((s, i) => ({
    ...s,
    caseRef,
    caseTitle: doc.title,
    commentIndex: typeof s.commentIndex === "number" ? s.commentIndex : i,
  }));
}

async function aggregateRisks(
  call: LlmCaller,
  accountName: string,
  signals: CommentSignals[],
): Promise<AggregatedRisk[]> {
  if (signals.length === 0) return [];
  const raw = await call(
    AGGREGATION_SYSTEM_PROMPT,
    buildAggregationUserPrompt(accountName, signals),
  );
  let parsed: unknown;
  try {
    parsed = parseJsonLoose(raw);
  } catch (err) {
    throw new Error(
      `Aggregation returned non-JSON: ${(err as Error).message}. First 200 chars: ${raw.slice(0, 200)}`,
    );
  }
  const risks = (parsed as { risks?: AggregatedRisk[] }).risks;
  if (!Array.isArray(risks)) {
    throw new Error('Aggregation JSON missing "risks" array.');
  }
  return risks
    .map((r, i) => ({
      ...r,
      rank: typeof r.rank === "number" ? r.rank : i + 1,
      evidence: Array.isArray(r.evidence) ? r.evidence : [],
      signalFrequency:
        typeof r.signalFrequency === "number" ? r.signalFrequency : r.evidence?.length ?? 0,
      ignoredRecommendationFlag: !!r.ignoredRecommendationFlag,
      frustrationFlag: !!r.frustrationFlag,
    }))
    .sort((a, b) => a.rank - b.rank);
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.accountName?.trim()) {
    return NextResponse.json(
      { error: "Missing accountName" },
      { status: 400 },
    );
  }
  if (!Array.isArray(body.cases) || body.cases.length === 0) {
    return NextResponse.json(
      { error: "No cases provided. Paste at least one case transcript." },
      { status: 400 },
    );
  }

  try {
    const call = makeLlmCaller(body);

    const allSignals: CommentSignals[] = [];
    const caseSummaries: AnalyzeResult["cases"] = [];

    // Extract sequentially to keep provider rate-limits predictable.
    for (const doc of body.cases) {
      const signals = await extractSignalsForCase(call, doc);
      allSignals.push(...signals);
      caseSummaries.push({
        caseRef: doc.caseNumber ?? doc.url,
        title: doc.title,
        commentsAnalyzed: signals.length,
      });
    }

    const risks = await aggregateRisks(call, body.accountName, allSignals);

    const result: AnalyzeResult = {
      cases: caseSummaries,
      signals: allSignals,
      risks,
    };
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
