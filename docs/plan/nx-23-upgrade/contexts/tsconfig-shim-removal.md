# tsconfig-shim-removal — STATE_NAME

**Phase:** config · **Kind:** work · **Depends on:** audit-reconcile · **Guard:** `node -e "const c=require(\"./tsconfig.base.json\").compilerOptions;for(const k of [\"strict\",\"types\",\"esModuleInterop\",\"ignoreDeprecations\",\"noUncheckedSideEffectImports\"])if(k in c)process.exit(1)" && ./node_modules/.bin/nx run-many -t build --projects=agent-base-types,data-query-engine,agent-core-policy`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [tsconfig-shim-removal.1] No migration strictness relaxation remains in the shared compiler config

- [tsconfig-shim-removal.2] No wildcard global-types relaxation remains in the shared compiler config
- [tsconfig-shim-removal.3] No deprecation-suppression relaxation remains in the shared compiler config
- [tsconfig-shim-removal.4] Representative projects still build and type-check
---

## Reservations

```text
read_only:  ["docs/plan/nx-23-upgrade/SCOPE.md", "docs/plan/nx-23-upgrade/USE_CASES.md", "docs/plan/nx-23-upgrade/demo/DEMO.md", "docs/plan/nx-23-upgrade/demo/UNRESOLVED.md", "docs/plan/nx-23-upgrade/TOOLS.md", "docs/plan/nx-23-upgrade/APPROVAL.md", "docs/plan/nx-23-upgrade/contexts/_shared.md", "AGENTS.md", "CLAUDE.md", "nx.json", "package.json", "docs/plan/nx-23-upgrade/SHIM-REMOVAL.md"]
mutates:    ["tsconfig.base.json", "docs/plan/nx-23-upgrade/SHIM-REMOVAL.md"]
```

---

## Notes for executor

Delete the five migration shims the upgrade added to the shared compiler config and prove empirically that builds still type-check. Measure the real blast radius; do not assume the stated one.
