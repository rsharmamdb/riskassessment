/**
 * Embedded copy of the Risk Assessment skill playbook.
 *
 * Source: premserv-workspace/extension/src/tools/premserv-agent/skills/
 *          operations/risk-assessment.md
 *
 * We inline it here so the app has a single-file, dependency-free copy of
 * the exact workflow the PremServ agent follows. It is fed to the LLM as
 * the system prompt during report synthesis.
 */

/** Title-case a string: "zomato" → "Zomato", "ACME corp" → "Acme Corp" */
export function titleCase(s: string): string {
  return s.replace(/\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

export const RISK_ASSESSMENT_SKILL = String.raw`# Risk Assessment — Risk Register Report Generation

Generate a Risk Register Report for a customer account. This report identifies technical risks previously highlighted in support cases and consulting reports, and recommends actions to address them in engagements.

**Focus:** Operations / Risk Management
**DRI:** Technical Services
**Typical Timeline:** ~13 business days (agent accelerates data gathering significantly)

## Step 1 — Gather Account Context and Identify Stakeholders
Ask the user for: account name, motivation (proactive / reactive / renewal / escalation), timeframe (default 6 months), known concerns.

Automated gathering:
- monday_get_tam_accounts({ accountName, includeSubitems: true })
- monday_get_doc({ subitemId }) for the last 4-8 weekly reports
- glean search: "{account} engagement overview", "{account} account team AE CSM", "csm-{account}" (app=slack)

Produce a stakeholder table (AE, CSM, SA, PS, TS, EM, TAM/NTSE) and flag high-context individuals for review later.

## Step 2 — Data Collection
Automated (Glean):
- "{account} consulting report", "{account} professional services", "{account} PS report recommendations"
- "csm-{account}" (app=slack), "{account} risk escalation" (app=slack)
- "{account} post-mortem RCA", "{account} HELP escalation"
- Case clustering & pattern analysis (Glean synthesizes support case themes)
- Per-case deep dive for top escalations (Sev1/Sev2, HELP JIRAs)

STOP after presenting the prompts; do not continue until the user pastes results back.

## Step 3 — Analyze Artifacts
Cross-reference PS report recommendations against case patterns. For each risk candidate assess:
- Severity: Critical / Significant / Roadmap Planning
- Confidence: High / Medium / Low
- Frequency: High / Medium / Low
- Impact of taking no action

Categorize findings by: Connectivity, Performance, Query/Index, Upgrade, Environment/Sizing, Product, Training, Admin, Terraform/CLI/API.

## Step 4 — Draft the Risk Register Report
Use this exact structure. Document is INTERNAL ONLY.

\`\`\`markdown
# {Account Name}: Risk Register Report

INTERNAL DOCUMENT ONLY - NOT TO BE SHARED WITH THE CUSTOMER

**Author(s):** MongoDB Technical Services
**Date Finalized:** {date}

## Executive Summary
{2-3 paragraphs: what prompted this review, the scope (number of cases, timeframe), key findings summary, and why it matters for the account relationship. If evidence is thin, add a caveat about confidence. End with a forward-looking statement about recommended engagement.}

## Key Findings
| # | Risk Identified | Severity | Confidence | Frequency of Risk | Impact of Taking No Action |
|---|-----------------|----------|------------|-------------------|----------------------------|
| 1 | ... | Critical / Significant / Roadmap Planning | High / Medium / Low | High / Medium / Low | ... |

## Case Review Summary
| Field | Value |
|-------|-------|
| Case Review Timeline | {start} to {end} |
| Total Cases Reviewed | {N} |
| Escalated Cases | {N} ({%}) |

**Case breakdown by problem category:**
| Category | Count |
|----------|-------|
| Training / Knowledge gaps | {N} ({%}) |
| Environment / Sizing problem | {N} ({%}) |
| Product (legitimate MongoDB issue) | {N} ({%}) |
| Pending Event | {N} ({%}) |
| Administrative issue | {N} ({%}) |

*Note: If some cases are unrelated (billing, portal questions), discount them and note the total vs reviewed count.*

**Case breakdown by technical area:**
| Technical Area | Count |
|----------------|-------|
| Connectivity / Networking | {N} ({%}) |
| Upgrade Activity | {N} ({%}) |
| Performance Issues | {N} ({%}) |
| Query & Index Issues | {N} ({%}) |
| Application / Client Side | {N} ({%}) |
| Resilience / DR Activity | {N} ({%}) |
| Terraform / CLI / API tools | {N} ({%}) |
| Atlas Administration Issues | {N} ({%}) |

## Recommendations
{Use a markdown table for recommendations. Each row should map to a specific risk and be specific about deliverables.}

| # | Recommendation | Severity | Deliverable | Expected Outcome |
|---|----------------|----------|-------------|------------------|
| 1 | {Specific action} | Critical Risk #1 | {Concrete deliverable} | {Expected outcome} |
| 2 | {Specific action} | Critical Risk #2 | {Concrete deliverable} | {Expected outcome} |
| 3 | {Specific action} | Significant Risk #3 | {Concrete deliverable} | {Expected outcome} |
| 4 | {Specific action} | Roadmap Planning Risk #N | {Concrete deliverable} | {Expected outcome} |

## Notes & Anecdotes
{Bullet points of raw observations from case review. Focus on behavioral patterns:
- Recommendations that went unimplemented or unacknowledged
- Cases that auto-closed due to lack of customer response
- Patterns of case severity mis-selection
- Recurring issues that could have been prevented
- Customer engagement quality with Technical Support
Include specific case numbers and source attribution for each observation.}

## Appendix
### A. Referenced Artifacts
| Artifact | Type | Link |
|----------|------|------|
### B. Case Review Detail
{Group by technical theme (e.g. "High CPU / Node Performance Issues", "Memory Management Issues", etc.). Under each theme, describe the pattern across cases with specific case references.}
### C. Account Timeline
| Date | Ticket / Reference | Summary |
|------|-------------------|---------|
| {Mon DD, YY} | {Case/HELP/Slack link} | {What happened and outcome} |
### D. LGTM Tracking
| Reviewer | Role | LGTM Date |
|----------|------|-----------|
| {name or —} | AE | — |
| {name or —} | CSM | — |
| {name or —} | PS | — |
\`\`\`

## Step 5 — Review Checklist
- All risks supported by case numbers / PS references
- Severity ratings justified and consistent
- Confidence reflects actual data quality
- Recommendations are specific and actionable
- No customer-sensitive info included
- Case counts and timeline accurate
- Executive summary matches findings

## Step 6 — Delivery
Acquire LGTM from AE, CSM, PS, TS. Deliver to account team only. Any customer-facing share should be a presentation at a QBR, not the raw register.
`;

/**
 * Glean `chat` prompts for the Data Collection step.
 *
 * Glean's `chat` tool invokes its agentic synthesis — it explores support
 * cases, Slack, PS reports, JIRA, and docs, then returns a cited, synthesized
 * answer. This is what produces the rich Ubuy-style recap (cases + CPU
 * spikes + escalation threads) rather than bare document snippets. Each
 * prompt here is tuned to be a self-contained ask Glean can answer in one
 * shot.
 */
export function buildGleanChatQueries(
  accountName: string,
  timeframeMonths: number,
  knownConcerns?: string,
): { label: string; message: string }[] {
  const window = `past ${timeframeMonths} month${timeframeMonths === 1 ? "" : "s"}`;
  const concernsClause = knownConcerns?.trim()
    ? ` Pay particular attention to: ${knownConcerns.trim()}.`
    : "";

  return [
    {
      label: "Support cases recap",
      message:
        `For the account "${accountName}" over the ${window}, list every support ` +
        `case you can find. For each, include: case number, problem statement, ` +
        `severity (Sev1/2/3/4), current status, product (Atlas/Enterprise/etc.), ` +
        `cluster name, and resolution or current blocker. Sort by severity, then ` +
        `by date descending. Cite each case with its hub.corp.mongodb.com URL.` +
        concernsClause,
    },
    {
      label: "Professional Services engagements",
      message:
        `For "${accountName}" over the ${window}, find every Professional Services ` +
        `engagement, consulting report, and PS-authored recommendation. For each ` +
        `engagement: date, scope, deliverable link, and the list of recommendations. ` +
        `Flag which recommendations appear implemented vs NOT implemented based on ` +
        `later cases or Slack discussion. Cite each source.`,
    },
    {
      label: "Slack channel activity + escalations",
      message:
        `Summarize Slack activity for "${accountName}" in the ${window}. Focus on: ` +
        `the csm-${accountName} channel, #help / #escalations discussions naming ` +
        `this account, RCA/post-mortem threads, and any recurring issue discussions. ` +
        `Include thread dates, participants, and the resulting decision or action. ` +
        `Cite each thread link.`,
    },
    {
      label: "Stakeholder map (AE / CSM / PS / TS / EM)",
      message:
        `Who is the AE, CSM, and full account team for "${accountName}"? ` +
        `Look across ALL sources: Salesforce Account Owner field, Salesforce Account CSM field, ` +
        `opportunity-level CSM/AE assignments on ${accountName} opportunities, ` +
        `"Set as Account CSM" or "Primary CSM" designations, ` +
        `csm-${accountName} Slack channel ownership/membership, ` +
        `recent case owner and escalation owner fields, and internal account planning docs. ` +
        `Produce this exact table: | Role | Name | Source | Notes |. ` +
        `Include rows for: AE, CSM, SA, PS, TS, EM, TAM/NTSE. ` +
        `For CSM: accept evidence from opportunity-level "Account CSM" or "Primary CSM" fields, ` +
        `not just the formal account-team role. If someone is listed as CSM on ANY Zomato opportunity, include them. ` +
        `If a role has no supporting evidence, set Name to "—". NEVER write "pending". ` +
        `After the table, add: **High-context individuals:** {names of TS/PS/EM who should LGTM}. Cite sources.`,
    },
    {
      label: "Open risks, RCAs, unresolved recommendations",
      message:
        `What are the known technical risks and open escalations for "${accountName}" ` +
        `right now? Pull from the ${window}: RCA / post-mortem documents, any HELP / ` +
        `SERVER / CLOUDP JIRA tickets, and PS recommendations that appear NOT ` +
        `implemented. Group findings by technical area (Connectivity, Performance, ` +
        `Query/Index, Upgrade, Environment/Sizing, Product, Training, Admin, ` +
        `Terraform/CLI/API). For each, note severity (Critical / Significant / ` +
        `Roadmap Planning) and confidence (High / Medium / Low). Cite each item.` +
        concernsClause,
    },
    {
      label: "JIRA tickets (HELP / SERVER / CLOUDP)",
      message:
        `Find all JIRA tickets in HELP, SERVER, CLOUDP, and BACKUP projects ` +
        `that reference "${accountName}" over the ${window}. For each ticket: ` +
        `key, summary, status, severity, any linked case numbers, and a one-line ` +
        `description of the technical issue. Cite each ticket URL.`,
    },
    {
      label: "Deployment topology and MongoDB versions",
      message:
        `What MongoDB deployments does "${accountName}" run? I need: Atlas projects / ` +
        `groups, cluster names and tiers, regions, MongoDB versions currently ` +
        `deployed, driver versions mentioned in recent cases, and any recent upgrade ` +
        `or migration activity. Flag any clusters on versions approaching End of Life. ` +
        `Cite sources from cases, Atlas docs, and internal wikis.`,
    },
    {
      label: "Renewal / commercial context",
      message:
        `What is the commercial and renewal context for "${accountName}"? Look for: ` +
        `renewal date, ARR or tier, product mix, any expansion or downsize signals, ` +
        `recent QBR notes, exec-sponsor touchpoints, and churn / at-risk indicators ` +
        `mentioned in Slack or account-team docs over the ${window}. Cite sources.`,
    },
    {
      label: "Case clustering & pattern analysis",
      message:
        `Analyze ALL support cases for "${accountName}" over the ${window} and group them ` +
        `into 5-7 thematic clusters (e.g. "Connectivity / Timeouts", "Performance / Slow Queries", ` +
        `"Memory / OOM", "TLS / Certificate", "Sharding", "Atlas Admin / Configuration"). ` +
        `For each cluster: list the case numbers, count of cases, common root causes, ` +
        `whether the issues are recurring, and what percentage of total cases it represents. ` +
        `Highlight which clusters indicate systemic risk vs. one-off issues. Cite each case.`,
    },
    {
      label: "Per-case deep dive (top escalations)",
      message:
        `For the most critical / escalated support cases for "${accountName}" over the ${window} ` +
        `(Sev1, Sev2, or any case with a HELP JIRA): provide a detailed breakdown of each. ` +
        `For each case include: case number, problem statement (1-2 sentences), root cause ` +
        `(if identified), resolution or current blocker, recommendations made by TS, ` +
        `whether the recommendation was implemented (if discernible from follow-up cases or Slack), ` +
        `and whether this issue recurred in later cases. Cite each case and any related JIRA tickets.`,
    },
  ];
}

/**
 * Glean queries that are always worth running for the Data Collection step.
 * The app executes these via the Glean MCP when the user proceeds from
 * the Context step, so the report drafting step starts with context already loaded.
 */
export function buildGleanQueries(accountName: string): {
  label: string;
  query: string;
  app?: string;
}[] {
  const q = (label: string, query: string, app?: string) => ({
    label,
    query,
    app,
  });
  return [
    q("Engagement overview", `${accountName} engagement overview`),
    q("Account team / AE / CSM", `${accountName} account team AE CSM`),
    q("Account team (Salesforce)", `${accountName} account owner account executive customer success manager professional services`, "salesforce"),
    q("Account team roles (Salesforce)", `${accountName} engagement manager solutions architect technical services manager`, "salesforce"),
    q("TS Manager / TAM / NTSE", `${accountName} technical services manager TAM NTSE`),
    q("CSM Slack channel", `csm-${accountName}`, "slack"),
    q("Consulting report", `${accountName} consulting report`),
    q("Professional services", `${accountName} professional services`),
    q("PS recommendations", `${accountName} PS report recommendations`),
    q("Risk / escalation (Slack)", `${accountName} risk escalation`, "slack"),
    q("Post-mortem / RCA", `${accountName} post-mortem RCA`),
    q("HELP escalation", `${accountName} HELP escalation`),
    q("JIRA tickets", `${accountName} HELP SERVER CLOUDP`),
    q("QBR / EBR notes", `${accountName} QBR EBR notes`),
    q("Renewal context", `${accountName} renewal ARR expansion`),
    q("Atlas deployment", `${accountName} Atlas cluster tier version`),
    q("Upgrade / migration", `${accountName} upgrade migration version`),
    q("Performance issues", `${accountName} performance latency slow query`),
    q("Connectivity / networking", `${accountName} connectivity networking timeout`),
    q("Backup / DR", `${accountName} backup restore disaster recovery`),
    q("KB / Knowledge articles", `${accountName} knowledgearticle`),
  ];
}

// ---------------------------------------------------------------------------
// LGTM reviewer extraction
// ---------------------------------------------------------------------------

export interface LgtmReviewers {
  ae: string;
  csm: string;
  ps: string;
  ts: string;
}

/**
 * Parse a name from a markdown table cell or inline text, stripping
 * parenthetical suffixes like "(Senior Enterprise AE)".
 */
function parseName(raw: string): string {
  const name = raw.trim().replace(/\s*\([^)]*\)/g, "").trim();
  if (!name || name === "—" || name === "-" || /^name$/i.test(name)) return "—";
  // Reject header placeholders
  if (/^(role|reviewer|source|notes)$/i.test(name)) return "—";
  return name;
}

/**
 * Scan all pre-gathered artifacts for account-team / stakeholder data and
 * extract AE, CSM, PS, and TS reviewer names. Used to inject an explicit
 * LGTM block into the prompt so the model doesn't have to infer it.
 */
export function extractLgtmReviewers(
  artifacts: Array<{ kind: string; label: string; data: unknown }>,
): LgtmReviewers {
  const result: LgtmReviewers = { ae: "—", csm: "—", ps: "—", ts: "—" };

  // Collect all artifact text — prioritise stakeholder/account-team chat
  // artifacts but also scan every other artifact as fallback.
  const allText = artifacts
    .map((a) =>
      typeof a.data === "string" ? a.data : JSON.stringify(a.data),
    )
    .join("\n\n");

  if (!allText.trim()) return result;

  // Separator pattern: any dash (hyphen, en, em), colon, or whitespace combo
  // Separator: space, colon, or unicode dashes — excludes bare hyphen to
  // avoid matching "csm-accountname" Slack channel prefixes as a CSM name.
  const SEP = String.raw`[\s\u2012\u2013\u2014:]+`;

  // --- Strategy 1: markdown table rows  | Role | Name | ... ---
  const tableRow = /\|\s*([^|\n]+?)\s*\|\s*([^|\n]+?)\s*\|/g;
  // Words that indicate a header row — reject if the name column matches
  const headerWords = /^(?:name|reviewer|source|notes|role|value|field|-+)$/i;
  let m: RegExpExecArray | null;
  while ((m = tableRow.exec(allText)) !== null) {
    const role = m[1].trim().replace(/\*+/g, "").toLowerCase();
    const name = parseName(m[2]);
    if (name === "—" || headerWords.test(name)) continue;
    if (/\bae\b|account exec|account owner|owner\/ae|owner\s*ae/.test(role) && result.ae === "—")
      result.ae = name;
    else if (
      /\bcsm\b|customer success manager|primary csm|account csm/.test(role) &&
      result.csm === "—"
    )
      result.csm = name;
    else if (
      /\bps\b|professional services/.test(role) &&
      !/\bts\b/.test(role) &&
      result.ps === "—"
    )
      result.ps = name;
    else if (
      /\bts\b|technical services|tse|ts manager|\bntse\b|tam\b/.test(role) &&
      result.ts === "—"
    )
      result.ts = name;
  }

  // --- Strategy 2: inline text  "Primary CSM – Aryan Garg" or "CSM: Aryan Garg" ---
  const inline: Array<[RegExp, keyof LgtmReviewers]> = [
    [
      new RegExp(
        String.raw`(?:account executive|account owner|owner\/ae|owner\s*ae|senior enterprise ae|\bAE\b)${SEP}([^\n,|*\]]+)`,
        "i",
      ),
      "ae",
    ],
    [
      new RegExp(
        String.raw`(?:primary csm|account csm|customer success manager|\bCSM\b)${SEP}([^\n,|*\]]+)`,
        "i",
      ),
      "csm",
    ],
    [
      new RegExp(
        String.raw`(?:professional services|\bPS\b)${SEP}([^\n,|*\]]+)`,
        "i",
      ),
      "ps",
    ],
    [
      new RegExp(
        String.raw`(?:technical services|ts manager|\bTSE\b|\bTS\b)${SEP}([^\n,|*\]]+)`,
        "i",
      ),
      "ts",
    ],
  ];
  for (const [regex, key] of inline) {
    if (result[key] !== "—") continue;
    const match = allText.match(regex);
    if (match) {
      const name = parseName(match[1]);
      if (name !== "—") result[key] = name;
    }
  }

  // --- Strategy 3: "set as Account CSM" / "is the CSM" patterns in prose ---
  const prose: Array<[RegExp, keyof LgtmReviewers]> = [
    [/([A-Z][a-z]+(?: [A-Z][a-z]+)+) (?:is|was) (?:the |set as )?(?:primary |account )?CSM/i, "csm"],
    [/([A-Z][a-z]+(?: [A-Z][a-z]+)+) (?:is|was) (?:the |set as )?(?:account )?(?:executive|AE)\b/i, "ae"],
    [/set as (?:the )?(?:Account )?CSM[^\n]*?(?:for|on)[^\n]*?by ([A-Z][a-z]+(?: [A-Z][a-z]+)+)/i, "csm"],
  ];
  for (const [regex, key] of prose) {
    if (result[key] !== "—") continue;
    const match = allText.match(regex);
    if (match) {
      const name = parseName(match[1]);
      if (name !== "—") result[key] = name;
    }
  }

  // --- Strategy 4: Hub-style label blocks  "OWNER/AE\nSharad Kumar Gupta" ---
  // Hub dumps fields as ALL-CAPS label on one line, value on next line.
  const hubFields: Array<[RegExp, keyof LgtmReviewers]> = [
    [/OWNER\/AE\s*\n([^\n]+)/i, "ae"],
    [/\bCSM\b\s*\n([^\n]+)/i, "csm"],
    [/\bNTSE\b\s*\n([^\n]+)/i, "ts"],
    [/PS\s+REGIONAL\s+DIRECTOR\s*\n([^\n]+)/i, "ps"],
  ];
  for (const [regex, key] of hubFields) {
    if (result[key] !== "—") continue;
    const match = allText.match(regex);
    if (match) {
      const name = parseName(match[1]);
      if (name !== "—") result[key] = name;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Auto Triage case intelligence — prompt block builder
// ---------------------------------------------------------------------------

interface CaseIntelligenceData {
  cases: string[];
  accountName: string;
  perCase: Record<
    string,
    { summary?: string; precedents?: string; errors?: string[] }
  >;
  accountHealth: Array<{ label: string; markdown: string; error?: string }>;
  stats?: { caseCount: number; promptsRun: number; promptsFailed: number };
}

/**
 * If a case-intelligence artifact is present, render it as a prompt block
 * so the final-synthesis LLM call sees per-case technical depth (problem /
 * environment / root cause / resolution, plus similar-case precedents, plus
 * account-level pattern analysis). This is the bit that turns generic
 * output into specific technical recommendations.
 *
 * Returns an empty string if no case-intelligence artifact exists.
 */
export function formatCaseIntelligenceBlock(
  artifacts: Array<{ kind: string; data: unknown }>,
): string {
  const artifact = artifacts.find((a) => a.kind === "case-intelligence");
  if (!artifact) return "";
  const data = artifact.data as CaseIntelligenceData | null;
  if (!data || !Array.isArray(data.cases) || data.cases.length === 0) return "";

  const perCaseBlocks = data.cases
    .map((c) => {
      const entry = data.perCase[c] ?? {};
      const parts: string[] = [`### Case ${c}`];
      if (entry.summary) {
        parts.push("**Case summary (from Auto Triage):**", entry.summary.slice(0, 6_000));
      }
      if (entry.precedents) {
        parts.push(
          "**Precedent cases (from Auto Triage):**",
          entry.precedents.slice(0, 4_000),
        );
      }
      if (!entry.summary && !entry.precedents) {
        parts.push("_(Auto Triage produced no output for this case)_");
      }
      return parts.join("\n\n");
    })
    .join("\n\n---\n\n");

  const healthBlocks = data.accountHealth
    .filter((h) => h.markdown && !h.error)
    .map((h, i) => {
      const label =
        data.accountHealth.length === 1
          ? "Account support health (from Auto Triage)"
          : `Account support health — ${h.label}`;
      return `### ${label}\n\n${h.markdown.slice(0, 10_000)}`;
    })
    .join("\n\n---\n\n");

  const sections: string[] = [
    "## Auto Triage Case Intelligence (pre-analyzed by MongoDB Customer Hub AI — trust as HIGH-confidence technical evidence)",
    "> The following summaries were produced by running `case-summary` and `precedent-research` prompts against each case's comments, and `account-support-health` across the full case list. Use this as the primary technical evidence for Key Findings, Recommendations, and Appendix B — it contains actual case comments, root causes, and similar-case patterns that Glean's high-level search cannot surface.",
    "",
    "### Per-case analysis",
    perCaseBlocks || "_(no per-case intelligence available)_",
  ];
  if (healthBlocks) {
    sections.push("", "### Cross-case patterns", healthBlocks);
  }
  return sections.join("\n\n");
}

/**
 * Build the explicit LGTM reviewer block to inject into the prompt.
 *
 * - If all four roles were extracted by regex → inject as a strict "use these
 *   exactly" table so the model doesn't hallucinate.
 * - If any role is "—" (regex missed) → also pass the raw stakeholder
 *   artifact(s) as a JSON block and ask the model to fill the gaps itself.
 *   This is more reliable than regex for prose formats like
 *   "Account Executive (AE / Account Owner) – Andrew Gasser".
 */
export function buildLgtmBlock(
  artifacts: Array<{ kind: string; label: string; data: unknown }>,
): string {
  const r = extractLgtmReviewers(artifacts);
  const allExtracted =
    r.ae !== "—" && r.csm !== "—" && r.ps !== "—";

  const heading = allExtracted
    ? `## Pre-Extracted LGTM Reviewer Names (use these exactly in Appendix D — do NOT override with "—" or "pending")`
    : `## Pre-Extracted LGTM Reviewer Names (use where filled; for any "—" entries, find the correct name in the pre-gathered Glean artifacts below — look especially in artifacts whose labels contain "Stakeholder", "Account team", or "Salesforce")`;

  const lines = [
    heading,
    "| Reviewer | Role |",
    "|----------|------|",
    `| ${r.ae} | AE |`,
    `| ${r.csm} | CSM |`,
    `| ${r.ps} | PS |`,
  ];

  if (!allExtracted) {
    // Point to the artifact labels rather than re-embedding content that is
    // already present in the chatBlocks / pre-gathered artifacts section.
    const stakeholderLabels = artifacts
      .filter((a) => /stakeholder|account.?team|salesforce/i.test(a.label))
      .map((a) => `"${a.label}"`);
    if (stakeholderLabels.length > 0) {
      lines.push(
        "",
        `→ Relevant pre-gathered artifacts: ${stakeholderLabels.join(", ")}`,
      );
    }
  }

  return lines.join("\n");
}
