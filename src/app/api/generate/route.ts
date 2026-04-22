/**
 * POST /api/generate — server-side LLM call that synthesizes the
 * collected artifacts + pasted Auto Triage output into a Risk Register
 * Report following the embedded risk-assessment skill.
 */

import { NextResponse } from "next/server";
import { RISK_ASSESSMENT_SKILL, buildLgtmBlock, extractLgtmReviewers, formatCaseIntelligenceBlock, titleCase } from "@/lib/risk-skill";
import type { AssessmentInput, GatheredArtifact } from "@/lib/types";
import { callMongoGpt } from "@/lib/mongogpt";
import { resolveMongoGptMessagesUrl } from "@/lib/mongogpt-url";
import { getValidToken, invalidateToken } from "@/lib/mongogpt-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface Body {
  input: AssessmentInput;
  artifacts: GatheredArtifact[];
  provider?: "openai" | "anthropic" | "mongogpt";
  apiKey?: string;
  model?: string;
  mongogptUrl?: string;
}

const SYSTEM_PROMPT = `You are a senior MongoDB Technical Services engineer drafting an internal Risk Register Report for a customer. Follow the embedded skill playbook below exactly — especially the Step 4 output structure. Produce a single complete markdown document and nothing else.

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

Rules:
- Output ONLY the markdown report. Your very first character must be the # heading marker. No preamble like "Here is the report" or "I have enough information". No explanation before or after. No code fences around the whole document. JUST the markdown.
- Every risk in Key Findings must be backed by evidence from the artifacts. If evidence is weak, set Confidence to Low.
- Prefer specific case numbers, PS report titles, and Slack thread dates when citing sources.
- When referencing a Slack thread or conversation ANYWHERE in the report (Notes & Anecdotes, timeline, risk evidence), you MUST include a clickable Slack URL from the Glean citations. Write as [Slack thread — topic](https://mongodb.enterprise.slack.com/archives/...) or [csm-{account} discussion](https://mongodb.enterprise.slack.com/archives/...). Scan ALL citation URLs for slack.com links and use them. Never mention a Slack conversation without a URL. If no URL is available for a Slack reference, state "(Slack URL not available in sources)".
- If a table cell has no data, write "—" rather than fabricating a value.
- Keep the document INTERNAL ONLY banner at the top.
- Set Author(s) to "MongoDB Technical Services". Never refer to the author or DRI as a "TAM" or "Technical Account Manager" — always use "Technical Services".
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
- The Account Timeline (Appendix C) must use this EXACT table format — no bullets, no numbered lists, always a table:
  | Date | Ticket / Reference | Summary |
  |------|-------------------|---------|
  | {Mon DD, YY or Month YYYY} | [Case XXXXXXXX](https://hub.corp.mongodb.com/case/XXXXXXXX) / [HELP-XXXXX](https://jira.mongodb.org/browse/HELP-XXXXX) / [Slack thread](https://slack-url...) | {What happened and outcome} |
  Every row MUST have a hyperlinked reference. Omit rows without one.

=== Risk Assessment Skill (authoritative playbook) ===
${RISK_ASSESSMENT_SKILL}
=== End Skill ===`;

function buildUserMessage(body: Body): string {
  const { input, artifacts } = body;

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
        body.slice(0, 8_000) +
        (citationsLines ? `\n\n**Citations:**\n${citationsLines}` : "")
      );
    })
    .join("\n\n---\n\n");

  const searchBlocks = searchArtifacts
    .map((a) => {
      const payload =
        typeof a.data === "string" ? a.data : JSON.stringify(a.data, null, 2);
      return `### ${a.source.toUpperCase()} — ${a.label}${a.query ? ` (query: ${a.query})` : ""}\n\n\`\`\`json\n${payload.slice(0, 4_000)}\n\`\`\``;
    })
    .join("\n\n");

  const now = new Date();
  const startDate = new Date(now);
  startDate.setMonth(startDate.getMonth() - input.timeframeMonths);
  const fmtDate = (d: Date) => d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const timelineStart = fmtDate(startDate);
  const timelineEnd = fmtDate(now);

  const accountDisplay = titleCase(input.accountName);

  const lgtmBlock = buildLgtmBlock(artifacts);
  console.log("[LGTM extract]", extractLgtmReviewers(artifacts));
  // Log the raw stakeholder artifact text to diagnose extraction misses
  const stakeholderArt = artifacts.find(
    (a) => a.kind === "chat" && /stakeholder/i.test(a.label),
  );
  if (stakeholderArt) {
    const txt = typeof stakeholderArt.data === "string"
      ? stakeholderArt.data
      : JSON.stringify(stakeholderArt.data);
    console.log("[Stakeholder artifact text (first 1500 chars)]:\n", txt.slice(0, 1500));
  } else {
    console.log("[Stakeholder artifact] NOT FOUND — artifact labels:", artifacts.map((a) => a.label));
  }

  return [
    `Account: **${accountDisplay}**`,
    `Motivation: ${input.motivation}`,
    `Timeframe: last ${input.timeframeMonths} months (${timelineStart} to ${timelineEnd})`,
    `IMPORTANT: The Case Review Timeline in the report MUST be "${timelineStart} to ${timelineEnd}". Do NOT use any other date range. Ignore case dates that fall outside this window.`,
    input.knownConcerns ? `Known concerns: ${input.knownConcerns}` : null,
    "",
    lgtmBlock,
    "",
    caseIntelligenceBlock || null,
    caseIntelligenceBlock ? "" : null,
    "## Glean Synthesis (pre-analyzed by Glean AI — trust as evidence)",
    chatBlocks ||
      "_(Glean chat produced no content — rely on search artifacts below)_",
    "",
    "## Supporting Artifacts (raw Glean search hits)",
    searchBlocks || "_(none)_",
    "",
    "Draft the complete Risk Register Report now. The Glean Synthesis block contains pre-analyzed, cited content — treat it as High confidence evidence where it names specific cases, JIRA tickets, Slack threads, or PS engagements." +
      (caseIntelligenceBlock
        ? " The Auto Triage Case Intelligence block contains per-case technical depth pulled directly from Salesforce case comments — use it as the primary evidence for Key Findings, Recommendations, and Appendix B (Case Review Detail)."
        : ""),
  ]
    .filter(Boolean)
    .join("\n");
}

async function generateOpenAI(
  apiKey: string,
  model: string,
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
      temperature: 0.2,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
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

async function generateAnthropic(
  apiKey: string,
  model: string,
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
      max_tokens: 16_000,
      temperature: 0.2,
      system: SYSTEM_PROMPT,
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

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.input?.accountName) {
    return NextResponse.json(
      { error: "Missing input.accountName" },
      { status: 400 },
    );
  }

  const provider =
    body.provider ??
    (process.env.LLM_PROVIDER as "openai" | "anthropic" | "mongogpt") ??
    "mongogpt";

  const user = buildUserMessage(body);

  try {
    let report: string;
    if (provider === "anthropic") {
      const apiKey = body.apiKey || process.env.ANTHROPIC_API_KEY || "";
      const model =
        body.model || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
      if (!apiKey)
        return NextResponse.json(
          { error: "Missing Anthropic API key (set in Settings)." },
          { status: 400 },
        );
      report = await generateAnthropic(apiKey, model, user);
    } else if (provider === "mongogpt") {
      const url = resolveMongoGptMessagesUrl(body.mongogptUrl);
      const model = body.model || process.env.MONGOGPT_MODEL || "";
      if (!model)
        return NextResponse.json(
          {
            error:
              "No MongoGPT model selected. Open Settings → MongoGPT and pick a model from the dropdown.",
          },
          { status: 400 },
        );
      const messages = [
        { role: "system" as const, content: SYSTEM_PROMPT, name: "risksi" },
        { role: "user" as const, content: user, name: "risksi" },
      ];
      const first = await getValidToken();
      try {
        report = await callMongoGpt({
          url,
          token: first.token,
          model,
          messages,
          timeoutMs: 240_000,
        });
      } catch (err) {
        const msg = (err as Error).message;
        if (/\b(401|403|unauthori[sz]ed|forbidden)\b/i.test(msg)) {
          invalidateToken();
          const refreshed = await getValidToken({ force: true });
          report = await callMongoGpt({
            url,
            token: refreshed.token,
            model,
            messages,
            timeoutMs: 240_000,
          });
        } else {
          throw err;
        }
      }
    } else {
      const apiKey = body.apiKey || process.env.OPENAI_API_KEY || "";
      const model = body.model || process.env.OPENAI_MODEL || "gpt-4o";
      if (!apiKey)
        return NextResponse.json(
          { error: "Missing OpenAI API key (set in Settings)." },
          { status: 400 },
        );
      report = await generateOpenAI(apiKey, model, user);
    }
    // Post-process: strip any preamble before the first markdown heading
    report = stripPreamble(report);
    // Post-process: normalize case links to hub.corp.mongodb.com
    report = normalizeCaseLinks(report);
    return NextResponse.json({ ok: true, report });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}

/**
 * Strip any conversational preamble the LLM may have emitted before the
 * actual markdown report. Finds the first top-level heading (`# ...`) and
 * discards everything before it.
 */
function stripPreamble(md: string): string {
  const idx = md.search(/^#\s/m);
  if (idx > 0) return md.slice(idx);
  return md;
}

/**
 * Post-process generated markdown to ensure all case number references
 * link to https://hub.corp.mongodb.com/case/{number}.
 * Matches bare "Case XXXXXXXX" text that isn't already inside a markdown link.
 */
function normalizeCaseLinks(md: string): string {
  // Match "Case 01234567" not already inside [...](...) markdown links
  return md.replace(
    /(?<!\[)Case\s+(0\d{7})(?!\]\()/gi,
    (_, num: string) =>
      `[Case ${num}](https://hub.corp.mongodb.com/case/${num})`,
  );
}
