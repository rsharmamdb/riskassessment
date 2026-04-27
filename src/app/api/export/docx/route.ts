/**
 * POST /api/export/docx — convert a markdown Risk Register Report to a
 * Microsoft Word .docx file.
 *
 * Uses the `docx` package directly via `src/lib/markdown-to-docx.ts` for
 * high-fidelity output: proper H1–H6 headings, monospace code blocks with
 * shading, styled tables, and Word-native bullets/numbering. Renders
 * cleanly in Word, Google Docs, and LibreOffice.
 */

import { NextResponse } from "next/server";
import { renderMarkdownToDocx } from "@/lib/markdown-to-docx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

interface Body {
  markdown: string;
  accountName?: string;
  timeframeMonths?: number;
  motivation?: string;
}

/** Ensure bare "Case 0XXXXXXX" strings link to hub.corp.mongodb.com. */
function normalizeCaseLinks(md: string): string {
  return md.replace(
    /(?<!\[)Case\s+(0\d{7})(?!\]\()/gi,
    (_, num: string) =>
      `[Case ${num}](https://hub.corp.mongodb.com/case/${num})`,
  );
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
    const normalized = normalizeCaseLinks(body.markdown);

    const title = body.accountName
      ? `${body.accountName} — Risk Register Report`
      : "Risk Register Report";
    const subtitleParts: string[] = [];
    if (body.motivation) subtitleParts.push(body.motivation);
    if (body.timeframeMonths) {
      subtitleParts.push(
        `Last ${body.timeframeMonths} month${body.timeframeMonths === 1 ? "" : "s"}`,
      );
    }
    const subtitle = subtitleParts.join(" · ");

    const buffer = await renderMarkdownToDocx(normalized, {
      title,
      subtitle: subtitle || undefined,
    });

    const slug = (body.accountName || "account")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const filename = `${slug}-risk-register.docx`;

    const ab = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ) as ArrayBuffer;

    return new NextResponse(ab, {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[docx export] failed:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
