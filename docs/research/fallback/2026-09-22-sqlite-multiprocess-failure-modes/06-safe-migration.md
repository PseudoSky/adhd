---
name: "Safe schema migration for SQLite-family stores (backup-first, idempotent DDL, ledger, verify, rollback)"
topic: "sqlite-multiprocess-patterns"
tags: ["pattern:recommended", "sqlite", "migration", "vacuum-into", "backup", "integrity-check", "ddl", "rollback"]
summary: "Backup-first with VACUUM INTO (consistent live snapshot; target must not pre-exist; interrupted output is corrupt). Idempotent DDL via IF NOT EXISTS (but Turso's CREATE VIEW IF NOT EXISTS is not idempotent, and writable_schema is unsupported). A migration ledger records applied ids; DDL is transactional; verify with integrity_check + object assertions (Turso has no foreign_key_check). Roll back by restoring the backup or ROLLBACK."
importance: 8
data_quality: verified
type: best-practice
pattern_class: recommended
---

# Safe schema migration for SQLite-family stores

**Failure class addressed:** a `migrateStore` routine that changes schema without backup, idempotency, or post-migration verification.

## Mechanism (authoritative)

- **Backup-first.** `VACUUM INTO 'file'` *(sqlite.org/lang_vacuum.html §2.1)* copies a live database into a new file; the output is a **consistent snapshot**; the target file must not previously exist (or must be empty) or the command fails; it is transactional, but if interrupted by shutdown/power loss the **output may be incomplete and corrupt**; SQLite fsyncs the output when the source's `synchronous` is NORMAL or FULL. The `sqlite3_backup` API is the incremental alternative *(sqlite.org/backup.html)*. A raw file copy of a WAL database requires a process holding a write lock while a **separate** process copies `db` **and `-wal` together** (`-shm` is optional); copying the DB alone can lose committed transactions or corrupt *(wal.html §4; howtocorrupt.html §1.4)*.
- **Turso-specific:** `VACUUM INTO` is supported; plain in-place `VACUUM` is experimental. `PRAGMA writable_schema` is **not** supported. *(Turso COMPAT.md)*
- **Idempotent DDL.** `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` are no-ops when the object exists. **Caveat:** Turso's `CREATE VIEW IF NOT EXISTS` is documented as **not idempotent** — a second create on an existing view errors instead of no-op'ing. *(Turso COMPAT.md)*
- **Migration ledger.** Record each applied migration's id, timestamp, and a checksum in a dedicated table; apply each migration exactly once and check the ledger before running. DDL in SQLite is transactional, so the ledger insert and the DDL can commit atomically.
- **Post-migration verification.** `PRAGMA integrity_check` (optionally scoped per table) for structural/index consistency; assert the expected objects exist (`PRAGMA table_list`, `PRAGMA index_list`); read back a sentinel row. Note Turso does **not** support `PRAGMA foreign_key_check`, so FK verification must be done another way. *(Turso COMPAT.md)*
- **Concurrent access.** Quiesce other writers before DDL. In Turso, schema changes made by one process are picked up by siblings on their next statement; prepared statements may return `SchemaUpdated` and re-prepare. *(docs.turso.tech/sql-reference/multiprocess-access)*

## Correct pattern

1. Take a `VACUUM INTO` backup and keep it until verification passes.
2. Quiesce writers (or hold the write lock) for the DDL window.
3. Apply each migration once, gated by a ledger row, inside a transaction.
4. Verify: `integrity_check`, object assertions, sentinel read-back.
5. Commit on success; on failure `ROLLBACK`, or restore from the backup if the transaction already committed.

## Anti-pattern

- In-place schema change with no backup, no idempotency, and no post-migration verification.
- Copying only the `.db` file of a live WAL database as a "backup".
- Assuming `foreign_key_check` / `writable_schema` / `CREATE VIEW IF NOT EXISTS` behave as in stock SQLite on Turso.

## References

- https://www.sqlite.org/lang_vacuum.html §2.1 (VACUUM INTO)
- https://www.sqlite.org/backup.html
- https://www.sqlite.org/howtocorrupt.html §1.4
- https://www.sqlite.org/pragma.html#pragma_integrity_check
- Turso COMPAT.md (VACUUM, writable_schema, foreign_key_check, CREATE VIEW IF NOT EXISTS)
