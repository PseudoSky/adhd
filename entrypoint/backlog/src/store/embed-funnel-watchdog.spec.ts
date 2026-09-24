/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `embed-funnel-watchdog.e2e.ts`.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer spawns
 * subprocesses or loads the real fastembed embedding model. This file spawns
 * nothing and embeds nothing; it exists so the future MOCKED unit-test version
 * of this suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real
 * case in `embed-funnel-watchdog.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess or a real model.
 *
 * Resource lane: proc — spawns the embedding-funnel consumer child process.
 */
import { describe, it } from 'vitest';

describe("mocked: embed-funnel-watchdog", () => {
  it.todo("mocked: a consumer exits on its own when its absolute lifetime bound expires — no parent signal");
  it.todo("mocked: a consumer exits when its owning process dies, long before its lifetime bound");
});
