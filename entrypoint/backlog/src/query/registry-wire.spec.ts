/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `registry-wire.e2e.ts`.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer spawns
 * subprocesses or loads the real fastembed embedding model. This file spawns
 * nothing and embeds nothing; it exists so the future MOCKED unit-test version
 * of this suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real
 * case in `registry-wire.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess or a real model.
 */
import { describe, it } from 'vitest';

describe("mocked: registry-wire", () => {
  it.todo("mocked: view:\"projects\" returns the seeded projects, full field set survives encoding");
  it.todo("mocked: view:\"components\" UNFILTERED returns components from BOTH seeded projects");
  it.todo("mocked: view:\"components\" scoped by filter.project returns ONLY that project\\'s components");
  it.todo("mocked: view:\"locations\" returns the seeded tool + path locations, scoped by filter.component");
  it.todo("mocked: get{registry:\"project\",...} returns path, repoUrl, and its linked locations[]+components[] — full field set survives encoding");
  it.todo("mocked: get{registry:\"component\",...} returns its owning project object and locations[]");
  it.todo("mocked: get{registry:\"component\", name:\"(root)\", filter:{project:...}} resolves to the SAME project\\'s (root) — not the other project\\'s namesake (AC-23 collision, AC-11 scoping)");
  it.todo("mocked: get{registry:\"location\",...} resolves by uid, returning its component AND project");
  it.todo("mocked: get{registry:\"project\",...} for an unresolved name throws a wire-visible not_found error, never a phantom detail");
  it.todo("mocked: AC-13 unchanged: get{uid} still returns EXACTLY the five-field default card, not a registry shape");
  it.todo("mocked: a worktree directory under the project resolves to the SAME project row — never a phantom row");
});
