# QA test variance, tail: entrypoint/policy specs (qa-variance)

Continues `docs/discovery/qa-test-variance-tail-policy-backlog-nx.md`, which found the production cause and only sampled these specs. This pass read every spec below in full (and `tmp.ts`, `capture.ts`, `fixtures.ts`, `run-deps.ts`, `wrapper/ir.ts`, `wrapper/package.ts`, `wrapper/mount.ts`, `entry/http.ts`). No test, build, nx or tsc command was run; every change is **verification pending (tests not run per user)**. No production file was edited. Nothing was merged.

## Fixed

### P1. Test support: `useScratchDirs` (`src/test/helpers/tmp.ts`)
- Cause: `withTmpDir` created a directory, removed it recursively, then ran `rmdir` on the shared `tmp/policy` root after EVERY test. With parallel vitest workers the root is removed and re-created continuously, and `makeDir` has an `ENOENT` retry loop for exactly that race, so per-test cost is dominated by cross-worker filesystem contention (IO spikes), not by the test.
- Fix: new `useScratchDirs(name)` registers one scratch parent per spec file, removed in a single `afterAll` (which runs after a failing test too). `fresh(label)` / `with(label, fn)` hand out a new empty leaf directory under it. The root is touched once at file start and once at file end. Directories are never shared between `fresh()` calls, so a mutating test cannot affect another. `withTmpDir` is unchanged (s2 and s6 still use it, outside this scope).

### P2. `review-fixes-entrypoint.spec.ts`: one real bake instead of five
- Cause: `inspectChanged` called the real `writeBakedIr`, which runs a live ts-morph extraction of the client declarations (the file's own comment: several seconds), in five cases (fresh + four stale variants), and `e1-quiet` a sixth time. Those are the dominant, load-scaled seconds in this file.
- Fix: the artifact is baked once by the real `writeBakedIr` in a `beforeAll` of the describe (`hookTimeout` raised to match the file's 60 s `testTimeout`); each case writes a copy of the baked text and mutates its JSON exactly as before. Every assertion is untouched. Cases that test the live fallback (`e1-warn`, `e1-quiet`'s live half) and the `ir-artifact` end-to-end case (`E10 --out under dist/`) still run their own live extraction on purpose. If `writeBakedIr` regressed, the `beforeAll` fails and the whole describe goes red.
- `e4`, `e12-level`, `e12-doctor-ok` shared one identical `WORKSPACE_YAML` directory and `e12-doctor-bad` a `BROKEN_YAML` one, each re-created per case; they now use two directories built once (`verify` and `doctor` only read their working directory). All other cases use `useScratchDirs` leaves.

### P3. `s3-run-bin.spec.ts`: one demo tree for the file
- Cause: every case created three directories plus the gate file and removed them.
- Fix: the tree and gate are built once in `beforeAll`. Cases only read it; each case writes its own uniquely numbered attributes file; `who.json`, `bad-attrs.json` and the D-07 forced gate use file names only their one case touches (the D-07 case previously rewrote the shared `gate.yaml`; it now writes `gate-forced.yaml`). Assertions unchanged.

### P4. `s5-narrow.spec.ts`: one demo tree for the file
- Cause: every case re-created and re-wrote the narrow policy and two directories; `s5-lib` created a directory only to obtain a path string.
- Fix: one tree in `beforeAll`; `narrow` and `check` never write, so cases share it. The "nothing is stored or issued" case keeps its OWN fresh directory so its before/after `readdir` comparison cannot be masked by files an earlier case left behind (that would silently weaken it). `s5-lib` uses the shared path.

### P5. `s7-mcp-json.spec.ts`, `s7-serve.spec.ts`, `s8-serve-handshake-and-precedence.spec.ts`
- Moved from `withTmpDir` to `useScratchDirs` leaves (fresh per case; no per-case root churn). They are not shared further on purpose: s7-mcp-json asserts exact `readdir` listings, inode changes, file modes and backup mtimes of the directory it mutates; s7-serve and s8 write policy and attribute files that cases then rewrite mid-session (`who.json`, `.mcp.json`). In s8 the fake-timer cases no longer remove a directory while fake timers are active (cleanup is in `afterAll`).

### P6. `http-entry.spec.ts`: waits were turn counts, now a bounded deadline
- Cause: `untilUp` and the ephemeral-port case waited for the entry with `for (attempt < 2000)` over `setImmediate` turns. A refused connection costs microseconds, so 2000 attempts is well under a second, while the file's own comment says a cold live extraction takes seconds. Under load or with no baked `dist/api.ir.json` the loop could exhaust before the server came up ("never came up", or `expect(servers()).toBe(before + 1)` failing). The busy loop also competes with the extraction for CPU.
- Fix: `waitFor` / `untilUp` poll on real 10 ms timers against a 50 s deadline (below the 60 s test timeout). Stop conditions are the same as before (entry settled, connection accepted, server count changed). Assertions unchanged. Tier P and the real listening sockets are kept.

## Kept-unfixed

- `http-entry.spec.ts` `vi.resetModules()` per case: needed. `src/entry/http.ts` starts the server in a top-level `await` on import, so each case must re-evaluate it, and `resetModules` is the only mechanism that re-runs it. A cache-busting import query would keep dependency modules loaded but would carry module-level state (telemetry init, plugin singletons) between cases, which cannot be proven safe without running. The cost that remains is the production cause below; the four bad-port cases exit before any package build, so their cost is module-graph load only.
- `runCli` / `runVerb` per case in s3 and s5: each call is the unit under test (in-process CLI per consumer call); amortizing it would mean sharing results between cases.
- `review-fixes` `E10 --out under dist/`, `e1-warn`, `e1-quiet` live extractions: these ARE the behaviour under test (bake end-to-end, stale-artifact fallback, live equals baked).
- s7-serve / s8 per-case serve sessions: each session is a real wiring of host transport, serve verb and stub upstream; sessions carry mutable state (calls log, process state) and are intentionally per case.

## Production-cause (no production edit)

`entrypoint/policy/src/wrapper/ir.ts` `extractPolicyOperations` -> `inspectBakedIr` (called from `buildPolicyPackage`, `wrapper/package.ts:42`) re-reads and JSON-parses the baked artifact and re-walks and sha256-hashes every `.d.ts` under the client surface root (`surfaceDigest`, ir.ts:89-105) on every call, and with no artifact performs a full live ts-morph extraction. Nothing is memoised per process, so every in-process CLI/HTTP call in these specs repays it. Suggested fix (production): memoise the `extractPolicyOperations` result (and the `surfaceDigest`) per process keyed by `distDir`, invalidating on the artifact's mtime/size so a re-baked file is still seen, and expose a test reset hook. The `E1` stale/fresh cases in `review-fixes` (which vary the artifact under one `distDir`) would then need that invalidation to keep their teeth. Not done here by instruction.

## Tests obsoleted
None.

## Out-of-scope observed
- `s2-check-evaluate.spec.ts` and `s6-verify-explain-draft.spec.ts` still use per-test `withTmpDir` (same root churn as P1, plus the same shared `WORKSPACE_YAML` setup); they are outside this brief's list and are the obvious next candidates for `useScratchDirs`.
- Other agents' uncommitted edits sit in this worktree (orchestrator, nx-plugins specs); only the explicit paths below were committed.

## Remaining
- Run the policy `test` target once (user holds the instruction not to run tests). Things to read in the first run: the `review-fixes` `beforeAll` bake time, `afterAll` removing `tmp/policy` cleanly (`ls tmp/policy` empty afterwards), and `git status --porcelain` clean.
- Red runs for the changed headers are `pending`.
