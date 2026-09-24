/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `ir-cache.perf.e2e.ts`.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer spawns
 * subprocesses or loads the real fastembed embedding model. This file spawns
 * nothing and embeds nothing; it exists so the future MOCKED unit-test version
 * of this suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real
 * case in `ir-cache.perf.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess or a real model.
 */
import { describe, it } from 'vitest';

describe("mocked: ir-cache.perf", () => {
  it.todo("mocked: a warm cache HIT is measurably (>=3x) faster than a live/disabled-cache run, real numbers");
});
