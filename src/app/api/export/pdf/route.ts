/**
 * POST /api/export/pdf — converts a markdown Risk Register Report into a
 * styled PDF with charts, timeline, and MongoDB Technical Services branding.
 *
 * Uses Puppeteer to render HTML → PDF server-side.
 */
import { NextResponse } from "next/server";
import puppeteer from "puppeteer";
import { marked } from "marked";
import { BRAND_LOGO_SVG, BRAND_NAME, BRAND_TAGLINE } from "@/lib/brand";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

interface Body {
  markdown: string;
  accountName?: string;
  timeframeMonths?: number;
  motivation?: string;
}

/**
 * Post-process generated markdown to ensure all case number references
 * link to https://hub.corp.mongodb.com/case/{number}.
 */
function normalizeCaseLinks(md: string): string {
  return md.replace(
    /(?<!\[)Case\s+(0\d{7})(?!\]\()/gi,
    (_, num: string) =>
      `[Case ${num}](https://hub.corp.mongodb.com/case/${num})`,
  );
}

/** Markdown → HTML via `marked`. Covers full GFM: h1-h6, ordered & unordered
 *  lists, tables, fenced code blocks, inline code, links, emphasis, hr. */
function mdToHtml(md: string): string {
  // `async: false` makes marked return synchronously; we only use built-in
  // renderers so no async extensions are in play.
  return marked.parse(md, { async: false, gfm: true, breaks: false }) as string;
}

/**
 * Extract structured data from the markdown for chart rendering.
 */
function extractChartData(md: string) {
  // Extract Key Findings table rows for severity chart
  const findings: { risk: string; severity: string }[] = [];
  const findingsMatch = md.match(
    /## Key Findings\n\|[^\n]+\n\|[^\n]+\n((?:\|[^\n]+\n?)*)/,
  );
  if (findingsMatch) {
    for (const row of findingsMatch[1].trim().split("\n")) {
      const cells = row.split("|").filter((c) => c.trim());
      if (cells.length >= 3) {
        findings.push({
          risk: cells[1]?.trim() ?? "",
          severity: cells[2]?.trim() ?? "",
        });
      }
    }
  }

  // Extract case breakdown by technical area
  const techAreas: { area: string; count: number }[] = [];
  const techMatch = md.match(
    /technical area[:\s]*\n\|[^\n]+\n\|[^\n]+\n((?:\|[^\n]+\n?)*)/i,
  );
  if (techMatch) {
    for (const row of techMatch[1].trim().split("\n")) {
      const cells = row.split("|").filter((c) => c.trim());
      if (cells.length >= 2) {
        const count = parseInt(cells[1]?.trim() ?? "0", 10);
        if (!isNaN(count) && count > 0) {
          techAreas.push({ area: cells[0]?.trim() ?? "", count });
        }
      }
    }
  }

  // Extract case breakdown by problem category
  const categories: { cat: string; count: number }[] = [];
  const catMatch = md.match(
    /problem category[:\s]*\n\|[^\n]+\n\|[^\n]+\n((?:\|[^\n]+\n?)*)/i,
  );
  if (catMatch) {
    for (const row of catMatch[1].trim().split("\n")) {
      const cells = row.split("|").filter((c) => c.trim());
      if (cells.length >= 2) {
        const count = parseInt(cells[1]?.trim() ?? "0", 10);
        if (!isNaN(count) && count > 0) {
          categories.push({ cat: cells[0]?.trim() ?? "", count });
        }
      }
    }
  }

  return { findings, techAreas, categories };
}

function buildChartsHtml(chartData: ReturnType<typeof extractChartData>): string {
  const sections: string[] = [];

  // Severity distribution chart (horizontal bar via CSS)
  if (chartData.findings.length > 0) {
    const severityColors: Record<string, string> = {
      critical: "#ef4444",
      significant: "#f59e0b",
      "roadmap planning": "#3b82f6",
    };
    const sevCounts: Record<string, number> = {};
    for (const f of chartData.findings) {
      const key = f.severity.toLowerCase();
      sevCounts[key] = (sevCounts[key] ?? 0) + 1;
    }
    const maxCount = Math.max(...Object.values(sevCounts), 1);
    const bars = Object.entries(sevCounts)
      .map(
        ([sev, count]) =>
          `<div style="display:flex;align-items:center;gap:8px;margin:6px 0">
            <span style="width:140px;text-align:right;font-size:12px;text-transform:capitalize">${sev}</span>
            <div style="flex:1;background:#1e293b;border-radius:4px;height:24px;position:relative">
              <div style="width:${(count / maxCount) * 100}%;background:${severityColors[sev] ?? "#6b7280"};height:100%;border-radius:4px;display:flex;align-items:center;padding-left:8px">
                <span style="color:white;font-size:11px;font-weight:600">${count}</span>
              </div>
            </div>
          </div>`,
      )
      .join("");
    sections.push(
      `<div class="chart-block"><h3>Risk Severity Distribution</h3>${bars}</div>`,
    );
  }

  // Technical area breakdown (horizontal bar chart)
  if (chartData.techAreas.length > 0) {
    const colors = ["#10b981", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#06b6d4", "#84cc16"];
    const maxCount = Math.max(...chartData.techAreas.map((t) => t.count), 1);
    const bars = chartData.techAreas
      .map(
        (t, i) =>
          `<div style="display:flex;align-items:center;gap:8px;margin:6px 0">
            <span style="width:180px;text-align:right;font-size:12px">${t.area}</span>
            <div style="flex:1;background:#1e293b;border-radius:4px;height:24px">
              <div style="width:${(t.count / maxCount) * 100}%;background:${colors[i % colors.length]};height:100%;border-radius:4px;display:flex;align-items:center;padding-left:8px">
                <span style="color:white;font-size:11px;font-weight:600">${t.count}</span>
              </div>
            </div>
          </div>`,
      )
      .join("");
    sections.push(
      `<div class="chart-block"><h3>Cases by Technical Area</h3>${bars}</div>`,
    );
  }

  // Problem category pie-style (stacked horizontal bar)
  if (chartData.categories.length > 0) {
    const colors = ["#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ec4899"];
    const total = chartData.categories.reduce((s, c) => s + c.count, 0);
    const segments = chartData.categories
      .map(
        (c, i) =>
          `<div style="width:${(c.count / total) * 100}%;background:${colors[i % colors.length]};height:32px" title="${c.cat}: ${c.count}"></div>`,
      )
      .join("");
    const legend = chartData.categories
      .map(
        (c, i) =>
          `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:12px;font-size:11px">
            <span style="width:10px;height:10px;border-radius:2px;background:${colors[i % colors.length]};display:inline-block"></span>
            ${c.cat} (${c.count})
          </span>`,
      )
      .join("");
    sections.push(
      `<div class="chart-block">
        <h3>Cases by Problem Category</h3>
        <div style="display:flex;border-radius:4px;overflow:hidden;margin:8px 0">${segments}</div>
        <div style="margin-top:8px">${legend}</div>
      </div>`,
    );
  }

  if (sections.length === 0) return "";
  return `<div class="charts-section"><h2 style="page-break-before:always">Visual Summary</h2>${sections.join("")}</div>`;
}

function buildFullHtml(
  bodyHtml: string,
  chartsHtml: string,
  accountName: string,
  dateStr: string,
  meta: { timeframeMonths?: number; motivation?: string },
): string {
  // Compute timeframe range
  const now = new Date();
  const months = meta.timeframeMonths ?? 6;
  const from = new Date(now);
  from.setMonth(from.getMonth() - months);
  const fmtOpts: Intl.DateTimeFormatOptions = { year: "numeric", month: "short" };
  const timeframeStr = `${from.toLocaleDateString("en-US", fmtOpts)} – ${now.toLocaleDateString("en-US", fmtOpts)} (${months} months)`;

  const motivationLabel: Record<string, string> = {
    "proactive-health-check": "Proactive health check",
    "reactive-to-incident": "Reactive to incidents",
    "renewal-preparation": "Renewal preparation",
    escalation: "Escalation",
  };
  const motivationStr = meta.motivation
    ? (motivationLabel[meta.motivation] ?? meta.motivation)
    : "—";
  const logoUri = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(BRAND_LOGO_SVG)}`;

  const metaTable = `
    <table class="meta-table">
      <tbody>
        <tr><th>Generated</th><td>${dateStr}</td><th>Timeframe</th><td>${timeframeStr}</td></tr>
        <tr><th>Assessment type</th><td colspan="3">${motivationStr}</td></tr>
      </tbody>
    </table>`;
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<style>
  @page { margin: 60px 50px 60px 50px; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    font-size: 13px;
    line-height: 1.6;
    color: #1e293b;
    max-width: 900px;
    margin: 0 auto;
  }
  .header {
    display: flex;
    align-items: center;
    gap: 14px;
    border-bottom: 2px solid #1e2d3d;
    padding-bottom: 16px;
    margin-bottom: 24px;
  }
  .header h1 { color: #0f172a; margin: 0 0 4px 0; font-size: 24px; }
  .header .meta { font-size: 11px; color: #64748b; }
  .header img { width: 44px; height: 44px; border-radius: 9999px; flex-shrink: 0; }
  .header .logo-text {
    font-size: 14px;
    font-weight: 700;
    color: #0f172a;
    letter-spacing: -0.3px;
    margin-bottom: 8px;
  }
  .header .tagline {
    color: #64748b;
    font-size: 11px;
    margin-bottom: 8px;
  }
  h1 { font-size: 22px; color: #0f172a; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px; page-break-after: avoid; }
  h2 { font-size: 17px; color: #00684A; margin-top: 28px; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; page-break-after: avoid; }
  h3 { font-size: 14px; color: #334155; margin-top: 20px; page-break-after: avoid; }
  h4 { font-size: 13px; color: #475569; margin-top: 16px; page-break-after: avoid; font-weight: 700; }
  h5 { font-size: 12px; color: #64748b; margin-top: 12px; margin-bottom: 4px; page-break-after: avoid; font-weight: 700; text-transform: uppercase; letter-spacing: 0.3px; }
  h6 { font-size: 11px; color: #94a3b8; margin-top: 10px; margin-bottom: 3px; page-break-after: avoid; font-weight: 600; }
  table { border-collapse: collapse; width: 100%; margin: 12px 16px; font-size: 12px; page-break-inside: avoid; }
  th { background: #f1f5f9; text-align: left; padding: 8px 10px; border: 1px solid #e2e8f0; font-weight: 600; color: #334155; }
  td { padding: 6px 10px; border: 1px solid #e2e8f0; vertical-align: top; word-wrap: break-word; overflow-wrap: break-word; }
  tr:nth-child(even) td { background: #f8fafc; }
  /* Keep sections together — heading + first bit of content */
  h1 + *, h2 + *, h3 + *, h4 + *, h5 + *, h6 + * { page-break-before: avoid; }
  /* Prevent sections from being orphaned */
  section, .section-block { page-break-inside: avoid; }
  p, li { orphans: 3; widows: 3; }
  a { color: #2563eb; text-decoration: underline; }
  pre { background: #f1f5f9; padding: 10px 12px; border-radius: 4px; font-size: 10.5px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; border-left: 3px solid #cbd5e1; line-height: 1.4; }
  pre code { background: transparent; padding: 0; font-size: inherit; }
  code { font-family: 'SF Mono', Monaco, Consolas, monospace; font-size: 11px; background: #f1f5f9; padding: 1px 4px; border-radius: 3px; }
  hr { border: none; border-top: 1px solid #e2e8f0; margin: 20px 0; }
  ul, ol { padding-left: 22px; margin: 6px 0; }
  li { margin: 4px 0; }
  li > p { margin: 2px 0; }
  blockquote { border-left: 3px solid #cbd5e1; margin: 8px 0; padding: 4px 12px; color: #475569; background: #f8fafc; }
  .internal-banner {
    background: #fef2f2;
    border: 1px solid #fecaca;
    color: #991b1b;
    padding: 8px 12px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    text-align: center;
    margin-bottom: 20px;
  }
  .chart-block { margin: 20px 0; padding: 16px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; }
  .chart-block h3 { margin-top: 0; }
  .meta-table { width: 100%; border-collapse: collapse; margin: 0 0 20px 0; font-size: 12px; }
  .meta-table th { background: #f8fafc; font-weight: 600; color: #475569; padding: 6px 10px; border: 1px solid #e2e8f0; width: 140px; }
  .meta-table td { padding: 6px 10px; border: 1px solid #e2e8f0; color: #1e293b; }
  .footer {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    text-align: center;
    font-size: 10px;
    color: #94a3b8;
    padding: 8px 50px;
    border-top: 1px solid #e2e8f0;
  }
</style>
</head>
<body>
  <div class="header">
    <img src="${logoUri}" alt="${BRAND_NAME} logo" />
    <div>
      <div class="logo-text">${BRAND_NAME}</div>
      <div class="tagline">${BRAND_TAGLINE}</div>
      <h1>${accountName}: Risk Register Report</h1>
      <div class="meta">Generated: ${dateStr} &nbsp;|&nbsp; INTERNAL ONLY</div>
    </div>
  </div>
  <div class="internal-banner">INTERNAL DOCUMENT ONLY &mdash; NOT TO BE SHARED WITH THE CUSTOMER</div>
  ${metaTable}
  ${bodyHtml}
  ${chartsHtml}
  <div class="footer">${BRAND_NAME} &mdash; Risk Register &mdash; ${dateStr}</div>
</body>
</html>`;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.markdown) {
    return NextResponse.json({ error: "Missing markdown" }, { status: 400 });
  }

  try {
    const rawName = body.accountName || "Account";
    const accountName = rawName.replace(/\S+/g, (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
    const dateStr = new Date().toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    // Normalize case links before converting
    const md = normalizeCaseLinks(body.markdown);
    const bodyHtml = mdToHtml(md);
    const chartData = extractChartData(md);
    const chartsHtml = buildChartsHtml(chartData);
    const fullHtml = buildFullHtml(bodyHtml, chartsHtml, accountName, dateStr, {
      timeframeMonths: body.timeframeMonths,
      motivation: body.motivation,
    });

    // Use Puppeteer to render HTML → PDF
    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
    });
    const page = await browser.newPage();
    await page.setContent(fullHtml, { waitUntil: "domcontentloaded" });
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "60px", bottom: "60px", left: "50px", right: "50px" },
    });
    await browser.close();

    return new Response(Buffer.from(pdfBuffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${accountName}-risk-register.pdf"`,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
