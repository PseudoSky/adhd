# cache-isolation — STATE_NAME

**Phase:** config · **Kind:** work · **Depends on:** tsconfig-shim-removal · **Guard:** `node -e "const c=require(\"./nx.json\").cacheDirectory;if(c!==\".nx/cache\")process.exit(1)" && ./node_modules/.bin/nx show projects | rg -q "backlog" && test -f docs/plan/nx-23-upgrade/CACHE-ISOLATION.md`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

_No criteria yet._

---

## Reservations

```text
read_only:  ["docs/plan/nx-23-upgrade/SCOPE.md", "docs/plan/nx-23-upgrade/USE_CASES.md", "docs/plan/nx-23-upgrade/demo/DEMO.md", "docs/plan/nx-23-upgrade/demo/UNRESOLVED.md", "docs/plan/nx-23-upgrade/TOOLS.md", "docs/plan/nx-23-upgrade/APPROVAL.md", "docs/plan/nx-23-upgrade/contexts/_shared.md", "AGENTS.md", "CLAUDE.md", "tsconfig.base.json", "package.json", ".githooks/pre-commit"]
mutates:    ["nx.json", "docs/plan/nx-23-upgrade/CACHE-ISOLATION.md"]
```

---

## Notes for executor

Defuse nrwl/nx#36675: Nx 23 pools the task cache and cache DB across sibling worktrees, and a test target has replayed another worktree cached PASS. Pin a relative cache directory so each checkout owns its cache.
