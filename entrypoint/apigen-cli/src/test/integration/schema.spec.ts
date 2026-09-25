/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `schema.e2e.ts`.
 *
 * Resource lane: cpu — it runs real ts-morph extraction over the real-api fixture (~15s of pure CPU).
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer pays for
 * it. This file spawns nothing, embeds nothing, binds no port, and does no
 * real extraction; it exists so the future MOCKED unit-test version of this
 * suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real case in
 * `schema.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess, a port, or the real extraction pipeline.
 */
import { describe, it } from 'vitest';

describe('mocked: schema', () => {
  it.todo("mocked: excludes ctx from every generated param schema (getUser has `ctx` first param)");
  it.todo("mocked: adds session to getUser but suppresses session on ping via { ping: { session: false } } override");
});
