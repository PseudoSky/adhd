/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `api.surface.e2e.ts`.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer pays for
 * the real ts-morph extraction pass (and the ~1 GB the TypeScript compiler it
 * loads costs). This file consumes nothing; it exists so the future MOCKED
 * unit-test version of this suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real
 * case in `api.surface.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess or a real model.
 *
 * Resource lane: cpu, mem — three real `extract()` (ts-morph) passes over the
 * built `dist/api.d.ts`; 7.9s in the 20260924T030419Z default-lane timing log
 * (18.8s in the worktree log 20260924T033419Z) and a measured ~1.04 GB peak
 * RSS vs ~300 MB for a non-extractor spec.
 */
import { describe, it } from 'vitest';

describe("mocked: api.surface", () => {
  it.todo("mocked: has a built api.d.ts to extract from");
  it.todo("mocked: mounts exactly the verbs SPEC §6.7 names, under the names it names");
  it.todo("mocked: mounts `delete` under its spec'd name — the export alias is load-bearing");
  it.todo("mocked: mounts no verb twice and no verb outside the list");
});
