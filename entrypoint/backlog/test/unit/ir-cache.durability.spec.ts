/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `ir-cache.durability.e2e.ts`, which SPAWNS the built `dist/index.js`,
 * SIGKILLs it on the first stdout byte, and asserts the runtime-cache entry is
 * nonetheless complete and durable. It was moved there so the default `test`
 * target — and therefore `nx affected -t test` / the pre-commit + pre-push
 * hooks — no longer spawns and kills subprocesses.
 *
 * The DETERMINISTIC durability teeth that DO run by default live one package
 * down, where the awaited/durable contract is implemented and unit-proven:
 *   - `@adhd/apigen-plugin-ir-cache`'s `src/lib/ir-cache-layer.spec.ts` — a
 *     LATCHED `rename` proves the layer AWAITS `put` on the MISS path (a
 *     fire-and-forget regression does not resolve early).
 *   - its `src/lib/atomic-write-json.spec.ts` — proves the fsync-before-rename
 *     ORDERING that makes a successful write complete when `put` resolves.
 * This stub exists so the e2e's cases have a home the default target picks up,
 * and inventories what only the real-spawn e2e can prove.
 *
 * Resource lane: proc — spawns + SIGKILLs the built dist/index.js.
 */
import { describe, it } from 'vitest';

describe('mocked: ir-cache.durability', () => {
  it.todo(
    "mocked: a SIGKILL right after the first stdout byte still leaves a complete, valid cache entry (the MISS write was awaited and fsync'd before stdout)"
  );
  it.todo(
    'mocked: a respawn against the same cache is a HIT — no put, so the entry mtime is unchanged'
  );
});
