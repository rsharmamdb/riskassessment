/**
 * POST /api/agent/run — agentic Risk Register generator.
 *
 * Drives a tool-calling loop between MongoGPT and the Glean MCP. The model
 * is free to call `glean_chat`, `glean_search`, and `glean_read_document`
 * as many times as it needs (up to `maxSteps`) before emitting the final
 * markdown report. Progress is streamed back to the caller as Server-Sent
 * Events so the Wizard can show live tool-call status.
 *
 * Event types (`data: {...}` lines):
 *   - { type: "status",      message }
 *   - { type: "step_start",  step, toolCalls: [{ id, name, argsPreview }] }
 *   - { type: "tool_result", id, name, summary, ok }
 *   - { type: "final",       report }
 *   - { type: "error",       error }
 */

import { RISK_ASSESSMENT_SKILL, buildLgtmBlock, formatCaseIntelligenceBlock, titleCase } from "@/lib/risk-skill";
import {
  AGENT_TOOLS,
  createAgentContext,
  executeToolCall,
} from "@/lib/agent-tools";
import {
  callMongoGptTools,
  type MongoGptMessage,
} from "@/lib/mongogpt";
import {
  getValidToken,
  invalidateToken,
} from "@/lib/mongogpt-token";
import { resolveMongoGptMessagesUrl } from "@/lib/mongogpt-url";
import type { AssessmentInput, GatheredArtifact } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

const DEFAULT_MAX_STEPS = 12;

interface Body {
  input: AssessmentInput;
  artifacts?: GatheredArtifact[];
  model?: string;
  mongogptUrl?: string;
  gleanToken?: string;
  gleanUrl?: string;
  maxSteps?: number;
}

const AGENT_SYSTEM_PROMPT = `You are a senior MongoDB Technical Services engineer drafting an internal Risk Register Report for a customer. You have tool access to Glean (the MongoDB internal knowledge search) so you can gather evidence yourself — do NOT ask the user for more data; instead, call tools until you have what you need.

Operating loop:
1. Review: check the pre-gathered artifacts provided below. These are evidence already collected via Glean in a prior step — use them as-is and treat them as trustworthy.
2. Plan: note what evidence is STILL MISSING after reviewing the pre-gathered artifacts. Only call tools to fill gaps — do NOT re-fetch topics already covered.
3. Gather: call \`glean_chat\` for synthesis questions that span sources; \`glean_search\` to discover specific documents; \`glean_read_document\` to pull full bodies of promising hits.
4. Cross-check: if a risk is mentioned once, search for corroborating evidence before marking Confidence=High.
5. Only when you have enough evidence, emit the final markdown Risk Register Report. Do NOT emit any markdown in the same assistant turn as a tool call — finish tool calls first, then in a later turn emit ONLY the report.

IMPORTANT: The user has already gathered significant evidence from Glean. It will be included in the initial message. Do NOT duplicate those queries. Only call tools for information NOT already present in the pre-gathered artifacts.

Tool-use discipline:
- Prefer \`glean_chat\` first for breadth; follow up with \`glean_search\` + \`glean_read_document\` when you need specific citations (case numbers, PS report names, JIRA keys, Slack thread dates).
- Always mention the account name and timeframe in each tool call.
- Keep individual \`glean_read_document\` batches ≤ 5 URLs.
- If a tool returns nothing useful, try a different query rather than repeating.

Analysis methodology (from the official process guide):
- Cross-reference PS report recommendations against case patterns. Flag recommendations that went unimplemented or unacknowledged.
- Look for behavioral patterns: cases auto-closing due to lack of customer response, severity mis-selection, recurring issues that could have been prevented, poor engagement with TS.
- Skip transient one-off issues (network outages, etc.) — focus on patterns and recurring themes.
- If some cases are unrelated to technical support (billing, portal questions), discount them from the count and note it.
- Include percentages alongside counts in Case Review Summary breakdowns (e.g. "46 (64%)").
- Format Recommendations as a markdown table with these exact columns: "| # | Recommendation | Severity | Deliverable | Expected Outcome |".
- In Case Review Detail (Appendix B), when a theme paragraph ends with a "Pattern:" observation, the word "Pattern:" MUST start on its own new line (preceded by a blank line). Example:
  ...HELP-82089 was associated with this activity.

  **Pattern:** Two TLS-related cases in close succession suggest...
- Group Case Review Detail (Appendix B) by technical theme (e.g. "High CPU / Node Performance", "Memory Management", "Sharding Optimization") rather than listing cases sequentially.

Final output rules:
- Output ONLY the markdown report. Your very first character must be the # heading marker. No preamble. No explanation. No code fences. JUST the markdown.
- Every risk in Key Findings must be backed by evidence from Glean artifacts. If evidence is weak, set Confidence to Low.
- Prefer specific case numbers, PS report titles, and Slack thread dates when citing sources.
- When referencing a Slack thread or conversation ANYWHERE in the report, you MUST include a clickable Slack URL from the Glean citations. Never mention a Slack conversation without a URL. If no URL is available, state "(Slack URL not available in sources)".
- If a table cell has no data, write "\u2014" rather than fabricating a value.
- Keep the document INTERNAL ONLY banner at the top.
- Set Author(s) to "MongoDB Technical Services".
- For every case reference, link it as [Case XXXXXXXX](https://hub.corp.mongodb.com/case/XXXXXXXX) where XXXXXXXX is the case number (digits only, no dashes).
- Include an Appendix D (LGTM Tracking) section after Appendix C using this exact table:
  | Reviewer | Role | LGTM Date |
  |----------|------|-----------|
  | {name or —} | AE | — |
  | {name or —} | CSM | — |
  | {name or —} | PS | — |
  Populate reviewer names by scanning ALL provided artifacts — especially the Stakeholder Map artifact and any artifact that lists account team members from Salesforce.
  Role mapping rules: "Account Executive", "Account Owner", "AE" → AE row; "Primary CSM", "Account CSM", "Customer Success Manager", "CSM" → CSM row; "Professional Services", "PS", "Solutions Architect" explicitly listed as PS → PS row.
  Prefer Salesforce/account-team sources. If a reviewer is not known after scanning all artifacts, use "—" — NEVER write "pending" as a name. Do not omit any of the three rows.
- The Account Timeline (Appendix C) must use this EXACT table format \u2014 no bullets, no numbered lists, always a table:
  | Date | Ticket / Reference | Summary |
  |------|-------------------|---------|
  | {Mon DD, YY or Month YYYY} | [Case XXXXXXXX](https://hub.corp.mongodb.com/case/XXXXXXXX) / [HELP-XXXXX](https://jira.mongodb.org/browse/HELP-XXXXX) / [Slack thread](https://slack-url...) | {What happened and outcome} |
  Every row MUST have a hyperlinked reference. Omit rows without one.

=== Risk Assessment Skill (authoritative playbook) ===
${RISK_ASSESSMENT_SKILL}
=== End Skill ===`;

function formatArtifactsBlock(artifacts: GatheredArtifact[]): string {
  if (!artifacts || artifacts.length === 0) return "";

  const chatArtifacts = artifacts.filter((a) => a.kind === "chat");
  const searchArtifacts = artifacts.filter((a) => a.kind === "search");
  const caseIntelligenceBlock = formatCaseIntelligenceBlock(artifacts);

  const chatBlocks = chatArtifacts
    .map((a) => {
      const body =
        typeof a.data === "string" ? a.data : JSON.stringify(a.data, null, 2);
      const citationsLines = (a.citations ?? [])
        .map((c) => {
          const label = c.title || c.url || "source";
          const url = c.url ? ` — ${c.url}` : "";
          return `- ${label}${url}`;
        })
        .join("\n");
      return (
        `### Glean chat — ${a.label}\n\n` +
        body.slice(0, 12_000) +
        (citationsLines ? `\n\n**Citations:**\n${citationsLines}` : "")
      );
    })
    .join("\n\n---\n\n");

  const searchBlocks = searchArtifacts
    .map((a) => {
      const payload =
        typeof a.data === "string" ? a.data : JSON.stringify(a.data, null, 2);
      return `### ${a.source.toUpperCase()} — ${a.label}${a.query ? ` (query: ${a.query})` : ""}\n\n\`\`\`json\n${payload.slice(0, 6_000)}\n\`\`\``;
    })
    .join("\n\n");

  const parts: string[] = [];
  if (caseIntelligenceBlock) {
    // Place intelligence first — it's the highest-signal technical evidence
    // and agent loop should lean on it before falling back to Glean breadth.
    parts.push(caseIntelligenceBlock);
  }
  if (chatBlocks) {
    parts.push(
      "## Pre-Gathered Glean Synthesis (from Step 2 — trust as evidence, do NOT re-fetch)",
      chatBlocks,
    );
  }
  if (searchBlocks) {
    parts.push(
      "## Pre-Gathered Supporting Artifacts (raw Glean search hits from Step 2)",
      searchBlocks,
    );
  }
  return parts.join("\n\n");
}

function buildInitialUserMessage(
  input: AssessmentInput,
  artifacts: GatheredArtifact[],
): string {
  const artifactsBlock = formatArtifactsBlock(artifacts);
  const now = new Date();
  const startDate = new Date(now);
  startDate.setMonth(startDate.getMonth() - input.timeframeMonths);
  const fmtDate = (d: Date) => d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const timelineStart = fmtDate(startDate);
  const timelineEnd = fmtDate(now);

  const accountDisplay = titleCase(input.accountName);

  return [
    `Account: **${accountDisplay}**`,
    `Motivation: ${input.motivation}`,
    `Timeframe: last ${input.timeframeMonths} months (${timelineStart} to ${timelineEnd})`,
    `IMPORTANT: The Case Review Timeline in the report MUST be "${timelineStart} to ${timelineEnd}". Do NOT use any other date range. Ignore case dates that fall outside this window.`,
    input.knownConcerns ? `Known concerns: ${input.knownConcerns}` : null,
    "",
    artifacts.length > 0 ? buildLgtmBlock(artifacts) : null,
    "",
    artifactsBlock
      ? artifactsBlock
      : "_(no pre-gathered artifacts — use tools to collect all evidence)_",
    "",
    artifactsBlock
      ? "Review the pre-gathered artifacts above. Only call tools to fill gaps in evidence not already covered. When you have enough, emit the Risk Register Report."
      : "Begin by planning which tools to call. When you have enough evidence, emit the Risk Register Report as your final message.",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return sseError("Invalid JSON body", 400);
  }

  if (!body.input?.accountName) {
    return sseError("Missing input.accountName", 400);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        send({ type: "status", message: "Resolving Glean SSO…" });
        const ctx = await createAgentContext({
          gleanToken: body.gleanToken,
          gleanUrl: body.gleanUrl,
        });
        send({
          type: "status",
          message: `Glean ready (token source: ${ctx.glean.tokenSource}).`,
        });

        send({ type: "status", message: "Resolving MongoGPT token…" });
        const mongoUrl = resolveMongoGptMessagesUrl(body.mongogptUrl);
        const model = body.model || process.env.MONGOGPT_MODEL || "";
        if (!model) {
          send({
            type: "error",
            error:
              "No MongoGPT model selected. Open Settings → MongoGPT and pick a model.",
          });
          controller.close();
          return;
        }
        let tokenBundle = await getValidToken();
        send({
          type: "status",
          message: `MongoGPT token ready (${tokenBundle.actions.join(", ")}). Model: ${model}.`,
        });

        const messages: MongoGptMessage[] = [
          { role: "system", content: AGENT_SYSTEM_PROMPT },
          {
            role: "user",
            content: buildInitialUserMessage(body.input, body.artifacts ?? []),
          },
        ];

        const maxSteps = Math.max(
          1,
          Math.min(20, body.maxSteps ?? DEFAULT_MAX_STEPS),
        );

        send({
          type: "status",
          message: `Starting agent loop (max ${maxSteps} steps)…`,
        });

        let finalReport = "";
        for (let step = 1; step <= maxSteps; step++) {
          send({
            type: "status",
            message: `Step ${step}: asking MongoGPT…`,
          });

          let response;
          try {
            response = await callMongoGptTools({
              url: mongoUrl,
              token: tokenBundle.token,
              model,
              messages,
              tools: AGENT_TOOLS,
              toolChoice: "auto",
              temperature: 0.2,
              maxTokens: 8_000,
              timeoutMs: 240_000,
            });
          } catch (err) {
            const msg = (err as Error).message;
            if (/\b(401|403|unauthori[sz]ed|forbidden)\b/i.test(msg)) {
              send({
                type: "status",
                message: "MongoGPT returned 401 — refreshing token…",
              });
              invalidateToken();
              tokenBundle = await getValidToken({ force: true });
              response = await callMongoGptTools({
                url: mongoUrl,
                token: tokenBundle.token,
                model,
                messages,
                tools: AGENT_TOOLS,
                toolChoice: "auto",
                temperature: 0.2,
                maxTokens: 8_000,
                timeoutMs: 240_000,
              });
            } else {
              throw err;
            }
          }

          const { content, toolCalls } = response;

          // No tool calls → we have the final report.
          if (!toolCalls || toolCalls.length === 0) {
            finalReport = content.trim();
            break;
          }

          // Record the assistant turn (with its tool_calls) so the conversation
          // history is consistent for the next MongoGPT call.
          messages.push({
            role: "assistant",
            content: content || null,
            tool_calls: toolCalls,
          });

          send({
            type: "step_start",
            step,
            toolCalls: toolCalls.map((c) => ({
              id: c.id,
              name: c.function.name,
              argsPreview: previewArgs(c.function.arguments),
            })),
          });

          // Execute all tool calls for this step in parallel — Glean MCP
          // sessions are independent so there's no ordering constraint.
          const results = await Promise.all(
            toolCalls.map(async (call) => {
              try {
                const r = await executeToolCall(
                  call.function.name,
                  call.function.arguments,
                  ctx,
                );
                send({
                  type: "tool_result",
                  id: call.id,
                  name: call.function.name,
                  summary: r.summary,
                  ok: true,
                });
                return { call, text: r.text, ok: true };
              } catch (err) {
                const reason = (err as Error).message;
                send({
                  type: "tool_result",
                  id: call.id,
                  name: call.function.name,
                  summary: `error: ${reason}`,
                  ok: false,
                });
                return {
                  call,
                  text: `ERROR from ${call.function.name}: ${reason}`,
                  ok: false,
                };
              }
            }),
          );

          for (const r of results) {
            messages.push({
              role: "tool",
              tool_call_id: r.call.id,
              content: r.text,
            });
          }

          if (step === maxSteps) {
            send({
              type: "status",
              message: `Hit max step limit (${maxSteps}). Forcing final report…`,
            });
            // Ask the model to emit the report with no further tools.
            messages.push({
              role: "user",
              content:
                "Step budget reached. Emit the final Risk Register Report now " +
                "using the evidence gathered so far. Do not call any more tools. " +
                "Mark Confidence=Low where evidence is thin.",
            });
            const forced = await callMongoGptTools({
              url: mongoUrl,
              token: tokenBundle.token,
              model,
              messages,
              tools: AGENT_TOOLS,
              toolChoice: "none",
              temperature: 0.2,
              maxTokens: 8_000,
              timeoutMs: 240_000,
            });
            finalReport = forced.content.trim();
          }
        }

        if (!finalReport) {
          send({
            type: "error",
            error: "Agent exited without producing a report.",
          });
        } else {
          send({ type: "final", report: finalReport });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "error", error: message })}\n\n`,
          ),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

function previewArgs(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const pick = (k: string) =>
      typeof parsed[k] === "string" ? (parsed[k] as string) : undefined;
    const first =
      pick("message") ||
      pick("query") ||
      (Array.isArray(parsed.urls) ? `${parsed.urls.length} url(s)` : undefined);
    return first ? (first.length > 120 ? `${first.slice(0, 120)}…` : first) : raw.slice(0, 120);
  } catch {
    return raw.slice(0, 120);
  }
}

function sseError(message: string, status: number): Response {
  const body = `data: ${JSON.stringify({ type: "error", error: message })}\n\n`;
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/event-stream; charset=utf-8" },
  });
}
