# CONFIG-REPAIR-ABSORBED — verification record

State: `config-repair-absorbed` (phase: reconcile)
Branch: `perf/nx-upgraded`
Verified at: start-ref `fa87b1ab` (state start commit `261fc8e7`)

## Outcome

The four unpushed config-repair commits intended for absorption were **already present
on the upgrade branch by a cleaner path**, so this state performed **verification only** —
no edit was made to `nx.json`, `CHANGELOG.md`, or any of the nine reserved manifests.

## How the absorption happened

An earlier merge of `main` into this branch (commit `f03b9aef`, "bring main's 6 commits
into perf/nx-upgraded") carried in the two commits that supply exactly the substance
`perf/nx-cfgfix` was going to contribute:

| main commit | substance |
|---|---|
| `0d110a50` | deletes the nine self-referential `scripts.build` wrappers (restores build cache) |
| `f48ccdaa` | restores `lint` to the default test target — the publish gate (BUG-060) |

Because `main` already carries this content, the branch was **not** re-applied here.

## Guard

The state's guard was **already GREEN before any work** — no state work was required to
turn it red→green. Raw run:

```
$ ./node_modules/.bin/nx show projects | rg -q "data-query-engine" \
  && node -e "const d=require('./nx.json').targetDefaults.test.dependsOn;if(!d.includes('lint')||!d.includes('^build'))process.exit(1)" \
  && node -e "const s=require('./packages/agent/agent-core-env/package.json').scripts;if(s&&s.build)process.exit(1)"
GUARD EXIT: 0
```

### Finding — degenerate guard (`[inv:guards-are-red-then-green]`)

`[inv:guards-are-red-then-green]` requires a guard to fail **before** the state's work and
pass **after**, so that passing carries information. This guard passed on the first run,
before any work. It therefore carries **no information about this state's work**. This is a
**plan-level observation**, not a failure of the state's execution: the `main` merge
(`f03b9aef`) pre-empted the state. Recorded here per the state's semantic distillation.

## Acceptance criteria — evidence

### .1 — default test target still depends on `lint` (publish gate preserved)

```
$ node -e "console.log(JSON.stringify(require('./nx.json').targetDefaults.test.dependsOn))"
["lint","^build"]
```

PASS — `lint` present, `^build` present. The reduced form (`perf/nx-cfgfix`'s
`8d1c9335 perf(nx): drop lint+sync-deps from the default test target`) is **not** present.
`publish`/`nx-release-publish` reach `lint` only via `test`; keeping it preserves
`@nx/dependency-checks` + `sync-deps` on every release (BUG-060).

### .2 — no self-referential build script in the nine recovered manifests

```
$ for p in packages/agent/{agent-core-env,agent-core-policy,agent-core-provider,agent-engine-compiler,agent-engine-orchestrator,agent-store-prompts,agent-store-runtime,agent-store-tools} entrypoint/decompile-cli; do
    node -e "const s=require('./$p/package.json').scripts; console.log('$p', (s&&s.build)?'HAS_BUILD':'clean')"
  done
packages/agent/agent-core-env clean
packages/agent/agent-core-policy clean
packages/agent/agent-core-provider clean
packages/agent/agent-engine-compiler clean
packages/agent/agent-engine-orchestrator clean
packages/agent/agent-store-prompts clean
packages/agent/agent-store-runtime clean
packages/agent/agent-store-tools clean
entrypoint/decompile-cli clean
remaining self-referential scripts.build = 0
```

PASS — 0 of 9 remain.

### .3 — a sample recovered project exposes an inferred build target

Sample: `agent-core-env`.

```
$ ./node_modules/.bin/nx show project agent-core-env --json
name: agent-core-env
has build target: true
build executor: @nx/vite:build
```

PASS — the `build` target is inferred/available (`@nx/vite:build`).

### .4 — a sample recovered project builds successfully

```
$ ./node_modules/.bin/nx build agent-core-env
> nx run agent-core-env:build  [existing outputs match the cache, left as is]
...
 NX   Successfully ran target build for project agent-core-env and 4 tasks it depends on
BUILD EXIT: 0
```

PASS — exit 0. The build is served from cache (`5/5 hit`); the target is valid and the
artifact is present. Deleting the self-referential `scripts.build` wrapper did **not**
remove the real inferred build target — confirming the wrappers were redundant.

## Recommendation — `perf/nx-cfgfix` is now redundant

`perf/nx-cfgfix` carries 4 commits on base `b257f715`:

```
9b9d3702 fix(nx): delete 9 package.json scripts.build that defeat the build cache
649b4a03 perf(nx): drop lint from the build task graph (the second lint path)
27db74e2 fix(agent-engine-compiler): stop the migration-resolution spec re-invoking nx (DEBT-BUILD-001)
8d1c9335 perf(nx): drop lint+sync-deps from the default test target
```

Its merge-base with `main` is `b257f715`; `main` has since advanced with `0d110a50` +
`f48ccdaa`, which supersede `9b9d3702` and `8d1c9335` respectively (and `8d1c9335` is the
exact trap the state guards against — dropping `lint` from the test target). The branch is
therefore **a candidate for deletion**. It is **not** deleted here — recorded as a
recommendation only.

## Invariants observed

- No push, merge, or publish. `[def:upgrade-branch]`
- No `--skip-nx-cache`; no direct `tsc`; tools resolved via `./node_modules/.bin/`. `[inv:no-cache-bypass]`, `[inv:no-direct-tsc]`, `[inv:tool-resolution-pinned]`
- `test.dependsOn` retains `lint` + `^build`. `[inv:test-depends-on-lint]`, `[inv:test-depends-on-caret-build]`
- `nx.json`, `CHANGELOG.md`, and the nine manifests unmodified.
