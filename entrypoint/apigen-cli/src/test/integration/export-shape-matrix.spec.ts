/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `export-shape-matrix.e2e.ts`.
 *
 * Resource lane: cpu — it runs real ts-morph extraction over six export-shape fixtures (~39s of pure CPU).
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer pays for
 * it. This file spawns nothing, embeds nothing, binds no port, and does no
 * real extraction; it exists so the future MOCKED unit-test version of this
 * suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real case in
 * `export-shape-matrix.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess, a port, or the real extraction pipeline.
 */
import { describe, it } from 'vitest';

describe('mocked: export-shape-matrix', () => {
  it.todo("mocked: named exports: op leaf name == exported declaration name");
  it.todo("mocked: renamed exports: op leaf name == EXPORTED alias, never the local declaration name");
  it.todo("mocked: default-exported named function: op leaf name == declaration name (greet)");
  it.todo("mocked: default object: op leaf names == object keys (sum, product)");
  it.todo("mocked: anonymous default: op leaf name == \"default\" (matches the runtime .name)");
  it.todo("mocked: cjs source: op leaf names == module.exports keys (toUpper, repeat)");
  it.todo("mocked: every shape projects to a UNIQUE id (no two ops share an id)");
});
