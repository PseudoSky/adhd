# typecheck-teeth-restored — The build gate type-checks again

**Phase:** graph · **Kind:** work · **Depends on:** graph-release-eslint-inferred · **Guard:** `python3 docs/plan/nx-23-upgrade/scripts/guard_audit_config.py && ./node_modules/.bin/nx run-many -t typecheck && NX_CACHE_DIRECTORY="$(mktemp -d)/cache" NX_WORKSPACE_DATA_DIRECTORY="$(mktemp -d)/data" ./node_modules/.bin/nx build decompile-cli && ./node_modules/.bin/nx build agent-core-env && test -f docs/plan/nx-23-upgrade/TYPECHECK-TEETH.md`

---

## Goal

A type error in any project that exposes a `typecheck` target fails that project's
`build`, so the gate `tsconfig-shim-removal` established — and the graph remodel
silently removed — is restored, with `agent-core-env` and `decompile-cli` actually
green under it.

---

## Semantic distillation

- **This is a cross-state regression, not new scope.** `graph-test-build-inferred` deleted the
  47 explicit `@nx/vite:build` targets; *their* executor ran `validateTypes`, while the inferred
  `build` runs a plain `vite build` (vite-plugin-dts 3.8.3 logs diagnostics and exits 0). The
  build stopped type-checking, so `[tsconfig-shim-removal.5]` — "an injected type error turns it
  red" — went red and re-blocked every later gate, because the config-phase gate accumulates
  `[tsconfig-shim-removal.5]` (and this state's own guard re-runs that accumulated gate). *Updated
  2026-09-22: the later gate named here was `audit-graph`, since retired by owner directive; the
  regression was resolved by this state before that waiver, so the correction is historical.*
- **Restore the gate; do not re-add 47 targets.** The gate belongs in one place:
  `targetDefaults.build.dependsOn` gains `typecheck`. A same-project `dependsOn` entry naming a
  target a project does not have is **silently skipped** (Nx `create-task-graph.js`
  `processTasksForSingleProject` guards on `projectHasTarget`), so `apigen-java` — the one
  `build` project with no `typecheck` target — is unaffected rather than broken.
- **TS 6's `strict` default is the real behaviour change.** `tsconfig-shim-removal` recorded
  `strict: false` as "a TS default; removal is a no-op". TS 6.0.3 defaults `strict` to **true**,
  so removing the key enabled strict for the 137 configs that inherit it. That *is* a build-outcome
  change, and `SHIM-REMOVAL.md`'s "None … changed a build outcome" is false. Accept strict — it is
  the point of the removal — and fix what it exposed. Do **not** reinstate the shim.
- **`agent-core-env`'s typecheck is script-inferred, so it resolves the wrong compiler.** Its
  `package.json` `typecheck` script makes Nx infer an `nx:run-script` target that runs
  `pnpm run typecheck` with `cwd` = the package root, resolving the package-local
  `typescript@5.9.3`, which rejects the repo-wide `ignoreDeprecations: "6.0"` (TS5103). Its seven
  siblings are green because each declares an explicit `nx:run-commands` target running the
  **workspace-root** `tsc` (6.0.3). Match the siblings; do not "fix" the tsconfig.
- **A cached PASS is not evidence.** `nx build decompile-cli` has been observed reporting success
  from a cache hit while a cold run failed. Criterion `.4` therefore builds on a scratch cache
  (`NX_CACHE_DIRECTORY` + `NX_WORKSPACE_DATA_DIRECTORY`) so it measures a real execution. Never
  reach for `--skip-nx-cache` ([inv:no-cache-bypass]).

---

## Contract promise

```text
added:    ["docs/plan/nx-23-upgrade/TYPECHECK-TEETH.md"]
modified: ["nx.json", "packages/agent/agent-core-env/project.json", "entrypoint/decompile-cli/src/lib/extractors/index.ts", "entrypoint/decompile-cli/src/lib/extractors/site.ts", "docs/plan/nx-23-upgrade/SHIM-REMOVAL.md"]
deleted:  []
```

---

## Commit points

- Commit the gate restoration (`nx.json` + `agent-core-env/project.json`) **together with** the two
  `decompile-cli` source fixes. The type errors only become build-blocking once
  `build.dependsOn` gains `typecheck`; landing the gate without the fixes would leave the tree
  red, and landing the fixes alone would leave the gate toothless.
- Commit the corrected `SHIM-REMOVAL.md` and the new `TYPECHECK-TEETH.md` post-guard.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [typecheck-teeth-restored.1] The build gate has teeth again: an injected type error in a base package turns its build red

- [typecheck-teeth-restored.2] agent-core-env builds green with the typecheck target restored
- [typecheck-teeth-restored.3] The full typecheck sweep is green across every project that exposes the target
- [typecheck-teeth-restored.4] decompile-cli builds green on a cold cache, so the result is a real execution and not a stale-cache replay
- [typecheck-teeth-restored.5] The typecheck-teeth record exists
---

## Reservations

```text
read_only:  ["docs/plan/nx-23-upgrade/SCOPE.md", "docs/plan/nx-23-upgrade/USE_CASES.md", "docs/plan/nx-23-upgrade/demo/DEMO.md", "docs/plan/nx-23-upgrade/demo/UNRESOLVED.md", "docs/plan/nx-23-upgrade/TOOLS.md", "docs/plan/nx-23-upgrade/APPROVAL.md", "docs/plan/nx-23-upgrade/contexts/_shared.md", "AGENTS.md", "CLAUDE.md", "package.json", "tsconfig.base.json", "docs/plan/nx-23-upgrade/scripts/guard_audit_config.py", "docs/plan/nx-23-upgrade/scripts/run-audit.js", "docs/plan/nx-23-upgrade/scripts/criteria.json"]
mutates:    ["nx.json", "packages/agent/agent-core-env/project.json", "entrypoint/decompile-cli/src/lib/extractors/index.ts", "entrypoint/decompile-cli/src/lib/extractors/site.ts", "docs/plan/nx-23-upgrade/SHIM-REMOVAL.md", "docs/plan/nx-23-upgrade/TYPECHECK-TEETH.md"]
```

---

## Notes for executor

Cross-state repair: restore the build gate teeth the graph remodel removed. Scope is fixed by the
`architect-decision` verdict (**APPROVE**, mechanism A) — do not widen it, and do not weaken
`[tsconfig-shim-removal.5]` or any other existing criterion.

**The five edits (and nothing else).**

1. `nx.json` — in `targetDefaults.build`, add `"typecheck"` to `dependsOn` (keep `"^build"`), and
   add a `typecheck` targetDefault with `"cache": true` and `"inputs": ["production", "^production"]`.
2. `packages/agent/agent-core-env/project.json` — add an explicit `typecheck` target matching its
   seven siblings (`nx:run-commands`, `command`:
   `tsc -p packages/agent/agent-core-env/tsconfig.typecheck.json --noEmit`). Verified achievable:
   that command exits 0 from the workspace root today, so the fix is the target, not the source.
   `package.json` and `tsconfig.json` need no change — the siblings keep their `typecheck` script
   alongside the explicit target.
3. `entrypoint/decompile-cli/src/lib/extractors/index.ts:103` — **TS2454**, `'r' is used before
   being assigned` (`if (r?.length)` after `r = extractMapLink(input)`). `r` is assigned on only
   some branches; make the read provably post-assignment while preserving behaviour exactly.
4. `entrypoint/decompile-cli/src/lib/extractors/site.ts:83` — **TS18048**, `'cookies' is possibly
   'undefined'` in the `getCookies` callback; handle the undefined case explicitly.
5. `docs/plan/nx-23-upgrade/SHIM-REMOVAL.md` — correct the false blast-radius claim. The
   `strict: false` row is **not** a no-op under TS 6.0.3; record the measured consequence (strict
   enabled for the 137 inheriting configs; two real errors surfaced in `decompile-cli`) and keep
   the rest of the measured table as it stands.

**Constraints on the fixes.** Behaviour-preserving; no `any`, no `@ts-ignore`/`@ts-expect-error`,
no non-null assertion used to silence a real possibility. These are real errors, not strictness
noise — a silent-suppression "fix" fails the spirit of the state even if the guard goes green.

**Write `docs/plan/nx-23-upgrade/TYPECHECK-TEETH.md`** — the state's record: the regression and its
mechanism, the gate restoration, the strict-default correction, the `agent-core-env` root cause,
the cold-cache method for `.4`, and the **red-before / green-after** guard transcript
(`[inv:guards-are-red-then-green]`). Note explicitly that `apigen-java` is the one `build` project
without a `typecheck` target and is therefore unaffected.

**Guard mechanics.** The guard re-runs the currently-red accumulated config gate
(`guard_audit_config.py`) — that is the cross-state regression proof — and then this state's own
positive criteria. The negative control (`.1`) is deliberately **not** in the guard: a
mutate/restore pair is not safe in a bare shell one-liner (an interrupt between mutate and restore
leaves the tree dirty). It lives in `criteria.json` instead, where `run-audit.js` always restores in
a `finally`. The sibling control `[tsconfig-shim-removal.5]` runs the same teeth property and *is*
covered by the guard, via the accumulated config gate.

**Pinned tools.** Every command resolves through `./node_modules/.bin/` or a repo-owned `python3`
script — no ambient `PATH` ([inv:tool-resolution-pinned]).
