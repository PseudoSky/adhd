# Error reference

Every error this package throws is a `TripwireError` with a stable `code` from
the closed registry `TRIPWIRE_ERROR_CODES` (in `src/lib/errors.ts`). Each error
also carries the brand `TRIPWIRE_ERROR_BRAND`, the registry symbol
`Symbol.for('adhd.tripwire.error')`, so the guards below recognise errors
thrown by a duplicate copy of the package, where `instanceof` would fail:
`isTripwireError(e)` is true for any tripwire error and
`isTripwireTrippedError(e)` for `TRIPWIRE_TRIPPED`, from any copy.

Branch on `e.code`, never on the message text.

| Code | Class | Thrown by |
| --- | --- | --- |
| `TRIPWIRE_TRIPPED` | `TripwireTrippedError` | `assertOpen` |
| `TRIPWIRE_CONFIRM_REQUIRED` | `TripwireConfirmError` | `clear`, and every path that clears through it (`interactiveGate`, `confirmSolved`) |
| `TRIPWIRE_INVALID_KEY` | `TripwireKeyError` | every method that takes a key |
| `TRIPWIRE_IO` | `TripwireIoError` | `clear` and `resolve` |
| `TRIPWIRE_ABORTED` | `TripwireAbortedError` | `interactiveGate`, `confirmSolved` |

## TRIPWIRE_TRIPPED

- **Class:** `TripwireTrippedError`. Fields: `key`, `reason`, `trippedAt`
  (a `Date`), `recoveryHint`, `record` (the lock record), and, when built with
  `TripwireTrippedError.fromRecord(record, extra)`, the memory-only
  `responseStatus` and `responseBody`.
- **Cause:** `assertOpen(key)` found the key tripped (a lock file is present, or
  this process holds an in-memory latch for it). That is the tripwire working,
  not a fault. Each throw also counts and audits one block
  (`tripwire-gate-blocked`).
- **Remediation:** fix the upstream cause first (the `reason` and the lock
  `context` say what happened), then clear the key: with the unlock bin, with
  `clear(key, { method: 'programmatic-confirm', confirm: CONFIRM_TOKEN })`, with
  `clear(key, { method: 'mcp-clear' })` on an `open` instance, or with the
  break-glass `rm` in [RECOVERY.md](RECOVERY.md). `recoveryHint` already holds the
  right instruction for the instance policy. `toJSON()` never includes
  `responseBody` or the record `context`.

## TRIPWIRE_CONFIRM_REQUIRED

- **Class:** `TripwireConfirmError`. Field: `key`.
- **Cause:** `clear(key, opts)` was called on a `confirm-token` instance (the
  default) without `opts.confirm === CONFIRM_TOKEN`
  (`'I-UNDERSTAND-THE-RISK'`). Nothing was changed. `interactiveGate` and
  `confirmSolved` clear through `tw.clear`, so they raise it too when the instance is
  `confirm-token` and the caller did not pass `confirm` in their options; a TTY
  alone is never treated as the token. The unlock bin does not hit it: it passes
  the token after the human confirms.
- **Remediation:** pass `confirm: CONFIRM_TOKEN` when the caller really is the
  confirming human or an audited script, or create the instance with
  `clearPolicy: 'open'` when automated clearing is intended.

## TRIPWIRE_INVALID_KEY

- **Class:** `TripwireKeyError`. Field: `key` (the offending value as a string).
- **Cause:** the key does not match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`: it is
  empty, longer than 64 characters, starts with a dot or a dash, or contains a
  path separator or any other character. It is raised before any file-system
  access, so nothing was read or written. The unlock bin reports it as
  `invalid tripwire key: ...` with exit code 1.
- **Remediation:** use a short slug as the key (a client name, a provider name).
  Do not build keys from user input or paths.

## TRIPWIRE_IO

- **Class:** `TripwireIoError`. Fields: `operation` (for example `clear`) and
  `cause` (the original error).
- **Cause:** a file-system operation failed where the caller has to know.
  `clear` and `resolve` throw it when the lock file cannot be removed
  (permissions, a read-only disk). The unlock bin reports it as
  `failed to unlock: ...` with exit code 2. Everywhere else IO failures do not throw:
  they fail closed or arrive as a `TripwireWarning` with code `TRIPWIRE_IO` in
  `onWarning` (operations `trip.persist`, `trip.marker`, `gate.count`,
  `audit.append`, `clear.marker`, `expire.remove`). A lock that cannot be read
  is reported as `status: 'unreadable'` and counts as tripped.
- **Remediation:** read `cause.message` and the `code` of `cause` (`EACCES`,
  `EROFS`, `ENOSPC`...), fix the directory permissions or disk, and retry. If the
  disk cannot be repaired, use the break-glass removal in
  [RECOVERY.md](RECOVERY.md). A `trip.persist` warning means the lock was not
  written: this process stays blocked by its in-memory latch, other processes are
  not, so fix the state directory before relying on the tripwire.

## TRIPWIRE_ABORTED

- **Class:** `TripwireAbortedError`. Field: `key` (when known). The default
  message is `HITL aborted by user`.
- **Cause:** a human-in-the-loop gate did not get a go-ahead and the lock was
  kept. `interactiveGate` throws it for the answer `abort`, for a non-TTY io
  (`... (no TTY)`) and for a closed input (`... (input closed)`);
  `confirmSolved` throws `HITL aborted by user` for `abort`, no TTY or EOF. It never
  hangs on a closed stdin.
- **Remediation:** none is needed when a person typed `abort`. In a
  non-interactive run (cron, CI, a pipe) run the gate from a terminal, or clear
  the key out of band with the unlock bin and re-run.
