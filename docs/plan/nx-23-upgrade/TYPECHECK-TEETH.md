# TYPECHECK-TEETH — restoring the build gate the graph remodel removed

State `typecheck-teeth-restored` repaired a **cross-state regression**: an earlier
state, `graph-test-build-inferred`, removed the mechanism by which a `build` failed
on a type error, and with it went the teeth behind `[tsconfig-shim-removal.5]`.
This file records the regression and its mechanism, the restoration, the
`strict`-default correction, the `agent-core-env` root cause, the cold-cache method
used for the `.4` criterion, and the red-before / green-after guard transcript.

## The regression and its mechanism

`graph-test-build-inferred` deleted the **47 explicit `@nx/vite:build` targets**.
Those targets used the `@nx/vite:build` executor, which ran **`validateTypes`** as
part of the build. The replacement — an inferred `build` — runs a plain
`vite build`; with `vite-plugin-dts` 3.8.3 the declaration pass **logs** type
diagnostics and **exits 0**. The build therefore stopped type-checking.

Consequence: `[tsconfig-shim-removal.5]` ("an injected type error turns it red")
went red and re-blocked every later gate, because `audit-graph` accumulates the
config phase — a regression in the config phase re-blocks the graph phase.

Proof of the toothless build (red-before, measured): injecting a deliberate type
error into `packages/agent/agent-base-types/src/index.ts` and running
`./node_modules/.bin/nx build agent-base-types` exited **0** — the error was
logged by `vite-plugin-dts` and swallowed.

## The restoration (mechanism A)

The gate is restored in **one place**, not by re-adding 47 targets:

1. `nx.json` — `targetDefaults.build.dependsOn` gains `"typecheck"` (keeping
   `"^build"`), so every `build` now depends on the **same project's** `typecheck`.
2. `nx.json` — a `typecheck` `targetDefault` with `"cache": true` and
   `"inputs": ["production", "^production"]`, so the new dependency is itself
   cached and invalidated by the same source/version inputs as a build.

**A same-project `dependsOn` entry naming a target the project does not have is
silently skipped.** Nx's `create-task-graph.js` `processTasksForSingleProject`
guards on `projectHasTarget` before enqueuing the dependency. Verified: there are
**63** projects with a `build` target and **62** with a `typecheck` target, and the
sole difference is **`apigen-java`** — the one `build` project with no `typecheck`
target. It is therefore **unaffected** rather than broken: its `build` runs exactly
as before.

With the gate restored, the same injected error now fails the build:

```
$ printf '\n\nexport const __ttProbe: number = "not a number";\n' >> packages/agent/agent-base-types/src/index.ts
$ NX_CACHE_DIRECTORY="$(mktemp -d)/cache" NX_WORKSPACE_DATA_DIRECTORY="$(mktemp -d)/data" \
    ./node_modules/.bin/nx build agent-base-types
packages/agent/agent-base-types/src/index.ts:35:14 - error TS2322: Type 'string' is not assignable to type 'number'.
Found 1 error in packages/agent/agent-base-types/src/index.ts:35
MUTATED_BUILD_EXIT=130
$ git restore packages/agent/agent-base-types/src/index.ts   # tree left clean
```

## The `strict`-default correction

`SHIM-REMOVAL.md` recorded `strict: false` as "a TS default; removal is a no-op".
That is **false under TypeScript 6.0.3**, which defaults `strict` to **`true`**
(it was `false` through 5.x). Removing the key therefore *enabled* `strict` for the
**137** configs that inherited it — a real build-outcome change, and the reason two
real errors surfaced in `entrypoint/decompile-cli`. `SHIM-REMOVAL.md` has been
corrected to say so, keeping the rest of its measured table intact. Strict is
accepted — it is the point of the removal — and the exposed errors were fixed in
source rather than suppressed.

The two errors and their behaviour-preserving fixes (no `any`, no
`@ts-ignore`/`@ts-expect-error`, no non-null assertion):

- **TS2454** `Variable 'r' is used before being assigned` —
  `entrypoint/decompile-cli/src/lib/extractors/index.ts:103`. `r` is declared
  `let r;` (evolving `any`) and assigned on only some control-flow paths; under
  `strictNullChecks` TS's definite-assignment analysis flags a read it cannot prove
  post-assignment. Fixed by binding the branch's result to a branch-local `const`
  (`const mapLinks = extractMapLink(input)`), which is provably post-assignment and
  behaviour-identical (the shared `r` was not read after this branch).
- **TS18048** `'cookies' is possibly 'undefined'` —
  `entrypoint/decompile-cli/src/lib/extractors/site.ts:83`. `tough-cookie` types the
  `getCookies` callback's `cookies` as `Cookie[] | undefined`. Handled explicitly:
  `resolve((cookies ?? []).map((c) => c.cookieString()))`.

## The `agent-core-env` root cause

`agent-core-env` exposes a `typecheck` target that is **script-inferred** from its
`package.json` `"typecheck": "tsc -p tsconfig.typecheck.json --noEmit"`. Nx infers an
`nx:run-script` target that runs `pnpm run typecheck` with `cwd` = the package root.
That resolves the **package-local `typescript@5.9.3`**, which rejects the repo-wide
`ignoreDeprecations: "6.0"` with **TS5103**. Its seven siblings are green because
each declares an explicit `nx:run-commands` target running the **workspace-root**
`tsc` (6.0.3), which accepts `ignoreDeprecations: "6.0"`.

The fix matches the siblings — an explicit `nx:run-commands` `typecheck` target
whose command is `tsc -p packages/agent/agent-core-env/tsconfig.typecheck.json --noEmit`.
That command already exits 0 from the workspace root, so the fix is the **target**,
not the source. `package.json` and `tsconfig.json` are unchanged.

## The cold-cache method for `.4`

`nx build decompile-cli` has been observed reporting success from a **cache hit**
while a cold run failed. A cached PASS is not evidence. Criterion `.4` therefore
builds on a **scratch cache**:

```
NX_CACHE_DIRECTORY="$(mktemp -d)/cache" NX_WORKSPACE_DATA_DIRECTORY="$(mktemp -d)/data" \
  ./node_modules/.bin/nx build decompile-cli
```

so the run measures a **real execution** (the transcript shows `Cache: 0/6 hit`),
not a stale replay. `--skip-nx-cache` was never used — it would leave the shared
cache holding a stale entry and is banned by `AGENTS.md`.

## Guard transcript — red before, green after

**Red before** (`python3 docs/plan/nx-23-upgrade/scripts/guard_audit_config.py`):

```
[tsconfig-shim-removal.1] PASS
[tsconfig-shim-removal.2] PASS
[tsconfig-shim-removal.3] PASS
[tsconfig-shim-removal.4] PASS
[tsconfig-shim-removal.5] FAIL
[tsconfig-shim-removal.6] PASS
# [tsconfig-shim-removal.5] neg-control positive-under-mutation exit=0
guard_audit_config: RED — 1 criterion(s) failed.
```

The negative control's `positive-under-mutation exit=0` is the smoking gun: under an
injected type error the build still exited 0 — no teeth.

**Green after** (same command, after the restoration):

```
[tsconfig-shim-removal.1] PASS
[tsconfig-shim-removal.2] PASS
[tsconfig-shim-removal.3] PASS
[tsconfig-shim-removal.4] PASS
[tsconfig-shim-removal.5] PASS
[tsconfig-shim-removal.6] PASS
... 51 criteria PASS / 0 FAIL ...
guard_audit_config: exit 0 (no RED line)
```

The accumulated config gate — including `[tsconfig-shim-removal.5]` — is green on top
of the restored graph phase, which is the cross-state regression proof.

## Files changed

| File | Change |
|---|---|
| `nx.json` | `build.dependsOn` gains `typecheck`; new `typecheck` targetDefault (`cache: true`, `inputs: ["production", "^production"]`) |
| `packages/agent/agent-core-env/project.json` | explicit `nx:run-commands` `typecheck` target matching its siblings |
| `entrypoint/decompile-cli/src/lib/extractors/index.ts` | TS2454 fix — branch-local `const mapLinks` |
| `entrypoint/decompile-cli/src/lib/extractors/site.ts` | TS18048 fix — `(cookies ?? [])` |
| `docs/plan/nx-23-upgrade/SHIM-REMOVAL.md` | corrected the `strict`-default claim and recorded the measured consequence |
| `docs/plan/nx-23-upgrade/TYPECHECK-TEETH.md` | this record |

## Scope note

The scope is fixed by the `architect-decision` verdict (**APPROVE**, mechanism A).
`[tsconfig-shim-removal.5]` and every other existing criterion are unchanged — the
gate was **restored**, not weakened.
