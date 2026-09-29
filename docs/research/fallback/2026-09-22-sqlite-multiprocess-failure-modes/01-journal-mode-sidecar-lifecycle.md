---
name: "SQLite journal_mode + sidecar lifecycle (WAL persistent; -shm/-tshm coupling)"
topic: "sqlite-multiprocess-patterns"
tags: ["pattern:recommended", "sqlite", "wal", "journal-mode", "shm", "tshm", "sidecar", "multiprocess", "turso", "libsql"]
summary: "WAL journal_mode is persistent; TRUNCATE/DELETE are per-connection and revert on reopen. -wal exists while any connection is open and is deleted on last close after checkpoint; -shm/-tshm are mmapped index sidecars deleted on last close. A 0-byte WAL + frozen sidecar makes fresh opens fail; reconcile only when the WAL is provably empty. Never unlink sidecars under a live connection."
importance: 8
data_quality: verified
type: best-practice
pattern_class: recommended
---

# SQLite journal_mode + sidecar lifecycle — WAL is persistent, TRUNCATE/DELETE are not; -shm/-tshm coupling

**Failure class addressed:** a process closes its connection and a fresh process then cannot open the store (5/5 open failures) while another process holds it.

## Mechanism (authoritative)

- `PRAGMA journal_mode=WAL` is **PERSISTENT** — the setting is recorded in the database header (file-format version bytes 18/19 become 2). `TRUNCATE`, `DELETE`, `PERSIST`, `MEMORY`, `OFF` are **per-connection** and revert to the default `DELETE` when the database is closed and reopened. A `close()`-time `journal_mode=TRUNCATE` therefore has no cross-process persistence and is a rollback-journal mode, not a multi-process coordination mode. *(sqlite.org/wal.html §3.3; sqlite.org/pragma.html#pragma_journal_mode)*
- `TRUNCATE` commits a transaction by truncating the rollback journal to zero length (`DELETE` deletes it; `PERSIST` zeroes its header). All three are single-rollback-journal modes. Only WAL gives readers-do-not-block-writers / writer-does-not-block-readers.
- The `-wal` file exists for as long as **any** connection has the database open. Usually it is deleted when the **last** connection closes (after one final checkpoint). The `-shm` wal-index backing file (an mmapped ordinary file) is likewise deleted when the last connection disconnects. *(wal.html §4, §6, §7)*
- During close cleanup the last connection acquires an exclusive lock for a short time while it deletes the WAL and shared-memory files; a concurrent opener can receive `SQLITE_BUSY` in that window. After a crash, the first new opener holds an exclusive lock while running recovery; a third connection gets `SQLITE_BUSY_RECOVERY`. *(wal.html §9; sqlite.org/rescode.html#busy_recovery)*
- Turso's `multiprocess_wal` feature adds a third sibling, `-tshm` (Turso shared memory): an mmapped coordinator that tracks WAL state, a **single-writer slot**, a **single-checkpointer slot**, a bounded set of **reader slots** (each pinning a WAL frame), and a shared page-to-frame index. Cross-process byte-range locks are OFD locks on Linux and `fcntl` on macOS. *(docs.turso.tech/sql-reference/multiprocess-access)*
- The libSQL/SQLite wal-index has **7 lock states** — `UNLOCKED, READ, READ_FULL, WRITE, PENDING, CHECKPOINT, RECOVER` — where `RECOVER` is held during wal-index reconstruction and cannot coexist with `WRITE`, `PENDING`, or `CHECKPOINT`. A stale index therefore forces a recovery path. *(libsql-sqlite3/doc/vfs-shm.txt)*
- Turso docs state the `.tshm` "may be left in place — Turso reuses it on the next multi-process open and rebuilds its state from the WAL if necessary." Empirically, a **0-byte `-wal` plus a frozen `.tshm`** makes every fresh open fail: the stale index references WAL frames a truncated WAL cannot contain (short read / `IOERR_SHORT_READ`), and retrying is never transient for that state. *(prior incident evidence, sox-ecosystem memory 01KZV8RWHF3NZ1ZJP0S9B96G4B)*

## Correct pattern

- Use WAL for any file shared by multiple OS processes. Never use `TRUNCATE`/`DELETE` as the multi-process coordination mode.
- Never unlink or rename `-wal`, `-shm`, or `-tshm` while any connection is live. Only the owning connection may remove them, and only after a clean close.
- Budget for `SQLITE_BUSY` on open (the close-cleanup window) and `SQLITE_BUSY_RECOVERY` after a crash; treat both as retryable at open time.
- Reconcile an apparently-stale sidecar only after **proving the WAL is empty / 0 bytes** (content-based evidence), never on an mtime heuristic.

## Anti-pattern

- Deleting `-wal`/`-shm`/`-tshm` files as "cleanup".
- Mixing journal modes across processes writing one file.
- Using sidecar mtime to decide staleness (under multiprocess WAL the `.tshm` mtime can freeze at creation).
- Assuming the `.tshm` is always rebuilt from the WAL.

## References

- https://www.sqlite.org/wal.html (§3.3, §4, §6, §7, §9)
- https://www.sqlite.org/pragma.html#pragma_journal_mode
- https://www.sqlite.org/rescode.html#busy_recovery
- https://docs.turso.tech/sql-reference/multiprocess-access
- libsql-sqlite3/doc/vfs-shm.txt
