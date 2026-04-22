/**
 * MongoGPT (MongoDB internal LLM gateway) client.
 *
 * API shape from: https://gist.github.com/john-ziegler/417fac1b2a9edefb97c40085e74764d6
 *
 * - Endpoint:  POST <base>/api/v1/messages
 * - Auth:      X-Kanopy-Authorization: Bearer <jwt>
 * - Body:      { model, messages: [{ role, content, name? }], ... }
 * - Response:  Two observed shapes in the wild:
 *     A) OpenAI-compatible chat completion JSON:
 *        { id, choices: [{ message: { role, content: "..." } }], ... }
 *     B) SSE-ish stream where each chunk is `data: "..."` or
 *        `data: {"choices":[{"delta":{"content":"..."}}]}`.
 *   We detect by `Content-Type` and try JSON first, SSE second.
 *
 * Tool calling: OpenAI-compatible via `tools` + `tool_choice`. When the model
 * decides to call a tool, the assistant message comes back with
 * `tool_calls: [{ id, type: "function", function: { name, arguments } }]`;
 * we surface those directly so the agent loop can dispatch them.
 */

export interface MongoGptToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type MongoGptMessage =
  | {
      role: "system" | "user";
      content: string;
      name?: string;
    }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: MongoGptToolCall[];
      name?: string;
    }
  | {
      role: "tool";
      content: string;
      tool_call_id: string;
      name?: string;
    };

export interface MongoGptToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface CallMongoGptOpts {
  url: string;
  token: string;
  model: string;
  messages: MongoGptMessage[];
  /** Soft timeout for the full streamed response. */
  timeoutMs?: number;
}

export interface CallMongoGptToolsOpts extends CallMongoGptOpts {
  tools?: MongoGptToolDef[];
  toolChoice?: "auto" | "none" | "required";
  temperature?: number;
  /** OpenAI-style max tokens (or max_completion_tokens for reasoning models). */
  maxTokens?: number;
}

export interface MongoGptToolResponse {
  content: string;
  toolCalls: MongoGptToolCall[];
}

/** Reasoning model families that require `max_completion_tokens` over `max_tokens`. */
export function isReasoningModel(model: string): boolean {
  return /^(o[134]|gpt-5)/i.test(model.trim());
}

/**
 * Parse a single buffered SSE-style body and return the concatenated
 * assistant text. Safe against embedded quotes (unlike `split('"')[1]`).
 */
export function parseMongoGptStream(body: string): string {
  let out = "";
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;

    // Preferred: payload is a JSON-encoded string, e.g. `"Hello"`.
    if (payload.startsWith('"')) {
      try {
        const parsed = JSON.parse(payload);
        if (typeof parsed === "string") {
          out += parsed;
          continue;
        }
      } catch {
        // fall through to next strategies
      }
    }

    // Some chunks may come as JSON objects like {"content":"Hello"} or
    // an OpenAI-style delta object. Best-effort pull known text fields.
    if (payload.startsWith("{")) {
      try {
        const obj = JSON.parse(payload) as Record<string, unknown>;
        const text =
          (obj.content as string | undefined) ??
          (obj.text as string | undefined) ??
          ((obj.delta as Record<string, unknown> | undefined)?.content as
            | string
            | undefined) ??
          ((obj.choices as Array<Record<string, unknown>> | undefined)?.[0]
            ?.delta as Record<string, unknown> | undefined)?.content as
            | string
            | undefined;
        if (typeof text === "string") {
          out += text;
          continue;
        }
      } catch {
        // ignore
      }
    }

    // Last-ditch fallback mirroring the gist exactly:
    const naive = payload.split('"');
    if (naive.length >= 2) out += naive[1];
  }
  return out;
}

export async function callMongoGpt(opts: CallMongoGptOpts): Promise<string> {
  const { url, token, model, messages, timeoutMs = 120_000 } = opts;
  if (!token) throw new Error("Missing MongoGPT token.");
  if (!url) throw new Error("Missing MongoGPT URL.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "X-Kanopy-Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, messages }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `MongoGPT HTTP ${res.status} ${res.statusText}: ${text.slice(0, 600)}`,
    );
  }

  const assistant = extractAssistantText(text, res.headers.get("content-type"));
  if (!assistant.trim()) {
    throw new Error(
      `MongoGPT returned no text content. Raw first 300 chars: ${text.slice(0, 300)}`,
    );
  }
  return assistant;
}

/**
 * Tool-aware MongoGPT call. Returns `{ content, toolCalls }` rather than a
 * bare string so the agent loop can detect tool invocations and dispatch
 * them. For reasoning models, we use `max_completion_tokens`; for others,
 * `max_tokens` + low temperature. Streaming responses (SSE) are buffered
 * and parsed for either text deltas or a synthesized tool_calls payload
 * (though tool calls on MongoGPT usually come back as a single JSON body).
 */
export async function callMongoGptTools(
  opts: CallMongoGptToolsOpts,
): Promise<MongoGptToolResponse> {
  const {
    url,
    token,
    model,
    messages,
    tools,
    toolChoice = "auto",
    temperature,
    maxTokens,
    timeoutMs = 180_000,
  } = opts;
  if (!token) throw new Error("Missing MongoGPT token.");
  if (!url) throw new Error("Missing MongoGPT URL.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const reasoning = isReasoningModel(model);
  const body: Record<string, unknown> = { model, messages };
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = toolChoice;
  }
  if (!reasoning && typeof temperature === "number") {
    body.temperature = temperature;
  }
  if (typeof maxTokens === "number") {
    body[reasoning ? "max_completion_tokens" : "max_tokens"] = maxTokens;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "X-Kanopy-Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `MongoGPT HTTP ${res.status} ${res.statusText}: ${text.slice(0, 600)}`,
    );
  }

  return extractToolResponse(text, res.headers.get("content-type"));
}

/**
 * Pull assistant text out of whichever response shape MongoGPT used.
 * Ordering:
 *   1. Whole-body JSON (OpenAI-style `choices[0].message.content`, or
 *      Anthropic-style `content[*].text`, or a bare `{content:"..."}`).
 *   2. SSE-style line stream (`data: "..."` chunks).
 *   3. Empty string (caller treats as error).
 */
function extractAssistantText(body: string, contentType: string | null): string {
  const isSse = (contentType ?? "").toLowerCase().includes("event-stream");

  if (!isSse) {
    const fromJson = tryExtractFromJson(body);
    if (fromJson) return fromJson;
  }

  // SSE path (or JSON parse failed / was missing expected fields).
  return parseMongoGptStream(body);
}

/**
 * Parse a tool-aware response. Two shapes:
 *   1. JSON body — `choices[0].message` carries `content` and `tool_calls`.
 *   2. SSE stream — OpenAI-style deltas; tool call fragments arrive under
 *      `choices[0].delta.tool_calls[]` keyed by `index`, with `arguments`
 *      streamed as partial JSON that must be concatenated per-index.
 */
function extractToolResponse(
  body: string,
  contentType: string | null,
): MongoGptToolResponse {
  const isSse = (contentType ?? "").toLowerCase().includes("event-stream");

  if (!isSse) {
    const trimmed = body.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const choices = parsed.choices as
          | Array<Record<string, unknown>>
          | undefined;
        const message = Array.isArray(choices) && choices.length > 0
          ? (choices[0]?.message as Record<string, unknown> | undefined)
          : undefined;
        if (message) {
          const content =
            typeof message.content === "string"
              ? (message.content as string)
              : "";
          const rawCalls = message.tool_calls;
          const toolCalls: MongoGptToolCall[] = [];
          if (Array.isArray(rawCalls)) {
            for (const c of rawCalls) {
              if (!c || typeof c !== "object") continue;
              const obj = c as Record<string, unknown>;
              const fn = obj.function as Record<string, unknown> | undefined;
              if (!fn || typeof fn.name !== "string") continue;
              const args =
                typeof fn.arguments === "string"
                  ? (fn.arguments as string)
                  : JSON.stringify(fn.arguments ?? {});
              toolCalls.push({
                id: typeof obj.id === "string" ? (obj.id as string) : `call_${toolCalls.length}`,
                type: "function",
                function: { name: fn.name as string, arguments: args },
              });
            }
          }
          return { content, toolCalls };
        }
        // Fall through to plain-text extraction if shape is unexpected.
      } catch {
        // Not JSON — fall through.
      }
    }
  }

  return aggregateSseToolResponse(body);
}

/**
 * Fold an SSE body into a `{ content, toolCalls }` pair. Handles both plain
 * text deltas (already covered by `parseMongoGptStream`) and OpenAI-style
 * tool_calls deltas that arrive in fragments keyed by `index`.
 */
function aggregateSseToolResponse(body: string): MongoGptToolResponse {
  let content = "";
  type PendingCall = {
    id?: string;
    name?: string;
    args: string;
  };
  const byIndex = new Map<number, PendingCall>();

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    if (!payload.startsWith("{")) {
      // fallback: string payloads only contribute to content
      if (payload.startsWith('"')) {
        try {
          const parsed = JSON.parse(payload);
          if (typeof parsed === "string") content += parsed;
        } catch {
          /* ignore */
        }
      }
      continue;
    }
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    const choices = obj.choices as Array<Record<string, unknown>> | undefined;
    const delta = Array.isArray(choices) && choices.length > 0
      ? (choices[0]?.delta as Record<string, unknown> | undefined)
      : undefined;
    if (delta && typeof delta.content === "string") {
      content += delta.content as string;
    }
    const toolDeltas = delta?.tool_calls as
      | Array<Record<string, unknown>>
      | undefined;
    if (Array.isArray(toolDeltas)) {
      for (const td of toolDeltas) {
        if (!td || typeof td !== "object") continue;
        const index = typeof td.index === "number" ? (td.index as number) : 0;
        const pending = byIndex.get(index) ?? { args: "" };
        if (typeof td.id === "string" && !pending.id) {
          pending.id = td.id as string;
        }
        const fn = td.function as Record<string, unknown> | undefined;
        if (fn) {
          if (typeof fn.name === "string" && !pending.name) {
            pending.name = fn.name as string;
          }
          if (typeof fn.arguments === "string") {
            pending.args += fn.arguments as string;
          }
        }
        byIndex.set(index, pending);
      }
    }
  }

  const toolCalls: MongoGptToolCall[] = [];
  for (const [index, p] of [...byIndex.entries()].sort((a, b) => a[0] - b[0])) {
    if (!p.name) continue;
    toolCalls.push({
      id: p.id ?? `call_${index}`,
      type: "function",
      function: { name: p.name, arguments: p.args || "{}" },
    });
  }

  return { content, toolCalls };
}

function tryExtractFromJson(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  // OpenAI-style: { choices: [{ message: { content } }] }
  const choices = obj.choices as
    | Array<Record<string, unknown>>
    | undefined;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] ?? {};
    const message = first.message as Record<string, unknown> | undefined;
    if (message && typeof message.content === "string") return message.content;
    const delta = first.delta as Record<string, unknown> | undefined;
    if (delta && typeof delta.content === "string") return delta.content;
    if (typeof first.text === "string") return first.text;
  }

  // Anthropic-style: { content: [{ type: "text", text: "..." }, ...] }
  const anthropic = obj.content;
  if (Array.isArray(anthropic)) {
    const pieces = anthropic
      .filter(
        (c): c is { type?: string; text?: string } =>
          !!c && typeof c === "object",
      )
      .map((c) => (typeof c.text === "string" ? c.text : ""))
      .filter((t) => t.length > 0);
    if (pieces.length) return pieces.join("");
  }

  // Bare shapes we've seen: { content: "..." } / { message: "..." } / { text: "..." }
  if (typeof obj.content === "string") return obj.content;
  if (typeof obj.message === "string") return obj.message;
  if (typeof obj.text === "string") return obj.text;
  if (typeof obj.response === "string") return obj.response;

  return null;
}
