/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `paging-wire.e2e.ts`.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer spawns
 * subprocesses or loads the real fastembed embedding model. This file spawns
 * nothing and embeds nothing; it exists so the future MOCKED unit-test version
 * of this suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real
 * case in `paging-wire.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess or a real model.
 *
 * Resource lane: proc — spawns the built dist/index.js as a child process.
 */
import { describe, it } from 'vitest';

describe("mocked: paging-wire", () => {
  it.todo("mocked: a terminal page ENCODES hasMore:false — the field is present, not omitted");
  it.todo("mocked: a non-terminal page ENCODES hasMore:true and a usable nextCursor");
  it.todo("mocked: feeding nextCursor back as after walks every issue exactly once, in insertion order");
});
