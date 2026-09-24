/**
 * spawn-timeout.ts — the ONE owner of the child-process spawn-timeout policy
 * shared by every real-spawn helper in this package (`spawn-backlog-bin.ts`'s
 * `runBacklogBin`/`runBacklogBinRaw`, `spawn-isolated-bin.ts`'s
 * `runIsolatedBin`, and `cli.e2e.ts`'s local `runGlobalScoped`).
 *
 * WHY this helper exists. Each of those sites used a hardcoded
 * `timeout: 30_000`. On a CPU-starved host — this box routinely measures load
 * 100–222 on 10 cores from concurrent agent sessions plus a concurrent
 * `pnpm release` — the spawned bin does its actual work in well under a
 * second (~354 ms measured) yet the OS can starve its EXIT past 30 s, so
 * `spawnSync` returns `ETIMEDOUT` for a command that in fact SUCCEEDED. The
 * helper then throws, and the pre-commit (Gate 3) / pre-push
 * (`nx affected -t test`) gates become un-passable on a loaded box even when
 * the staged change is green (BACKLOG 345973b3, 2f117762).
 *
 * The default is deliberately generous — 120_000 ms, 4x the old hardcoded
 * 30 s. The observed failure mode is exit-scheduling starvation under 10–20x
 * CPU oversubscription, not slow work: a ~350 ms child starved even 100x
 * still finishes well inside 120 s, while a genuine hang is still bounded.
 * The value mirrors the repo's established generous-timeout precedent
 * (`tools/nx-plugins/build/executors/smoke-test/clean-room-smoke.mjs`'s
 * `ADHD_SMOKE_INSTALL_TIMEOUT_MS`, default 120_000).
 *
 * `ADHD_SPAWN_TIMEOUT_MS` overrides the default. It is read at CALL time
 * (not module load), so a spec can set it after import; a caller that passes
 * an explicit timeout keeps full, final control.
 */
export function spawnTimeoutMs(): number {
  return Number(process.env.ADHD_SPAWN_TIMEOUT_MS ?? 120_000);
}
