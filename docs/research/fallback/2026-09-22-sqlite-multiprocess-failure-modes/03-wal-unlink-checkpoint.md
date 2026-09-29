---
name: "WAL unlink/replace under live use + safe checkpoint lifecycle"
topic: "sqlite-multiprocess-patterns"
tags: ["pattern:recommended", "sqlite", "wal", "checkpoint", "truncate", "busy", "corruption", "multiprocess"]
summary: "Separating a DB from its -wal can lose committed transactions or corrupt; unlinking/renaming an in-use DB gives two files sharing name-derived journals. Checkpoint modes PASSIVE/FULL/RESTART/TRUNCATE all take the exclusive CHECKPOINTER lock (SQLITE_BUSY, no busy handler); TRUNCATE blocks writers and returns busy=1 without throwing when it fails. Never delete sidecars under a live connection."
importance: 8
data_quality: verified
type: best-practice
pattern_class: recommended
---

# WAL unlink/replace under a live connection + safe checkpoint lifecycle

**Failure class addressed:** a live WAL file is unlinked/replaced while in use, causing silent write loss.

## Mechanism (authoritative)

- howtocorrupt.html §2.5 (Unlinking or renaming a database file while in use): if two processes have the same file open and one unlinks it then creates a new file with the same name, the two processes are talking to **different database files with the same name** — but rollback journals and WAL files are derived from the **name**, so the two files share a journal/WAL. "A rollback or recovery for one of the databases might use content from the other database, resulting in corruption." The doc concludes: "unlinking or renaming an open database file results in behavior that is undefined and probably undesirable."
- sqlite.org/wal.html §4: "If a database file is separated from its WAL file, then transactions that were previously committed to the database might be lost, or the database file might become corrupted. The only safe way to remove a WAL file is to open the database file using one of the `sqlite3_open()` interfaces then immediately close."
- howtocorrupt.html §1.3/§1.4: deleting a **hot** journal defeats recovery; copying a DB without its journal, swapping journals between DBs, moving a journal, or overwriting a DB without deleting its hot journal all lead to corruption.
- Checkpoint modes *(sqlite.org/c3ref/wal_checkpoint_v2.html)*:
  - **PASSIVE** — checkpoints as much as possible without waiting; the busy handler is **never** invoked; may not finish if there are readers/writers.
  - **FULL** — blocks (invokes the busy handler) until there is no writer and all readers are on the latest snapshot; blocks new writers while pending.
  - **RESTART** — FULL, plus blocks until all readers have left the WAL so the next writer restarts it from the beginning.
  - **TRUNCATE** — RESTART, plus truncates the WAL to zero bytes on successful return.
  - **All** modes take the exclusive **CHECKPOINTER** lock; if another process is checkpointing, the lock cannot be obtained and `SQLITE_BUSY` is returned **even if a busy handler is configured** (it is not invoked). FULL/RESTART/TRUNCATE also take the exclusive **WRITER** lock; if it cannot be obtained and the busy handler returns 0, the checkpoint degrades to PASSIVE and returns `SQLITE_BUSY`.
- `PRAGMA wal_checkpoint` returns one row `(busy, log, checkpointed)`; `busy=1` means the WAL was **not** truncated — this is **not** raised as an exception.
- **Turso-specific:** `PRAGMA wal_autocheckpoint` is **not supported**, and `PRAGMA wal_checkpoint` is partial (no pragma-value argument). *(Turso COMPAT.md)*

## Correct pattern

- Never delete/rename `-wal`, `-shm`, or `-tshm` while a connection is live; let the owning connection do it on clean close.
- Checkpoint from the owning connection. Before close, request `TRUNCATE`, then **inspect the returned `busy` column** and retry with backoff or accept that the committed WAL frames are durable and will be consolidated later.
- Use PASSIVE for routine checkpoints; use FULL/RESTART/TRUNCATE only when quiescent.
- Do not rely on automatic checkpointing under Turso.

## Anti-pattern

- Manually unlinking `-wal` to "reset" the store.
- Treating a returned checkpoint row as unconditional success.
- Running `TRUNCATE` under live readers (blocks writers; can silently not truncate).
- Assuming Turso auto-checkpoints.

## References

- https://www.sqlite.org/howtocorrupt.html §1.3, §1.4, §2.5
- https://www.sqlite.org/wal.html §4
- https://www.sqlite.org/c3ref/wal_checkpoint_v2.html
- https://www.sqlite.org/pragma.html#pragma_wal_checkpoint
