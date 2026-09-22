# TEST-SELECTION-PROBE — revalidation of the changed-flag verdict on the upgraded toolchain

**State:** `test-selection-revalidated` (phase: tests) · **Date:** 2026-09-22
**Branch / worktree:** `perf/nx-upgraded` @ `8899bb2b`, `/Users/nix/dev/node/adhd/.worktrees/nx-perf-upgraded`
**Measurement only** — no defect is fixed here; this record is evidence, not a repair.

## Toolchain under test (measured)

```
$ ./node_modules/.bin/nx --version
Nx Version:
- Local: v23.2.1
- Global: Not found

$ node -e "…versions…"
vitest 4.1.9
nx 23.2.1
@nx/vite 23.2.1
vite 8.3.0
node v24.11.1
```

## Prior verdict being revalidated (the evidence, not a fact about this branch)

Measured 2026-09-18 on **Nx 18.3.4 / @nx/vite 18.3.4 / vitest 1.6.1 / vite 5.0.13 / Node v24.11.1**,
worktree `.worktrees/test-changed-scope` (branch `perf/test-changed-scope`, main @ `0d110a50`).
Recorded in memory topic `nx-test-changed-scope` (uid `01M2VADCXJPQ7W33P5G7XD7H24`). Three defects:

- **D1 — graph crash.** Adding ANY `options` under the `targetDefaults` **target-name** key `"test"`
  (e.g. `{"test":{"options":{"changed":true}}}`) broke project-graph construction. `nx show projects`
  → `LoadPluginError`/`ProjectConfigurationsError` wrapping `MergeNodesError` for
  `packages/apigen/java/project.json`. Root: `isCompatibleTarget` did
  `b.options?.command ?? b.options?.commands.join(' && ')`; the injected default had neither, so
  `.commands.join` threw `TypeError`. Fired for all 6 projects whose `test` was `nx:run-commands`.
  Proved it was the **presence** of `options`, not `changed` (`{"__probe":true}` reproduced it).
- **D2 — stringified boolean → fatal git invocation that HUNG.** `@nx/vite:test` forwarded options via
  `getOptionsAsArgv()` → `--changed=true`; vitest's `parseCLI` read it as the **string** `"true"`;
  vitest then ran `git diff --name-only true...HEAD` → fatal `exit 128`. Through Nx the task
  **hung** (single-project run hit a 240 s timeout; `nx affected` >21 min, killed). `changed:false`
  was also broken (`--changed=false` → string `"false"` → truthy → same fatal), so the proposed
  `-- --changed=false` CI mitigation was inert.
- **D3 — the one-character repair was FAIL-OPEN.** `changed: ""` → `getOptionsAsArgv` → `--changed=`
  → `parseCLI` → boolean `true` (worked). Verified end-to-end: **clean tree** → `No test files found,
  exiting with code 0` **plus** `NX Successfully ran target test` — a green gate having run **zero**
  tests. Bounded 4-project affected scope: 15 → 1 test file (93 % skipped) reported as success.

---

## D1 — targetDefaults `options` under a target-name key crashes graph construction

**Probe method.** Reproduced in isolation (no tracked file mutated) with the *same* Nx 23.2.1 binary.
A throwaway workspace at `<tmp>/nx-probe/{a,b}` (node_modules symlinked to this worktree) holds one
project whose `test` target is `nx:run-commands`:

```jsonc
// nx-probe/a/probe-lib/project.json
{ "name": "probe-lib", "projectType": "library",
  "targets": { "test": { "executor": "nx:run-commands",
                         "options": { "command": "echo probe-test-ran" } } } }
```

Variant **A** injects the exact prior shape `{"test":{"options":{"changed":true}}}` (options with
neither `command` nor `commands`). Variant **B** is the negative control, `{"test":{"options":{"command":"echo default-command"}}}`.

**Raw output.**

```
===== D1 VARIANT A: targetDefaults.test.options = {changed:true} (no command) =====
["probe-lib"]
EXIT=0

===== D1 VARIANT B (control): targetDefaults.test.options = {command:...} =====
["probe-lib"]
EXIT=0
```

The real repo already carries `options` under the target-name key `"test"`
(`nx.json` → `targetDefaults.test.options = { "cwd": ".", "command": "vitest run --config {projectRoot}/vite.config.ts" }`)
and its graph constructs:

```
$ NX_DAEMON=false ./node_modules/.bin/nx show projects
["workspace-base-vite-paths","apigen-plugin-java-javalin","dispatch-serializer-json", … ,"backlog","@adhd/source"]
```

The crashing expression no longer exists — Nx 23.2.1 optional-chains it
(`node_modules/nx/dist/src/project-graph/utils/project-configuration/target-merging.js:452-453`):

```js
const aCommand = a.options?.command ?? a.options?.commands?.join(' && ');
const bCommand = b.options?.command ?? b.options?.commands?.join(' && ');
```

**Verdict: D1 REFUTED on this toolchain.** Options under a target-name key no longer crash graph
construction — even with neither `command` nor `commands`, and even for `nx:run-commands` targets.
The 18.3.4 `TypeError` path (`?.commands.join`, no optional chain on `commands`) is gone.

**Implication for the fail-safe design.** The original objection that a target-default option cannot
be expressed at all is no longer true on Nx 23. A narrowed default *could* now be keyed by target
name without breaking the graph. This does **not** change the design decision — it removes a
*blocker*, it does not remove the *fail-open* hazard (see D3). The invariant `[inv:fail-safe-selection]`
still stands on D3's evidence, not on D1's.

---

## D2 — boolean option stringified into vitest's CLI → fatal git invocation that HANGS

**Probe method.** Two halves. (1) The vitest half, directly: `vitest run --changed=true --config
packages/data/data-base-transforms/vite.config.ts`, with a logging `git` shim first on `PATH` to
capture the exact git invocation. (2) The Nx half, end-to-end: `nx run data-base-transforms:test
--changed=true` (the branch runs `test` as `nx:run-commands` → `vitest run --config …`), bounded by
`timeout`.

**Raw output.**

Git calls issued by vitest 4.1.9 for `--changed=true`:

```
>> variant --changed=true
GIT-CALL: rev-parse --show-cdup
GIT-CALL: diff --name-only true...HEAD
GIT-CALL: diff --cached --name-only
GIT-CALL: ls-files --other --modified --exclude-standard
```

The stringification is therefore unchanged: vitest still receives the **string** `"true"` and still
issues `git diff --name-only true...HEAD`. That command fatals on its own:

```
$ git diff --name-only true...HEAD
fatal: ambiguous argument 'true...HEAD': unknown revision or path not in the working tree.
EXIT=128
```

But vitest no longer propagates it, and it does not hang:

```
===== D2a: vitest run --changed=true =====
 RUN  v4.1.9 …/packages/data/data-base-transforms
No test files found, exiting with code 0
EXIT=0
```

All four forms exit 0 with zero tests (no fatal, no hang):

```
VARIANT [--changed=true]  EXIT=0   No test files found, exiting with code 0
VARIANT [--changed=false] EXIT=0   No test files found, exiting with code 0
VARIANT [--changed=]      EXIT=0   No test files found, exiting with code 0
VARIANT [--changed]       EXIT=0   No test files found, exiting with code 0
```

End-to-end through Nx (the prior run hung here):

```
$ NX_DAEMON=false timeout 120 ./node_modules/.bin/nx run data-base-transforms:test --changed=true --excludeTaskDependencies
No test files found, exiting with code 0
 NX   Successfully ran target test for project data-base-transforms
  Run duration:      6.6s
EXIT=0
```

**Mechanism (why it no longer fatals).** Vitest 4's git runner is `tinyexec` — `import { x } from
'tinyexec'` (`node_modules/vitest/dist/chunks/cli-api.24X8XwN1.js:63`) — whose default does **not**
reject on a non-zero exit. `GitVCSProvider.resolveFilesWithGitCommand` (`…cli-api.24X8XwN1.js:12722-12731`)
wraps the call in `try/catch`, but the catch is never entered; `result.stdout` is `""`, so
`findChangedFiles` returns an empty set (`…:12732-12750`). Vitest 1.6.1 used a rejecting runner, so
the same git failure threw. The `collect()` path even documents the behaviour:
`// if run with --changed, don't exit if no tests are found` (`…:13404`).

**Verdict: D2 REFUTED on this toolchain.** The stringified-boolean parse and the fatal git invocation
both still occur, but the failure is **swallowed** rather than propagated: no fatal, no hang — a
clean `exit 0` with zero tests. `--changed=false` is no longer "truthy → fatal"; it, too, exits 0.

**Implication for the fail-safe design.** The old *hang* failure mode is gone, which removes the
"an operator will notice the task never finishes" safety net. The observable is now indistinguishable
from success — which makes the D3 hazard *worse*, not better, for any caller that trusts the exit code.

---

## D3 — a zero-selection run reports success (FAIL-OPEN)

**Probe method.** Selection surface `vitest run --changed[=…]` and the interface under contract
`vitest related <files...>` (`[iface:vitest-related-cli]`), plus the Nx end-to-end gate. Tree state
during the probes: HEAD `0b2216bb`; working tree had one modified plan file (`events.ndjson`) and two
untracked plan files — none of which any spec imports, so the changed set maps to zero specs.

**Raw output.**

Zero-selection, every form, exits 0 (from the D2 matrix above), and so does the contract interface:

```
$ (cwd=packages/data/data-base-transforms) vitest related src/index.ts
No test files found, exiting with code 0
EXIT=0

$ vitest related packages/data/data-base-transforms/README.md   # a real repo file no spec covers
No test files found, exiting with code 0
EXIT=0
```

And the Nx gate is green having run nothing (same run as D2):

```
$ nx run data-base-transforms:test --changed=true
No test files found, exiting with code 0
 NX   Successfully ran target test for project data-base-transforms
EXIT=0
```

For contrast, the narrow path *does* select when a spec actually covers the file (so this is not a
"selection is globally broken" artifact):

```
$ (cwd=packages/data/data-base-transforms) vitest related src/lib/date.ts
 ✓ src/lib/date.spec.ts (5 tests) 42ms
 Test Files  1 passed (1)
      Tests  5 passed (5)
EXIT=0
```

**Verdict: D3 CONFIRMED on this toolchain.** A run that selects zero tests exits **0** and reports
success — both through bare vitest and through the Nx target (`NX Successfully ran target test`).
The fail-open behaviour survives the Nx 18 → 23 and vitest 1.6 → 4 upgrade intact.

**Implication for the fail-safe design.** `[inv:fail-safe-selection]` ("a run that selects zero tests
is a FAILURE, never a success") and `[shape:fast-path-contract]` clause (1) are **confirmed by
measurement, not preference**: the toolchain will not fail a zero-selection run on its own, so the
guard must be added by the caller (`test-changed-optin`'s `check-zero-selection.mjs`). The default
must remain "run everything"; the narrow fast path stays explicit opt-in and must never be wired into
targetDefaults, the commit gate, CI, or the release path.

---

## Summary

| Defect | Prior toolchain (nx 18.3.4 / vitest 1.6.1) | This toolchain (nx 23.2.1 / vitest 4.1.9) |
|---|---|---|
| **D1** targetDefaults options under target-name key | graph crash (`TypeError` in `isCompatibleTarget`) | **REFUTED** — graph constructs; `?.commands?.join` guards it |
| **D2** stringified boolean → fatal git invocation | fatal `exit 128`, task **hangs** through Nx | **REFUTED** — git still fatals, but tinyexec swallows it; `exit 0`, 6.6 s |
| **D3** zero-selection reports success | fail-open (`No test files found`, exit 0, NX success) | **CONFIRMED** — identical fail-open |

The design decision to keep the **fail-safe default** (run everything; narrow path explicit opt-in;
zero selected ⇒ non-zero exit) is confirmed by measurement on the upgraded toolchain. D2's removal of
the hang removes an accidental safety net, strengthening the case for the explicit zero-selection
guard.
