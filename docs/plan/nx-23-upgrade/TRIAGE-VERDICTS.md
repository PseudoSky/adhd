# Triage verdicts — commit-gate failures after the vite 8 bump

Three test targets failed the commit gate immediately after the `vite ~6.4.3 -> ^8.3.0`
bump. This record gives each an explicit, cited verdict so no later state assumes the bump
was clean. It is the **input** consumed by `gate-triage-absorbed`; it is not a re-derivation.

Source: a `debug` dispatch that root-caused all three targets with an A/B on the same
worktree, the only difference being the `vite` pin. Mechanism for the CJS failures:
`VITE-CJS-REPAIR.md` (BUG-BUILD-002).

## Verdict table

| target | verdict | disposition | evidence |
|---|---|---|---|
| `apigen-cli:test` | **CAUSED BY VITE 8** (high confidence) | **Fixed** — `vite-cjs-import-meta-repair`, commit `7916e639` | A/B: vite 6.4.3 → 28 files / 188 tests pass, exit 0; vite 8.3.0 → 11 failed / 17 passed files, 26 failed / 162 passed tests |
| `backlog:test` | **CAUSED BY VITE 8** (high confidence) | **Fixed** — `vite-cjs-import-meta-repair`, commit `7916e639` | A/B: vite 6.4.3 → 64 files / 701 passed + 3 skipped, exit 0; vite 8.3.0 → spawned `node dist/index.js` threw `ERR_INVALID_ARG_VALUE`; `{}.url` appeared 5x in `entrypoint/backlog/dist/index.js` |
| `apigen-plugin-java-javalin:test` | **FLAKE (environment/load), NOT a regression** (high confidence) | **Still open as a flake** — not bump-caused, not covered by the CJS fix | Fails under BOTH vite 6 and vite 8; a different test times out each run (`process-cleanup.spec.ts` one run, `plugin.spec.ts` the next); `7/8` pass every time |
| `apigen-engine-conformance` `vectors.spec.ts` | **CAUSED BY VITE 8** | **Fixed** — `vite-cjs-import-meta-repair`, commit `7916e639` | Duplicate `project` import binding; vite 6's esbuild tolerated it, vite 8's stricter `vite:oxc` parser rejected it with `[PARSE_ERROR] Identifier 'project' has already been declared` |

## Target 1 — `apigen-cli:test` → CAUSED BY VITE 8, now fixed

- vite 6.4.3: 28 files / 188 tests PASS, exit 0.
- vite 8.3.0: 11 failed / 17 passed files; 26 failed / 162 passed tests.
- Root cause: Vite 8's Rolldown replaces `import.meta` with `{}` in `cjs` output, so
  `createRequire(import.meta.url)` became `createRequire({}.url)` ===
  `createRequire(undefined)` and threw `ERR_INVALID_ARG_VALUE` at **module load**.
- Disposition: **explained and fixed** by `vite-cjs-import-meta-repair` (commit `7916e639`),
  which restored the CJS `import.meta.url` shim. Recorded as *explained*, not an open flake.
- Validation this state (post-fix, vite 8.3.0 toolchain): `nx test apigen-cli` → **29 files /
  192 tests passed, exit 0**. The disposition holds; the module-load throw is gone.

## Target 2 — `backlog:test` → CAUSED BY VITE 8, now fixed

- vite 6.4.3: 64 files / 701 passed + 3 skipped, exit 0.
- vite 8.3.0: the spawned `node dist/index.js` threw `ERR_INVALID_ARG_VALUE`; `{}.url`
  appeared 5x in `entrypoint/backlog/dist/index.js`.
- Same root cause and disposition as target 1 — **explained and fixed** by
  `vite-cjs-import-meta-repair` (commit `7916e639`).
- Validation this state (post-fix, vite 8.3.0 toolchain): `nx test backlog` → **64 files /
  701 passed + 3 skipped, exit 0** — identical to the vite 6 baseline. The disposition holds.

## Target 3 — `apigen-plugin-java-javalin:test` → FLAKE, still open

- **Not a regression.** It fails under **both** vite 6 and vite 8, with a **different** test
  timing out on each run (`process-cleanup.spec.ts` one run, `plugin.spec.ts` the next),
  `7/8` passing every time.
- Mechanism (found by the executor of `vite-cjs-import-meta-repair`): it and
  `apigen-engine-conformance:test` both call `findFatJar()` → `mvn package` against the
  **shared** `packages/apigen/java/target` directory, so under `nx affected -t test`
  parallelism the two Maven builds collide.
- Proven not bump-caused: `mvn package -DskipTests` standalone → BUILD SUCCESS;
  `nx test apigen-plugin-java-javalin` alone → green; Nx itself flags the task flaky.
- Disposition: **open flake with a named mechanism** — not caused by the bump, not covered
  by the CJS fix. Fixing it is outside this state's reservation.

## Also recorded (same session, related)

`apigen-engine-conformance/src/test/vectors.spec.ts` had a duplicate `project` import binding
that vite 6's esbuild tolerated and vite 8's stricter `vite:oxc` parser rejects
(`[PARSE_ERROR] Identifier 'project' has already been declared`). It was a genuine regression
from the bump and was fixed in commit `7916e639`.

## References

- `VITE-CJS-REPAIR.md` (BUG-BUILD-002) — the defect mechanism and the fix.
- Commit `7916e639` — `vite-cjs-import-meta-repair` (CJS `import.meta.url` shim +
  `vectors.spec.ts` duplicate-import fix).
