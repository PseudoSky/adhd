/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `acked-write-durability.e2e.ts`.
 *
 * It was moved there (never in the default lane) because it spawns 5 real
 * `serve --transport mcp` child processes, SIGKILLs them, and reopens the
 * store from a fresh process — a `proc`-lane resource hog that must not run
 * under `nx affected -t test` / the pre-commit + pre-push hooks. This file
 * spawns nothing and opens nothing; it exists so a future MOCKED unit-test
 * version of the durability assertion has a home the default target picks up.
 *
 * Resource lane: proc — 5 concurrently-running `serve` child processes against
 * the same store, killed without a clean close, then a fresh reopen.
 */
import { describe, it } from 'vitest';

describe('mocked: acked-write-durability (multi-holder)', () => {
  it.todo(
    'mocked: 5 concurrently-live MCP holders against one store; all concurrent backlog_create calls acked; SIGKILL (no clean close); fresh reopen finds exactly the acked count'
  );
  it.todo(
    'mocked CONTROL: discarding the crash-time WAL drops acknowledged writes below the acked count (assertion has teeth)'
  );
});
