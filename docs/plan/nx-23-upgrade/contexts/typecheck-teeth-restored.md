# typecheck-teeth-restored — STATE_NAME

**Phase:** graph · **Kind:** work · **Depends on:** graph-release-eslint-inferred · **Guard:** `python3 docs/plan/nx-23-upgrade/scripts/guard_audit_config.py && ./node_modules/.bin/nx run-many -t typecheck && NX_CACHE_DIRECTORY="$(mktemp -d)/cache" NX_WORKSPACE_DATA_DIRECTORY="$(mktemp -d)/data" ./node_modules/.bin/nx build decompile-cli && ./node_modules/.bin/nx build agent-core-env && test -f docs/plan/nx-23-upgrade/TYPECHECK-TEETH.md`

---

## Goal

<What is true after this state that was not true before?>

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [typecheck-teeth-restored.1] The build gate has teeth again: an injected type error in a base package turns its build red

- [typecheck-teeth-restored.2] agent-core-env builds green with the typecheck target restored
- [typecheck-teeth-restored.3] The full typecheck sweep is green across every project that exposes the target
- [typecheck-teeth-restored.4] decompile-cli builds green on a cold cache, so the result is a real execution and not a stale-cache replay
---

## Reservations

```text
read_only:  []
mutates:    ["nx.json", "packages/agent/agent-core-env/project.json", "entrypoint/decompile-cli/src/lib/extractors/index.ts", "entrypoint/decompile-cli/src/lib/extractors/site.ts", "docs/plan/nx-23-upgrade/SHIM-REMOVAL.md", "docs/plan/nx-23-upgrade/TYPECHECK-TEETH.md"]
```

---

## Notes for executor

Cross-state repair: restore the build gate teeth the graph remodel removed. graph-test-build-inferred deleted the explicit @nx/vite:build targets whose executor ran validateTypes; the inferred build runs plain vite build, so a type error no longer turns the build red ([tsconfig-shim-removal.5] regressed). Wire build.dependsOn to typecheck in nx.json and accept TS 6 strict:true, which exposed two real errors in decompile-cli. Scope fixed by the architect-decision verdict (APPROVE, mechanism A) — do not widen it.
