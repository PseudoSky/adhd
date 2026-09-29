---
name: "VACUUM INTO — agent:approved backup primitive for live SQLite/libSQL stores"
topic: "tool-catalog"
tags: ["agent:approved", "sqlite", "vacuum-into", "backup", "migration", "wal", "turso"]
summary: "VACUUM INTO 'file' produces a consistent, fully-vacuumed snapshot of a live database in a single SQL statement — the practical backup primitive for SQLite/libSQL/Turso stores, including from a TS app where @libsql/client exposes no backup API. The target must not pre-exist; an interrupted run leaves a corrupt output; it fsyncs the output when synchronous is NORMAL/FULL. Approved as the backup-first step of any migration. Not available as a dedicated API — it is plain SQL executed through execute/executeMultiple."
importance: 6
data_quality: verified
type: tool
decision: integrate
---

# VACUUM INTO — backup primitive

**Decision: `agent:approved`** as the backup-first step of any schema migration on a SQLite-family store.

## What it is

`VACUUM INTO 'filename'` *(sqlite.org/lang_vacuum.html §2.1)* is a single SQL statement that writes a **consistent, fully-vacuumed** copy of the current database to a new file, leaving the original unchanged. It is the documented alternative to the `sqlite3_backup` API for backing up a **live** database.

## Mechanism / constraints

- The output is a **consistent snapshot** of the source; deleted content is purged (no forensic traces), so the output is minimal in size.
- The target file **must not previously exist** (or must be empty), or the command fails.
- It is transactional, but if interrupted by shutdown/power loss the generated output **may be incomplete and corrupt**.
- If the source's `synchronous` is NORMAL or FULL, SQLite fsyncs the output after writing, so a power failure after completion does not corrupt it.
- `VACUUM` (the in-place form) may change ROWIDs of tables that lack an explicit `INTEGER PRIMARY KEY`; `VACUUM INTO` avoids touching the original.
- **Turso:** `VACUUM INTO` is supported; plain in-place `VACUUM` is experimental. *(Turso COMPAT.md)*
- **Driver note:** `@libsql/client` exposes **no** backup/snapshot method (Client interface: batch/close/execute/executeMultiple/migrate/reconnect/sync/transaction; the native binding's `backup()` is unsupported). `VACUUM INTO` still works because it is plain SQL run through `execute`/`executeMultiple` on a local file connection. *(prior sox-ecosystem memory 01KZSDSD2CJ94AQMA4WZ0NMCFW)*

## Correct pattern

- Before any schema migration: `VACUUM INTO '<timestamped-backup-path>'`; keep the backup until post-migration verification passes.
- Choose a target path that does not exist; treat an interrupted run as invalid and re-run.
- For a raw file-copy alternative on a WAL database, copy `db` **and `-wal` together** with a separate process while a writer holds the lock — never the `.db` alone.

## Anti-pattern

- Copying only the `.db` file of a live WAL database.
- Assuming an interrupted `VACUUM INTO` produced a usable backup.
- Expecting a dedicated backup API in `@libsql/client`.

## Quality signals

- No standalone package metric (SQLite core feature).
- Source: SQLite 3.27+ (VACUUM INTO introduced 2019-02-07).

## metrics_source

- feature availability: "https://www.sqlite.org/lang_vacuum.html §2.1"
- Turso support: "Turso COMPAT.md (VACUUM)"

## References

- https://www.sqlite.org/lang_vacuum.html §2.1
- https://www.sqlite.org/backup.html
- https://www.sqlite.org/howtocorrupt.html §1.4
