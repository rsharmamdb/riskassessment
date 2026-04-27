/**
 * POST /api/generate — server-side LLM call that synthesizes the
 * collected artifacts + pasted Auto Triage output into a Risk Register
 * Report following the embedded risk-assessment skill.
 */

import { NextResponse } from "next/server";
import { RISK_ASSESSMENT_SKILL, formatCaseIntelligenceBlock, titleCase } from "@/lib/risk-skill";
import type { AssessmentInput, GatheredArtifact } from "@/lib/types";
import "@/lib/server-fetch-agent"; // side-effect: bump undici timeouts
import { callMongoGpt, callMongoGptStream } from "@/lib/mongogpt";
import { resolveMongoGptMessagesUrl } from "@/lib/mongogpt-url";
import { getValidToken, invalidateToken } from "@/lib/mongogpt-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900;

interface PriorRiskStatus {
  riskId: number;
  status: string;
  owner?: string | null;
  dueDate?: string | null;
}

interface PriorReport {
  report: string;
  generatedAt: string;
  /** Reviewer-set statuses for each Risk # in the prior report. */
  riskStatuses: PriorRiskStatus[];
}

interface Body {
  input: AssessmentInput;
  artifacts: GatheredArtifact[];
  provider?: "openai" | "anthropic" | "mongogpt";
  apiKey?: string;
  model?: string;
  mongogptUrl?: string;
  /** Most recent generation of this report, with the reviewer-set risk
   *  statuses at that point in time. Used for recurrence detection and
   *  regression flagging. Omit for first-ever generation. */
  priorReport?: PriorReport | null;
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
- **Preserve exact evidence.** Case-intelligence artifacts contain Evidence and Specific Recommendations blocks. When emitting the Risk Detail block described in the skill, reproduce queries / error codes / index specs / config params exactly as they appear in the artifacts rather than paraphrasing. Do not invent snippets that aren't in the artifacts — if a field is missing, write \`(not stated in evidence)\`. **Never emit the word "verbatim" or "VERBATIM" in the report** — that was direction to the extractor, not a label for the reader.
- **Formatting rules for code, queries, and logs.** Reader-friendliness is non-negotiable:
  - A single identifier, option name, field name, or short inline value goes in inline backticks: \`maxPoolSize\`, \`{ customerId: 1 }\`, \`E11000\`.
  - A single-line command or query (no newlines, under ~100 chars) can stay inline.
  - **Anything with newlines goes in a fenced code block with a language hint.** Stack traces → \`\`\`log. JavaScript / MongoDB shell → \`\`\`javascript. SQL → \`\`\`sql. Shell commands → \`\`\`shell. Plain multi-line text → \`\`\`text. NEVER emit a stack trace or a multi-line log as a series of comma-separated inline backtick spans.
  - **Three-or-more rule:** when listing 3+ items of the same kind (index specs, config params, commands, queries), render them as a fenced code block with ONE item per line — do NOT emit them as a single bullet with \`-\` or comma separators between items. Any prose annotation about each item belongs in a separate bullet list AFTER the code block. Example — right:

    \`\`\`javascript
    { tenant_id: 1, department_id: 1 }
    { stamp: 1 }
    { convert_status: 1, tenant_id: 1, model: 1 }
    \`\`\`
    - First index does not cover \`_id\` sort.
    - Second: leading-key mismatch causes full range scan.

    Wrong (what the current runs are doing): one bullet containing \`\` \`idx1\` — annotation \`idx2\` — annotation \`idx3\` \`\` smooshed together.
  - Never place a newline INSIDE an inline backtick span. An index spec like \`{ stamp: 1\n}\` (with the closing brace on its own line) breaks markdown rendering — put the whole spec on one inline line, or move the whole thing into a fenced block.
  - Recommendations must NEVER contain loose CLI fragments outside a fenced block. If the evidence has \`grep -E "model name"\` or similar, wrap the whole command in a \`\`\`shell block; don't drop the fragment inline in a prose sentence.
  - Section labels inside a Risk Detail block use markdown subheadings (\`#### Risk #N — …\`, \`##### Evidence\`, \`##### Recommendation\`). Do NOT emit \`**Evidence:**\` / \`**Recommendation:**\` as bold-text labels inside bullet lists — that renders as visual noise in PDFs.
- **Use taxonomy ids.** The Risk Register's Key Findings table has a Taxonomy column and the "Case breakdown by taxonomy" table uses the kebab-case ids emitted by case-intelligence (e.g. \`query-performance\`, \`connectivity\`, \`replication\`). Only emit rows for ids that actually appear in the case-intelligence classifications. Do not invent categories outside the taxonomy.
- **Concrete recommendations only.** Every row of the Recommendations table and every "Specific Recommendation" block in Risk Detail must carry literal parameters (exact index spec, concrete config values, runnable commands). Reject generic phrasing like "tune the pool" or "review indexes" — replace it with actual values drawn from the evidence.
- **Mandatory \`**Sources:**\` line at the END of every Risk Detail block.** Every Risk Detail block (\`#### Risk #N — …\`) MUST end with a single \`**Sources:**\` line listing every link the risk draws on, separated by " · ". Each entry is a markdown link — Cases, JIRAs, and Slack threads. This Banque-style provenance line lets a reviewer audit the risk without scanning the prose. Even though the same links appear inline within Evidence and Recommendation, restate them here as a consolidated list. Format example: \`**Sources:** [Case 01571156](https://hub.corp.mongodb.com/case/01571156) · [HELP-91610](https://jira.mongodb.org/browse/HELP-91610) · [csm-trend-micro · Mar 12 thread](https://mongodb.enterprise.slack.com/archives/...)\`.
- **Account Timeline cell formatting.** Cells in the Summary column of the Account Timeline (Appendix C) prefer 2-4 short bullets (one per distinct event), each ≤ 18 words, over a single dense run-on sentence. Wrap any inline JIRA / case / Slack mention as a markdown link, not plain text — same rule as elsewhere.
- **Prior-report awareness (recurrence + regression).** When the user message includes a "Prior Report Context" section, you must compare every current risk against the prior report's Key Findings + Recommendations and tag it with exactly one of these four labels in a **Change from prior** column on the Key Findings table:
  - \`NEW\` — risk did not appear in the prior report.
  - \`RECURRING-OPEN\` — prior recommendation existed and was NOT marked Mitigated (status was Open / In Progress / Deferred / blank).
  - \`REGRESSION\` — prior recommendation was marked \`Mitigated\` by a reviewer, BUT evidence of the same risk appears in the new data. **Upgrade severity by one notch** (Roadmap Planning → Significant → Critical; Critical stays Critical). In Risk Detail add a mandatory subsection titled **"Why the prior mitigation did not stick"** with at least one concrete hypothesis (e.g. partial fix, new cluster / region onboarding since last report, config drift, driver rollback).
  - \`PERSISTED-WORSE\` — same as RECURRING-OPEN but evidence is heavier than in the prior report (more cases, higher severities).
  Matching is semantic (same taxonomy id + same symptom cluster), not by Risk #. Prior report Risk #3 may correspond to current Risk #1.
- **Weave prior-report context into prose, do NOT emit a dedicated section for it.** When a prior report is provided:
  - Open the **Executive Summary** with one sentence naming this as the second (or Nth) review of the account and the date the previous register was delivered. Close the Executive Summary with one sentence summarizing what changed since — e.g. "Since the Mar 2026 review, 2 recommendations have been mitigated, 3 remain open, and 1 previously-closed risk has re-opened."
  - For each non-\`NEW\` risk, reference the prior report inside the Risk Detail prose / Recommendation text naturally — e.g. *"first flagged as Risk #3 in the Mar 2026 report"*, *"reiterating our Mar 2026 recommendation to set \`maxPoolSize=500\`, …"*, *"this is the third quarter this pattern has appeared."* Do NOT add a \`##### How this risk appeared in the previous report\`, \`##### Prior context\`, or similar standalone sub-section to Risk Detail. The only prior-state section that renders explicitly is the top-of-report **Regression Alerts** table (when REGRESSION tags exist). Everything else is prose.
  - If a matched risk has \`Not Set\` / missing reviewer status in the prior report, simply don't mention status in the prose — the absence of a reviewer mark is not itself a story beat.
- **Regression Alerts section.** Immediately BEFORE the Key Findings table, if any risk has a \`REGRESSION\` tag, emit a section titled \`## Regression Alerts\` listing those risks in a short table (Risk # · title · prior mitigation date · what was supposed to be fixed · what's recurring now). Omit the section entirely if no REGRESSION tags exist. Never emit an empty Regression Alerts section.
- **No Prior Report = all rows NEW.** If no "Prior Report Context" is provided, tag every risk \`NEW\` and skip the Regression Alerts section.
- **Inline links — non-negotiable.** Every mention of a case number, JIRA ticket, or Slack thread ANYWHERE in the report (prose, tables, lists, captions, Sources lines, timeline cells — every occurrence, not just the first) MUST be a markdown link to its source URL. Plain text references are forbidden.
  - **Cases:** \`[Case 0XXXXXXX](https://hub.corp.mongodb.com/case/0XXXXXXX)\` — digits only, no dashes.
  - **JIRA tickets:** match the prefix exactly. \`[HELP-91610](https://jira.mongodb.org/browse/HELP-91610)\`. Same pattern for \`SERVER-\`, \`CLOUDP-\`, \`CLOUDOPS-\`, \`MONGOSH-\`, \`PYTHON-\`, \`NODE-\`, \`JAVA-\`, \`GO-\`, \`KAFKA-\`, \`SPARK-\`, \`COMPASS-\`, \`DRIVERS-\`, etc.
  - **Slack threads:** see the Slack rule below.
- **Slack threads — prefer the URL list, fall back gracefully.** When the user message includes a \`## Available Slack threads\` section (server-injected from the Glean Slack search hits), ALWAYS prefer one of those URLs when citing a Slack conversation; emit as \`[csm-{account} · {Mon DD} thread](url)\` or \`[Slack thread — {short topic}](url)\`. If the relevant Slack URL is genuinely not in that list, you MAY still mention the Slack conversation in prose using \`[csm-{account} discussion](#)\` (no URL); do NOT silently drop the reference, and do NOT write "(Slack URL not available)" — that phrasing is verbose and gets stale. The pre-extracted list is authoritative; trust it before inventing URLs.
- If a table cell has no data, write "—" rather than fabricating a value.
- Keep the document INTERNAL ONLY banner at the top.
- Set Author(s) to "MongoDB Technical Services". Never refer to the author or DRI as a "TAM" or "Technical Account Manager" — always use "Technical Services".
- **Do NOT emit the company name in the report's H1.** Use \`# Risk Register Report\` only. The DOCX/PDF cover already prints the canonical account name above the body — repeating it in the H1 produces a "Trend" / "Trend Micro Incorporated" duplication that confuses readers.
- **Do NOT emit any reviewer sign-off or "LGTM Tracking" section in the report.** The report itself must not include any "Appendix D", a "Reviewer / Role / Sign-off Date" table, or a sign-off prompt. This app has no reviewer-sign-off workflow — omit the concept entirely.
- **Account Risk Rating (REQUIRED, top of report).** Emit the \`## Account Risk Rating\` section exactly once, immediately after \`**Date Finalized:**\` and BEFORE \`## Renewal / Commercial Context\`. Its \`**Overall:**\` line MUST contain exactly one of \`\`\`RED\`\`\`, \`\`\`YELLOW\`\`\`, or \`\`\`GREEN\`\`\` in inline backticks — this token is machine-parsed downstream to drive a badge on the report page. Rating rules (apply ALL, take the worst colour any rule produces):
  - **RED** if ANY of: ≥ 2 open Critical technical risks; customer sentiment = \`Frustrated\`; renewal window ≤ 3 months AND sentiment is not Cooperative; at least one \`REGRESSION\` tag in Key Findings; explicit competitive POC / migration activity (\`DocumentDB\`, \`Aurora\`, \`Cosmos DB\`, \`Firestore\`, \`CockroachDB\`, \`Yugabyte\`) cited in evidence.
  - **YELLOW** if (not RED and) ANY of: 1 open Critical OR ≥ 2 Significant technical risks; sentiment = \`Mixed\`; renewal 3–9 months with stable sentiment; recurring-open risks carried over from the prior report.
  - **GREEN** if (not RED, not YELLOW): no Critical risks, sentiment is \`Neutral\` or \`Cooperative\`, no commercial/churn signals, no regressions.
  - Evidence floor: the sentiment driver MUST cite 1–2 case numbers or short verbatim phrases from the Auto Triage \`Customer Sentiment & Engagement\` block. Do NOT invent sentiment if that block says "Insufficient evidence" — in that case, treat sentiment as \`Neutral\` for rating purposes and say so in the drivers table.
- **Every risk in Key Findings must carry a \`Category\` tag.** Exactly one of \`Technical\` / \`Interim\` / \`TS-Process\` / \`Customer-Behaviour\` / \`Commercial\`. A register that shows only Technical rows is incomplete — at least review the Auto Triage \`TS / Support-Ops Observations\` and \`Customer Sentiment & Engagement\` blocks for non-Technical candidates before finalizing. If none apply, say so in a one-line note under the Key Findings table.
- **Separate interim from durable fixes.** When a Technical risk has a durable fix with an ETA > 30 days AND a short-term tactical hold-over is known or reasonable to propose, add a separate row to Key Findings with \`Category: Interim\` that references the durable-fix row. Populate the \`## Interim Mitigations\` section with the same rows expanded (Interim action / Owner / ETA / Durable fix it replaces). If there are no interim mitigations, omit the \`## Interim Mitigations\` section entirely — do not emit an empty heading.
- **TS Process, Customer Behaviour sections must be evidence-backed or explicitly empty.** If the Auto Triage evidence produces observations, emit bullets with citations. If there are none, write the literal sentence *"No TS process gaps surfaced in the evidence for this period."* / *"No customer-side governance gaps surfaced in the evidence."* — never fabricate.
- The Account Timeline (Appendix C) is the final appendix. Do not add any appendix after it.
- The Account Timeline (Appendix C) must use this EXACT table format — no bullets, no numbered lists, always a table:
  | Date | Ticket / Reference | Summary |
  |------|-------------------|---------|
  | {Mon DD, YY or Month YYYY} | [Case XXXXXXXX](https://hub.corp.mongodb.com/case/XXXXXXXX) / [HELP-XXXXX](https://jira.mongodb.org/browse/HELP-XXXXX) / [Slack thread](https://slack-url...) | {What happened and outcome} |
  Every row MUST have a hyperlinked reference. Omit rows without one.

=== Risk Assessment Skill (authoritative playbook) ===
${RISK_ASSESSMENT_SKILL}
=== End Skill ===`;

/**
 * Render the prior-report context block that goes into the user message
 * when a previous generation exists. Empty string if no prior.
 */
function formatPriorReportBlock(prior: PriorReport | null | undefined): string {
  if (!prior?.report) return "";
  const statusMap = new Map<number, PriorRiskStatus>();
  for (const s of prior.riskStatuses ?? []) statusMap.set(s.riskId, s);
  const statusLines = Array.from(statusMap.values())
    .sort((a, b) => a.riskId - b.riskId)
    .map(
      (s) =>
        `- Risk #${s.riskId}: \`${s.status}\`${s.owner ? ` · owner ${s.owner}` : ""}${s.dueDate ? ` · due ${s.dueDate}` : ""}`,
    )
    .join("\n");

  return [
    "## Prior Report Context (for recurrence + regression detection)",
    `Prior report was generated on **${prior.generatedAt}**. Reviewer-set risk statuses AT THE TIME OF THIS NEW GENERATION:`,
    statusLines || "_(no reviewer statuses recorded — treat all prior risks as Open)_",
    "",
    "Use the statuses above to classify each current risk in the Key Findings \"Change from prior\" column (NEW / RECURRING-OPEN / REGRESSION / PERSISTED-WORSE). A risk is a REGRESSION only if the prior report's Risk # had status `Mitigated` AND the same symptom appears in current evidence.",
    "",
    "### Prior Report (full markdown)",
    "```markdown",
    // Cap the prior at 20k chars — risk register reports are typically well
    // under this, but a safety net keeps token count bounded.
    prior.report.slice(0, 20_000),
    "```",
  ].join("\n");
}

/**
 * Pull every Slack URL we can find across the artifacts (search hits +
 * chat citations) and return a deduplicated, link-ready list. The LLM
 * historically dropped Slack mentions when no URL was inline; injecting
 * this pre-extracted block under a "## Available Slack threads" header
 * gives it something to cite from.
 */
function extractSlackThreads(
  artifacts: GatheredArtifact[],
): Array<{ url: string; title: string; date?: string }> {
  const seen = new Set<string>();
  const out: Array<{ url: string; title: string; date?: string }> = [];
  const isSlack = (u?: string): boolean =>
    !!u && /(slack\.com|enterprise\.slack)/i.test(u);

  for (const a of artifacts) {
    // chat artifacts: structured citations array
    for (const c of a.citations ?? []) {
      if (isSlack(c.url) && !seen.has(c.url!)) {
        seen.add(c.url!);
        out.push({
          url: c.url!,
          title: c.title || c.snippet || "Slack thread",
        });
      }
    }
    // search artifacts: data is `SearchHit[]` with url + title
    if (Array.isArray(a.data)) {
      for (const hit of a.data as Array<{
        url?: string;
        title?: string;
        snippet?: string;
      }>) {
        if (isSlack(hit.url) && !seen.has(hit.url!)) {
          seen.add(hit.url!);
          out.push({
            url: hit.url!,
            title: hit.title || hit.snippet || "Slack thread",
          });
        }
      }
    }
  }
  return out;
}

function formatSlackThreadsBlock(
  threads: ReturnType<typeof extractSlackThreads>,
): string {
  if (threads.length === 0) return "";
  const lines = threads
    .slice(0, 40) // cap so the block stays bounded; 40 covers most accounts
    .map((t) => {
      const safeTitle = t.title.replace(/[\r\n]+/g, " ").slice(0, 120);
      return `- [${safeTitle}](${t.url})`;
    });
  return [
    "## Available Slack threads (use these URLs when citing Slack inline)",
    "_Pre-extracted from the Glean Slack search hits and chat-artifact citations. When a Slack thread informs a risk, cite ONE of these URLs in the inline link — do NOT invent Slack URLs._",
    "",
    ...lines,
  ].join("\n");
}

function buildUserMessage(body: Body): string {
  const { input, artifacts } = body;
  const priorBlock = formatPriorReportBlock(body.priorReport ?? null);
  const slackThreads = extractSlackThreads(artifacts);
  const slackThreadsBlock = formatSlackThreadsBlock(slackThreads);

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

  return [
    `Account: **${accountDisplay}**`,
    `Motivation: ${input.motivation}`,
    `Timeframe: last ${input.timeframeMonths} months (${timelineStart} to ${timelineEnd})`,
    `IMPORTANT: The Case Review Timeline in the report MUST be "${timelineStart} to ${timelineEnd}". Do NOT use any other date range. Ignore case dates that fall outside this window.`,
    input.knownConcerns ? `Known concerns: ${input.knownConcerns}` : null,
    "",
    priorBlock || null,
    priorBlock ? "" : null,
    slackThreadsBlock || null,
    slackThreadsBlock ? "" : null,
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
        : "") +
      (priorBlock
        ? " Apply the Prior Report Context rules: every risk in Key Findings carries a Change-from-prior tag, and a Regression Alerts section appears only when REGRESSION tags exist."
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
  const startMs = Date.now();
  console.log("[generate] start", {
    provider,
    model: body.model,
    accountName: body.input.accountName,
    artifacts: body.artifacts?.length ?? 0,
    priorReport: body.priorReport ? "yes" : "no",
    userMessageChars: user.length,
    approxUserTokens: Math.round(user.length / 4),
  });

  // Pre-validate provider-specific inputs so we can return a clean 400
  // before starting the stream.
  if (provider === "anthropic") {
    const apiKey = body.apiKey || process.env.ANTHROPIC_API_KEY || "";
    if (!apiKey) {
      return NextResponse.json(
        { error: "Missing Anthropic API key (set in Settings)." },
        { status: 400 },
      );
    }
  } else if (provider === "mongogpt") {
    const model = body.model || process.env.MONGOGPT_MODEL || "";
    if (!model) {
      return NextResponse.json(
        {
          error:
            "No MongoGPT model selected. Open Settings → MongoGPT and pick a model from the dropdown.",
        },
        { status: 400 },
      );
    }
  } else {
    const apiKey = body.apiKey || process.env.OPENAI_API_KEY || "";
    if (!apiKey) {
      return NextResponse.json(
        { error: "Missing OpenAI API key (set in Settings)." },
        { status: 400 },
      );
    }
  }

  // Build a streaming NDJSON response. One event per line:
  //   {"type":"start"}
  //   {"type":"delta","text":"...partial markdown..."}  (many, for mongogpt)
  //   {"type":"done","report":"<normalized final report>"}
  //   {"type":"error","error":"..."}
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (evt: Record<string, unknown>) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(evt) + "\n"));
        } catch {
          /* controller may already be closed */
        }
      };

      try {
        send({ type: "start", provider, model: body.model });

        let report: string;
        if (provider === "mongogpt") {
          const url = resolveMongoGptMessagesUrl(body.mongogptUrl);
          const model = body.model || process.env.MONGOGPT_MODEL || "";
          const messages = [
            { role: "system" as const, content: SYSTEM_PROMPT, name: "risksi" },
            { role: "user" as const, content: user, name: "risksi" },
          ];

          const runStream = async (token: string) =>
            callMongoGptStream({
              url,
              token,
              model,
              messages,
              timeoutMs: 900_000,
              onChunk: (text) => send({ type: "delta", text }),
            });

          const first = await getValidToken();
          try {
            report = await runStream(first.token);
          } catch (err) {
            const msg = (err as Error).message;
            if (/\b(401|403|unauthori[sz]ed|forbidden)\b/i.test(msg)) {
              invalidateToken();
              const refreshed = await getValidToken({ force: true });
              report = await runStream(refreshed.token);
            } else {
              throw err;
            }
          }
        } else if (provider === "anthropic") {
          const apiKey = body.apiKey || process.env.ANTHROPIC_API_KEY || "";
          const model =
            body.model || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
          // Buffered — emit as one delta + done so the client code path is
          // uniform.
          report = await generateAnthropic(apiKey, model, user);
          send({ type: "delta", text: report });
        } else {
          const apiKey = body.apiKey || process.env.OPENAI_API_KEY || "";
          const model = body.model || process.env.OPENAI_MODEL || "gpt-4o";
          report = await generateOpenAI(apiKey, model, user);
          send({ type: "delta", text: report });
        }

        // Post-process final text.
        report = stripPreamble(report);
        report = normalizeCaseLinks(report);

        console.log("[generate] done", {
          provider,
          model: body.model,
          durationMs: Date.now() - startMs,
          reportChars: report.length,
        });
        send({ type: "done", report });
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        const cause = (err as { cause?: unknown })?.cause;
        const causeCode =
          cause && typeof cause === "object" && "code" in cause
            ? String((cause as { code: unknown }).code)
            : undefined;
        const causeMessage =
          cause instanceof Error ? cause.message : undefined;
        let message = raw;
        if (causeCode) {
          message = `Generation failed (${provider}): ${raw} [cause=${causeCode}${causeMessage ? `: ${causeMessage}` : ""}]`;
        } else if (/\baborted\b/i.test(raw)) {
          message = `Generation aborted (${provider}) — likely exceeded a timeout. raw=${raw.slice(0, 200)}`;
        } else {
          message = `Generation failed (${provider}): ${raw}`;
        }
        console.error("[generate] failed:", {
          provider,
          model: body.model,
          durationMs: Date.now() - startMs,
          message: raw,
          causeCode,
          causeMessage,
          err,
        });
        send({ type: "error", error: message });
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
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
