/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `ir-cache.integration.e2e.ts`.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer spawns
 * subprocesses or loads the real fastembed embedding model. This file spawns
 * nothing and embeds nothing; it exists so the future MOCKED unit-test version
 * of this suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real
 * case in `ir-cache.integration.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess or a real model.
 */
import { describe, it } from 'vitest';

describe("mocked: ir-cache.integration", () => {
  it.todo("mocked: --help run 1 MISSes and writes one entry; run 2 HITs (no re-extraction); mtime-touch still HITs (content-addressed key)");
  it.todo("mocked: APIGEN_IR_CACHE_ENABLED=0 disables caching entirely — no cache file is ever created");
});
