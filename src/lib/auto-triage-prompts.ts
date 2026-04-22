/**
 * Auto Triage Chat prompt templates.
 *
 * Lifted verbatim from PremServ Workspace
 * (extension/src/tools/auto-triage-assistant/prompt-templates.ts) so output
 * shape matches what TS engineers already see in the Hub side-panel.
 *
 * The prompts are sent as the `input` query param of a GET request to
 * /api/ai/autoTriageChat — the bot resolves `{placeholders}` by calling its
 * own tools (`get_mongodb_case_comments`, `find_summaries_by_filter`, etc.).
 * Our job is just to substitute the user-provided values before sending.
 */

export interface PromptTemplate {
  id: PromptId;
  name: string;
  description: string;
  variables: readonly string[];
  prompt: string;
}

export type PromptId =
  | "case-summary"
  | "case-summary-table"
  | "precedent-research"
  | "full-triage"
  | "quick-triage"
  | "log-analysis"
  | "ftdc-analysis"
  | "sap-note"
  | "account-support-health";

export const CASE_SUMMARY_PROMPT: PromptTemplate = {
  id: "case-summary",
  name: "Case Summary",
  description: "Structured summary for handoff or status update",
  variables: ["case-number"],
  prompt: `For case {case-number}:

1. Use \`get_mongodb_case_comments\` with case_number="{case-number}" to fetch all comments
2. Analyze the conversation thread and provide:

**Summary Output:**
- **Problem Statement:** (1-2 sentences describing the core issue)
- **Environment:** (product, version, deployment type if mentioned)
- **Root Cause:** (if identified, otherwise "Under investigation")
- **Current Status:** (where things stand now)
- **Key Actions Taken:** (bullet list of diagnostic steps and findings)
- **Pending Items:** (what's still needed)
- **Recommended Next Steps:** (for TSE/NTSE/TAM)

If the case is resolved, also provide:
- **Suggested Close Comment:** (professional summary suitable for case closure)

At the VERY END of your response, on its own line, emit exactly one of:
- \`**Closed: Yes**\` — if the case is in a terminal state (Resolved, Closed, Won, Customer Confirmed Fix, or similar).
- \`**Closed: No**\` — if the case is open, awaiting customer, in progress, on hold, or otherwise unresolved.

This tag is machine-read for caching. It MUST appear exactly as shown, on its own line, as the last line.`,
};

export const CASE_SUMMARY_TABLE_PROMPT: PromptTemplate = {
  id: "case-summary-table",
  name: "Case Summary (Table)",
  description: "Structured table-format summary",
  variables: ["case-number"],
  prompt: `For case {case-number}:

1. Use \`get_mongodb_case_comments\` with case_number="{case-number}" to fetch all comments
2. Analyze the conversation thread and provide a summary in this EXACT table format:

**Case {case-number} – [Customer Name] – "[Brief Case Title]"**

| Topic | Key points |
| **Problem** | [Brief description of the main issue] |
| **Stakeholders** | [List of people involved with their roles] |
| **Root-cause / Context** | [Technical root cause and background] |
| **Key Actions / Decisions** | [Numbered list of main actions taken] |
| **Timeline** | [Key dates and events] |
| **Outcome / Current Status** | [Current state of the case] |
| **Resolution Steps for Customer** | [Step-by-step resolution guidance] |
| **Key Take-aways** | [Bullet points of important lessons] |

**Bottom line:** [One sentence summary of what customer needs to do next]

Important:
- Extract the customer name from the comments or participant list
- Infer a brief case title from the technical issue discussed
- Keep it professional, concise, and focus on technical accuracy
- Use bullet points and numbered lists for clarity
- Include specific technical details mentioned in comments`,
};

export const PRECEDENT_RESEARCH_PROMPT: PromptTemplate = {
  id: "precedent-research",
  name: "Precedent Search",
  description: "Find similar past cases for resolution guidance",
  variables: ["case-number"],
  prompt: `For case {case-number}:

1. First use \`get_mongodb_case_comments\` with case_number="{case-number}" to understand the problem
2. Then use \`get_case_precedents_guidance\` with case_number="{case-number}", problem_statement="<extracted from case comments>", k_max_precedents=5

For each precedent found, provide:
1. Case number and brief description
2. Root cause identified
3. Resolution approach used
4. Applicability to current case (High/Medium/Low)

Then recommend an approach based on the precedents.

At the VERY END of your response, on its own line, emit exactly one of:
- \`**Closed: Yes**\` — if case {case-number} is itself in a terminal state (Resolved, Closed, Won, Customer Confirmed Fix).
- \`**Closed: No**\` — if case {case-number} is open, awaiting customer, in progress, on hold, or otherwise unresolved.

This tag refers to the STATE OF CASE {case-number}, not the precedents. It is machine-read for caching. It MUST appear exactly as shown, on its own line, as the last line.`,
};

export const FULL_TRIAGE_PROMPT: PromptTemplate = {
  id: "full-triage",
  name: "Full Triage",
  description: "Comprehensive triage analysis for complex cases",
  variables: ["case-number"],
  prompt: `For case {case-number}, perform a full triage:

1. Use \`get_mongodb_case_comments\` with case_number="{case-number}" to fetch all case comments
2. Use \`get_case_precedents_guidance\` with case_number="{case-number}", problem_statement="<extracted from step 1>", k_max_precedents=5
3. Use \`case_triage_tool\` with case_comments=<result from step 1>, case_precedents=<result from step 2>

Provide output in this format:
- **Observations:** (what the evidence shows)
- **Hypotheses:** (possible root causes ranked by likelihood)
- **Recommended Actions:** (next diagnostic steps)
- **Relevant Precedents:** (similar cases if found)
- **Estimated Complexity:** (Low/Medium/High)
- **Suggested Priority:** (if different from current severity)`,
};

export const QUICK_TRIAGE_PROMPT: PromptTemplate = {
  id: "quick-triage",
  name: "Quick Triage",
  description: "Quick initial assessment for new cases",
  variables: ["case-number"],
  prompt: `For case {case-number}:

1. Use \`get_mongodb_case_comments\` with case_number="{case-number}" to fetch the case content
2. Use \`get_case_precedents_guidance\` with case_number="{case-number}", problem_statement="<from step 1>", k_max_precedents=3
3. Use \`case_triage_tool\` with case_comments=<from step 1>, case_precedents=<from step 2>

Provide:
- **Initial Assessment:** (1-2 sentence summary of the issue)
- **Severity Appropriateness:** (is current severity correct? recommend change?)
- **Similar Precedents:** (any relevant past cases?)
- **Recommended First Steps:** (what should TSE do first?)
- **NTSE/TAM Watch Items:** (anything requiring premium support attention?)`,
};

export const LOG_ANALYSIS_PROMPT: PromptTemplate = {
  id: "log-analysis",
  name: "Log Analysis",
  description: "Analyze MongoDB log files attached to the case",
  variables: ["case-number"],
  prompt: `For case {case-number}:

1. Use \`list_case_attachments_details\` with case_number="{case-number}" to list all attachments
2. Identify MongoDB log files (typically .log or mongod.log) from the results
3. Use \`download_case_attachments_files\` with case_number="{case-number}", attachment_names=["<identified log files>"]
4. Use \`analyze_case_mongodb_log_file\` with case_number="{case-number}", log_file_path="<downloaded file path>", analysis_type="error_summary"

Provide:
- **Errors Found:** (count and types)
- **Most Frequent Errors:** (top 5 with counts)
- **Critical Errors:** (any that indicate data issues or crashes)
- **Time Pattern:** (when errors occur - startup, under load, etc.)
- **Correlation:** (do errors correlate with customer-reported symptoms?)
- **Recommended Focus Areas:** (what to investigate next)`,
};

export const FTDC_ANALYSIS_PROMPT: PromptTemplate = {
  id: "ftdc-analysis",
  name: "FTDC Analysis",
  description: "Analyze Atlas cluster performance via FTDC",
  variables: ["case-number", "atlas-group-id", "cluster-name"],
  prompt: `For case {case-number}, perform Atlas FTDC analysis:

1. Use \`get_mongodb_case_comments\` with case_number="{case-number}" to identify the Atlas Group ID and Cluster Name from the case
   (Or use provided: atlas_group_id="{atlas-group-id}", cluster_name="{cluster-name}")

2. Use \`get_atlas_cluster_details\` with atlas_group_id="{atlas-group-id}", atlas_cluster_name="{cluster-name}"
   - From the response, identify the primary node's resourceName

3. Use \`atlas_cluster_node_ftdc_analyses\` with:
   - atlas_group_id="{atlas-group-id}"
   - atlas_cluster_name="{cluster-name}"
   - resourceName_node_ids=["<primary node resourceName from step 2>"]
   - ftdc_start_ISODate_str="<incident start time>"
   - ftdc_interval_seconds=3600
   - analysis_comment="Performance analysis for case {case-number}"

Provide:
- **Bottleneck Identified:** (CPU, disk, network, locks, etc.)
- **Root Cause Analysis:** (what's causing the bottleneck)
- **Peak Times:** (when issues are worst)
- **Recommendations:** (remediation steps)`,
};

export const SAP_NOTE_PROMPT: PromptTemplate = {
  id: "sap-note",
  name: "SAP Note",
  description: "Generate internal SAP Note for end-of-shift case handoff",
  variables: ["case-number"],
  prompt: `For case {case-number}, generate an internal SAP Note for case handoff:

1. Use \`get_mongodb_case_comments\` with case_number="{case-number}" to fetch all case comments
2. Use \`get_case_precedents_guidance\` with case_number="{case-number}", problem_statement="<from case comments>", k_max_precedents=3 to find any relevant precedents

Generate a SAP Note in the following **Symptom-Action-Plan** format:

## SAP Note - Case {case-number}

**S (Symptom):**
- Main problem/issue: [Describe the core issue the customer is experiencing]
- Error messages: [Include any specific error messages or codes]
- Environment: [MongoDB version, platform (Atlas/Enterprise/Community), driver if relevant]
- Impact: [How is this affecting the customer? Severity level?]

**A (Action Performed):**
- Diagnostic steps taken:
  1. [Step 1 - what was checked/analyzed]
  2. [Step 2 - what was checked/analyzed]
- Findings: [Key discoveries from the investigation]
- KB articles referenced: [List any KB articles mentioned in comments]
- JIRA tickets: [List any related JIRA tickets]
- Precedent cases: [Relevant similar cases from precedent search]

**P (Plan of Action):**
- Immediate next steps:
  1. [Priority action 1]
  2. [Priority action 2]
- Expected resolution path: [What approach is recommended?]
- Blockers/Dependencies: [Any blockers or things waiting on customer/other teams?]
- Estimated effort: [Low/Medium/High complexity]

---
**Internal Use Only** - Do not share with customer`,
};

export const ACCOUNT_SUPPORT_HEALTH_PROMPT: PromptTemplate = {
  id: "account-support-health",
  name: "Account Support Health",
  description:
    "Research account's past cases to identify patterns and support health",
  variables: ["account-name", "case-list"],
  prompt: `Analyze support history for account "{account-name}" using the following case numbers:

**Case Numbers to Analyze:** {case-list}

---

## Step 1: Fetch Case Summaries

For EACH case number listed above, fetch the pre-computed summary:

Use \`find_summaries_by_filter\` with:
- vector_set: "case_tstools8866_summaries_problem"
- query_filter: {"case": "<8-digit case number>"}

This returns: problem, symptoms, rootcauses, resolution, severity, product.

If a case returns 0 results (no summary), use \`get_mongodb_case_comments\` as fallback.

---

## Step 2: Identify Top Problem Themes

From the collected summaries, identify the **top 2-3 recurring problem themes** based on:
- Frequency (how many cases mention similar issues)
- Severity (prioritize Sev1/Sev2 patterns)
- Problem statement similarity

Examples of themes: "connection pooling issues", "replication lag", "slow query performance", "authentication failures"

---

## Step 3: Cluster Analysis for Each Theme

For EACH major theme identified, run clustering to confirm systemic patterns:

Use \`cluster_vectors_and_generate_centroids_by_semantic_query\` with:
- vector_set: "summaries_vector_case_summary_Problem_Statement"
- query_text: "<problem theme from Step 2>"
- min_vectors_per_cluster: 2
- top_k: 50
- min_score: 0.55

This returns: cluster centroids (themes), cluster labels, member case IDs, representative texts.

---

## Step 4: Validate Risk Patterns

For each confirmed cluster theme, validate if it represents a known risk:

Use \`get_case_precedents_guidance\` with:
- problem_statement: "<cluster label/theme>"
- case_number: "<any case from the cluster>"
- k_max_precedents: 3

This confirms whether the pattern is a recognized issue with known resolutions.

---

## Step 5: Generate Report

### Support Case Profile

- **Total Cases Analyzed:** [count]
- **Time Period:** [earliest case date] to [latest case date]
- **Severity Distribution:**
  | Severity | Count | % |
  |----------|-------|---|
  | Sev1 (Critical) | | |
  | Sev2 (High) | | |
  | Sev3 (Medium) | | |
  | Sev4 (Low) | | |
- **Significant Outages:** List any Sev1/Sev2 production-down incidents
- **Products Used:** Atlas, Enterprise, Community, drivers, etc.

### Confirmed Systemic Patterns (from Clustering)

For each cluster identified in Step 3:

**Pattern 1: [Cluster Label]**
- Cases: [list case numbers in cluster]
- Severity: [distribution within cluster]
- Root Cause: [from precedent validation]
- Risk Level: High / Medium / Low
- Precedent Match: [Yes/No - from Step 4]

**Pattern 2: [Cluster Label]**
- Cases: [list]
- ...

### Systemic Stability Concerns

- Performance degradation patterns: [from clusters]
- Application crashes / connection issues: [from clusters]
- Replication / cluster stability: [from clusters]
- Query / index issues: [from clusters]

### Support Health Assessment

- **Overall Health:** Healthy / Needs Attention / At Risk
- **Trend:** Improving / Stable / Declining
- **Key Observations:**
  - [Pattern 1 insight]
  - [Pattern 2 insight]
  - [Pattern 3 insight]
- **Recommendations for TAM:**
  - [Proactive actions based on clusters]
  - [Training needs based on recurring issues]
  - [Escalation recommendations if high-risk patterns found]

### Case Summary Table

| Case # | Severity | Product | Problem | Cluster | Root Cause |
|--------|----------|---------|---------|---------|------------|
| | | | | | |`,
};

export const DEFAULT_PROMPTS: readonly PromptTemplate[] = [
  CASE_SUMMARY_PROMPT,
  CASE_SUMMARY_TABLE_PROMPT,
  PRECEDENT_RESEARCH_PROMPT,
  FULL_TRIAGE_PROMPT,
  QUICK_TRIAGE_PROMPT,
  LOG_ANALYSIS_PROMPT,
  FTDC_ANALYSIS_PROMPT,
  SAP_NOTE_PROMPT,
  ACCOUNT_SUPPORT_HEALTH_PROMPT,
];

export function getPromptById(id: string): PromptTemplate | undefined {
  return DEFAULT_PROMPTS.find((p) => p.id === id);
}

/**
 * Substitute `{var}` placeholders in a prompt body. Unknown vars pass through
 * as-is so the bot can see what was missing and raise a sensible error.
 */
export function substituteVariables(
  prompt: string,
  variables: Record<string, string>,
): string {
  let out = prompt;
  for (const [k, v] of Object.entries(variables)) {
    out = out.replace(new RegExp(`\\{${k}\\}`, "g"), v);
  }
  return out;
}

/** Convenience: fetch template by id, substitute vars, throw on missing. */
export function renderPrompt(
  id: PromptId,
  variables: Record<string, string>,
): string {
  const tpl = getPromptById(id);
  if (!tpl) throw new Error(`Unknown prompt id: ${id}`);
  const missing = (tpl.variables ?? []).filter((v) => !(v in variables));
  if (missing.length > 0) {
    throw new Error(
      `Prompt ${id} missing variables: ${missing.join(", ")}`,
    );
  }
  return substituteVariables(tpl.prompt, variables);
}
