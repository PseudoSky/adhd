/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `cli-envelope.e2e.ts`.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer spawns
 * subprocesses or loads the real fastembed embedding model. This file spawns
 * nothing and embeds nothing; it exists so the future MOCKED unit-test version
 * of this suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real
 * case in `cli-envelope.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess or a real model.
 */
import { describe, it } from 'vitest';

describe("mocked: cli-envelope", () => {
  it.todo("mocked: a successful create returns its data, not a bare {ok:true}");
  it.todo("mocked: a successful get returns a real card — never a codec envelope");
  it.todo("mocked: a successful query returns its real, un-collapsed items — never a bare {ok:true}");
  it.todo("mocked: a reported item_not_found exits 1, not 0");
  it.todo("mocked: a validation failure exits 2");
  it.todo("mocked: a successful call still exits 0");
  it.todo("mocked: an unknown command exits 4");
});
