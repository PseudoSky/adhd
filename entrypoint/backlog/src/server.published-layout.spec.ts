/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `server.published-layout.e2e.ts`.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer spawns
 * subprocesses or loads the real fastembed embedding model. This file spawns
 * nothing and embeds nothing; it exists so the future MOCKED unit-test version
 * of this suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real
 * case in `server.published-layout.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess or a real model.
 *
 * Resource lane: proc — spawns the built dist/index.js as a child process.
 */
import { describe, it } from 'vitest';

describe("mocked: server.published-layout", () => {
  it.todo("mocked: mounts via the built bin when index.js and client.d.ts are siblings at the package root (npm publish <distDir> shape)");
  it.todo("mocked: \"version\" reports the real, currently-built package.json name/version in the published (rebased-to-root) layout too");
});
