/**
 * Client-side helpers for exporting a generated Risk Register report.
 *
 * Three formats:
 *   - Markdown (.md) — client-side blob, no server round-trip.
 *   - PDF (.pdf)     — `/api/export/pdf` (puppeteer-backed, includes charts).
 *   - Word (.docx)   — `/api/export/docx` (html-to-docx, text/tables only).
 *
 * Each helper downloads the file via a hidden anchor and emits a usage
 * event the Admin usage page can aggregate.
 */

import { track } from "@/lib/track";

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "account";
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export interface ReportExportInput {
  markdown: string;
  accountName: string;
  timeframeMonths?: number;
  motivation?: string;
}

/** Download the report as plain markdown (.md). Client-only. */
export function exportMarkdown({ markdown, accountName }: ReportExportInput): void {
  const blob = new Blob([markdown], { type: "text/markdown" });
  triggerDownload(blob, `${slugify(accountName)}-risk-register.md`);
  track({ event: "report_downloaded_md", account: accountName });
}

/** Download the report as a .docx via `/api/export/docx`. */
export async function exportDocx(input: ReportExportInput): Promise<void> {
  const res = await fetch("/api/export/docx", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `DOCX export failed: HTTP ${res.status}`);
  }
  const blob = await res.blob();
  triggerDownload(blob, `${slugify(input.accountName)}-risk-register.docx`);
  track({ event: "docx_exported", account: input.accountName });
}
