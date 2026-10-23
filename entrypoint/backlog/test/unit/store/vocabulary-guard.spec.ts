/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `vocabulary-guard.e2e.ts`.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer pays for
 * its heavy real-store fixture. This file consumes nothing; it exists so the
 * future MOCKED unit-test version of this suite has a home that the default
 * target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real
 * case in `vocabulary-guard.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess or a real model.
 *
 * Resource lane: cpu — a 200-node `seedRecognizedNode` fixture loop
 * (`vocabulary-guard.e2e.ts:283`, the bounded-probe "LARGE healthy store"
 * case) plus real-store opens per test; 3.2s in the 20260924T030419Z
 * default-lane timing log (4.2s in the worktree log 20260924T033419Z).
 */
import { describe, it } from 'vitest';

describe("mocked: vocabulary-guard", () => {
  it.todo("mocked: passes on an empty store (a fresh store legitimately has no items)");
  it.todo("mocked: passes on a store holding only recognized catalog rows (item-empty ≠ unrecognized)");
  it.todo("mocked: throws on a store whose live nodes are ENTIRELY foreign, naming expected + observed");
  it.todo("mocked: rejects through the guard instead of returning {ok:true,total:0}");
  it.todo("mocked: succeeds normally against a store that holds the expected vocabulary");
  it.todo("mocked: refuses to open a foreign-vocabulary store (fails loud, does not serve emptiness)");
  it.todo("mocked: opens a store that holds the expected vocabulary");
  it.todo("mocked: short-circuits on a LARGE healthy store: exactly one statement, a LIMIT-1 probe, no histogram");
  it.todo("mocked: falls back to the histogram only when no recognized node exists — and throws with it");
  it.todo("mocked: pays the histogram for an EMPTY store (no recognized node) but still passes");
});
