/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `java-ts-decimal-parity.e2e.ts`.
 *
 * Resource lane: proc — it spawns real `node` + `java`/`mvn`/`javac` JVM processes.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer pays for
 * it. This file spawns nothing, embeds nothing, binds no port, and does no
 * real extraction; it exists so the future MOCKED unit-test version of this
 * suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real case in
 * `java-ts-decimal-parity.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess, a port, or the real extraction pipeline.
 *
 * NOTE: The real file is currently `describe.skip`’d (CPU-THRASH-SKIP, owner-requested); it is retained here because the e2e lane is its correct home.
 */
import { describe, it } from 'vitest';

describe('mocked: java-ts-decimal-parity', () => {
  it.todo("mocked: byte-identical decimal wire form for the same input value across TS and Java hosts");
  it.todo("mocked: [TEETH] negative control: decimal wire must be a JSON string, never a bare number");
});
