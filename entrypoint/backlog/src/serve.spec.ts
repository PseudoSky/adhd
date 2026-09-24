/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `serve.e2e.ts`.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer spawns
 * subprocesses or loads the real fastembed embedding model. This file spawns
 * nothing and embeds nothing; it exists so the future MOCKED unit-test version
 * of this suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real
 * case in `serve.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess or a real model.
 *
 * Resource lane: proc — spawns the built bin's `serve` as a real MCP stdio child process.
 */
import { describe, it } from 'vitest';

describe("mocked: serve", () => {
  it.todo("mocked: starts a real MCP stdio server via `serve --transport mcp`; tools/list + a real create/get round-trip work");
  it.todo("mocked: BUG-033: `serve --help` prints usage and exits 0 — never a raw unhandled-exception stack trace");
  it.todo("mocked: rejects an unknown --transport value rather than silently defaulting");
});
