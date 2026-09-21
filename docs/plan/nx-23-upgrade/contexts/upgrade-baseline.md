# upgrade-baseline — STATE_NAME

**Phase:** intake · **Kind:** work · **Depends on:** none · **Guard:** `test -f docs/plan/nx-23-upgrade/BASELINE.md && ./node_modules/.bin/nx --version | rg -q "Local: v23\.2\.1" && node -e "const d=require(\"./package.json\").devDependencies;if(d.nx!==\"23.2.1\"||d.vite!==\"^8.3.0\"||d.vitest!==\"4.1.9\")process.exit(1)"`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [upgrade-baseline.1] The repo-local Nx binary reports 23.2.1

---

## Reservations

```text
read_only:  ["docs/plan/nx-23-upgrade/SCOPE.md", "docs/plan/nx-23-upgrade/USE_CASES.md", "docs/plan/nx-23-upgrade/demo/DEMO.md", "docs/plan/nx-23-upgrade/demo/UNRESOLVED.md", "docs/plan/nx-23-upgrade/TOOLS.md", "docs/plan/nx-23-upgrade/APPROVAL.md", "docs/plan/nx-23-upgrade/contexts/_shared.md", "AGENTS.md", "CLAUDE.md", "nx.json", "tsconfig.base.json", ".githooks/pre-commit", "docs/plan/nx-23-upgrade/UPGRADE-PLAN.md"]
mutates:    ["docs/plan/nx-23-upgrade/BASELINE.md", "package.json", "pnpm-lock.yaml"]
```

---

## Notes for executor

Commit the in-flight vite 8 bump and freeze the measured baseline that every later guard compares against.
