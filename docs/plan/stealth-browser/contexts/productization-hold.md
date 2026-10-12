# productization-hold — REVIEW STATE

**Phase:** productization · **Kind:** review · **Depends on:** none · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py productization-hold`
**Executor:** `product` (sonnet/medium) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree])

---

## Goal

Product reviews this finished plan (README, SCOPE.md, USE_CASES.md, demo/DEMO.md, TOOLS.md and every context) and files productization tasks BEFORE any implementation is dispatched. This is the clearly marked, amendable hold point: it is the root of the DAG, so everything downstream waits for it, and it can add states without renumbering any existing id (state identity is the slug, criterion ids key off the slug).

---

## Semantic Distillation

- **Primitive:** REVIEW `docs/plan/stealth-browser/README.md` and its artifact set; WRITE `docs/plan/stealth-browser/PRODUCT-REVIEW.md`.

- **Reference Pattern:** The packaged surface a consumer sees: package name and description, six verb names (`chromeStatus launchChrome shutdownChrome listPageTargets checkChromeActivity getPageContext`), bin names (`stealth-browser`, `stealth-browser-mcp`), search-named leftovers in the generic layer (`SearchResultSource`, `searchDepth` in `types.ts`, `getSearchSessionId` in `session.ts`), the Google-specific `capture/dom.ts` walker, default port 9222 / profile handling, publish metadata, docs surface.

- **Delta Spec:** Product writes `PRODUCT-REVIEW.md` with exactly these machine lines: `STATUS: folded` once every productization task is either folded into the DAG or explicitly rejected with a reason, and `INSERTED: <comma-separated new state slugs | none>`. To INSERT work: `node $SKILL/scripts/plan-scaffold.js add-state docs/plan/stealth-browser prod-<topic> --phase <phase> --kind work --depends-on <predecessors> --artifacts <paths>` then `set-reservation`, `add-criterion`, add the slug to `scripts/ownership.json`, and make the intended successor depend on it. Never rename or renumber an existing state. Never widen another state's owned paths; run `python3 docs/plan/stealth-browser/scripts/check-disjoint.py` after every insertion (it must exit 0). Product does NOT edit package code.

- **Invariants:** [inv:one-new-package]: a productization task that needs a second package is rejected or escalated to the human, never inserted. Existing state slugs and criterion ids are immutable. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:productization-hold]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py productization-hold` — runs every acceptance criterion below (red until the work is done); `--only productization-hold.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py productization-hold --only productization-hold.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [productization-hold.1] PRODUCT-REVIEW.md exists with the line `STATUS: folded` (product's tasks are folded into the DAG).

- [productization-hold.2] Every state listed on the `INSERTED:` line exists in dag.json with a non-empty depends_on; the line may be `INSERTED: none`.
---

## Reservations

```text
read_only:  ["docs/plan/stealth-browser/README.md"]
mutates:    ["docs/plan/stealth-browser/PRODUCT-REVIEW.md"]
```

---

## Contract Promise

Added: `docs/plan/stealth-browser/PRODUCT-REVIEW.md`; optional new `prod-*` states. Modified: none. Deleted: none.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:productization-hold]`:

- [ ] After PRODUCT-REVIEW.md is complete -- commit it: `docs(stealth-browser): productization review [psm:productization-hold]`
- [ ] After any state insertion -- the plan-scaffold CLI auto-commits its own bookkeeping; commit `scripts/ownership.json` by explicit path
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- This is the amend point. Adding a `prod-*` state is cheap here (nothing has started) and expensive later (use `state-transition.js --amend`).
- Candidates product should weigh: keep or drop `capture/dom.ts` (Google SERP walker, deprecated in the source); rename search-named exports in the generic layer; whether `launchChrome` should expose headless/profile options; whether to publish or only merge (that decision stays with the dispatcher in `merge-readiness`).
- Out of scope for this plan and for productization: the sox-service-proxy self-reaping singleton (backlog 19dfb641) and the FEAT-AGENT-TRACING dashboard (backlog 5b98d3b2); see README 'Related backlog items'. Product may file follow-ups, not fold them in silently.
