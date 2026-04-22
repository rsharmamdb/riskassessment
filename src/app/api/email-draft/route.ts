/**
 * POST /api/email-draft
 * Generates a 3-paragraph stakeholder email from the top risks of a report.
 * Body: { accountName, risks: ParsedRisk[], mongogptUrl?, model? }
 */
import { NextResponse } from "next/server";
import { callMongoGpt } from "@/lib/mongogpt";
import { resolveMongoGptMessagesUrl } from "@/lib/mongogpt-url";
import { getValidToken } from "@/lib/mongogpt-token";
import type { ParsedRisk } from "@/lib/parse-risks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const { accountName, risks, mongogptUrl, model } = (await req.json()) as {
      accountName: string;
      risks: ParsedRisk[];
      mongogptUrl?: string;
      model?: string;
    };

    if (!accountName || !risks?.length) {
      return NextResponse.json({ ok: false, error: "Missing accountName or risks" }, { status: 400 });
    }

    const resolvedModel = model || process.env.MONGOGPT_MODEL || "";
    if (!resolvedModel) {
      return NextResponse.json({ ok: false, error: "No MongoGPT model configured" }, { status: 400 });
    }

    const topRisks = risks
      .filter((r) => r.status !== "Mitigated")
      .slice(0, 3)
      .map((r, i) => `${i + 1}. [${r.severity}] ${r.title}`)
      .join("\n");

    const url = resolveMongoGptMessagesUrl(mongogptUrl);
    const token = await getValidToken();

    const draft = await callMongoGpt({
      url,
      token: token.token,
      model: resolvedModel,
      messages: [
        {
          role: "system",
          content:
            "You are a MongoDB Technical Services engineer writing an internal summary email for the Account Executive to send to the customer. " +
            "Write exactly 3 short paragraphs: (1) what you reviewed and when, (2) the top risks and their business impact (no jargon, no case numbers), " +
            "(3) the proposed next step. Keep it under 200 words. Professional but warm tone. Do not mention MongoDB internal tooling.",
        },
        {
          role: "user",
          content: `Account: ${accountName}\n\nTop open risks:\n${topRisks}\n\nDraft the email now.`,
        },
      ],
      timeoutMs: 60_000,
    });

    return NextResponse.json({ ok: true, draft });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
}
