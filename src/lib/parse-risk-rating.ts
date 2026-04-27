/**
 * Parse the overall account risk rating out of a generated Risk Register
 * markdown. The synthesis prompt requires an `## Account Risk Rating`
 * section whose `**Overall:**` line contains `` `RED` ``, `` `YELLOW` ``,
 * or `` `GREEN` `` in inline backticks.
 *
 * Returns the normalized rating, or `null` if none was found (older
 * reports generated before this feature landed).
 */

export type RiskRating = "RED" | "YELLOW" | "GREEN";

const RATING_LINE_RE =
  /##\s*Account Risk Rating[\s\S]{0,400}?\*\*Overall:\*\*[^\n`]*`(RED|YELLOW|GREEN)`/i;

export function parseRiskRating(markdown: string | null | undefined): RiskRating | null {
  if (!markdown) return null;
  const m = markdown.match(RATING_LINE_RE);
  if (!m) return null;
  const tok = m[1].toUpperCase();
  if (tok === "RED" || tok === "YELLOW" || tok === "GREEN") return tok;
  return null;
}

/** Tailwind-compatible tuple: [bg, border, text]. Used by the report-page
 *  header chip and the reports-list row. */
export function ratingChipClasses(r: RiskRating | null): {
  bg: string;
  border: string;
  text: string;
  label: string;
  dot: string;
} {
  switch (r) {
    case "RED":
      return {
        bg: "bg-danger/15",
        border: "border-danger/50",
        text: "text-danger",
        label: "At risk",
        dot: "bg-danger",
      };
    case "YELLOW":
      return {
        bg: "bg-warn/15",
        border: "border-warn/50",
        text: "text-warn",
        label: "Needs attention",
        dot: "bg-warn",
      };
    case "GREEN":
      return {
        bg: "bg-success/15",
        border: "border-success/50",
        text: "text-success",
        label: "Healthy",
        dot: "bg-success",
      };
    default:
      return {
        bg: "bg-ink-800",
        border: "border-ink-700",
        text: "text-ink-400",
        label: "Unrated",
        dot: "bg-ink-500",
      };
  }
}
