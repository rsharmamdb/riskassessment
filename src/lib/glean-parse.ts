/**
 * Shared helpers for turning Glean MCP tool payloads into typed CaseDocuments.
 *
 * Used by:
 *   - /api/cases/fetch   — direct MCP calls via the server-configured token
 *   - /api/cases/parse   — paste-back bridge; accepts raw JSON copied out of
 *                          Cursor's chat (where Cursor calls the Glean MCP
 *                          with its own OAuth token that we cannot extract).
 *
 * Both Glean's `search` and `read_document` responses are loosely typed and
 * the envelope shape has drifted over time, so these helpers walk common
 * container keys (`results`, `documents`, `data`, `items`, …) and pick out
 * anything that looks like a case record.
 */

import type { CaseDocument } from "@/lib/case-analysis";
import type { MCPToolCallResult } from "@/lib/types";

export interface SearchHit {
  url: string;
  title: string;
  caseNumber?: string;
  snippet?: string;
}

export interface ReadDoc {
  url: string;
  title?: string;
  fullText: string;
}

export interface GleanChatCitation {
  url?: string;
  title?: string;
  snippet?: string;
}

export interface GleanChatAnswer {
  answer: string;
  citations: GleanChatCitation[];
}

// ---------- generic coercion ----------

export function toolResultToJson(result: MCPToolCallResult): unknown {
  if (result.structuredContent) return result.structuredContent;
  const texts = (result.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string);
  if (texts.length === 0) return null;
  for (const t of texts) {
    try {
      return JSON.parse(t);
    } catch {
      /* try next */
    }
  }
  return texts.join("\n");
}

function firstString(
  obj: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return undefined;
}

// ---------- search ----------

export function extractSearchHits(payload: unknown): SearchHit[] {
  if (!payload) return [];
  const visit = (node: unknown): unknown[] => {
    if (Array.isArray(node)) return node;
    if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      for (const k of [
        "results",
        "hits",
        "documents",
        "data",
        "items",
        "response",
      ]) {
        if (k in obj) {
          const r = visit(obj[k]);
          if (r.length) return r;
        }
      }
    }
    return [];
  };

  const items = visit(payload);
  const out: SearchHit[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const doc = (o.document ?? o.doc ?? o) as Record<string, unknown>;
    const url = firstString(doc, ["url", "link", "sourceUrl"]);
    if (!url) continue;
    const title = firstString(doc, ["title", "name", "subject"]) || url;
    const caseNumber =
      firstString(doc, ["caseNumber", "case_number", "number"]) ||
      title.match(/\b\d{7,}\b/)?.[0];
    const snippet = firstString(doc, ["snippet", "summary", "description"]);
    const hit: SearchHit = { url, title };
    if (caseNumber) hit.caseNumber = caseNumber;
    if (snippet) hit.snippet = snippet;
    out.push(hit);
  }
  return out;
}

// ---------- read_document ----------

export function extractDocuments(payload: unknown): ReadDoc[] {
  if (!payload) return [];
  const visit = (node: unknown): unknown[] => {
    if (Array.isArray(node)) return node;
    if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      for (const k of [
        "documents",
        "results",
        "data",
        "items",
        "docs",
        "response",
      ]) {
        if (k in obj) {
          const r = visit(obj[k]);
          if (r.length) return r;
        }
      }
      if (
        "url" in obj &&
        ("content" in obj || "body" in obj || "text" in obj || "fullText" in obj)
      ) {
        return [obj];
      }
    }
    return [];
  };

  const items = visit(payload);
  const out: ReadDoc[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const doc = (o.document ?? o.doc ?? o) as Record<string, unknown>;
    const url = firstString(doc, ["url", "link"]);
    if (!url) continue;
    const fullText =
      firstString(doc, ["fullText", "full_text", "content", "body", "text"]) ||
      "";
    if (!fullText.trim()) continue;
    const title = firstString(doc, ["title", "name", "subject"]);
    const rec: ReadDoc = { url, fullText };
    if (title) rec.title = title;
    out.push(rec);
  }
  return out;
}

// ---------- chat ----------

/**
 * Pull the synthesized answer and citations out of a Glean `chat` response.
 * Glean's payload shape varies — the answer may land in `answer`, `response`,
 * `message.content`, a concatenation of `messages[*].fragments[*].text`, or
 * just a fallback string. Citations appear under `citations`, `sources`, or
 * nested inside `fragments` as `citation` objects.
 */
export function extractChatAnswer(payload: unknown): GleanChatAnswer {
  if (payload == null) return { answer: "", citations: [] };

  if (typeof payload === "string") {
    return { answer: payload, citations: [] };
  }

  const obj =
    typeof payload === "object" ? (payload as Record<string, unknown>) : {};

  // Direct string fields.
  const directAnswer = firstString(obj, [
    "answer",
    "response",
    "text",
    "output",
    "content",
  ]);

  // Some responses wrap the text inside message{ content: string | [{text}] }
  const message = obj.message as Record<string, unknown> | undefined;
  const messageContent = message
    ? typeof message.content === "string"
      ? (message.content as string)
      : Array.isArray(message.content)
        ? (message.content as Array<Record<string, unknown>>)
            .map((c) => (typeof c.text === "string" ? (c.text as string) : ""))
            .join("\n")
            .trim()
        : undefined
    : undefined;

  // messages: [{ fragments: [{ text: "..." , citation?: {...} }] }]
  const messagesArr = Array.isArray(obj.messages)
    ? (obj.messages as Array<Record<string, unknown>>)
    : [];
  const fragmentTexts: string[] = [];
  const fragmentCitations: GleanChatCitation[] = [];
  for (const m of messagesArr) {
    const frags = Array.isArray(m.fragments)
      ? (m.fragments as Array<Record<string, unknown>>)
      : [];
    for (const f of frags) {
      if (typeof f.text === "string" && f.text.trim()) fragmentTexts.push(f.text);
      const cit = f.citation as Record<string, unknown> | undefined;
      if (cit && typeof cit === "object") {
        const fromDoc = (cit.document ?? cit) as Record<string, unknown>;
        const citation: GleanChatCitation = {};
        const url = firstString(fromDoc, ["url", "link", "sourceUrl"]);
        if (url) citation.url = url;
        const title = firstString(fromDoc, ["title", "name", "subject"]);
        if (title) citation.title = title;
        const snippet = firstString(fromDoc, ["snippet", "summary"]);
        if (snippet) citation.snippet = snippet;
        if (citation.url || citation.title) fragmentCitations.push(citation);
      }
    }
  }

  const answer =
    directAnswer ||
    messageContent ||
    (fragmentTexts.length > 0 ? fragmentTexts.join("") : "");

  // Top-level citations / sources arrays (dedupe with fragment citations).
  const topCitationArr =
    (Array.isArray(obj.citations)
      ? (obj.citations as unknown[])
      : Array.isArray(obj.sources)
        ? (obj.sources as unknown[])
        : []) ?? [];
  const topCitations: GleanChatCitation[] = [];
  for (const c of topCitationArr) {
    if (!c || typeof c !== "object") continue;
    const fromDoc = ((c as Record<string, unknown>).document ?? c) as Record<
      string,
      unknown
    >;
    const citation: GleanChatCitation = {};
    const url = firstString(fromDoc, ["url", "link", "sourceUrl"]);
    if (url) citation.url = url;
    const title = firstString(fromDoc, ["title", "name", "subject"]);
    if (title) citation.title = title;
    const snippet = firstString(fromDoc, ["snippet", "summary"]);
    if (snippet) citation.snippet = snippet;
    if (citation.url || citation.title) topCitations.push(citation);
  }

  const byKey = new Map<string, GleanChatCitation>();
  for (const c of [...fragmentCitations, ...topCitations]) {
    const key = c.url || c.title || JSON.stringify(c);
    if (!byKey.has(key)) byKey.set(key, c);
  }

  return { answer: answer.trim(), citations: [...byKey.values()] };
}

// ---------- paste-back bridge ----------

/**
 * Attempts to turn a free-form string (as pasted out of Cursor's chat) into
 * JSON. Strips Markdown code fences (``` or ```json) and trims common
 * "Result:" / "Output:" labels. Returns `null` if no JSON is recoverable.
 */
export function coercePasteToJson(raw: string): unknown {
  if (!raw) return null;
  let s = raw.trim();
  if (!s) return null;

  // strip a leading label like "Result:" or "Output:"
  s = s.replace(/^[A-Za-z][A-Za-z ]*:\s*/, "");

  // strip fenced code blocks ```json … ``` or ``` … ```
  const fence = /```(?:json|javascript|ts|typescript)?\s*([\s\S]*?)```/i;
  const m = s.match(fence);
  if (m) s = m[1].trim();

  // direct parse
  try {
    return JSON.parse(s);
  } catch {
    /* try to locate the first {...} / [...] */
  }

  // heuristic — find the first balanced {...} or [...] block
  const start = s.search(/[\[{]/);
  if (start < 0) return null;
  const open = s[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Merge a list of SearchHits with ReadDocs into CaseDocuments, preserving the
 * ordering from search and dropping any hits without a readable body.
 */
export function mergeHitsAndDocs(
  hits: SearchHit[],
  docs: ReadDoc[],
): CaseDocument[] {
  const docByUrl = new Map(docs.map((d) => [d.url, d]));
  const out: CaseDocument[] = [];
  for (const h of hits) {
    const d = docByUrl.get(h.url);
    if (!d?.fullText?.trim()) continue;
    const doc: CaseDocument = {
      url: h.url,
      title: d.title || h.title,
      fullText: d.fullText,
    };
    if (h.caseNumber) doc.caseNumber = h.caseNumber;
    out.push(doc);
  }
  // If no hits were supplied (e.g. user only pasted read_document output),
  // fall back to synthesizing CaseDocuments from the docs directly.
  if (hits.length === 0) {
    for (const d of docs) {
      const doc: CaseDocument = {
        url: d.url,
        title: d.title || d.url,
        fullText: d.fullText,
      };
      const cn = d.url.match(/\b\d{7,}\b/)?.[0];
      if (cn) doc.caseNumber = cn;
      out.push(doc);
    }
  }
  return out;
}
