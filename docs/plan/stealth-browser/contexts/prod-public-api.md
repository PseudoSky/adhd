# prod-public-api — WORK STATE

**Phase:** surface · **Kind:** work · **Depends on:** surface-api · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py prod-public-api`
**Executor:** `typescript-pro` (sonnet/high) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])
**Parallel with:** prod-errors (disjoint owned paths, proven by `check-disjoint.py`)

**Origin:** inserted by `productization-hold` from `PRODUCT-REVIEW.md`; criteria carry the review's PA ids in their text.

---

## Goal

The package root exposes exactly the six verbs and their types as the stable public API. Google- and search-named leftovers of the generic layer (`SearchResultSource`, `searchDepth` consumers, `getSearchSessionId`, the Google SERP extractors) are removed from the root barrel and exported from a `./legacy` subpath marked `@deprecated`; neutral aliases exist for the generic names; every other root export is tagged `@experimental`. (Source: PRODUCT-REVIEW.md P3, decision D1.)

---

## Semantic Distillation

- **Primitive:** CREATE `entrypoint/stealth-browser/src/legacy.ts` and `entrypoint/stealth-browser/src/test/unit/public-api/`; MODIFY `entrypoint/stealth-browser/src/index.ts` (sequential after `surface-api`, which created it).

- **Reference Pattern:** `entrypoint/stealth-browser/src/index.ts` (the full barrel written by surface-api), `/Users/nix/dev/ai/scratch/agent-browser/cdp-query-client.ts` (the old barrel names), `scripts/port-manifest.json` (every export must stay exported, [dod.4]).

- **Delta Spec:** Move every Google- or search-named old-barrel name out of `index.ts` into `src/legacy.ts` (re-export from the lib files with `@deprecated` TSDoc on each export statement). Add neutral aliases (e.g. `PageSource` for `SearchResultSource`) to the root. Nothing is renamed or deleted in `src/lib/` (additive only: [dod.4] and the >=80% line-similarity port rule). `searchDepth` keeps its field name (frozen shape) and is documented; `getSearchSessionId` stays as the alias required by `mig-foundation.4`; `capture/dom.ts` is KEPT. Root exports other than the `./api.js` verbs carry `@experimental`. `package.json` `exports['./legacy']` is a one-line edit made by `surface-hosts` (it owns package.json); this state ships the file it points at. A public-API snapshot spec (sorted root export names via `toEqual`) fails on drift.

- **Invariants:** [inv:esm-js-specifiers] [inv:tests-cite] [inv:unit-purity]; additive only: no symbol is renamed or removed from the union of `index.ts` + `legacy.ts`; the root contains no Google- or Search-named export. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:prod-public-api]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py prod-public-api` — runs every acceptance criterion below (red until the work is done); `--only prod-public-api.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py prod-public-api --only prod-public-api.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [prod-public-api.1] (PA3.1) A public-API export snapshot spec under src/test/unit/public-api/ lists every root export of src/index.ts (and the six verbs) and fails on drift (toEqual / snapshot of the sorted export names).

- [prod-public-api.2] (PA3.2) src/index.ts exports no Google- or Search-named symbol and does not re-export ./legacy; src/legacy.ts exports every such old-barrel name (the union of both files still covers the old barrel).
- [prod-public-api.3] (PA3.3, source level) src/legacy.ts exports SearchResultSource and src/index.ts exports the neutral alias PageSource; capture/dom.ts stays present (dod.4).
- [prod-public-api.4] (PA3.5) Tier tags: every export statement in src/legacy.ts carries @deprecated and every export in src/index.ts other than the `./api.js` verbs carries @experimental in its TSDoc.
- [prod-public-api.5] Specs cite ticket 8468f7b1, a valid criterion id of this state and the PA ids they cover (PA3.1, PA3.5); only owned paths changed by [psm:prod-public-api] commits.
---

## Reservations

```text
read_only:  ["entrypoint/stealth-browser/src/api.ts", "entrypoint/stealth-browser/src/lib/", "/Users/nix/dev/ai/scratch/agent-browser/cdp-query-client.ts"]
mutates:    ["entrypoint/stealth-browser/src/legacy.ts", "entrypoint/stealth-browser/src/index.ts", "entrypoint/stealth-browser/src/test/unit/public-api/"]
```

---

## Contract Promise

Added: `entrypoint/stealth-browser/src/legacy.ts`, `entrypoint/stealth-browser/src/test/unit/public-api/*.spec.ts`. Modified: `entrypoint/stealth-browser/src/index.ts` (search/Google names move to legacy). Deleted: none.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:prod-public-api]`:

- [ ] After legacy.ts and the trimmed barrel -- commit: `feat(stealth-browser): legacy subpath and stable root API [psm:prod-public-api]`
- [ ] After the export-snapshot spec -- commit: `test(stealth-browser): public API snapshot [psm:prod-public-api]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- `surface-api.3` (amended, D1) accepts a name from root OR `./legacy`; keep the union covering the old barrel at every commit.
- The `./legacy` exports-map edit, the built-d.ts check (PA3.2), `import '@adhd/stealth-browser/legacy'` resolution (PA3.3) and `verify-dist-load` (PA3.4) are `surface-hosts.9`: package.json is that state's file.
