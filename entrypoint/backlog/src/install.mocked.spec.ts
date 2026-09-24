/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `install.e2e.ts`.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer spawns
 * subprocesses or loads the real fastembed embedding model. This file spawns
 * nothing and embeds nothing; it exists so the future MOCKED unit-test version
 * of this suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real
 * case in `install.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess or a real model.
 *
 * Resource lane: proc — spawns the built dist/index.js as a child process.
 */
import { describe, it } from 'vitest';

describe("mocked: install", () => {
  it.todo("mocked: the exact args install.ts writes are the intended portable npx invocation (assertion on the config content itself, before ever spawning anything)");
  it.todo("mocked: claude-style config: spawning the real dist/index.js serve --transport mcp (the local stand-in for the written npx invocation) advertises all 7 real tools");
  it.todo("mocked: opencode-style config: spawning the real dist/index.js via the written command ARRAY shape advertises the real tool set");
});
