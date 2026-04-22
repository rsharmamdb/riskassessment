/**
 * POST /api/mongogpt/models — proxy to MongoGPT's model-list endpoint.
 *
 * Body: { url?: string, token: string }
 *
 * Derives the models URL from the chat URL:
 *   https://…/api/v1/messages  →  https://…/api/v1/models
 * If the chat URL does not end with `/messages` we try appending `/models`
 * to the same path as a fallback.
 *
 * Accepted response shapes (OpenAI-compatible or variants):
 *   { data: [{ id: "gpt-4o" }, …] }
 *   { models: ["gpt-4o", …] }       or { models: [{ id: "…" }, …] }
 *   ["gpt-4o", …]                    or [{ id: "…" }, …]
 */

import { NextResponse } from "next/server";
import { getValidToken, invalidateToken } from "@/lib/mongogpt-token";
import { resolveMongoGptModelsUrl } from "@/lib/mongogpt-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 200;

interface Body {
  url?: string;
  /** Optional override; when omitted the server uses its cached token. */
  token?: string;
}

function coerceToIds(body: unknown): string[] {
  const pickId = (item: unknown): string | null => {
    if (typeof item === "string") return item;
    if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      if (typeof o.id === "string") return o.id;
      if (typeof o.name === "string") return o.name;
      if (typeof o.model === "string") return o.model;
    }
    return null;
  };

  const fromArray = (arr: unknown[]): string[] =>
    arr
      .map(pickId)
      .filter((s): s is string => !!s)
      .filter((s, i, a) => a.indexOf(s) === i)
      .sort();

  if (Array.isArray(body)) return fromArray(body);
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    if (Array.isArray(obj.data)) return fromArray(obj.data);
    if (Array.isArray(obj.models)) return fromArray(obj.models);
  }
  return [];
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const modelsUrl = resolveMongoGptModelsUrl(
    body.url || process.env.MONGOGPT_URL,
  );

  let token: string;
  try {
    token = body.token || (await getValidToken()).token;
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `Could not resolve MongoGPT token: ${(err as Error).message}` },
      { status: 502 },
    );
  }

  try {
    const doFetch = (bearer: string) =>
      fetch(modelsUrl, {
        method: "GET",
        headers: {
          "X-Kanopy-Authorization": `Bearer ${bearer}`,
          Accept: "application/json",
        },
      });

    let res = await doFetch(token);
    let text = await res.text();

    // Auto-refresh on unauthorized / forbidden and retry once.
    if (!body.token && (res.status === 401 || res.status === 403)) {
      invalidateToken();
      const refreshed = await getValidToken({ force: true });
      token = refreshed.token;
      res = await doFetch(token);
      text = await res.text();
    }

    if (!res.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: `MongoGPT HTTP ${res.status} ${res.statusText} at ${modelsUrl}: ${text.slice(0, 400)}`,
        },
        { status: 502 },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return NextResponse.json(
        {
          ok: false,
          error: `MongoGPT returned non-JSON at ${modelsUrl}. First 200 chars: ${text.slice(0, 200)}`,
        },
        { status: 502 },
      );
    }

    const models = coerceToIds(parsed);
    if (models.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          error: `Could not parse a model list from ${modelsUrl}. Response shape: ${Object.keys((parsed as object) ?? {}).join(", ") || "(scalar)"}.`,
        },
        { status: 502 },
      );
    }

    return NextResponse.json({ ok: true, models, resolvedUrl: modelsUrl });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
