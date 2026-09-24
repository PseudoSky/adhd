/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `search-shortcut-wire.e2e.ts`.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer spawns
 * subprocesses or loads the real fastembed embedding model. This file spawns
 * nothing and embeds nothing; it exists so the future MOCKED unit-test version
 * of this suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real
 * case in `search-shortcut-wire.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess or a real model.
 *
 * Resource lane: proc — spawns the built dist/index.js as a child process.
 */
import { describe, it } from 'vitest';

describe("mocked: search-shortcut-wire", () => {
  it.todo("mocked: --repo, --tag, --family are no longer advertised — the surface stops offering a capability that does not exist");
  it.todo("mocked: --plan reaches the real mounted schema (no additionalProperty rejection) and returns exactly the part_of member");
  it.todo("mocked: --project-path reaches the real mounted schema and returns exactly the matching component's issue");
});
