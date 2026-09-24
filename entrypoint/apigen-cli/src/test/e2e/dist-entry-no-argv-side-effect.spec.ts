/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `dist-entry-no-argv-side-effect.e2e.ts`.
 *
 * Resource lane: proc — it spawns the built `dist/index.js` / `dist/index.mjs` as real `node` child processes.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer pays for
 * it. This file spawns nothing, embeds nothing, binds no port, and does no
 * real extraction; it exists so the future MOCKED unit-test version of this
 * suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real case in
 * `dist-entry-no-argv-side-effect.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess, a port, or the real extraction pipeline.
 */
import { describe, it } from 'vitest';

describe('mocked: dist-entry-no-argv-side-effect', () => {
  it.todo("mocked: require()ing the built CJS entry with ambient argv does NOT dispatch to commander");
  it.todo("mocked: dynamically import()ing the built ESM entry does not throw or dispatch");
  it.todo("mocked: invoking the built bin directly as the real process entry point still works (--version)");
});
