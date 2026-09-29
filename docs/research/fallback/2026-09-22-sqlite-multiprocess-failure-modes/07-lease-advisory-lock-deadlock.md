---
name: "Lease/advisory-lock deadlock on SQLite — use the transaction as the lock"
topic: "sqlite-multiprocess-patterns"
tags: ["pattern:recommended", "pattern:antipattern", "sqlite", "lease", "advisory-lock", "deadlock", "begin-immediate", "multiprocess"]
summary: "An app-level lease layered on SQLite's own file lock creates a second lock with a different acquisition order and deadlocks. The transaction IS the lock: BEGIN IMMEDIATE acquires the write lock atomically and releases on COMMIT/ROLLBACK/crash. If a cross-store lease is required, use one lock row with a monotonic owner token + TTL, a single conditional UPDATE to claim, fixed global ordering, and never block while holding a lock another needs."
importance: 8
data_quality: verified
type: best-practice
pattern_class: recommended
---

# Lease/advisory-lock deadlock on SQLite — use the transaction as the lock

**Failure class addressed:** a lease deadlock where two processes each wait on the other's lease.

## Mechanism (authoritative)

- SQLite already provides a database file lock for mutual exclusion. Layering a separate application-level **lease** on top creates a second lock whose acquisition order is independent of SQLite's; two processes can each hold a lease the other needs and each wait on the other — neither can progress, and SQLite's own locking cannot see (or break) the application lease.
- `BEGIN IMMEDIATE` *(sqlite.org/lang_transaction.html §2.2)* "causes the database connection to start a new write immediately, without waiting for a write statement. The BEGIN IMMEDIATE might fail with SQLITE_BUSY if another write transaction is already active on another database connection."
- `SQLITE_BUSY` *(sqlite.org/rescode.html#busy)*: "To avoid encountering SQLITE_BUSY errors in the middle of a transaction, the application can use BEGIN IMMEDIATE instead of just BEGIN … The BEGIN IMMEDIATE command might itself return SQLITE_BUSY, but if it succeeds, then SQLite guarantees that no subsequent operations on the same database through the next COMMIT will return SQLITE_BUSY."
- Therefore the **transaction itself is the lease**: it is acquired atomically at `BEGIN IMMEDIATE`, held for the transaction, and released automatically on `COMMIT`, `ROLLBACK`, or process death (crash-safe — no orphaned lock).
- wal-lock.md (libSQL): with blocking locks configured (`SQLITE_ENABLE_SETLK_TIMEOUT` + `busy_timeout`), the only remaining `SQLITE_BUSY` cases are (a) the OS not granting a blocking lock before the timeout, and (b) upgrading an open read-transaction to a write-transaction. "Clients that lock multiple databases simultaneously must be wary of deadlock."
- **Prior incident:** a lease-gate deadlock where two processes each waited on the other's lease, compounded by a stale `-tshm` sidecar and a 0-byte WAL — fresh opens failed permanently. *(sox-ecosystem memory 01KZV8RWHF3NZ1ZJP0S9B96G4B)*

## Correct pattern

- **Prefer the transaction as the lock**: `BEGIN IMMEDIATE … COMMIT` for any read-modify-write, instead of a separate lease table.
- If an application-level lease is genuinely required (e.g. coordinating a resource that is not a single SQLite transaction):
  - Represent the lease as **one lock row** with a monotonic owner token and an `expires_at` (TTL).
  - Claim it with a **single conditional UPDATE** (`WHERE owner IS NULL OR expires_at < now`) and check the affected-row count — atomic, no read-then-write race.
  - Always acquire multiple leases in a **fixed global order**.
  - Renew by heartbeat; a lease with no TTL is a permanent deadlock risk.
  - **Never block** on another lease while holding one another process needs.

## Anti-pattern

- Two processes each holding a lease the other needs (mutual wait).
- Nested lease acquisition in inconsistent order.
- A lease with no expiry.
- Holding a lease across a blocking call that itself needs another lease.
- Relying on lease state that is not crash-recoverable (orphaned locks after a kill).

## References

- https://www.sqlite.org/lang_transaction.html §2.2
- https://www.sqlite.org/rescode.html#busy
- libsql-sqlite3/doc/wal-lock.md
