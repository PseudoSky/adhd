# cache-isolation — Per-checkout task cache isolation

**Phase:** config · **Kind:** work · **Depends on:** tsconfig-shim-removal · **Guard:** `node -e "const c=require(\"./nx.json\").cacheDirectory;if(c!==\".nx/cache\")process.exit(1)" && ./node_modules/.bin/nx show projects | rg -q "backlog" && test -f docs/plan/nx-23-upgrade/CACHE-ISOLATION.md`

---

## Goal

A cached task result belonging to a sibling worktree can never be replayed as a pass in this checkout.

---

## Semantic distillation

- The hazard: Nx 23 pools the task cache and its sqlite database across sibling worktrees, and a test target has reported a cached PASS belonging to another worktree whose suite never ran.
- THE TENSION: cross-worktree cache sharing IS the upgrade's headline benefit. You are trading a measured correctness hazard for a speed benefit. Make that trade explicitly in the record, not implicitly.
- Use a RELATIVE cache directory so it resolves inside whichever checkout is running — an absolute path would re-pool everything.

---

## Contract promise

```text
added:    ["docs/plan/nx-23-upgrade/CACHE-ISOLATION.md"]
modified: ["nx.json"]
deleted:  []
```

---

## Commit points

- Commit nx.json + CACHE-ISOLATION.md post-guard.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [cache-isolation.1] The task cache directory is declared relative to the checkout

- [cache-isolation.2] The declared cache directory resolves inside this checkout
- [cache-isolation.3] The project graph still loads after the cache change
- [cache-isolation.4] The cache-isolation rationale record exists
---

## Reservations

```text
read_only:  ["docs/plan/nx-23-upgrade/SCOPE.md", "docs/plan/nx-23-upgrade/USE_CASES.md", "docs/plan/nx-23-upgrade/demo/DEMO.md", "docs/plan/nx-23-upgrade/demo/UNRESOLVED.md", "docs/plan/nx-23-upgrade/TOOLS.md", "docs/plan/nx-23-upgrade/APPROVAL.md", "docs/plan/nx-23-upgrade/contexts/_shared.md", "AGENTS.md", "CLAUDE.md", "tsconfig.base.json", "package.json", ".githooks/pre-commit"]
mutates:    ["nx.json", "docs/plan/nx-23-upgrade/CACHE-ISOLATION.md"]
```

---

## Notes for executor

Defuse nrwl/nx#36675: Nx 23 pools the task cache and cache DB across sibling worktrees, and a test target has replayed another worktree cached PASS. Pin a relative cache directory so each checkout owns its cache.
