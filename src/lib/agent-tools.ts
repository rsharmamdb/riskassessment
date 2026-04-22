/**
 * Agent tool definitions + dispatcher for the MongoGPT-driven Risk Register
 * agent. Mirrors the OpenAI "function tools" spec so MongoGPT's
 * OpenAI-compatible endpoint can invoke them directly.
 *
 * Three tools are exposed — the same three primitives surfaced in the
 * non-agent Wizard:
 *   - glean_chat          → Glean's own synthesis across cases/Slack/PS/JIRA
 *   - glean_search        → document-level hits with metadata
 *   - glean_read_document → full text of chosen URLs
 *
 * Calls hit the Glean MCP directly via `callMcpTool` (same as the
 * /api/glean/* routes) so SSO and static tokens both work, and we avoid an
 * in-process HTTP hop per tool call.
 */

import { callMcpTool } from "@/lib/mcp-client";
import {
  extractChatAnswer,
  extractDocuments,
  extractSearchHits,
  mergeHitsAndDocs,
  toolResultToJson,
  type SearchHit,
} from "@/lib/glean-parse";
import { resolveGleanServer, type ResolvedGleanServer } from "@/lib/glean-server";
import type { MongoGptToolDef } from "@/lib/mongogpt";

export const AGENT_TOOLS: MongoGptToolDef[] = [
  {
    type: "function",
    function: {
      name: "glean_chat",
      description:
        "Ask Glean's synthesis engine a high-level question about the customer " +
        "account. Glean searches across support cases (Support Hub), Slack " +
        "channels (csm-*, #help, #escalations), Professional Services reports, " +
        "JIRA (HELP/SERVER/CLOUDP), and internal wikis, then returns a cited " +
        "markdown answer. Use for stakeholder maps, open risks, PS " +
        "recommendations, escalation summaries, and similar questions that need " +
        "reasoning across sources.",
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description:
              "The question for Glean. Always mention the account name and the " +
              "timeframe explicitly, e.g. 'For Ubuy in the past 6 months, list " +
              "every open escalation and its RCA link'.",
          },
        },
        required: ["message"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glean_search",
      description:
        "Run a Glean keyword search. Returns document-level hits with URL, " +
        "title, and a short snippet — NO synthesis. Use this when you want to " +
        "discover specific documents (PS reports, RCA docs, JIRA tickets, Slack " +
        "threads) so you can then call glean_read_document on the promising " +
        "ones. Combine keywords with filters: owner:\"name\", from:\"name\", " +
        "updated:past_week, after:YYYY-MM-DD.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query string.",
          },
          app: {
            type: "string",
            description:
              "Optional datasource filter: 'slack', 'confluence', 'gdrive', " +
              "'salesforce', 'jira', etc. Omit to search all indexed apps.",
          },
          pageSize: {
            type: "number",
            description: "Max hits to return (default 5, max 15).",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glean_read_document",
      description:
        "Fetch the full text of specific documents by URL. Use after " +
        "glean_search when you need the actual contents (e.g. full PS report, " +
        "full RCA, full Slack thread) rather than a snippet. Returns an array " +
        "of { url, title, fullText } objects; each fullText is truncated to " +
        "~8k chars to keep context bounded.",
      parameters: {
        type: "object",
        properties: {
          urls: {
            type: "array",
            items: { type: "string" },
            description:
              "URLs to read. Pass 1–5 URLs per call; batch larger sets across " +
              "multiple calls to stay under the context budget.",
          },
        },
        required: ["urls"],
        additionalProperties: false,
      },
    },
  },
];

// ------------------------------ execution ------------------------------

/** Result of executing a single tool call; `text` is what gets fed back
 * to the model as the tool message content, `summary` is a short human
 * line for streaming status updates. */
export interface AgentToolResult {
  text: string;
  summary: string;
}

export interface AgentRunContext {
  glean: ResolvedGleanServer;
  maxSnippetChars: number;
  maxDocChars: number;
}

export async function createAgentContext(params: {
  gleanToken?: string;
  gleanUrl?: string;
}): Promise<AgentRunContext> {
  const glean = await resolveGleanServer({
    bodyToken: params.gleanToken,
    bodyUrl: params.gleanUrl,
  });
  return { glean, maxSnippetChars: 400, maxDocChars: 8_000 };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…[truncated, ${s.length - max} more chars]`;
}

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export async function executeToolCall(
  name: string,
  rawArgs: string,
  ctx: AgentRunContext,
): Promise<AgentToolResult> {
  const args = safeParseArgs(rawArgs);

  if (name === "glean_chat") {
    const message = String(args.message ?? "").trim();
    if (!message) return toolError(name, "missing required `message`");
    const res = await callMcpTool(ctx.glean.server, "chat", { message });
    const { answer, citations } = extractChatAnswer(toolResultToJson(res));
    const citationLines = citations
      .slice(0, 12)
      .map(
        (c, i) =>
          `[${i + 1}] ${c.title || "source"}${c.url ? ` — ${c.url}` : ""}`,
      )
      .join("\n");
    const text =
      (answer || "_(empty answer)_") +
      (citationLines ? `\n\nCitations:\n${citationLines}` : "");
    return {
      text: truncate(text, 12_000),
      summary: `glean_chat: ${citations.length} citation(s), ${answer.length.toLocaleString()} chars`,
    };
  }

  if (name === "glean_search") {
    const query = String(args.query ?? "").trim();
    if (!query) return toolError(name, "missing required `query`");
    const app = typeof args.app === "string" ? args.app : undefined;
    const pageSize = clampNumber(args.pageSize, 1, 15, 5);
    const mcpArgs: Record<string, unknown> = { query, pageSize };
    if (app) mcpArgs.app = app;
    const res = await callMcpTool(ctx.glean.server, "search", mcpArgs);
    const hits = extractSearchHits(toolResultToJson(res));
    if (hits.length === 0) {
      return {
        text: `No Glean results for "${query}"${app ? ` (app=${app})` : ""}.`,
        summary: `glean_search("${query}") → 0 hits`,
      };
    }
    const lines = hits.slice(0, pageSize).map((h, i) => {
      const caseTag = h.caseNumber ? ` [case ${h.caseNumber}]` : "";
      const snip = h.snippet
        ? `\n    ${truncate(h.snippet, ctx.maxSnippetChars).replace(/\n+/g, " ")}`
        : "";
      return `${i + 1}. ${h.title}${caseTag}\n    ${h.url}${snip}`;
    });
    return {
      text: lines.join("\n"),
      summary: `glean_search("${query}") → ${hits.length} hit(s)`,
    };
  }

  if (name === "glean_read_document") {
    const urls = Array.isArray(args.urls)
      ? (args.urls as unknown[])
          .filter((u): u is string => typeof u === "string" && u.length > 0)
          .slice(0, 5)
      : [];
    if (urls.length === 0) return toolError(name, "missing required `urls` (non-empty)");
    const res = await callMcpTool(ctx.glean.server, "read_document", { urls });
    const docs = extractDocuments(toolResultToJson(res));
    const hintHits: SearchHit[] = urls.map((u) => ({ url: u, title: u }));
    const merged = mergeHitsAndDocs(hintHits, docs);
    if (merged.length === 0) {
      return {
        text: `No readable content for urls:\n${urls.map((u) => `- ${u}`).join("\n")}`,
        summary: `glean_read_document(${urls.length}) → 0 readable`,
      };
    }
    const blocks = merged.map((d) => {
      const header = `### ${d.title || d.url}\n${d.url}`;
      return `${header}\n\n${truncate(d.fullText.trim(), ctx.maxDocChars)}`;
    });
    return {
      text: blocks.join("\n\n---\n\n"),
      summary: `glean_read_document(${urls.length}) → ${merged.length} doc(s)`,
    };
  }

  return toolError(name, `unknown tool \`${name}\``);
}

function toolError(name: string, reason: string): AgentToolResult {
  return {
    text: `ERROR calling ${name}: ${reason}`,
    summary: `${name} → error (${reason})`,
  };
}

function clampNumber(
  v: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
