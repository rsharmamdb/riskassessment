/**
 * POST /api/mcp — legacy server-side MCP proxy kept for Glean static-token
 * calls. SSO-based calls go through the dedicated /api/glean/* routes.
 *
 * Body: { server: "glean", tool: string, args: Record<string, unknown>,
 *         token?: string, url?: string }
 */

import { NextResponse } from "next/server";
import { callMcpTool } from "@/lib/mcp-client";
import type { MCPServerConfig } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  server: "glean";
  tool: string;
  args?: Record<string, unknown>;
  token?: string;
  url?: string;
}

function resolveServer(body: Body): MCPServerConfig {
  if (body.server === "glean") {
    const url =
      body.url || process.env.GLEAN_MCP_URL || "https://mongodb-be.glean.com/mcp/default";
    const token = body.token || process.env.GLEAN_API_TOKEN || "";
    if (!token) {
      throw new Error(
        "Glean token missing. Add a Glean MCP token in Settings or set GLEAN_API_TOKEN.",
      );
    }
    return {
      id: "glean",
      name: "Glean",
      url,
      headers: { Authorization: `Bearer ${token}` },
    };
  }

  throw new Error(`Unknown MCP server: ${body.server}`);
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.server || !body.tool) {
    return NextResponse.json(
      { error: "Missing required fields: server, tool" },
      { status: 400 },
    );
  }

  try {
    const server = resolveServer(body);
    const result = await callMcpTool(server, body.tool, body.args ?? {});
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
