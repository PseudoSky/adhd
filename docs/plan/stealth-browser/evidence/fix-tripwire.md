# fix-tripwire evidence

## fix-tripwire.1 (backlog 84e1f7a2)

The expiry audit line now carries `reason: ttl-expired` (`EXPIRY_AUDIT_REASON` in `src/lib/audit.ts`, used by `expire()` in `src/lib/tripwire.ts`). The package held no `it.fails` test, so the proof is a new passing spec, `test/unit/audit-expiry.spec.ts`: it trips an entry, advances the clock past the ttl, gates, and parses the line written to the audit log. Three existing specs asserted the old reason (`captcha`) on the expiry line and now assert `ttl-expired` (expiry.spec.ts, scenario-agent-search.spec.ts); RECOVERY.md documents the reason.

RED: audit-expiry.spec.ts on untouched source: `AssertionError: expected 'captcha' to be 'ttl-expired'` (test "writes reason ttl-expired on the audit line when a tripped entry expires"); second test failed the same way (`reason: 'ttl-expired'` expected, `captcha`/`rate_limited` received).
GREEN: audit-expiry.spec.ts 2 passed, expiry.spec.ts and scenario-agent-search.spec.ts green after the fix; full package lane 313 passed.

## fix-tripwire.2

The storage spec's interleaved-writers test ("deterministic interleaved writers ...") is driven by gates: `test/helpers/gates.ts` parks every fs port operation (and file-handle operation) on a promise the test resolves, waits by event notification (no timers) until every task is parked or finished, and lets the schedule picker release exactly one operation. No `setTimeout`, `sleep(`, polling, or per-test timeout.

RED: `guard.py fix-tripwire --only fix-tripwire.2` on the untouched storage.spec.ts: `FAIL ... no spec under packages/resilience/resilience-core-tripwire/test/unit cites [fix-tripwire.2]` (title lacked `deterministic`, no citation).
GREEN: the test dropped from 2534 ms (setImmediate-polling scheduler, 150 exhaustive + 60 random schedules) to 52 ms; storage.spec.ts passes; package lane green three consecutive uncached runs.

Guard defect (not fixable in owned paths): `fix-tripwire.2` has `repeat: 3`, and guards/amend_a.py appends `--skip-nx-cache` AFTER `--`, so nx forwards it to vitest, which exits 1 with `CACError: Unknown option --skipNxCache`. Reproduce: `CI=true ./node_modules/.bin/nx run resilience-core-tripwire:test -- test/unit --skip-nx-cache`. The same command without the flag exits 0. Three uncached runs (`pnpm nx run resilience-core-tripwire:test --skip-nx-cache`) exit 0.

## fix-tripwire.3

root cause: the interleaved-writers test in storage.spec.ts ran 150 exhaustive plus 60 random schedules through `MemoryFs.schedule`, which awaits two real `setImmediate` macrotask turns per scheduling step. Its wall time was therefore proportional to event-loop and CPU contention (2534 ms unloaded) against vitest's 5 s default per-test timeout. The tripwire-core.32 guard runs `typecheck`, `typecheck-spec`, `lint` and `test` together, so under parallel load the test crossed 5 s and failed the `:test` lane. The gate driver advances only on promise notifications, so the schedule no longer depends on load (52 ms).

`guard.py tripwire-core --only tripwire-core.32`: exit 0, exit 0, exit 0 (three consecutive runs).

## fix-tripwire.5

EXIT pnpm nx run resilience-core-tripwire:lint: 0
EXIT pnpm nx run resilience-core-tripwire:typecheck: 0
EXIT pnpm nx run resilience-core-tripwire:typecheck-spec: 0
EXIT pnpm nx run resilience-core-tripwire:test: 0
EXIT pnpm nx run resilience-core-tripwire:build: 0
