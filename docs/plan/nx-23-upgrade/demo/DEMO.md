# 🎬 Nx 23 / Vite 8 Upgrade — Live Demo & Acceptance Script

> Land a five-major Nx upgrade, remodelled onto inferred targets, without losing the publish gate — and make the test loop file-granular without ever going green having run nothing.

**What this is.** A presentation-grade walkthrough of the `nx-23-upgrade` plan that doubles as its acceptance test. Follow it top to bottom and you will (a) experience the change the way a developer on this repo does, and (b) prove every outcome works — with exact commands, exact data, and pass/fail checks. It is the contract for what "done" means: if it is demonstrated here, it must work; if it must work, it is demonstrated here.

---

## 0 · How to Read This Script

**Legend**

| Marker | Meaning |
|---|---|
| 🎬 **Scene** | The story beat — what's happening and why the persona cares. Read this aloud in a demo. |
| ▶️ **Do** | The exact action to take, with literal input data. |
| 👀 **Expect** | The exact observable result. Volatile parts shown as ⟨…⟩. |
| ✅ **Verify** | Binary pass/fail assertions. Tick each only if it is literally true. |
| 🔗 **Proves** | Requirement and capability IDs this beat satisfies. |
| 📎 **Source** | What grounds this step — plan artifact, spec section, or file it came from. |
| ⟦U#⟧ | An **unresolved stub**: a value guessed because the plan does not specify it. Logged in `UNRESOLVED.md` beside this file. |
| ⚠️ **Edge / 🛟 Recovery** | A deliberately adversarial or failure-then-recover beat. |

**Conventions**

- Shell prompt is `$`. All commands run from the worktree root: `.worktrees/nx-perf-upgraded`.
- Every command is copy-paste runnable as written.
- Values shown as ⟨like-this⟩ vary per run; the assertion next to them states what stays invariant.
- Tokens shown as ⟦U#⟧ are interfaces this script had to guess; each is listed in `UNRESOLVED.md` beside this file — confirm them before treating the step as authoritative.
- This script never pushes, merges to the default branch, or publishes. Its teardown is a clean working tree, not a released artifact.

---

## 1 · Cold Open — The Hook

🎬 **Scene.** You are a developer on a monorepo that runs ~35 concurrent worktrees and 68 Nx projects. Someone has done the hard part of the Nx 18 → 23 upgrade and left it on a branch. It builds. It tests. And it cannot land — because the branch carries five compiler relaxations that `main` does not have, 136 task targets that merely restate what Nx can already infer, and a commit gate that re-runs entire package suites when you change one file. Meanwhile the branch's newest feature — sharing the task cache across worktrees — has already produced a cached PASS belonging to a *different* worktree whose suite never ran.

> **The promise we'll prove:** the upgrade lands with the type-checker intact, the graph reduced to what Nx infers, and a test loop that runs only the specs covering your change — and *fails loudly* rather than reporting success when it selects nothing.

🔗 **Proves (framing):** REQ-001 · REQ-006 · REQ-011 · REQ-013 · CAP-001 · CAP-006 · CAP-007
📎 **Source:** `docs/plan/nx-23-upgrade/SCOPE.md` §1 (Outcomes), §2 (Scope boundaries)

---

## 2 · Cast, World & Cold-Start Setup

### 2.1 Meet the developer

A **monorepo developer on this repo** — human or agent. They touch one source file and want the commit gate to run the tests that file actually affects, not every suite in the package. They are the consumer of every outcome in this plan; the secondary consumer is the release path, which reaches dependency checking only through the default test target.

### 2.2 The Canonical Demo Dataset

All literal paths used throughout. Nothing else is fabricated.

| Name | Literal value | Why this one |
|---|---|---|
| Base package | `packages/data/data-base-transforms` | Small, has one spec per source file |
| Base source file | `packages/data/data-base-transforms/src/lib/date.ts` | Has `date.spec.ts` in the same package |
| Dependent package | `packages/data/data-query-engine` | Its `query.ts` / `parser.ts` / `filters.ts` import the base package |
| Uncovered input | `packages/data/data-base-transforms/README.md` | A real repo file no spec can cover — the zero-selection case |
| tsc-built project | `agent-core-policy` | Builds with the tsc executor, not vite |
| Vite-built project | `data-query-engine` | Builds with the vite executor |
| Bespoke second pass | `dispatch-cli:build-bin` | Compiles a bin entry into an already-populated dist |

### 2.3 Prerequisites

- Node ≥ 22.12 (`node --version`)
- pnpm 8.15.9 (`pnpm --version`)
- The worktree checked out at `.worktrees/nx-perf-upgraded`, branch `perf/nx-upgraded`
- `node_modules` installed in that worktree
- A quiet machine — this box runs ~35 worktrees; bound every test run

### 2.4 Cold Start — From Nothing to Running

▶️ **Do**
```bash
cd .worktrees/nx-perf-upgraded
git rev-parse --abbrev-ref HEAD
pnpm install --frozen-lockfile
./node_modules/.bin/nx --version
./node_modules/.bin/nx show projects | tr ',' '\n' | wc -l
```

👀 **Expect**
```
perf/nx-upgraded
Lockfile is up to date, resolution step is skipped
Nx Version:
- Local: v23.2.1
- Global: Not found
⟨68⟩
```

✅ **Verify**
- [ ] `git rev-parse --abbrev-ref HEAD` prints exactly `perf/nx-upgraded`
- [ ] `nx --version` reports `Local: v23.2.1`
- [ ] `nx show projects` lists ⟨68⟩ projects and exits 0

🔗 **Proves:** REQ-001 · CAP-001
📎 **Source:** `docs/plan/nx-23-upgrade/BASELINE.md` (measured at `f03b9aef`); ⟦U3⟧ inferred — see UNRESOLVED.md

---

## 3 · The Journey

### Act 1 — What does this branch actually carry?

🎬 **Scene.** Before trusting a five-major upgrade, the developer wants to know what is really installed — not what `package.json` claims.

#### 1.1 · The resolved toolchain   (happy)

🎬 **Scene.** Version declarations drift from installed reality. The developer checks what actually resolved.

▶️ **Do**
```bash
node -e "const p=require('./package.json').devDependencies; console.log('nx',p.nx,'vite',p.vite,'vitest',p.vitest)"
node -e "console.log('installed vite', require('vite/package.json').version)"
node -e "console.log('installed vitest', require('vitest/package.json').version)"
npm view vite version
```

👀 **Expect**
```
nx 23.2.1 vite ^8.3.0 vitest 4.1.9
installed vite 8.3.0
installed vitest 4.1.9
8.3.0
```

✅ **Verify**
- [ ] The declared Nx version is `23.2.1`, which equals the latest published (`npm view nx version` → `23.2.1`)
- [ ] Installed vite is `8.3.0`, equal to the latest published
- [ ] Installed vitest is `4.1.9`

🔗 **Proves:** REQ-001 · REQ-002 · CAP-001
📎 **Source:** `SCOPE.md` §3 (verified facts table)

#### 1.2 · The effective graph   (happy)

🎬 **Scene.** The developer counts what the graph actually contains, because that number is the before-picture for the remodel.

▶️ **Do**
```bash
./node_modules/.bin/nx show projects | tr ',' '\n' | wc -l
rg -o -N '"@[a-z]+/[a-z-]+:[a-z-]+"' -g '**/project.json' . | sed 's/.*://; s/"//g' | sort | uniq -c | sort -rn
```

👀 **Expect**
```
⟨68⟩
⟨57⟩ test
⟨47⟩ build
⟨15⟩ tsc
⟨12⟩ release-publish
⟨5⟩ lint
```

✅ **Verify**
- [ ] The project count matches §2.4
- [ ] The five executor counts are recorded in `BASELINE.md` and match this run
- [ ] Every one of these counts is treated as a *measured* number, not a remembered one

🔗 **Proves:** REQ-006 · CAP-003
📎 **Source:** `SCOPE.md` §5; measured on the branch

#### 1.3 · ⚠️ The ceiling nobody chose   (edge)

🎬 **Scene.** A teammate asks why vitest is not on 5. The developer answers with the peer range rather than an opinion.

▶️ **Do**
```bash
node -e "const p=require('@nx/vitest/package.json'); console.log(p.version, JSON.stringify(p.peerDependencies))"
npm view vitest version
```

👀 **Expect**
```
23.2.1 {"vitest":"^3.0.0 || ^4.0.0","vite":"^5.0.0 || ^6.0.0 || ^7.0.0 || ^8.0.0","@nx/eslint":"23.2.1"}
5.0.1
```

✅ **Verify**
- [ ] The peer range is `^3.0.0 || ^4.0.0`, which excludes the published `5.0.1`
- [ ] The ceiling is recorded as an interface contract with its evidence, not as a preference
- [ ] No state in this plan attempts a vitest 5 upgrade

🔗 **Proves:** REQ-003 · CAP-001
📎 **Source:** `interfaces.json` → `nx-vitest-peer-range` (provenance: vendored-source, `node_modules/@nx/vitest/package.json`)

---

### Act 2 — Make it landable

🎬 **Scene.** The branch builds today. The question is whether it still builds once the migration relaxations come out.

#### 2.1 · A package builds and type-checks   (happy)

🎬 **Scene.** The developer builds three representative packages — a vite-built one, a shared-data one, and a tsc-built one.

▶️ **Do**
```bash
./node_modules/.bin/nx run-many -t build --projects=agent-base-types,data-query-engine,agent-core-policy
echo "exit=$?"
```

👀 **Expect**
```
NX  Successfully ran target build for ⟨3⟩ projects
exit=0
```

✅ **Verify**
- [ ] Exit code is 0
- [ ] All three projects report success
- [ ] `packages/data/data-query-engine/dist/index.js` exists afterwards

🔗 **Proves:** REQ-005 · CAP-002
📎 **Source:** `criteria.json` → `tsconfig-shim-removal.4`

#### 2.2 · ⚠️ The build gate has teeth   (edge)

🎬 **Scene.** A green build proves nothing if the type-checker is dead. The developer deliberately breaks a type and demands the build notice.

▶️ **Do**
```bash
printf '\n\nexport const __shimProbe: number = "not a number";\n' >> packages/agent/agent-base-types/src/index.ts
./node_modules/.bin/nx build agent-base-types; echo "exit=$?"
git restore packages/agent/agent-base-types/src/index.ts
```

👀 **Expect**
```
src/index.ts:⟨35⟩:⟨14⟩ - error TS2322: Type 'string' is not assignable to type 'number'.
NX   Found type errors. See above.
exit=⟨1⟩
```

✅ **Verify**
- [ ] The build exits **non-zero** with a TS2322 diagnostic
- [ ] After `git restore`, `git status --porcelain -- packages/agent/agent-base-types/src/index.ts` prints nothing
- [ ] If the build exits 0 here, the type-checker is dead and REQ-005 is unmet — stop the run

🔗 **Proves:** REQ-005 · CAP-002
📎 **Source:** `README.md` → `[dod.3]` negative control; `contexts/tsconfig-shim-removal.md`

#### 2.3 · ⚠️ The migration relaxations are gone   (edge)

🎬 **Scene.** The reason the branch could not land: it carried compiler relaxations `main` does not have.

▶️ **Do**
```bash
node -e "const c=require('./tsconfig.base.json').compilerOptions; const bad=['strict','types','esModuleInterop','ignoreDeprecations','noUncheckedSideEffectImports'].filter(k=>k in c); console.log(bad.length? 'STILL PRESENT: '+bad.join(','):'SHIMS_GONE')"
git diff main..HEAD -- tsconfig.base.json
```

👀 **Expect**
```
SHIMS_GONE
⟨empty diff⟩
```

✅ **Verify**
- [ ] None of the five keys is present in the shared compiler config
- [ ] The diff against `main` for that file is empty (byte-parity)
- [ ] The build in 2.1 still passed *after* this removal — the two beats together are the proof

🔗 **Proves:** REQ-004 · CAP-002
📎 **Source:** `SCOPE.md` §4 corrections; `contexts/tsconfig-shim-removal.md`

---

### Act 3 — Remodel the graph

🎬 **Scene.** 136 explicit targets restate what Nx already infers. The developer removes the duplicates and proves the artifacts survive.

#### 3.1 · No shadowing targets remain   (happy)

🎬 **Scene.** The developer scans every manifest for executors that duplicate a registered plugin.

▶️ **Do**
```bash
rg -l '"@nx/(vitest:test|vite:build|js:tsc|js:release-publish|eslint:lint)"' -g '**/project.json' . ; echo "exit=$?"
```

👀 **Expect**
```
⟨no output⟩
exit=1
```

✅ **Verify**
- [ ] No manifest declares any of the five shadowing executors
- [ ] `nx show projects` still lists ⟨68⟩ projects — the graph loads
- [ ] The js plugin is registered, so the previously tsc-built projects still have a build target

🔗 **Proves:** REQ-006 · CAP-003
📎 **Source:** `criteria.json` → `graph-test-build-inferred.1/.2`, `graph-js-tsc-inferred.1/.2`

#### 3.2 · Build through the inferred target   (happy)

🎬 **Scene.** Deleting a declaration is only safe if the inferred replacement produces the same thing.

▶️ **Do**
```bash
./node_modules/.bin/nx show project data-query-engine --json | rg -o '"build"' | head -1
./node_modules/.bin/nx build data-query-engine; echo "exit=$?"
ls -la packages/data/data-query-engine/dist/index.js
```

👀 **Expect**
```
"build"
NX  Successfully ran target build for project data-query-engine
exit=0
-rw-r--r--  ⟨...⟩  packages/data/data-query-engine/dist/index.js
```

✅ **Verify**
- [ ] The project still exposes a `build` target after the explicit one was deleted
- [ ] The build exits 0
- [ ] The artifact exists at the same path it did before

🔗 **Proves:** REQ-007 · CAP-004
📎 **Source:** `references.json` → `target-artifact-parity`; `criteria.json` → `graph-test-build-inferred.4/.6`

#### 3.3 · Run a suite through the inferred target   (happy)

🎬 **Scene.** A build target that survives but a test target that silently stops running tests is the worst outcome.

▶️ **Do**
```bash
./node_modules/.bin/nx run data-base-transforms:test; echo "exit=$?"
```

👀 **Expect**
```
 ✓ ⟨...⟩ (⟨9⟩ tests)
 Test Files  ⟨9⟩ passed
exit=0
```

✅ **Verify**
- [ ] Exit code is 0
- [ ] The output reports executed tests — **not** "No test files found"
- [ ] The target was contributed by the registered plugin, not a manifest declaration

🔗 **Proves:** REQ-007 · CAP-005
📎 **Source:** `criteria.json` → `graph-test-build-inferred.5`

#### 3.4 · ⚠️ The tsc-built project survives the plugin registration   (edge)

🎬 **Scene.** The trap the plan was written around: the js plugin was *not* registered, so deleting these targets first would have deleted the build target outright.

▶️ **Do**
```bash
./node_modules/.bin/nx show project agent-core-policy --json | rg -o '"build"' | head -1
./node_modules/.bin/nx build agent-core-policy; echo "exit=$?"
ls packages/agent/agent-core-policy/dist
```

👀 **Expect**
```
"build"
NX  Successfully ran target build for project agent-core-policy
exit=0
⟨index.js  index.d.ts  drizzle⟩
```

✅ **Verify**
- [ ] A `build` target is still present
- [ ] The build exits 0
- [ ] The `drizzle` assets declared by the original target are still emitted

🔗 **Proves:** REQ-008 · CAP-004
📎 **Source:** `contexts/graph-js-tsc-inferred.md`; `criteria.json` → `graph-js-tsc-inferred.3/.4`

#### 3.5 · ⚠️ The release chain survives   (edge)

🎬 **Scene.** Releases reach their gating tests through a dependency chain. Inference supplies the target; the chain is a separate promise.

▶️ **Do**
```bash
./node_modules/.bin/nx show project apigen-plugin-jsonschema --json | rg -o 'nx-release-publish'
./node_modules/.bin/nx run dispatch-cli:build-bin; echo "exit=$?"
ls packages/data/data-query-engine/dist/index.js && ls entrypoint/dispatch-cli/dist/bin/cli.js
```

👀 **Expect**
```
nx-release-publish
NX  Successfully ran target build-bin for project dispatch-cli
exit=0
⟨both paths listed⟩
```

✅ **Verify**
- [ ] `nx-release-publish` is still present on a publishable project
- [ ] The bespoke second-pass compile still exits 0
- [ ] Running it did **not** wipe the sibling `build` output in the shared dist directory

🔗 **Proves:** REQ-009 · CAP-010
📎 **Source:** `contexts/graph-release-eslint-inferred.md`; `criteria.json` → `graph-release-eslint-inferred.3`, `graph-js-tsc-inferred.5`

#### 3.6 · ⚠️ Lint leaves the tree alone   (edge)

🎬 **Scene.** A check path that rewrites tracked files is not a check path. The developer runs lint and then looks at `git status`.

▶️ **Do**
```bash
./node_modules/.bin/nx run apigen-plugin-ts-types:lint; echo "exit=$?"
git status --porcelain -- packages/apigen/apigen-plugin-ts-types/package.json; echo "dirty=$?"
```

👀 **Expect**
```
NX  Successfully ran target lint for project apigen-plugin-ts-types
exit=0
⟨no output⟩
dirty=0
```

✅ **Verify**
- [ ] Lint exits 0
- [ ] `git status --porcelain` prints **nothing** for that manifest
- [ ] The lint target depends on the check-only sibling, not the rewriting one

🔗 **Proves:** REQ-010 · CAP-010
📎 **Source:** `contexts/graph-release-eslint-inferred.md`; `criteria.json` → `graph-release-eslint-inferred.4/.5`

---

## 4 · The Climax — Only the tests that matter, and never a false green

🎬 **Scene.** This is the payoff the whole demo built toward. The developer changes one line in a base package. On the default branch that costs the entire suite of every affected package. Here it costs the specs that actually cover the change — and if the selection comes back empty, the command **refuses to report success**. That last part is the whole point: the previous attempt at this shipped a selector that printed "No test files found" and exited 0, so the gate went green having run nothing.

▶️ **Do**
```bash
pnpm run test:related -- packages/data/data-base-transforms/src/lib/date.ts; echo "exit=$?"
```

👀 **Expect**
```
selected=⟨4⟩/⟨22⟩
 ✓ packages/data/data-base-transforms/src/lib/date.spec.ts
 ✓ packages/data/data-query-engine/src/lib/⟨...⟩.spec.ts
exit=0
```

✅ **Verify**
- [ ] Exit code is 0
- [ ] A selected-count line is printed, and the selected count is **strictly below** the package's full suite count
- [ ] `date.spec.ts` is among the selected files
- [ ] At least one selected file belongs to `data-query-engine` — a *different* package that imports the changed one. On the default branch this selected zero.
- [ ] The run took materially less wall-clock than the package's full suite

🔗 **Proves:** REQ-011 · REQ-012 · CAP-006 · CAP-008
📎 **Source:** `README.md` → `[dod.5]`, `[dod.7]`; `scripts/check-cross-package-selection.mjs`; ⟦U2⟧ inferred — see UNRESOLVED.md

**And now the half that makes it trustworthy — the refusal.**

▶️ **Do**
```bash
pnpm run test:related -- packages/data/data-base-transforms/README.md; echo "exit=$?"
```

👀 **Expect**
```
no tests selected for ⟨1⟩ changed file(s)
exit=⟨1⟩
```

✅ **Verify**
- [ ] The command exits **non-zero**
- [ ] The output names the empty selection explicitly
- [ ] If this exits 0, the design is fail-open and REQ-013 is unmet — stop the run

🔗 **Proves:** REQ-013 · REQ-014 · CAP-007
📎 **Source:** `README.md` → `[dod.6]`; `scripts/check-zero-selection.mjs`; measured precedent in `memory` topic `nx-test-changed-scope`; ⟦U1⟧ inferred — see UNRESOLVED.md

---

## 5 · Resilience Sweep — Edges We Didn't Hit in the Story

#### 5.1 · ⚠️ The publish gate survived the absorption

🎬 **Scene.** Absorbing the config-repair branch brought a commit that dropped `lint` from the default test target. `main` had already reverted exactly that, because `publish` reaches dependency checking only through `test`.

▶️ **Do**
```bash
node -e "console.log(require('./nx.json').targetDefaults.test.dependsOn)"
rg -n 'nx affected --target=test' .githooks/pre-commit
```

👀 **Expect**
```
[ 'lint', '^build' ]
⟨line⟩:CI=true npx nx affected --target=test --files="$files" ⟨...⟩
```

✅ **Verify**
- [ ] The default test target still depends on both `lint` and `^build`
- [ ] The commit gate still runs an affected-test pass — it was not narrowed to the changed package
- [ ] A publishable project still reaches lint through its test target

🔗 **Proves:** REQ-014 · REQ-015 · REQ-018 · CAP-010
📎 **Source:** `README.md` → `[dod.8]`; `contexts/config-repair-absorbed.md`; `CHANGELOG.md` (BUG-060)

#### 5.2 · ⚠️ A sibling worktree's cached pass cannot be replayed here

🎬 **Scene.** With ~35 worktrees, Nx 23 pools the task cache and its database across siblings. A test target has reported a cached PASS belonging to another worktree whose suite never ran.

▶️ **Do**
```bash
node -e "console.log(require('./nx.json').cacheDirectory)"
node -e "const p=require('path'),r=process.cwd(),c=require('./nx.json').cacheDirectory; console.log('resolves inside checkout:', p.resolve(r,c).startsWith(r+p.sep))"
```

👀 **Expect**
```
.nx/cache
resolves inside checkout: true
```

✅ **Verify**
- [ ] A cache directory is declared, and it is **relative**
- [ ] It resolves inside this checkout, not to a shared or absolute location
- [ ] The trade is recorded: per-checkout isolation is bought at the cost of the cross-worktree sharing the upgrade introduced

🔗 **Proves:** REQ-016 · CAP-009
📎 **Source:** `README.md` → `[dod.10]`; `contexts/cache-isolation.md`

#### 5.3 · ⚠️ Branch hygiene

🎬 **Scene.** Nothing in this plan may land itself.

▶️ **Do**
```bash
git rev-parse --abbrev-ref HEAD
git status --porcelain
git log --oneline -3
```

👀 **Expect**
```
perf/nx-upgraded
⟨no output⟩
⟨three most recent plan commits⟩
```

✅ **Verify**
- [ ] HEAD is `perf/nx-upgraded`
- [ ] The working tree is clean
- [ ] Nothing was pushed (`git status -sb` shows no ahead/behind against a remote for this branch's new commits) and no merge to the default branch was performed

🔗 **Proves:** REQ-017 · CAP-009
📎 **Source:** `README.md` → `[dod.11]`; `SCOPE.md` §2 (out of scope: landing)

#### 5.4 · ⚠️ What file-level selection cannot see

🎬 **Scene.** Honesty about limits is part of the contract.

▶️ **Do**
```bash
rg -n 'dynamic|child process|spawned' docs/plan/nx-23-upgrade/TEST-SELECTION.md
```

👀 **Expect**
```
⟨lines naming dynamic imports and spawned child processes as blind spots⟩
```

✅ **Verify**
- [ ] The limitations are written down: dynamic `import(variable)` edges are invisible; spawned child processes resolve to built output
- [ ] The four child-process projects keep their opt-out and keep `^build`
- [ ] `^build` was not dropped from the test path

🔗 **Proves:** REQ-012 · CAP-008
📎 **Source:** `contexts/test-resolution-absorbed.md`; `_shared.md` → `[inv:test-depends-on-caret-build]`

---

## 6 · Teardown — Back to Zero

▶️ **Do**
```bash
git status --porcelain
./node_modules/.bin/nx reset --only-daemon 2>/dev/null || ./node_modules/.bin/nx reset
git status --porcelain
```

👀 **Expect**
```
⟨no output⟩
⟨no output⟩
```

✅ **Verify**
- [ ] The probe file from 2.2 is restored and the tree is clean
- [ ] No stray files were created under a tracked path
- [ ] The branch is exactly where it started, plus the plan's own commits

🔗 **Proves:** REQ-017 · CAP-002
📎 **Source:** `README.md` → Invariants; `AGENTS.md` (leave the tree as you found it)

---

## 7 · Coverage & Traceability Matrix

### 7.1 Requirements → Beats

| Req ID | Requirement (short) | Proven by beat(s) | Paths covered (H/E/R) | Status |
|---|---|---|---|---|
| REQ-001 | Nx is at the latest published 23 line with matching plugins | 1.1, 2.4 | H | ☐ |
| REQ-002 | Vite is at the highest version the Nx plugins support | 1.1 | H | ☐ |
| REQ-003 | The test runner sits at its peer-permitted ceiling, recorded | 1.3 | E | ☐ |
| REQ-004 | No migration-only compiler relaxation remains | 2.3 | E | ☐ |
| REQ-005 | A package build still type-checks | 2.1, 2.2 | H, E | ☐ |
| REQ-006 | Shadowing explicit targets are gone | 1.2, 3.1 | H | ☐ |
| REQ-007 | Inferred targets produce the same artifacts | 3.2, 3.3 | H | ☐ |
| REQ-008 | tsc-built projects still build after plugin registration | 3.4 | E | ☐ |
| REQ-009 | Release targets keep their dependency chains | 3.5 | E | ☐ |
| REQ-010 | The lint path no longer rewrites tracked manifests | 3.6 | E | ☐ |
| REQ-011 | A changed file selects only the specs covering it | 4.1 | H | ☐ |
| REQ-012 | A cross-package change still selects the dependent's specs | 4.1, 5.4 | H, E | ☐ |
| REQ-013 | A zero-selection run fails loudly | 4.2 | E | ☐ |
| REQ-014 | The full suite remains the default | 4.2, 5.1 | E | ☐ |
| REQ-015 | The commit gate still covers downstream consumers | 5.1 | E | ☐ |
| REQ-016 | Each checkout owns its task cache | 5.2 | E | ☐ |
| REQ-017 | All work sits on the upgrade branch | 5.3, 6 | H | ☐ |
| REQ-018 | The publish gate survives the sibling-branch absorption | 5.1 | E | ☐ |

### 7.2 Capabilities → Beats

| Cap ID | Capability | Proven by beat(s) | Status |
|---|---|---|---|
| CAP-001 | Verify the toolchain versions actually resolved | 1.1, 1.3 | ☐ |
| CAP-002 | Build and type-check a package | 2.1, 2.2, 2.3, 6 | ☐ |
| CAP-003 | Inspect the effective task graph for a project | 1.2, 3.1 | ☐ |
| CAP-004 | Build a project through an inferred target | 3.2, 3.4 | ☐ |
| CAP-005 | Run a package's suite through an inferred target | 3.3 | ☐ |
| CAP-006 | Select tests for a changed file | 4.1 | ☐ |
| CAP-007 | Detect and fail a zero-selection run | 4.2 | ☐ |
| CAP-008 | Preserve cross-package consumer coverage | 4.1, 5.4 | ☐ |
| CAP-009 | Isolate the task cache per checkout | 5.2, 5.3 | ☐ |
| CAP-010 | Absorb sibling branches without regressing the publish gate | 5.1, 3.5, 3.6 | ☐ |

### 7.3 Unresolved Interfaces & Gaps

- 3 unresolved interface stubs (⟦U1⟧–⟦U3⟧) and 2 scope gaps; full list in `UNRESOLVED.md`. Highest impact: ⟦U2⟧ — the exact stdout shape of the fast-path wrapper, which two beats assert against.

---

## 8 · Sign-Off

| Field | Value |
|---|---|
| Environment | ⟨OS / version / commit SHA⟩ |
| Run by | ⟨name or agent ID⟩ |
| Date | ⟨date⟩ |
| Beats passed | ⟨X of Y⟩ |
| Requirements proven | ⟨X of Y⟩ |
| Result | ☐ PASS &nbsp;&nbsp; ☐ FAIL |
| Notes / defects filed | ⟨…⟩ |

> A run is **PASS** only if every ✅ assertion is checked and every requirement in §7 is proven. One unchecked binary assertion = FAIL until resolved.
