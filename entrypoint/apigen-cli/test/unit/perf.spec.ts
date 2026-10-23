/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `perf.e2e.ts`.
 *
 * Resource lane: cpu, mem — it builds full TypeScript programs repeatedly and measures heap flatness.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer pays for
 * it. This file spawns nothing, embeds nothing, binds no port, and does no
 * real extraction; it exists so the future MOCKED unit-test version of this
 * suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real case in
 * `perf.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess, a port, or the real extraction pipeline.
 *
 * NOTE: The real file is currently `describe.skip`’d (CPU-THRASH-SKIP, owner-requested); it is retained here because a dedicated, explicitly-invoked lane is exactly the "serial lane" its own comment names as the durable fix.
 */
import { describe, it } from 'vitest';

describe('mocked: perf', () => {
  it.todo("mocked: repeated runs return deep-equal descriptors (cache changes nothing observable)");
  it.todo("mocked: heap stays flat across repeated runs (no per-run Project/generator leak)");
  it.todo("mocked: warm runs are near-free (persistent tier reused across runs)");
});
