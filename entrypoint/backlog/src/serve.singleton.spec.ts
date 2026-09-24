/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `serve.singleton.e2e.ts`.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer spawns
 * subprocesses or loads the real fastembed embedding model. This file spawns
 * nothing and embeds nothing; it exists so the future MOCKED unit-test version
 * of this suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real
 * case in `serve.singleton.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess or a real model.
 *
 * Resource lane: proc — two concurrently-running `serve` child processes against the same store.
 */
import { describe, it } from 'vitest';

describe("mocked: serve.singleton", () => {
  it.todo("mocked: GREEN: two REAL, simultaneously-live \\`serve --transport mcp\\` processes against the SAME store each fire ${N_PER_WRITER} concurrent backlog_create calls (${ N_PER_WRITER * 2 } total, no lock coordinating them); both stay up and answering throughout, and a fresh reopen finds exactly the number of writes reported ok:true");
});
