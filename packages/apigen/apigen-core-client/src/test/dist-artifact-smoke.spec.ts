/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `dist-artifact-smoke.e2e.ts`.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer spawns a child process that loads the shipped dist/index.mjs (measured ~3.9s / 2 cases).
 * This file spawns nothing and imports no built artifact; it exists so the future MOCKED unit-test version
 * of this suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real
 * case in `dist-artifact-smoke.e2e.ts`); they are the contract a mocked version must
 * satisfy without spawning a subprocess or loading the built artifact.
 *
 * Resource lane: proc.
 */
import { describe, it } from 'vitest';

describe("mocked: dist-artifact-smoke", () => {
  it.todo("mocked: calls collectLocalImportPaths (getProjectCtor) + extract (getTsjsg) through dist/index.mjs");
  it.todo("mocked: teeth: a bare `require` in an ESM artifact throws ReferenceError (the pre-fix failure)");
});
