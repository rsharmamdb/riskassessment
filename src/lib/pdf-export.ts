import { track } from "@/lib/track";

interface ExportPdfInput {
  markdown: string;
  accountName: string;
  timeframeMonths?: number;
  motivation?: string;
}

export async function exportPdf({
  markdown,
  accountName,
  timeframeMonths,
  motivation,
}: ExportPdfInput): Promise<void> {
  const res = await fetch("/api/export/pdf", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      markdown,
      accountName,
      timeframeMonths,
      motivation,
    }),
  });

  if (!res.ok) {
    throw new Error(`PDF export failed: ${res.status}`);
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${accountName || "account"}-risk-register.pdf`;
  a.click();
  URL.revokeObjectURL(url);

  track({ event: "pdf_exported", account: accountName });
}

export async function exportPdfForAccount(accountName: string): Promise<void> {
  const res = await fetch(`/api/db/assessments?account=${encodeURIComponent(accountName)}`);
  const json = await res.json();

  if (!json.ok || !json.assessment?.report) {
    throw new Error("No saved report found for this account.");
  }

  await exportPdf({
    markdown: json.assessment.report as string,
    accountName,
    timeframeMonths: json.assessment.input?.timeframeMonths as number | undefined,
    motivation: json.assessment.input?.motivation as string | undefined,
  });
}
