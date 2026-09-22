# tsconfig-shim-removal — Migration compiler shims removed, parity with main proven

**Phase:** config · **Kind:** work · **Depends on:** audit-reconcile · **Guard:** `node -e "const c=require(\"./tsconfig.base.json\").compilerOptions;for(const k of [\"strict\",\"types\",\"esModuleInterop\",\"ignoreDeprecations\",\"noUncheckedSideEffectImports\"])if(k in c)process.exit(1)" && ./node_modules/.bin/nx run-many -t build --projects=agent-base-types,data-query-engine,agent-core-policy`

---

## Goal

The shared compiler config carries no migration-only relaxation, and the tree still builds and type-checks.

---

## Semantic distillation

- MEASURED, not assumed: main sets NONE of these keys. Of the 62 configs reaching the shared config, ~14 inherit `strict` and ~57 inherit `types` — but every removed value is either a TypeScript default or a diagnostics suppressor, so the shim is far less load-bearing than its reputation.
- The one that suppresses real diagnostics is the deprecation key. Delete it too, but if the build goes red, that is the cause — record it rather than reinstating silently.
- The negative-control criterion is the proof that matters: an injected type error must turn the build red. A green build with a dead type-checker is the failure this state exists to prevent.

---

## Contract promise

```text
added:    ["docs/plan/nx-23-upgrade/SHIM-REMOVAL.md"]
modified: ["tsconfig.base.json"]
deleted:  []
```

---

## Commit points

- Commit the shim removal + SHIM-REMOVAL.md post-guard. If a shim proves load-bearing, do NOT reinstate it silently — record which one and why, then escalate.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [tsconfig-shim-removal.1] No migration strictness relaxation remains in the shared compiler config

- [tsconfig-shim-removal.2] No wildcard global-types relaxation remains in the shared compiler config
- [tsconfig-shim-removal.3] No deprecation-suppression relaxation remains in the shared compiler config
- [tsconfig-shim-removal.4] Representative projects still build and type-check
- [tsconfig-shim-removal.5] The build gate has teeth: an injected type error turns it red
- [tsconfig-shim-removal.6] The measured blast-radius record exists
---

## Reservations

```text
read_only:  ["docs/plan/nx-23-upgrade/SCOPE.md", "docs/plan/nx-23-upgrade/USE_CASES.md", "docs/plan/nx-23-upgrade/demo/DEMO.md", "docs/plan/nx-23-upgrade/demo/UNRESOLVED.md", "docs/plan/nx-23-upgrade/TOOLS.md", "docs/plan/nx-23-upgrade/APPROVAL.md", "docs/plan/nx-23-upgrade/contexts/_shared.md", "AGENTS.md", "CLAUDE.md", "nx.json", "package.json"]
mutates:    ["tsconfig.base.json", "docs/plan/nx-23-upgrade/SHIM-REMOVAL.md"]
```

---

## Notes for executor

Delete the five migration shims the upgrade added to the shared compiler config and prove empirically that builds still type-check. Measure the real blast radius; do not assume the stated one.
