/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `vocabulary-gate.e2e.ts`.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer spawns
 * subprocesses or loads the real fastembed embedding model. This file spawns
 * nothing and embeds nothing; it exists so the future MOCKED unit-test version
 * of this suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real
 * case in `vocabulary-gate.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess or a real model.
 */
import { describe, it } from 'vitest';

describe("mocked: vocabulary-gate", () => {
  it.todo("mocked: exits 0 on a clean fixture");
  it.todo("mocked: exits 1 and names the file on a fixture carrying a banned token");
  it.todo("mocked: exempts a `<token>.db` data-file name but still fails bare <token> prose");
  it.todo("mocked: exits 1 and names the file when a packed dist/ carries a banned token");
  it.todo("mocked: exits 2 — never 0 — when the packed tarball has no dist/**/*.d.ts");
  it.todo("mocked: exempts a packed `<token>.db` data-file name but still fails bare <token> prose");
  it.todo("mocked: the embedding-usage gate (tools/gate/embedding-usage-gate.mjs) exits 0 — every embedding-touching spec is a declared real-by-design or faked file");
});
