export interface MCPServerConfig {
  id: string;
  name: string;
  url: string;
  headers?: Record<string, string>;
}

export interface MCPToolCallResult {
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
  isError?: boolean;
  [k: string]: unknown;
}

export interface AssessmentInput {
  accountName: string;
  /** The official account name from Salesforce (e.g. "Zomato Limited"). */
  canonicalName?: string;
  motivation: string;
  timeframeMonths: number;
  knownConcerns?: string;
  salesforceId?: string;
}

export interface GatheredArtifact {
  source: "glean" | "auto-triage";
  /**
   * Distinguishes Glean's synthesis (`chat`) from document snippet lookups
   * (`search`). The report generator renders `chat` answers as pre-synthesized
   * markdown (high-signal evidence) and `search` artifacts as raw JSON blocks.
   * `case-intelligence` carries the full Auto Triage pipeline output
   * (per-case summaries + precedents + account health) as a structured blob.
   */
  kind: "search" | "chat" | "case-intelligence";
  query?: string;
  label: string;
  data: unknown;
  citations?: Array<{ url?: string; title?: string; snippet?: string }>;
}

export interface AssessmentState {
  input: AssessmentInput | null;
  artifacts: GatheredArtifact[];
  report: string;
}
