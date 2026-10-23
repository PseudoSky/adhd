/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `ts-types.e2e.ts`.
 *
 * Resource lane: proc — it spawns the built `dist/index.js` and esbuild-compiles the emitted files.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer pays for
 * it. This file spawns nothing, embeds nothing, binds no port, and does no
 * real extraction; it exists so the future MOCKED unit-test version of this
 * suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real case in
 * `ts-types.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess, a port, or the real extraction pipeline.
 */
import { describe, it } from 'vitest';

describe('mocked: ts-types', () => {
  it.todo("mocked: list-types lists ts-types as a generate-only target");
  it.todo("mocked: generate --type ts-types writes per-fn TS type files that esbuild-compile; union proven; negative control");
});
