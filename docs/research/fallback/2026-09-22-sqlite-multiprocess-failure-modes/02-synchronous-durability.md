---
name: "SQLite synchronous modes and ACK-before-durable-commit"
topic: "sqlite-multiprocess-patterns"
tags: ["pattern:recommended", "sqlite", "synchronous", "durability", "fsync", "wal", "turso", "mvcc"]
summary: "synchronous OFF/FULL/NORMAL/EXTRA govern fsync frequency. NORMAL in WAL loses durability only on power loss (safe on app crash); OFF can corrupt on power loss; FULL is ACID in WAL. A successful return can precede the durable commit when synchronous<FULL. Turso supports only OFF and FULL, and has an MVCC gap where a success-reported write is not durable while sibling statements are active."
importance: 8
data_quality: verified
type: best-practice
pattern_class: recommended
---

# SQLite synchronous modes + why an ACKed write can be non-durable

**Failure class addressed:** a process ACKs writes that never persist (~15 items lost).

## Mechanism (authoritative)

- `PRAGMA synchronous` levels *(sqlite.org/pragma.html#pragma_synchronous)*:
  - **EXTRA (3)** — like FULL, plus it fsyncs the directory containing the rollback journal after the journal is unlinked (DELETE mode). No different from FULL in WAL mode.
  - **FULL (2)** — the engine uses the VFS `xSync` to ensure all content is on the disk surface before continuing. FULL is ACID in WAL mode; it is the default for a rollback journal.
  - **NORMAL (1)** — syncs at the most critical moments but less often. "WAL mode is safe from corruption with synchronous=NORMAL … but WAL mode does lose durability. A transaction committed in WAL mode with synchronous=NORMAL might roll back following a power loss or system crash. Transactions are durable across application crashes regardless of the synchronous setting or journal mode."
  - **OFF (0)** — no syncs; "SQLite continues without syncing as soon as it has handed data off to the operating system." Safe against application crash, but "the database might become corrupted if the operating system crashes or the computer loses power."
- howtocorrupt.html §3.2: setting `synchronous=OFF` omits all syncs and lets the OS freely reorder writes; "For maximum reliability and for robustness against database corruption, SQLite should always be run with its default synchronous setting of FULL." §7 lists `synchronous=OFF`, `journal_mode=OFF/MEMORY`, and `writable_schema=ON` as configuration errors that disable built-in protection.
- Autocommit semantics *(sqlite.org/lang_transaction.html)*: an implicit transaction commits when the last statement finishes; an explicit `COMMIT` runs immediately. A successful API return can therefore **precede** the fsync that makes the write durable whenever `synchronous < FULL`.
- **Turso-specific:** `PRAGMA synchronous` is only **PARTIAL** — only `OFF` and `FULL` are supported (`NORMAL`/`EXTRA` are not). Turso's MVCC mode has a documented gap: "a write that reported success is not durable while sibling statements remain active, and it is silently rolled back if the transaction then ends abnormally." *(Turso COMPAT.md)*

## Correct pattern

- For a store of record under multi-process access: **WAL + `synchronous=FULL`**. Never `OFF`.
- Do read-modify-write inside `BEGIN IMMEDIATE … COMMIT`, and report success only **after COMMIT returns**.
- For critical writes, verify durability by reopening and reading back rather than inferring it from the API return.
- On Turso, do not request `NORMAL` (unsupported); prefer `FULL`, and finish/reset sibling statements promptly after writing.

## Anti-pattern

- `synchronous=OFF` for speed on a durable store.
- Treating `NORMAL` as durable (it loses the last transaction(s) on power loss).
- ACKing a write before `COMMIT` returns.
- Assuming Turso accepts `NORMAL`.
- Leaving sibling write statements open in Turso MVCC and expecting the write to be durable.

## References

- https://www.sqlite.org/pragma.html#pragma_synchronous
- https://www.sqlite.org/howtocorrupt.html §3.2, §7
- https://www.sqlite.org/lang_transaction.html
- Turso COMPAT.md (`PRAGMA synchronous`; MVCC durability gap)
