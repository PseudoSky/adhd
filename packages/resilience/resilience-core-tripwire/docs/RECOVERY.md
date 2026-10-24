# Recovery runbook

For the operator whose tool stopped with a tripwire error and who needs it
running again. Read [ERRORS.md](ERRORS.md) for what each error means.

A tripwire is a latch: it stays closed until someone clears it. Clearing is a
deliberate act, so work through the steps in order.

1. Find the lock and read why it tripped.
2. Fix the upstream cause (the account, the captcha, the rate limit).
3. Unlock with the unlock bin (preferred) or the break-glass `rm`.

## Where the files are

Everything lives under the tripwire's `stateDir`. With the shared convention
that is `$ADHD_HOME/<app>/` (`~/.adhd/<app>/` when `ADHD_HOME` is unset).

```text
<stateDir>/
  audit.log                       NDJSON audit trail (path overridable with auditPath)
  tripwire/
    <key>.lock                    present = tripped; JSON record of the first trip
    <key>.blocked.<generation>    block counter sidecar of that lock
    <key>.cleared                 marker left by the last clear
```

The exact lock path is `<stateDir>/tripwire/<key>.lock`. A `<key>` is the
client or provider name the error mentioned (`Tripwire "tinder" is tripped`).
Files are mode `0600`, directories `0700`.

## Read the lock

The lock is plain JSON; it is meant to be read by a person.

```sh
cat "$ADHD_HOME/request-builder/tripwire/tinder.lock"
```

```json
{
  "schema": 1,
  "key": "tinder",
  "namespace": "request-builder",
  "reason": "http-4xx",
  "trippedAt": "2026-10-12T09:14:03.220Z",
  "trippedBy": { "pid": 48211, "actor": "sky" },
  "blockedCount": 0,
  "generation": "3f9a6c1d0b7e48a25c9e0d14",
  "context": { "lastStatus": 401, "lastOperationId": "getProfile" }
}
```

- `reason` says why (`http-4xx`, `captcha`, `banned`, `rate_limited`,
  `login_required`, or any string the application chose).
- `trippedAt` and `trippedBy` say when and who. `context` holds the
  application's redacted forensic fields; secrets are never in it.
- `priorClear`, when present, says how and when the previous trip of this key
  was cleared. A tripwire that re-trips soon after a clear usually means the
  cause was not fixed.
- `recoveryHint`, when present, is the instruction the application wrote.
- `generation` is a random id (24 hex characters) of this trip. It names the
  counter sidecar.

An empty, corrupt or unknown-schema lock still blocks (the tripwire fails
closed). The unlock bin shows it as `could not be parsed as JSON` and still
lets you clear it.

## The sidecars

- `<key>.blocked.<generation>` is an append-only counter for the lock with that
  `generation`: one byte per counted block, so its size in bytes is the number
  of blocked attempts. Counting never rewrites the lock. A lock without a
  `generation` (written by an older tool, or unreadable) counts in
  `<key>.blocked` instead. The count is part of `blockedCount` and its mtime is
  `lastBlockedAt`. A sidecar of a dead generation can never be mistaken for the
  count of a later lock.
- `<key>.cleared` is written by every clear. Its content is the clear marker:
  `{"clearedAt": ..., "method": ..., "actor": ...}`. The next trip of the same
  key consumes it and records it in the new lock as `priorClear`; if nobody trips
  the key again it stays as the last-clear record. It is not a lock: its
  presence does not block anything.

Other files you may see are leftovers of an interrupted write and are safe to
delete when no process is running: `*.tmp` (a write that never completed) and
`*.tomb` (a removal that was interrupted).

## Unlock with the bin (preferred)

If the application ships the unlock bin (the five-line `runUnlockCli` recipe),
use it. It prints the lock, asks for confirmation, removes the lock and audits
the clear.

```sh
unlock tinder                                       # prompts on a terminal
CONFIRM=I-UNDERSTAND-THE-RISK unlock tinder          # scripted
```

Exit codes: `0` unlocked (or there was nothing to unlock), `1` no key, invalid
key, no TTY and no `CONFIRM`, or the confirmation did not match (the lock is
kept), `2` an unexpected IO error. The clear is audited as `unlock-cli-tty` or
`unlock-cli-env`.

## Break-glass: delete the lock file

When the bin is not available, or the tripwire code itself is broken, delete
the lock. This is the documented last resort and it is always allowed:

```sh
rm "<stateDir>/tripwire/<key>.lock"
# for example
rm "$ADHD_HOME/request-builder/tripwire/tinder.lock"
```

The next `gate` on that key sees no lock and opens. A process whose trip was
persisted keeps no in-memory latch (the lock file is its only state), so it
opens at its next `gate` too. What a manual `rm` does not do:

- it writes no `tripwire-cleared` audit line and no `<key>.cleared` marker, so
  the next trip will have no `priorClear`. Write down who removed it and why;
- it leaves the `<key>.blocked.<generation>` sidecar behind. That is harmless
  (a later lock has a new generation) and you can delete it too:
  `rm "<stateDir>/tripwire/<key>.blocked."*`.

One case needs a restart: if `trip` could not write the lock (an
`onWarning` with operation `trip.persist`), there is no file to delete and the
process stays blocked by its in-memory latch until it restarts. Fix the state
directory (permissions, disk space) and restart the process.

Never edit a lock to "fix" it, and never remove the `tripwire/` directory
while a process is running: delete exactly the one `<key>.lock`.

## Read the audit log

`<stateDir>/audit.log` (or the configured `auditPath`) is NDJSON: one JSON
object per line, always under 4 KB. It never contains the lock `context`, and
`pageUrl` is reduced to origin and path. The file is capped (5 MiB by default,
configurable with `maxAuditBytes`, minimum 100000 bytes); when it would grow
past the cap the oldest half is dropped on a line boundary.

```sh
tail -n 20 "$ADHD_HOME/request-builder/audit.log"
jq -c 'select(.key == "tinder")' "$ADHD_HOME/request-builder/audit.log"
jq -c 'select(.event == "tripwire-cleared") | {ts, key, method, actor}' "$ADHD_HOME/request-builder/audit.log"
```

| `event` | Meaning |
| --- | --- |
| `tripwire-fired` | A key tripped. `reason`, `actor`, and `priorClear` when the previous clear is known. |
| `tripwire-gate-blocked` | A gate refused work while tripped. `blockedCount` is the running count. |
| `tripwire-retripped` | A trip hit an already tripped key; the first record was kept. |
| `tripwire-cleared` | A clear. `method` says how, `actor` who, `reverified` whether the human re-checked upstream. |
| `tripwire-resolved` | The success path: the upstream recovered. `durationMs` is the time tripped. |
| `tripwire-expired` | A gate found a lock older than the instance `expiry` and removed it; its `reason` is `ttl-expired` and its `tripReason` is the reason the lock was originally tripped for, so the log says both that it lapsed and why it was locked. |

Other fields on every line: `ts`, `key`, `namespace`, and `sessionId` when the
application supplies one. `method` is one of `unlock-cli-tty`, `unlock-cli-env`,
`programmatic-confirm`, `hitl-clear`, `hitl-retry`, `mcp-clear`, `resolved` or
`expired`. A line with `"truncated": true` had optional fields dropped to stay
under the size limit.

Audit writes are best effort. A missing line is never a reason to believe a
clear did not happen: check whether the `.lock` file is gone.

## Before you re-run

Re-running before the cause is fixed trips the key again, and the next lock
will carry a `priorClear` that points at your clear. Verify the upstream
first (log in, solve the captcha, wait out the rate limit), clear, then
re-run once and watch the audit log for a new `tripwire-fired` line.
