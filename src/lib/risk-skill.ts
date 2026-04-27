/**
 * Embedded copy of the Risk Assessment skill playbook. Fed to the LLM as
 * the system prompt during report synthesis.
 */

import { buildCaseSearchArgs } from "./case-analysis";

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

**Preserve exact evidence.** When case-intelligence artifacts carry an Evidence block (exact queries, error codes, index specs, config params, versions), reproduce those snippets exactly in the risk's evidence section. Do not paraphrase technical specifics — the whole point of the bot-side extraction is so the register can land at artifact-level detail. Do not include the word "verbatim" in the output.

**Refer to the prior report as prose, not as a section.** When a prior report exists (any risk in Key Findings carries a tag other than \`NEW\`), weave references into narrative copy instead of emitting a dedicated "Prior context" block:
- **Executive Summary** opens with a sentence like _"This report is our second review of {Account}; the previous register was delivered on {Mon DD, YYYY}."_ and closes with one sentence summarizing what changed since — e.g. _"Since the Mar 2026 review, 2 recommendations have been mitigated, 3 remain open, and 1 previously-closed risk has re-opened."_
- **Each non-\`NEW\` risk** inside the Risk Detail narrative (not in a sub-section header) naturally references the prior report where relevant: _"This risk was first flagged as Risk #3 in the Mar 2026 report; the original recommendation to add a compound index on \`{ orderDate: -1, tenantId: 1 }\` was not implemented"_ or _"Reiterating our Mar 2026 recommendation to set \`maxPoolSize=500\`, evidence from cases 01562914 and 01547215 shows the driver still runs at the default of 50."_
- **Regression Alerts** is the one place where prior status surfaces explicitly (reviewer marked Mitigated, risk reappeared). That callout table stays.
- Do NOT emit a separate \`##### How this risk appeared in the previous report\` section, \`##### Prior context\` block, or any standalone "Prior Risk # / Original recommendation / Reviewer status / What has changed" scaffolding in Risk Detail. That scaffolding is direction to you, not output for the reader.

**Use the taxonomy.** Every risk candidate carries a primary taxonomy id (kebab-case) drawn from the case-intelligence classifications — e.g. \`query-performance\`, \`connectivity\`, \`replication\`, \`atlas-platform\`. Group findings by taxonomy id in Appendix B and use it to populate the Taxonomy Breakdown table.

Legacy coarse buckets (still shown in the high-level breakdown): Connectivity, Performance, Query/Index, Upgrade, Environment/Sizing, Product, Training, Admin, Terraform/CLI/API.

## Step 4 — Draft the Risk Register Report
Use this exact structure. Document is INTERNAL ONLY.

\`\`\`markdown
# Risk Register Report

_The DOCX / PDF cover already prints the account name; do NOT repeat it in the H1 — keep this heading literally as \`# Risk Register Report\`. The "Trend / Trend Micro Incorporated" duplication came from emitting the company name in both places._

INTERNAL DOCUMENT ONLY - NOT TO BE SHARED WITH THE CUSTOMER

**Author(s):** MongoDB Technical Services
**Date Finalized:** {date}

## Account Risk Rating

**Overall:** \`RED\` / \`YELLOW\` / \`GREEN\` — emit exactly one of those three uppercase tokens inside inline backticks, followed by a 1-sentence rationale.

**Why:** {one sentence summarizing the dominant driver — e.g. *"Two open Critical technical risks combined with frustrated customer sentiment heading into a 3-month renewal window."*}

| Driver | Signal |
|--------|--------|
| Technical severity | {e.g. "2 Critical, 4 Significant; 1 regression"} |
| Customer sentiment | {Frustrated / Mixed / Neutral / Cooperative} — cite 1-2 evidence cases or phrases |
| Commercial context | {renewal proximity, churn/competitive signals, cooperative posture toward TS} |

## Renewal / Commercial Context
{2-3 sentences of commercial framing: renewal date / window, ARR trajectory if evident, competitive pressure (DocumentDB, Aurora, Cosmos DB mentions in cases or Slack), sentiment trend vs prior report. This is GTM framing, not a to-do list. If no signals are present in evidence, write "No commercial signals surfaced in the case-intelligence evidence or Glean artifacts for this period." and move on.}

## Executive Summary
{2-3 paragraphs: what prompted this review, the scope (number of cases, timeframe), key findings summary, and why it matters for the account relationship. If evidence is thin, add a caveat about confidence. End with a forward-looking statement about recommended engagement.}

## Regression Alerts
_(Emit this section ONLY when a Prior Report Context is provided AND at least one current risk carries the \`REGRESSION\` tag. Omit the heading entirely otherwise — do NOT emit an empty section.)_

| Risk # | Title | Prior mitigation date | What was supposed to be fixed | What is recurring now |
|--------|-------|-----------------------|------------------------------|----------------------|
| ... | ... | {Mon YYYY} | ... | ... |

## Key Findings
Every risk carries a \`Category\` tag. A risk register is not just technical fixes — it also owns the internal-process, customer-behaviour, and commercial risks that land on the same account. Use exactly one of:
- \`Technical\` — concrete server/driver/config/schema change.
- \`Interim\` — short-term safety-valve action pending a durable technical fix (e.g. TCMalloc tunable until 8.0 upgrade, targeted OIS until index programme).
- \`TS-Process\` — internal TS / Support-ops gap on this account: case auto-closure, severity misuse, handover gap, inconsistent follow-through.
- \`Customer-Behaviour\` — customer-side governance gap: declined mitigations, no recommendation-tracking cadence, over-reliance on manual monitoring.
- \`Commercial\` — renewal / sentiment / competitive risk surfaced by evidence (not just narrative — there must be a case citation, Slack thread, or PS note that supports it).

| # | Risk Identified | Category | Taxonomy | Severity | Confidence | Frequency | Change from prior | Impact of Taking No Action |
|---|-----------------|----------|----------|----------|------------|-----------|-------------------|----------------------------|
| 1 | ... | \`Technical\` | \`query-performance\` | Critical / Significant / Roadmap Planning | High / Medium / Low | High / Medium / Low | \`NEW\` / \`RECURRING-OPEN\` / \`REGRESSION\` / \`PERSISTED-WORSE\` | ... |

### Risk Detail
For EVERY risk in the Key Findings table, emit a block in the exact shape below. Reproduce evidence snippets exactly as they appear in the case-intelligence artifacts — do not rewrite technical specifics as prose. Never include the words "verbatim", "VERBATIM", or "(verbatim)" in the output.

#### Risk #{N} — {Short title} · \`{taxonomy-id}\` · \`{change-from-prior tag}\`

##### Evidence
- **Cases:** [Case 0XXXXXXX](https://hub.corp.mongodb.com/case/0XXXXXXX), ...
- **Representative query / command:** single-line → inline \`<snippet>\`; multi-line → a fenced \`\`\`javascript / \`\`\`sql block.
- **Representative error / log:** single code or short phrase → inline; **stack trace or multi-line log → always a fenced \`\`\`log block**, never inline \`code\` spans. E.g.

  \`\`\`log
  do_exit+0x78/0x3e8
  do_group_exit+0x3c/0xa0
  get_signal+0x72c/0x758
  \`\`\`
- **Server / driver versions seen:** e.g. MongoDB 7.0.14, Node.js driver 6.3.0.
- **Indexes discussed:** inline literal spec, e.g. \`{ customerId: 1, orderDate: -1 }\`.
- **Config / tuning params referenced:** inline, e.g. \`maxPoolSize=200\`.

##### Why the prior mitigation did not stick _(emit ONLY when tag is \`REGRESSION\`; omit otherwise)_
- At least one concrete hypothesis: partial fix, config drift, new cluster or region onboarded, driver rollback, etc. Cite evidence.

##### Recommendation
- **Action:** one-sentence exact change.
- **Target:** specific collection / config file / command / driver setting.
- **Parameters:** concrete literal values, e.g. \`{ customerId: 1, orderDate: -1 }\`, \`maxPoolSize: 500\`.
- **Example command:** single-line → inline; multi-line → a fenced \`\`\`shell block:

  \`\`\`shell
  mongosh --eval 'db.orders.createIndex({ customerId: 1, orderDate: -1 })'
  \`\`\`

**Sources:** A single line at the END of every Risk Detail block listing all source links the risk draws on, separated by " · ". Cases, JIRAs, and Slack threads each as a markdown link. Even though these sources also appear inline within the Evidence and Recommendation copy, this line lets a reviewer audit provenance at a glance — Banque-style.

Example:

\`\`\`
**Sources:** [Case 01571156](https://hub.corp.mongodb.com/case/01571156) · [Case 01571856](https://hub.corp.mongodb.com/case/01571856) · [HELP-91610](https://jira.mongodb.org/browse/HELP-91610) · [csm-trend-micro · Mar 12 thread](https://mongodb.enterprise.slack.com/archives/...)
\`\`\`

## Interim Mitigations
_(Short-term safety-valve actions that hold the line until the durable technical fix lands. Emit this section only if at least one Key Findings risk has \`Category: Interim\` OR at least one Technical risk has a known durable-fix ETA > 30 days AND a tactical hold-over action exists. Omit entirely otherwise.)_

| Risk # | Interim action | Owner | ETA | Durable fix it replaces |
|--------|----------------|-------|-----|-------------------------|
| {N} | e.g. Set \`tcmallocReleaseRate=0.5\` on \`instance7\` | TS / Darwinbox ops | 2 weeks | 8.0 upgrade (Risk #2) |

## TS Process & Handover Risks
_(INTERNAL actions for MongoDB TS / Support Ops. These are action items for MongoDB, NOT the customer. One bullet per observed pattern with evidence and a specific follow-up. If evidence does not support any pattern, write "No TS process gaps surfaced in the evidence for this period." and move on — do NOT fabricate.)_

- **{Pattern e.g. Case auto-closure}:** observed in {specific cases} — {one-sentence description}. **Follow-up:** {specific TS owner-ready action, e.g. "review severity calibration with TSE pool handling cases opened 2026-Q1 for Darwinbox; establish handover checklist for NTSE coverage gaps"}.
- **{Severity misuse / handover gap / inconsistent follow-through / …}:** {evidence}. **Follow-up:** {action}.

## Customer Engagement & Behaviour
_(Customer-side governance items that MongoDB should drive in partnership. Behaviour-change items, not technical fixes. Again, one bullet per observed pattern with evidence. Write "No customer-side governance gaps surfaced in the evidence." if the register has no support for any pattern.)_

- **{Pattern e.g. Recommendations not tracked}:** {evidence — e.g. "recommendations from the Jul 2025 PS review cases 01547215 and 01561638 were not implemented"}. **Follow-up:** {action — e.g. "establish monthly recommendation-review cadence between CSM and Darwinbox DBA lead; close the loop by 2026-06-01"}.
- **{Declined mitigations / no change-tracking / over-reliance on TS monitoring / …}:** {evidence}. **Follow-up:** {action}.

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

**Case breakdown by technical area (high-level):**
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

**Case breakdown by taxonomy (granular — one row per id that appears):**
| Taxonomy (id) | Count |
|---------------|-------|
| \`query-performance\` | {N} ({%}) |
| \`connectivity\` | {N} ({%}) |
| ... (emit rows only for ids that actually appear in case-intelligence) | |

## Recommendations
{Use a markdown table for recommendations. Each row should map to a specific risk and be specific about deliverables.}

| # | Recommendation (literal — concrete params, not general advice) | Severity | Deliverable | Expected Outcome |
|---|----------------------------------------------------------------|----------|-------------|------------------|
| 1 | e.g. "Create compound index \`{ customerId: 1, orderDate: -1 }\` on \`orders\` to eliminate COLLSCAN on $in+$sort queries seen in cases 01561638 / 01562914" | Critical Risk #1 | {Concrete deliverable} | {Expected outcome} |
| 2 | e.g. "Set \`maxPoolSize=500\` and \`serverSelectionTimeoutMS=30000\` in the Node.js driver (currently 50/5000); addresses pool-starvation pattern in cases 01558368 / 01559716" | Critical Risk #2 | {Concrete deliverable} | {Expected outcome} |
| 3 | {Specific action — include exact params} | Significant Risk #3 | {Concrete deliverable} | {Expected outcome} |
| 4 | {Specific action — include exact params} | Roadmap Planning Risk #N | {Concrete deliverable} | {Expected outcome} |

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
| {Mon DD, YY} | {Case/HELP/Slack link} | {What happened and outcome — see formatting rule below} |

_Formatting rule for the **Summary** cell: prefer 2–4 short bullets ("- bullet text") over a single run-on sentence. One bullet per distinct event. Keep each bullet ≤ 18 words. Wrap any inline JIRA / case / Slack mention as a markdown link, not plain text. This is the cell pattern that makes the Banque-style timeline scannable._
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
Deliver to the account team only. Any customer-facing share should be a presentation at a QBR, not the raw register.
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
        `After the table, add: **High-context individuals:** {names of TS/PS/EM who should review this report before delivery}. Cite sources.`,
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
export interface GleanQueryPlan {
  label: string;
  query: string;
  app?: string;
  /** When present, overrides the default `{ query, app, pageSize }` args
   *  sent to `/api/glean/search`. Use for calls that need `exhaustive`,
   *  `after`, or `updated` filters (e.g. the servicecloud case search). */
  args?: Record<string, unknown>;
}

export function buildGleanQueries(
  accountName: string,
  timeframeMonths = 1,
): GleanQueryPlan[] {
  const q = (label: string, query: string, app?: string): GleanQueryPlan => ({
    label,
    query,
    app,
  });
  return [
    {
      label: "Support cases (servicecloud)",
      query: accountName,
      app: "servicecloud",
      args: buildCaseSearchArgs({ accountName, timeframeMonths }),
    },
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
 * account-level pattern analysis).
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
    .map((h) => {
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
