/**
 * Parse structured risks out of the Risk Register markdown report.
 *
 * Targets the "## Key Findings" table which has this shape:
 *   | # | Risk Identified | Severity | Confidence | Frequency of Risk | Impact of Taking No Action |
 *
 * Returns an array of ParsedRisk objects that drive the risk matrix,
 * status workflow, and evidence audit panels.
 */

export type Severity = "Critical" | "Significant" | "Roadmap Planning" | "Low";
export type Confidence = "High" | "Medium" | "Low";
export type Frequency = "High" | "Medium" | "Low" | "—";
export type RiskStatus = "Open" | "Acknowledged" | "Action Planned" | "Mitigated";

export interface ParsedRisk {
  id: number;
  title: string;
  severity: Severity;
  confidence: Confidence;
  frequency: Frequency;
  impact: string;
  /** Populated from DB after initial parse */
  status?: RiskStatus;
  dueDate?: string;
  owner?: string;
}

/** Normalize a cell string to a typed severity */
function parseSeverity(raw: string): Severity {
  const s = raw.trim().toLowerCase();
  if (s.includes("critical")) return "Critical";
  if (s.includes("significant")) return "Significant";
  if (s.includes("roadmap")) return "Roadmap Planning";
  return "Low";
}

function parseConfidence(raw: string): Confidence {
  const s = raw.trim().toLowerCase();
  if (s.includes("high")) return "High";
  if (s.includes("medium") || s.includes("med")) return "Medium";
  return "Low";
}

function parseFrequency(raw: string): Frequency {
  const s = raw.trim().toLowerCase();
  if (s.includes("high")) return "High";
  if (s.includes("medium") || s.includes("med")) return "Medium";
  if (s.includes("low")) return "Low";
  return "—";
}

/** Strip markdown bold/link syntax from a cell */
function cleanCell(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

export function parseRisks(markdown: string): ParsedRisk[] {
  const risks: ParsedRisk[] = [];
  const lines = markdown.split("\n");

  let inKeyFindings = false;
  let headerParsed = false;
  let colMap: Record<string, number> = {};

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Detect start of Key Findings section
    if (/^#+\s+key findings/i.test(line)) {
      inKeyFindings = true;
      headerParsed = false;
      colMap = {};
      continue;
    }

    // Leave Key Findings when hitting next ## section
    if (inKeyFindings && /^#+\s+/.test(line) && !/^#+\s+key findings/i.test(line)) {
      inKeyFindings = false;
      continue;
    }

    if (!inKeyFindings) continue;

    // Parse table header row
    if (!headerParsed && line.startsWith("|")) {
      const cells = line.split("|").map((c) => c.trim().toLowerCase()).filter(Boolean);
      cells.forEach((c, i) => {
        if (/^#$/.test(c)) colMap.num = i;
        else if (c.includes("risk identified")) colMap.title = i;
        else if (c.includes("severity")) colMap.severity = i;
        else if (c.includes("confidence")) colMap.confidence = i;
        else if (c.includes("frequency")) colMap.frequency = i;
        else if (c.includes("impact")) colMap.impact = i;
        else if (c.includes("risk")) colMap.title = i; // fallback for columns just named "risk"
      });
      if (colMap.title !== undefined) headerParsed = true;
      continue;
    }

    // Skip separator row
    if (line.startsWith("|") && /^[|\s\-:]+$/.test(line)) continue;

    // Parse data rows
    if (headerParsed && line.startsWith("|")) {
      const cells = line.split("|").map((c) => cleanCell(c)).filter((_, i, arr) =>
        i > 0 && i < arr.length - 1,
      );

      // Re-index: split removes first/last empty cells
      const get = (key: keyof typeof colMap) =>
        colMap[key] !== undefined ? (cells[colMap[key]] ?? "") : "";

      const numStr = get("num");
      const num = parseInt(numStr, 10);
      const title = get("title");
      const severity = get("severity");
      const confidence = get("confidence");
      const frequency = get("frequency");
      const impact = get("impact");

      if (!title || title === "Risk Identified") continue;
      if (isNaN(num) && !title) continue;

      risks.push({
        id: isNaN(num) ? risks.length + 1 : num,
        title: title.slice(0, 200),
        severity: parseSeverity(severity),
        confidence: parseConfidence(confidence),
        frequency: parseFrequency(frequency),
        impact: impact.slice(0, 300),
        status: "Open",
      });
    }
  }

  return risks;
}

/** Severity → numeric weight for matrix Y axis (higher = more severe) */
export const SEVERITY_WEIGHT: Record<Severity, number> = {
  Critical: 3,
  Significant: 2,
  "Roadmap Planning": 1,
  Low: 0,
};

/** Confidence → numeric weight for matrix X axis */
export const CONFIDENCE_WEIGHT: Record<Confidence, number> = {
  High: 3,
  Medium: 2,
  Low: 1,
};

/** Left-border severity label — no filled background */
export const SEVERITY_COLOR: Record<Severity, string> = {
  Critical:           "border-l-2 pl-2 border-[#be6464] text-[#be6464] bg-transparent",
  Significant:        "border-l-2 pl-2 border-[#f0ad4e] text-[#f0ad4e] bg-transparent",
  "Roadmap Planning": "border-l-2 pl-2 border-[#889397] text-[#889397] bg-transparent",
  Low:                "border-l-2 pl-2 border-[#C8D3CF] text-ink-600  bg-transparent",
};

/** Left-border status — no filled background */
export const STATUS_COLORS: Record<RiskStatus, string> = {
  Open:              "text-[#be6464] border-[#be6464]/50 bg-transparent",
  Acknowledged:      "text-[#f0ad4e] border-[#f0ad4e]/50 bg-transparent",
  "Action Planned":  "text-[#337ab7] border-[#337ab7]/50 bg-transparent",
  Mitigated:         "text-[#8dc572] border-[#8dc572]/50 bg-transparent",
};

export const ALL_STATUSES: RiskStatus[] = ["Open", "Acknowledged", "Action Planned", "Mitigated"];
