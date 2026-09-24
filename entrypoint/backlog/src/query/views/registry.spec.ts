/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `views/registry.e2e.ts`.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer pays for
 * its heavy real-store fixture. This file consumes nothing; it exists so the
 * future MOCKED unit-test version of this suite has a home that the default
 * target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real
 * case in `views/registry.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess or a real model.
 *
 * Resource lane: cpu — a 1,000-node `writeNodeTx` fixture loop
 * (`views/registry.e2e.ts:686`, the bounded path-fallback-scan suite) plus a
 * real-store fixture re-seeded in every test's `beforeEach`; 31.0s in the
 * 20260924T030419Z default-lane timing log (27.2s in the worktree log
 * 20260924T033419Z).
 */
import { describe, it } from 'vitest';

describe("mocked: registry", () => {
  it.todo("mocked: lists every live project, unfiltered");
  it.todo("mocked: narrows by filter.project (name)");
  it.todo("mocked: narrows by filter.project (uid)");
  it.todo("mocked: returns [] for an unresolved project ref — never an error on a read path (§6.1)");
  it.todo("mocked: lists every live component, unfiltered");
  it.todo("mocked: narrows by filter.project");
  it.todo("mocked: returns [] for an unresolved project ref");
  it.todo("mocked: lists every live location, unfiltered");
  it.todo("mocked: narrows by filter.component (name)");
  it.todo("mocked: scopes by filter.project + filter.component together");
  it.todo("mocked: a project+component scope that does not resolve (wrong project) returns []");
  it.todo("mocked: returns [] for an unresolved component ref");
  it.todo("mocked: project detail includes its components and their locations");
  it.todo("mocked: component detail includes its owning project and its locations");
  it.todo("mocked: location detail includes its component and project (resolved by uid — no independent name)");
  it.todo("mocked: throws CatalogNotFoundError for an unresolved project name");
  it.todo("mocked: throws CatalogNotFoundError for an unresolved component name");
  it.todo("mocked: throws InvalidArgumentError for a non-uid location name (a location has no name)");
  it.todo("mocked: throws CatalogNotFoundError for an invalidated (soft-deleted) location");
  it.todo("mocked: an invalidated location disappears from its LIVE project's detail (chain integrity)");
  it.todo("mocked: an invalidated location disappears from its LIVE component's detail (chain integrity)");
  it.todo("mocked: an invalidated component disappears from its LIVE project's detail, and its OWN detail degrades project to empty (chain integrity)");
  it.todo("mocked: an invalidated project degrades a LIVE component's detail to an empty project (chain integrity)");
  it.todo("mocked: resolves a tool query to its full chain");
  it.todo("mocked: resolves a url query to its full chain");
  it.todo("mocked: resolves an exact path query to its full chain, no hint");
  it.todo("mocked: resolves a repo-relative path via suffix fallback, WITH a hint");
  it.todo("mocked: throws CatalogNotFoundError for a query that resolves nothing — never a silent null");
  it.todo("mocked: surfaces a hint when a component resolves but its owning project is a data-integrity gap");
  it.todo("mocked: throws CatalogNotFoundError when the resolved location's component has been invalidated (chain integrity)");
  it.todo("mocked: degrades to the data-integrity hint when the resolved project has been invalidated, not the tombstoned project's data (chain integrity)");
  it.todo("mocked: a match that lands beyond the cap is reported as an honest truncated-scan miss, not a bare not-found");
  it.todo("mocked: a match within the cap still resolves normally even with many noise rows ahead of it");
});
