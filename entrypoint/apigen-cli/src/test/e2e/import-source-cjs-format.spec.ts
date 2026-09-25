/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `import-source-cjs-format.e2e.ts`.
 *
 * Resource lane: proc — it spawns the built `dist/index.js` as a real `node` child (a verifiable CJS require path).
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer pays for
 * it. This file spawns nothing, embeds nothing, binds no port, and does no
 * real extraction; it exists so the future MOCKED unit-test version of this
 * suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real case in
 * `import-source-cjs-format.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess, a port, or the real extraction pipeline.
 */
import { describe, it } from 'vitest';

describe('mocked: import-source-cjs-format', () => {
  it.todo("mocked: resolves the sibling .ts module instead of crashing with MODULE_NOT_FOUND");
});
