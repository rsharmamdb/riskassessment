/**
 * Server-side fetch dispatcher tuned for long-running LLM calls.
 *
 * Node's built-in fetch uses undici under the hood with a default
 * `headersTimeout` of 300s and `bodyTimeout` of 300s. MongoGPT / Anthropic
 * / OpenAI synthesis of a 30+ artifact Risk Register routinely runs 3–8
 * minutes — the default timeouts produce bare `fetch failed` errors that
 * look like network flakes but are really silent server-side aborts.
 *
 * Setting a global undici dispatcher lifts those ceilings to 10 minutes
 * (600_000 ms), matching each API route's `maxDuration`. This module is
 * imported for side effects by any server-side file that does fetch() to
 * an LLM provider.
 */

import { setGlobalDispatcher, Agent } from "undici";

const TEN_MINUTES = 600_000;

// Keep a module-level flag so importing from multiple places is a no-op.
let _applied = false;

export function applyLongTimeoutDispatcher(): void {
  if (_applied) return;
  setGlobalDispatcher(
    new Agent({
      // Seconds the server has to send the first byte of the response.
      headersTimeout: TEN_MINUTES,
      // Seconds between body chunks; tolerates a slow-streaming LLM response.
      bodyTimeout: TEN_MINUTES,
      // TCP connect ceiling; leave modest.
      connect: { timeout: 30_000 },
    }),
  );
  _applied = true;
}

// Eager side-effect so a bare `import "@/lib/server-fetch-agent"` is enough.
applyLongTimeoutDispatcher();
