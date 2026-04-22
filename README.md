# riskSi — Risk Register Report Generator

Standalone web app that orchestrates **Glean (MCP)**, **Monday.com (MCP)**,
and **Support Hub Auto Triage Chat** (human-in-the-loop) to draft internal
Risk Register Reports for customer accounts.

## What it does

Five-step wizard:

1. **Account Context** — name, motivation, timeframe, known concerns.
2. **Auto-Gather** — server-side proxy runs the Glean queries defined in
   the skill (engagement overview, CSM Slack, PS reports, post-mortems,
   JIRA links). Optionally calls a local Monday MCP for account data.
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
- Server-side MCP JSON-RPC client
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
- **Monday** (optional) — point to a local Monday MCP on port `3001`
  (default URL) or your own deployment.
- **LLM** — OpenAI or Anthropic API key.

## Architecture

```
 Browser ────POST /api/mcp──▶  Next.js server ──JSON-RPC over HTTPS──▶  Glean MCP
                                                         └────────▶  Monday MCP (local)
 Browser ───POST /api/generate──▶ Next.js server ──HTTPS──▶ OpenAI / Anthropic
```

Auto Triage stays human-in-the-loop because the underlying Support Hub
Auto Triage Chat is only reachable from an authenticated `hub.corp.mongodb.com`
session, so prompts are rendered for the user to run and paste results
back.
