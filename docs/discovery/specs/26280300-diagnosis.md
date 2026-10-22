# 26280300 AC0 — root-cause diagnosis (read-only)

Item: 26280300-8194-443b-b95c-2f12c84c2fb6 (memory-server: N concurrent instances). Spec: `26280300-memory-server-n100-instances.md`.
Method: read-only. Disk listings (`ls`, `stat`), the live-service jsonl logs under `~/.adhd/sox-ecosystem/memory-server/logs/`, and the sox source under `/Users/nix/dev/ai/sox-ecosystem` (HEAD dfd1b352). No process was started, stopped or signalled; nothing under `~/.memory` was written. Observation time: 2026-10-15 10:46-10:50 EDT (14:46-14:50Z).
Labels: **(verified)** = read in code or log with the cited evidence. **(hypothesis)** = consistent with evidence, not yet proven.

## 1. Observed facts

F1 (verified) Stale `-tshm` sidecars on disk, counted with `ls ~/.memory | rg stale` = 53 (the architect saw 51). By creator pid and database: 20 for `memory.db` from pid 9328 (the prod instance, alive since 22:11:37 EDT), 21 for `memory-dev.db` from pid 75391 (dev instance, last log line 02:25:31Z, no longer running). Rename times are 30.0-30.2 s apart (`ls -l --time-style=+%H:%M:%S.%N`, e.g. prod 10:30:35.56 -> 10:31:05.65 -> 10:31:35.79 -> 10:32:05.93). The count is held near 20 per database by the retention cap: the log shows `sidecar_sweep: pruned ...-p9328: exceeds retention count cap (rank 21 > keepRecentN=20)` and `pruned 12 stale WAL-index sidecar(s)` at 14:47:12Z. So the parent AC3 (bounded count) already holds; the defect is the churn that creates them.

F2 (verified) The filename stamp is the RENAME time in UTC, and the `-p<pid>` suffix is the renaming process (`sidecar-retention.ts:125-148`). A stale file's mtime is the `-tshm` creation time (rename preserves mtime): 30.04 s before its rename (22:12:18.096 -> stamp 02:12:48.136Z). Each cycle therefore creates a fresh `-tshm` at reopen and renames it 30 s later.

F3 (verified) The loop is not limited to the dev instance and does not need a second instance. Prod pid 9328 is in it right now (stale files at 10:44:41, 10:45:41, ...). `~/.memory/sandbox` holds 5 databases with 20 stale files each from a single pid (28173) on 2026-10-03, at a 30-60 s cadence.

F4 (verified) Log counts, `memory-server.live-service-2026-10-15.jsonl`:
- pid 9328: 1168 `store_adapter.turso.idle_flush`, 1086 with `idle_window_ms=30000`, 715 of 1167 consecutive gaps in [29.9, 30.6] s; 1102 `open_timing reason=release`; 612 `integrity.repaired` ("[BL-373] stale -tshm reconciled BEFORE the open").
- pid 75391 (dev): 236 idle_flush, all `idle_window_ms=30000`, 205 of 235 gaps in [29.9, 30.6] s; 237 `reason=release` reopens; 204 `integrity.repaired`.
- Latest prod record: `idle_window_ms:30000, write_interval_ewma_ms:59683` (14:46:11Z).

F5 (verified) Each idle flush is followed 4-11 ms later by a reopen. At 14:47:12.083Z `idle_flush`, at 14:47:12.094Z `open_timing reason=release total_ms=10.93`. At 14:47:42.243Z `idle_flush`, at 14:47:42.256Z `open_timing reason=release`. Between them the log holds only `mainthread.lag`. So an operation is already waiting when the connection is released (it queued behind `_releaseBarrier` and reconnects on resume), and the next 30 s window starts at once.

F6 (verified, code) Why the window is 30 s. The flush window is `min(max(1.5 * writeIntervalEwma, 2000), 30000)` (`wal-tuning.ts:30,43,93-101`); the EWMA is fed only by WRITES (`turso-adapter.ts:1900-1909`, `isWrite`), and the timer is armed by every completed op, read or write (`turso-adapter.ts:1402-1426`, `_trackOp` finally at ~1926). With a write gap of ~60 s the window is pinned at the 30,000 ms ceiling. `releaseIdleConnection()` runs the full close ceremony (PASSIVE checkpoint, quiescence-gated TRUNCATE, driver close, lease release) at `turso-adapter.ts:4188-4222`.

F7 (verified, code) Why the release makes a stale file. The release closes with `close_truncate_skipped_empty_wal` (empty WAL, TRUNCATE skipped) or `close_checkpoint_busy` ("another connection holds the store"), leaving the `-tshm` in place. The reopen's pre-flight (`turso-adapter.ts:2987-3000` -> `proactivelyReconcileStaleSidecar`, `integrity.ts:1056-1095`) calls `isTshmContentDead` (`integrity.ts:657-690`), which returns `dead: true` whenever the WAL is 0 bytes or absent. That is the normal state of an idle store, so a healthy sidecar from the previous clean close is classified dead and renamed to `.stale-*` on every reopen. When the TRUNCATE did succeed, `resetTshmAfterTruncate` (`turso-adapter.ts:4727-4760`) renames it at close instead. 247 `close_tshm_reset` events today are that second producer.

F8 (verified for timers, hypothesis for identity) A candidate for the 30 s caller, in the same process: the embed drain chain re-arms every `DEFAULT_DRAIN_FLOOR_MS = 30_000` after a pass that found nothing, and each pass calls `getDb()`, `healMissingVectors()` and `embedBacklogStats()` (a COUNT) through the adapter (`memory-server/src/index.ts:3632, 4560-4585, 4640-4690`). The timer is armed by `scheduleNextDrain` only after the pass settles, a few ms to ~170 ms after the last op armed the idle-flush timer, which explains why the flush fires first and the drain lands in the teardown window (F5) and the observed 30.00-30.17 s drift. Other 30 s timers checked and ruled out as store callers: `liveness-watchdog.ts:42`, `driver-stall-watchdog.ts:41` (status read only, no worker touch), `mainthread-monitor.ts:255`. The WAL-ownership heartbeat is 10 s (`wal-ownership.ts:52`). The identity of the waiting caller is NOT directly logged (see section 4).

F9 (verified) The reported E_IO. `EWalModeUnverified` (`concurrency-mode.ts:108-127`) is thrown by `_openReal` at `turso-adapter.ts:~3523-3540` when `verifyMultiprocessWalSidecar` (`concurrency-mode.ts:129-148`: 5 x `existsSync(<db>-tshm)` at 100 ms) never sees the `-tshm`. Live occurrences: 110 log lines containing the tag, all pid 9328, 03:09:00.797Z-03:15:29.470Z (32 `reconnect_failed`, 75 `op_failed`, 3 `mcp.tool_call.error`). The sequence at the first failure: 03:08:57.249Z `close_tshm_reset` renamed the sidecar and `idle_flush` released (adaptive window 4.5 s, not 30 s); 03:09:00.356Z a write-queue task started and reopened; 03:09:00.797Z the open had consumed 449 ms and threw. Peers held the store at the time: `close_checkpoint_busy: another connection holds the store` (03:08:35Z), and a reopen at 03:08:52Z spent 8919 ms in `lease_and_cold_open_lock`. The dev instance had been dead since 02:25:31Z, so this E_IO episode was not caused by the dev/prod pairing. The peer processes were not identified.

F10 (verified) Prod process deaths. Prod pids 1363, 98757, 76630, 36234 each ended (last log line) with `mainthread.blocked` of 34.9 s, 12.9 s, 23.0 s, 9.6 s respectively (1363 also logged `driver_stalled blocked_for_ms=39597` on `all:SELECT n.rowid, n.uid...`), and the successor pid logged its first line 16 s, 28 s, 7 s, 0.4 s later. The in-process kill thresholds are 5 minutes (`liveness-watchdog.ts:41`, `mainthread-monitor.ts:97`), so none of those deaths can be the in-process watchdog at default settings. The log file contains no `hard_exit` line at all (`rg -c hard_exit` -> no matches), so the reported "592 hard_exit lines" is not in this file. Pid 9328 survived 12.6 h with a max block of 3.7 s, including 14 minutes alongside the dev instance.

## 2. Ranked hypotheses

H1 (verified mechanism; waiting caller = hypothesis, strong) Self-inflicted perpetual release/reopen loop in the store-adapter's idle-release policy. Condition: a periodic caller with period P > W, where W is the adaptive flush window (<= 30 s ceiling). With P ~ 30.0x s and W = 30.000 s, the flush fires just before every poll, so the connection never stays open across two polls. Each cycle runs the full close ceremony plus a lease take, a cold-open lock, a driver open, and (F7) a rename of a healthy `-tshm`. This explains the 30 s cadence, the one-file-per-cycle stale debris, the ~1100 reopens a day per instance, the chronic `close_checkpoint_busy`/`sidecar_reconcile_deferred` under peers, and the spec's "30 s cadence under a 60 s threshold is unexplained" (the threshold is irrelevant; content-deadness is the trigger).

H2 (hypothesis) `E_WAL_MODE_UNVERIFIED` is a sidecar-lifecycle race made frequent by H1: the verification gate treats "sidecar missing for 400 ms after open" as a driver fault, but the sidecar is renamed or recreated by the release cycle (own close_tshm_reset or a peer's pre-open reconcile/sweep) and the reopen is write-free (`e5b712d4`), so a legitimate reopen racing a peer can see no `-tshm` yet. Rate scales with (instances x cycles per second) on a shared path: 100 instances -> ~3.3 closes/s.

H3 (hypothesis) Prod kills come from outside the process (supervisor or proxy health probe, or `launchd`), triggered by 10-35 s main-thread blocks that coincide with contention on the shared database; unverified, not in the data read.

H4 (hypothesis, weaker) The kills and blocks are caused by the dev instance's TRUNCATE/rename traffic on `memory.db`. Evidence against: the dev instance used `memory-dev.db` (a different file) in every log line except pid 36234.

## 3. Most likely root cause

H1: the idle-release policy releases and reopens the connection on every poll of a ~30 s periodic caller, because (a) the flush window is derived from WRITE cadence only (`turso-adapter.ts:1900-1909`) and clamped to a 30 s ceiling (`wal-tuning.ts:43`), so read-only polling is invisible to it, and (b) the reopen's pre-open reconcile renames a healthy sidecar whenever the WAL is empty (`integrity.ts:657-690`).

What separates it from H2/H3: H1's signature (30 s `idle_flush` with window 30000, then `open_timing reason=release` within 11 ms) is present in every instance including ones with no peer (sandbox pid 28173; dev on a private db), so it needs no cross-instance coupling. H2 and H3 each appear in one process only at specific times (E_IO: 03:09-03:15Z in pid 9328 with the dev instance already dead; deaths: pids that died before 02:11:37Z), and neither follows from F1-F8 alone. H1 is necessary context for both (it raises the number of reopen/rename events per instance to ~120 per hour) but is not proven to be their trigger. Treat it as the root of the stale-sidecar churn and a probable amplifier of parent AC1/AC2.

Shortcut vs real fix (stated, not applied): lowering the retention cap or raising the 30 s ceiling would hide the stale files and keep the loop. The real fix removes the release/reopen cycle for pollers and the false "dead" verdict.

## 4. Live repro to run after the hold

R1 (confirms H1, one process, private temp db, fake HOME, no prod job): start one memory-server on a temp store with default settings; after 3 minutes expect ~6 `.stale-*` files and an `idle_flush` (window 30000) followed by `open_timing reason=release` every 30 s. Falsifier: no release per 30 s => H1 wrong.
R2 (identifies the caller; differential): repeat with the drain floor moved off the window (`SOX_EMBED_DRAIN_FLOOR_MS` = 20000, then 45000, in the repro environment only; production uses no env toggles, ADR-0013). Prediction: 20000 -> flush cancelled every poll, zero releases, zero stale files; 45000 -> a release per poll (every 45 s), proving the condition is P > W and not an exact 30 s phase-lock. A test build with the drain disabled isolates the caller.
R3 (E_IO, 2 and 3 instances): start A and B on one shared temp db with the R1 settings plus a third on a distinct db; count `E_WAL_MODE_UNVERIFIED` and `close_checkpoint_busy` per hour; expect the E_IO rate to grow with instance count on the shared db only. Negative control: SIGSTOP one instance past the watchdog threshold; the others must stay green (spec test plan).
R4 (kill): while R3 runs, capture the supervisor/proxy health-probe log and `ps` start times to attribute any exit; log `mainthread.blocked` durations; confirm whether a probe timeout, not the in-process watchdog, ends the process.
R5 (for parent AC4): record time-to-`memory_ping` at N=1, 4, 16.

## 5. Proposed fix direction (not implemented)

Slice A (churn; ready): (1) track the inter-op gap for ALL ops (not writes only) and do not arm a release flush when the observed op cadence would reopen within 2 x W (hysteresis), or make the ceiling relative to the observed poll cadence; (2) stop classifying an empty-WAL sidecar that this process's own clean close just left as content-dead: carry a "clean close, tshm consistent with empty WAL" marker through release (`_releasedClean` already exists, `turso-adapter.ts:4204`) and skip the pre-open rename when it is set; (3) alternatively route the drain's idle COUNT through a path that does not wake a released connection (a dirty flag or WAL mtime check, falling back to a real query on change).
Slice B (E_IO and cross-instance; needs-triage until R3/R4): make a `verifyMultiprocessWalSidecar` failure re-open once and re-verify under the cold-open lock before throwing, and do not let any process rename a `-tshm` it did not create while a peer lease exists. Do not edit before R3 identifies the racing party.

## 6. Acceptance criteria for the fix slice (ids stable)

- AC1 Single instance, quiescent store with a 30 s poller, 10 min: zero `.stale-*` files created, at most 1 `open_timing reason=release` (maps to parent AC3).
- AC2 A poller with period P in {20 s, 30 s, 45 s} on an idle store yields no more than one release per 10 min (maps to parent AC3, AC4).
- AC3 After a clean release followed by reopen, the existing `-tshm` is kept (not renamed) and `walModeVerified` is true; a genuinely dead sidecar (WAL shorter than the index extent) is still reconciled (regression guard for BL-373).
- AC4 With 2 instances on one shared db plus 1 on a distinct db for 30 min: zero `E_WAL_MODE_UNVERIFIED`, zero foreign `hard_exit.forced`/SIGKILL (maps to parent AC2).
- AC5 Time-to-`memory_ping` at N=1, 4, 16 recorded; N=4 p95 <= 2x N=1 (provisional, per the Product revision; maps to parent AC4).
- AC6 Each AC ships as an automated test citing `26280300 AC<n>`, red on current main first (parent AC5), with a negative control (re-introduce the false-dead verdict -> the AC3 test goes red).

## 7. Definition-of-ready verdict

- Diagnostic slice (AC0): DONE for churn (H1 verified in code and logs); the E_IO race and the kills remain hypotheses with a defined live repro (R3, R4).
- Slice A (loop and false-dead rename): ready. Observable done-state is AC1-AC3, scope is named (`turso-adapter.ts`, `wal-tuning.ts`, `integrity.ts`, optionally memory-server `index.ts` drain), no blocking unknown. Serialize after 87799e1d (shares `integrity.ts`).
- Slice B (E_IO and cross-instance kill): needs-triage until R3/R4 run after the hold.
- N=100 harness: needs-spec (blocked on slice B findings), unchanged from the spec.

## 8. Other findings (to file)

- `memory-server` honors `SOX_MEMORY_SERVER_WATCHDOG_THRESHOLD_MS` / `_INTERVAL_MS` (`liveness-watchdog.ts:38-39`) and `SOX_EMBED_DRAIN_*` env knobs (`index.ts:3650-3654`) against the no-env-toggle rule (ADR-0013 D3).
- The reported "592 hard_exit lines" is not reproducible from `memory-server.live-service-2026-10-15.jsonl` (0 matches); the source file for that count is unidentified.
- Prod instances died with no exit record in the log (SIGKILL leaves none), so the exit cause is unrecoverable from current telemetry; a supervisor-side exit-reason record is missing.
