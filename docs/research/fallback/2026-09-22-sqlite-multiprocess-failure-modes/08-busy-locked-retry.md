---
name: "SQLITE_BUSY / SQLITE_LOCKED retry policy for multi-process SQLite"
topic: "sqlite-multiprocess-patterns"
tags: ["pattern:recommended", "sqlite", "sqlite-busy", "sqlite-locked", "busy-timeout", "begin-immediate", "retry", "multiprocess", "turso"]
summary: "SQLITE_BUSY is a conflict with a separate connection (retryable); SQLITE_LOCKED is a conflict within the same connection (fix the code). Set one busy_timeout at open, use BEGIN IMMEDIATE for read-modify-write, retry BUSY/BUSY_SNAPSHOT with bounded backoff, never retry LOCKED or same-connection 'statements in progress'. Multiple independent retry implementations that disagree are the bug."
importance: 8
data_quality: verified
type: best-practice
pattern_class: recommended
---

# SQLITE_BUSY / SQLITE_LOCKED retry policy for multi-process SQLite

**Failure class addressed:** retry/backoff for `SQLITE_BUSY` / `SQLITE_LOCKED`, and multiple disagreeing retry implementations.

## Mechanism (authoritative)

- `SQLITE_BUSY` (5) *(sqlite.org/rescode.html#busy)*: "the database file could not be written (or in some cases read) because of concurrent activity by some other database connection, usually a database connection in a separate process." It can occur at any point: at transaction start, mid-write, or at commit.
- `SQLITE_LOCKED` (6) *(rescode.html#locked)*: a conflict **within the same database connection** (or a shared-cache connection). "SQLITE_BUSY indicates a conflict with a separate database connection … whereas SQLITE_LOCKED indicates a conflict within the same database connection." → `LOCKED` is a code bug, not contention.
- Extended codes: `SQLITE_BUSY_RECOVERY` (261) — another process is recovering a WAL database after a crash; `SQLITE_BUSY_SNAPSHOT` (517) — in WAL mode, a connection tries to promote a read transaction to a write transaction but another connection already wrote, invalidating prior reads; `SQLITE_BUSY_TIMEOUT` (773) — a blocking POSIX lock timed out (requires `SQLITE_ENABLE_SETLK_TIMEOUT`); `SQLITE_PROTOCOL` (15) — a WAL transaction-start locking race whose loser backs off, returning `SQLITE_PROTOCOL` only after losing dozens of times over seconds.
- `sqlite3_busy_timeout(db, ms)` *(sqlite.org/c3ref/busy_timeout.html)*: installs a busy handler that sleeps until at least `ms` have accumulated, then returns 0, causing `sqlite3_step()` to return `SQLITE_BUSY`. **There can be only one busy handler per connection**; calling with `ms <= 0` turns all busy handlers off. `PRAGMA busy_timeout` is the SQL equivalent. **The default is 0 (no wait).**
- `BEGIN IMMEDIATE` avoids mid-transaction `SQLITE_BUSY`: it may itself return `SQLITE_BUSY`, but if it succeeds, no subsequent operation through `COMMIT` returns `SQLITE_BUSY` *(rescode.html#busy; lang_transaction.html)*.
- **Turso-specific:** `PRAGMA busy_timeout` is supported; but a second write statement on the **same** connection returns `SQLITE_BUSY` (error class, "SQL statements in progress") for which the **busy handler is never invoked** — no amount of waiting can release it; the statement must be reset/re-executed. *(Turso COMPAT.md)*
- **Prior evidence:** a deferred transaction reproduced a raw `SQLITE_BUSY_SNAPSHOT` leaking out of a `DELETE`; switching to `{behavior:'immediate'}` (`BEGIN IMMEDIATE`) eliminated it, and reverting reproduced it. *(adhd memory 01M1MG5A595MCG3DED9X640PEH)*

## Correct pattern

- Set **one** `busy_timeout` (e.g. 5000 ms) on **every** connection at open — a missing busy_timeout (default 0) surfaces lock contention as an unhandled driver exception.
- Use `BEGIN IMMEDIATE` for all read-modify-write; on `SQLITE_BUSY`/`SQLITE_BUSY_SNAPSHOT`, **retry the whole transaction** with bounded exponential backoff + jitter.
- Distinguish: `SQLITE_BUSY` (different connection — retryable) from `SQLITE_LOCKED` (same connection — fix the code) and from Turso's same-connection "statements in progress" (non-retryable — reset the statement).
- Centralize the policy: **one** retry implementation for the whole store.

## Anti-pattern

- Leaving `busy_timeout` at its default of 0 and expecting callers to handle `SQLITE_BUSY`.
- Multiple per-module retry loops that disagree about what is retryable.
- Retrying an upgrade of an open read transaction without first rolling it back (the snapshot is already invalidated).
- Treating `SQLITE_LOCKED` or same-connection "statements in progress" as transient contention.

## References

- https://www.sqlite.org/rescode.html#busy | #locked | #busy_snapshot | #busy_recovery | #busy_timeout
- https://www.sqlite.org/c3ref/busy_timeout.html
- https://www.sqlite.org/lang_transaction.html §2.2
- Turso COMPAT.md (same-connection write statements)
