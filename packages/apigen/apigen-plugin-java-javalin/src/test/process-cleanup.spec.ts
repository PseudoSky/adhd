/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `process-cleanup.e2e.ts`.
 *
 * Resource lane: proc — it spawns a real `tsx` child Node process which spawns
 * a real Javalin `java` server, sends it a real `SIGTERM`, and verifies via
 * `pgrep`/`ps` that the JVM child was reaped.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer pays for
 * it. The `it.todo` entry below inventories the moved case (the one real case
 * in `process-cleanup.e2e.ts`); it is the contract a mocked version must
 * satisfy without spawning a subprocess or signalling a real PID.
 */
import { describe, it } from 'vitest';

describe('mocked: java-javalin plugin — process-lifecycle hygiene (BUG-006 regression)', () => {
  it.todo(
    'mocked: SIGTERM to the parent process kills the orphaned JVM child within the grace period'
  );
});
