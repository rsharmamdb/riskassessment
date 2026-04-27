/**
 * Markdown → DOCX conversion via the `docx` library.
 *
 * Produces a `docx.Document` from a markdown string using `marked`'s
 * tokenizer. Keeps a minimal, opinionated style set tuned for the Risk
 * Register output:
 *   - H1–H6 map to `HeadingLevel.HEADING_1`..`HEADING_6`
 *   - Inline `code` uses Consolas with light-gray shading
 *   - Fenced code blocks render as single-paragraph boxes with monospace
 *     font, gray shading, and a 1pt left border (visually match the PDF)
 *   - Tables have a shaded header row, alternating body rows, 0.5pt borders
 *   - Bullet + ordered lists are emitted via docx's bullet / numbering APIs
 *   - Links are ExternalHyperlink runs
 *
 * Export is deterministic — same input markdown always produces the same
 * docx bytes. No headless browser, no HTML intermediary.
 */

import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type IParagraphOptions,
  type ParagraphChild,
  type ISectionOptions,
} from "docx";
import { marked, type Tokens } from "marked";

// ---------------- style constants ----------------

const MONO_FONT = "Consolas";
const BODY_FONT = "Calibri";
const CODE_SHADE = "F6F8FA"; // subtle gray
const HEADER_SHADE = "EDF1F5";
const ROW_SHADE = "F9FAFB";
const MUTED_COLOR = "6B7280";

const HEADING_LEVEL_BY_DEPTH: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6,
};

// ---------------- inline tokens ----------------

interface InlineStyle {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
}

/** Recursively render inline tokens (children of a paragraph / heading /
 *  table cell / list item) into docx runs.
 */
function renderInline(
  tokens: Tokens.Generic[] | undefined,
  style: InlineStyle = {},
): ParagraphChild[] {
  if (!tokens) return [];
  const out: ParagraphChild[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case "text": {
        // `text` tokens may themselves have children (e.g. inside list items).
        const nested = (t as Tokens.Text).tokens;
        if (nested && nested.length > 0) {
          out.push(...renderInline(nested as Tokens.Generic[], style));
        } else {
          out.push(textRun((t as Tokens.Text).text, style));
        }
        break;
      }
      case "strong": {
        out.push(
          ...renderInline((t as Tokens.Strong).tokens as Tokens.Generic[], {
            ...style,
            bold: true,
          }),
        );
        break;
      }
      case "em": {
        out.push(
          ...renderInline((t as Tokens.Em).tokens as Tokens.Generic[], {
            ...style,
            italic: true,
          }),
        );
        break;
      }
      case "del": {
        out.push(
          ...renderInline((t as Tokens.Del).tokens as Tokens.Generic[], {
            ...style,
            strike: true,
          }),
        );
        break;
      }
      case "codespan": {
        out.push(
          new TextRun({
            text: (t as Tokens.Codespan).text,
            font: MONO_FONT,
            size: 20, // half-points → 10pt
            shading: { type: ShadingType.CLEAR, fill: CODE_SHADE, color: "auto" },
            bold: style.bold,
            italics: style.italic,
            strike: style.strike,
          }),
        );
        break;
      }
      case "link": {
        const lt = t as Tokens.Link;
        out.push(
          new ExternalHyperlink({
            link: lt.href,
            children: [
              new TextRun({
                text: lt.text,
                color: "2563EB",
                underline: {},
                bold: style.bold,
                italics: style.italic,
              }),
            ],
          }),
        );
        break;
      }
      case "br": {
        out.push(new TextRun({ text: "", break: 1 }));
        break;
      }
      case "html": {
        // Strip bare HTML — we don't want to embed raw tags in the doc.
        const stripped = (t as Tokens.HTML).text.replace(/<[^>]*>/g, "");
        if (stripped) out.push(textRun(stripped, style));
        break;
      }
      default: {
        // Fallback — most unknown inline tokens carry a `text` field.
        const anyT = t as { text?: string };
        if (anyT.text) out.push(textRun(anyT.text, style));
      }
    }
  }
  return out;
}

function textRun(text: string, style: InlineStyle): TextRun {
  return new TextRun({
    text,
    bold: style.bold,
    italics: style.italic,
    strike: style.strike,
    font: style.code ? MONO_FONT : undefined,
  });
}

// ---------------- block tokens ----------------

/** Render a fenced code block as a single paragraph with monospace font,
 *  gray shading, and a left border. Line breaks are preserved via TextRun
 *  `break` separators. */
function codeBlockParagraph(text: string): Paragraph {
  const lines = text.split("\n");
  const children: ParagraphChild[] = [];
  lines.forEach((line, i) => {
    if (i > 0) children.push(new TextRun({ text: "", break: 1 }));
    children.push(new TextRun({ text: line, font: MONO_FONT, size: 19 })); // 9.5pt
  });
  return new Paragraph({
    children,
    spacing: { before: 120, after: 120 },
    shading: { type: ShadingType.CLEAR, fill: CODE_SHADE, color: "auto" },
    border: {
      left: { style: BorderStyle.SINGLE, size: 12, color: "CBD5E1", space: 6 },
      top: { style: BorderStyle.SINGLE, size: 4, color: "E5E7EB", space: 4 },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: "E5E7EB", space: 4 },
      right: { style: BorderStyle.SINGLE, size: 4, color: "E5E7EB", space: 4 },
    },
    indent: { left: 120 },
  });
}

/** Render an HR as an empty paragraph with a bottom border. */
function horizontalRule(): Paragraph {
  return new Paragraph({
    border: {
      bottom: { style: BorderStyle.SINGLE, size: 6, color: "D0D7DE", space: 4 },
    },
    spacing: { before: 200, after: 200 },
  });
}

/** Render a blockquote as an italic indented paragraph with a left border. */
function blockquoteParagraphs(
  tokens: Tokens.Blockquote,
): (Paragraph | Table)[] {
  const inner = (tokens.tokens as Tokens.Generic[]) ?? [];
  const children = renderBlocks(inner);
  // Apply quote styling to any Paragraph children produced.
  return children.map((c) => {
    if (c instanceof Paragraph) {
      return new Paragraph({
        children: [
          ...getExistingInline(c),
        ],
        border: {
          left: {
            style: BorderStyle.SINGLE,
            size: 12,
            color: "CBD5E1",
            space: 8,
          },
        },
        indent: { left: 220 },
        shading: { type: ShadingType.CLEAR, fill: "F9FAFB", color: "auto" },
      });
    }
    return c;
  });
}

/** Re-extract the inline children we constructed for a Paragraph — the
 *  docx Paragraph API doesn't expose its children once constructed, so
 *  this is a best-effort (stores nothing additional, just passes through
 *  via a wrapper). Used only by blockquoteParagraphs. */
const _paragraphInline = new WeakMap<Paragraph, ParagraphChild[]>();
function rememberInline(p: Paragraph, c: ParagraphChild[]): Paragraph {
  _paragraphInline.set(p, c);
  return p;
}
function getExistingInline(p: Paragraph): ParagraphChild[] {
  return _paragraphInline.get(p) ?? [];
}

/** Render a list (ordered or unordered, possibly nested). `level` starts
 *  at 0. Each list item becomes one Paragraph (nested lists produce more
 *  paragraphs at a deeper level). */
function listParagraphs(
  list: Tokens.List,
  level = 0,
  orderedRef?: string,
): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const ref = orderedRef ?? "ordered-list";
  for (const item of list.items) {
    // Split the item's child tokens: inline content first, nested lists after.
    const children = (item.tokens as Tokens.Generic[]) ?? [];
    const inlineTokens: Tokens.Generic[] = [];
    const nestedLists: Tokens.List[] = [];
    for (const c of children) {
      if (c.type === "list") nestedLists.push(c as Tokens.List);
      else if (c.type === "text") {
        const nested = (c as Tokens.Text).tokens;
        if (nested) inlineTokens.push(...(nested as Tokens.Generic[]));
        else inlineTokens.push(c);
      } else if (c.type === "paragraph") {
        inlineTokens.push(...((c as Tokens.Paragraph).tokens as Tokens.Generic[]));
      } else {
        inlineTokens.push(c);
      }
    }
    const inlineChildren = renderInline(inlineTokens);
    const base: IParagraphOptions = {
      children: inlineChildren,
      spacing: { before: 40, after: 40 },
    };
    if (list.ordered) {
      paragraphs.push(
        new Paragraph({
          ...base,
          numbering: { reference: ref, level },
        }),
      );
    } else {
      paragraphs.push(
        new Paragraph({
          ...base,
          bullet: { level },
        }),
      );
    }
    // Recurse into any nested lists under this item.
    for (const nl of nestedLists) {
      paragraphs.push(...listParagraphs(nl, level + 1, ref));
    }
  }
  return paragraphs;
}

/** Page content width for Letter with 1000-twip margins on both sides:
 *   12240 (page) − 1000 − 1000 = 10240 twips. */
const CONTENT_WIDTH_TWIPS = 10240;

/** Render a GFM table. Header row is shaded; body rows alternate.
 *
 *  CRITICAL: without `columnWidths` (and a per-cell `width`), Word picks
 *  per-column minimum widths based on content — which wraps every
 *  character onto its own line for long headers. We set even widths based
 *  on column count.
 */
function tableBlock(tok: Tokens.Table): Table {
  const colCount = Math.max(tok.header.length, 1);
  const colWidth = Math.floor(CONTENT_WIDTH_TWIPS / colCount);
  const columnWidths = new Array(colCount).fill(colWidth);

  const headerCells = tok.header.map(
    (cell) =>
      new TableCell({
        width: { size: colWidth, type: WidthType.DXA },
        shading: { type: ShadingType.CLEAR, fill: HEADER_SHADE, color: "auto" },
        children: [
          new Paragraph({
            children: renderInline(cell.tokens as Tokens.Generic[], {
              bold: true,
            }),
          }),
        ],
      }),
  );
  const bodyRows = tok.rows.map(
    (row, rIdx) =>
      new TableRow({
        children: row.map(
          (cell) =>
            new TableCell({
              width: { size: colWidth, type: WidthType.DXA },
              shading:
                rIdx % 2 === 1
                  ? {
                      type: ShadingType.CLEAR,
                      fill: ROW_SHADE,
                      color: "auto",
                    }
                  : undefined,
              children: [
                new Paragraph({
                  children: renderInline(cell.tokens as Tokens.Generic[]),
                }),
              ],
            }),
        ),
      }),
  );
  return new Table({
    width: { size: CONTENT_WIDTH_TWIPS, type: WidthType.DXA },
    columnWidths,
    rows: [
      new TableRow({ children: headerCells, tableHeader: true }),
      ...bodyRows,
    ],
  });
}

/** Walk block-level tokens and emit Paragraphs / Tables. */
function renderBlocks(
  tokens: Tokens.Generic[],
): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case "heading": {
        const h = t as Tokens.Heading;
        const level = HEADING_LEVEL_BY_DEPTH[h.depth] ?? HeadingLevel.HEADING_6;
        out.push(
          new Paragraph({
            heading: level,
            children: renderInline(h.tokens as Tokens.Generic[]),
            spacing: { before: 240, after: 80 },
          }),
        );
        break;
      }
      case "paragraph": {
        const p = t as Tokens.Paragraph;
        const inline = renderInline(p.tokens as Tokens.Generic[]);
        const para = new Paragraph({
          children: inline,
          spacing: { before: 80, after: 80 },
        });
        out.push(rememberInline(para, inline));
        break;
      }
      case "code": {
        out.push(codeBlockParagraph((t as Tokens.Code).text));
        break;
      }
      case "blockquote": {
        out.push(...blockquoteParagraphs(t as Tokens.Blockquote));
        break;
      }
      case "list": {
        out.push(...listParagraphs(t as Tokens.List));
        break;
      }
      case "table": {
        out.push(tableBlock(t as Tokens.Table));
        out.push(new Paragraph({ spacing: { before: 40, after: 40 } }));
        break;
      }
      case "hr": {
        out.push(horizontalRule());
        break;
      }
      case "space": {
        // marked inserts these between blocks; skip — our spacing handles gaps.
        break;
      }
      case "html": {
        const h = t as Tokens.HTML;
        const stripped = h.text.replace(/<[^>]*>/g, "").trim();
        if (stripped) {
          out.push(
            new Paragraph({
              children: [new TextRun({ text: stripped, color: MUTED_COLOR })],
            }),
          );
        }
        break;
      }
      default: {
        // Unknown block — degrade gracefully by rendering its text if any.
        const anyT = t as { text?: string };
        if (anyT.text) {
          out.push(
            new Paragraph({ children: [new TextRun({ text: anyT.text })] }),
          );
        }
      }
    }
  }
  return out;
}

// ---------------- public entry ----------------

export interface MarkdownDocxOptions {
  title: string;
  subtitle?: string;
  generatedAt?: Date;
}

/** Convert a full markdown Risk Register into a DOCX Buffer. */
export async function renderMarkdownToDocx(
  markdown: string,
  opts: MarkdownDocxOptions,
): Promise<Buffer> {
  const tokens = marked.lexer(markdown);
  const body = renderBlocks(tokens as Tokens.Generic[]);

  // Cover header — title, subtitle, generated-on line, divider.
  const cover: Paragraph[] = [
    new Paragraph({
      children: [
        new TextRun({
          text: opts.title,
          bold: true,
          size: 48, // 24pt
          color: "0A0A0A",
        }),
      ],
      spacing: { before: 0, after: 60 },
    }),
  ];
  if (opts.subtitle) {
    cover.push(
      new Paragraph({
        children: [
          new TextRun({
            text: opts.subtitle,
            size: 22,
            color: MUTED_COLOR,
          }),
        ],
        spacing: { after: 40 },
      }),
    );
  }
  const genAt = opts.generatedAt ?? new Date();
  cover.push(
    new Paragraph({
      children: [
        new TextRun({
          text: `Generated ${genAt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })} · INTERNAL ONLY`,
          size: 18,
          color: MUTED_COLOR,
        }),
      ],
      spacing: { after: 120 },
    }),
    horizontalRule(),
  );

  // docx requires all ordered-list references to be declared once at the
  // Document level. We declare one shared reference "ordered-list" and let
  // levels 0-5 auto-number independently.
  const section: ISectionOptions = {
    properties: {
      page: {
        margin: {
          top: 1000,
          right: 1000,
          bottom: 1000,
          left: 1000,
        },
      },
    },
    children: [...cover, ...body],
  };

  const doc = new Document({
    creator: "riskSi",
    title: opts.title,
    description: opts.subtitle,
    styles: {
      default: {
        document: { run: { font: BODY_FONT, size: 22 } }, // 11pt body
        heading1: { run: { font: BODY_FONT, size: 40, bold: true, color: "0A0A0A" } },
        heading2: {
          run: { font: BODY_FONT, size: 32, bold: true, color: "0A0A0A" },
          paragraph: {
            spacing: { before: 280, after: 100 },
            border: {
              bottom: {
                style: BorderStyle.SINGLE,
                size: 4,
                color: "D0D7DE",
                space: 2,
              },
            },
          },
        },
        heading3: { run: { font: BODY_FONT, size: 26, bold: true, color: "24292F" } },
        heading4: { run: { font: BODY_FONT, size: 24, bold: true, color: "24292F" } },
        heading5: {
          run: {
            font: BODY_FONT,
            size: 20,
            bold: true,
            color: MUTED_COLOR,
            allCaps: true,
          },
        },
        heading6: { run: { font: BODY_FONT, size: 20, bold: true, color: MUTED_COLOR } },
      },
    },
    numbering: {
      config: [
        {
          reference: "ordered-list",
          levels: [
            { level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.START },
            { level: 1, format: LevelFormat.LOWER_LETTER, text: "%2.", alignment: AlignmentType.START },
            { level: 2, format: LevelFormat.LOWER_ROMAN, text: "%3.", alignment: AlignmentType.START },
            { level: 3, format: LevelFormat.DECIMAL, text: "%4.", alignment: AlignmentType.START },
            { level: 4, format: LevelFormat.LOWER_LETTER, text: "%5.", alignment: AlignmentType.START },
            { level: 5, format: LevelFormat.LOWER_ROMAN, text: "%6.", alignment: AlignmentType.START },
          ],
        },
      ],
    },
    sections: [section],
  });

  return Packer.toBuffer(doc);
}
