# riskSi — Risk Register Report Generator

Standalone web app that orchestrates **Glean (MCP)**, **Monday.com (MCP)**,
and **Support Hub Auto Triage Chat** (human-in-the-loop) to draft internal
Risk Register Reports for customer accounts.

Extracted from the PremServ Chrome extension: the same `risk-assessment`
skill, Glean MCP integration, and Auto Triage prompts — rebuilt as a
browser-extension-free, deployable web app.

## What it does

Five-step wizard:

1. **Account Context** — name, motivation, timeframe, known concerns.
2. **Auto-Gather** — server-side proxy runs the Glean queries defined in
   the skill (engagement overview, CSM Slack, PS reports, post-mortems,
   JIRA links). Optionally calls a local Monday MCP for TAM account data.
3. **Auto Triage (human-in-the-loop)** — renders the three Auto Triage
   prompts (bulk case search, clustering, per-case deep dive) with copy
   buttons. User runs them in Support Hub Auto Triage Chat and pastes
   results back.
4. **Draft Report** — server-side LLM call (OpenAI or Anthropic)
   synthesizes everything into the exact Risk Register structure from the
   skill playbook.
5. **Review & Export** — live markdown preview + download as `.md`.

## Stack

- Next.js 15 (App Router) + React 19 + TypeScript
- Tailwind CSS for styling, `react-markdown` + `remark-gfm` for report preview
- Server-side MCP JSON-RPC client (adapted from `premserv-workspace/extension/src/tools/premserv-agent/mcp-manager.ts`)
- API routes at `/api/mcp` (MCP proxy) and `/api/generate` (LLM synthesis)

## Setup

```bash
cd /Users/r.sharma/Desktop/staff/riskSi
npm install
cp .env.example .env.local  # optional — all tokens can also be set in-app
npm run dev                 # http://localhost:4321
```

## Credentials

All credentials live in the **Settings** page and are stored only in
browser `localStorage`. They are sent with each API-route request and
never persisted server-side.

- **Glean** — Personal API token with MCP scopes from
  `https://mongodb-be.glean.com/settings/developer`.
- **Monday** (optional) — keep the parent `premserv-workspace` running its
  local Monday MCP on port `3001` and leave the default URL.
- **LLM** — OpenAI or Anthropic API key.

## Architecture

```
 Browser ────POST /api/mcp──▶  Next.js server ──JSON-RPC over HTTPS──▶  Glean MCP
                                                         └────────▶  Monday MCP (local)
 Browser ───POST /api/generate──▶ Next.js server ──HTTPS──▶ OpenAI / Anthropic
```

Auto Triage stays human-in-the-loop because the underlying Support Hub
Auto Triage Chat is only reachable from an authenticated `hub.corp.mongodb.com`
session — the same reason the parent extension renders prompts and waits
for the user to paste results back.

## Relation to PremServ

This app re-implements only the `risk-assessment` skill flow. The
original extension remains the right tool for in-page Support Hub
automation, multi-skill routing, and full MCP tool aggregation.

Files copied or adapted:

| New file | Source |
|----------|--------|
| `src/lib/mcp-client.ts` | `extension/src/tools/premserv-agent/mcp-manager.ts` |
| `src/lib/risk-skill.ts` | `extension/src/tools/premserv-agent/skills/operations/risk-assessment.md` |
| `src/app/api/mcp/route.ts` | glean-token injection logic from `mcp-manager.ts` |
