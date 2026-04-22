/**
 * Minimal server-side MCP (Model Context Protocol) JSON-RPC client.
 *
 * Adapted from the PremServ extension's mcp-manager, stripped of
 * chrome.* dependencies and simplified for a single request/response
 * pattern behind a Next.js API route. Each call opens a short-lived
 * session (initialize -> notifications/initialized -> tools/call).
 */

import type { MCPServerConfig, MCPToolCallResult } from "./types";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const PROTOCOL_VERSION = "2024-11-05";

let requestCounter = 1;

function parseSSE(text: string): JsonRpcResponse {
  let last: string | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) last = line.slice(6);
  }
  if (!last) throw new Error("MCP SSE response missing data field");
  return JSON.parse(last);
}

async function send(
  server: MCPServerConfig,
  method: string,
  params: Record<string, unknown> | undefined,
  sessionId: string | null,
  captureSession: boolean,
): Promise<{ response: JsonRpcResponse; sessionId: string | null }> {
  const req: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: requestCounter++,
    method,
    ...(params ? { params } : {}),
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(server.headers ?? {}),
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);

  try {
    const res = await fetch(server.url, {
      method: "POST",
      headers,
      body: JSON.stringify(req),
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `MCP HTTP ${res.status} ${res.statusText} from ${server.name}: ` +
          text.slice(0, 300),
      );
    }

    const contentType = res.headers.get("content-type") ?? "";
    let parsed: JsonRpcResponse;
    if (contentType.includes("text/event-stream")) {
      parsed = parseSSE(text);
    } else {
      try {
        parsed = JSON.parse(text);
      } catch {
        if (text.includes("data: ")) parsed = parseSSE(text);
        else
          throw new Error(
            `Unexpected MCP response from ${server.name}: ${text.slice(0, 200)}`,
          );
      }
    }

    const nextSession = captureSession
      ? res.headers.get("mcp-session-id") ?? sessionId
      : sessionId;
    return { response: parsed, sessionId: nextSession };
  } finally {
    clearTimeout(timer);
  }
}

async function sendNotification(
  server: MCPServerConfig,
  method: string,
  sessionId: string | null,
): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(server.headers ?? {}),
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  await fetch(server.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", method }),
  }).catch(() => {
    /* notifications are fire-and-forget */
  });
}

/**
 * Execute a single tool call against an MCP server. Handles the full
 * initialize -> notify -> call handshake, then returns the tool result.
 */
export async function callMcpTool(
  server: MCPServerConfig,
  toolName: string,
  args: Record<string, unknown>,
): Promise<MCPToolCallResult> {
  const init = await send(
    server,
    "initialize",
    {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "risksi", version: "0.1.0" },
    },
    null,
    true,
  );

  if (init.response.error) {
    throw new Error(
      `MCP initialize failed for ${server.name}: ${init.response.error.message}`,
    );
  }

  await sendNotification(server, "notifications/initialized", init.sessionId);

  const call = await send(
    server,
    "tools/call",
    { name: toolName, arguments: args },
    init.sessionId,
    false,
  );

  if (call.response.error) {
    throw new Error(
      `MCP tool '${toolName}' failed on ${server.name}: ${call.response.error.message}`,
    );
  }

  return (call.response.result ?? {}) as MCPToolCallResult;
}

/**
 * List available tools on a server — useful for connectivity checks.
 */
export async function listMcpTools(server: MCPServerConfig): Promise<unknown> {
  const init = await send(
    server,
    "initialize",
    {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "risksi", version: "0.1.0" },
    },
    null,
    true,
  );
  if (init.response.error) {
    throw new Error(
      `MCP initialize failed for ${server.name}: ${init.response.error.message}`,
    );
  }
  await sendNotification(server, "notifications/initialized", init.sessionId);

  const list = await send(server, "tools/list", {}, init.sessionId, false);
  if (list.response.error) throw new Error(list.response.error.message);
  return list.response.result;
}
