---
name: "Pattern (recommended, rank 3): Pre-migration backup for SQLite/Turso"
topic: tool-catalog
tags: [pattern:recommended, sqlite, turso, backup, vacuum-into, wal, integrity-check, restorable]
summary: Take a consistent snapshot with VACUUM INTO (preferred; WAL-safe, no write lock), or the online backup API (not on Turso), or cp of the DB + -wal under a deferred txn. Then verify the backup is restorable before mutating the source.
importance: 9
project_path: /Users/nix/dev/node/adhd
data_quality: verified
fallback_reason: "memory_write returned MCP -32001; memory server became unresponsive mid-Phase-5 on 2026-09-25"
---

name: Pre-migration backup for SQLite/Turso (rank 3)
description: A verified, restorable backup is the only thing that makes an in-place copy migration reversible.
how_it_works:
  1. Preferred snapshot: `VACUUM INTO 'path'`. Produces a minimal, fully-vacuumed, CONSISTENT snapshot of a live DB and, unlike plain `VACUUM`, does NOT take the write lock. The target file must not already exist or must be empty, or VACUUM INTO errors. It fails if an open transaction exists on the same connection.
  2. Alternative: the SQLite online backup API (sqlite3_backup_init/step/finish) — incremental, source locked only while pages are read. NOT available on Turso: sqlite3_backup_init is a stub (❌ in COMPAT.md).
  3. Naive `cp` is unsafe in WAL mode: you must copy BOTH the main DB and the `-wal` sidecar AND hold a DEFERRED read transaction for the duration of the copy so the WAL is not truncated/checkpointed underneath you. The copy is then a point-in-time snapshot (misses writes during the copy). Copying only the `.db` is the classic corruption path.
  4. VERIFY the backup is restorable BEFORE mutating the source: open it with the production driver, run `PRAGMA integrity_check`, perform a real read (row count + a content digest), and record a sha256 of the backup file.
  5. Run `PRAGMA integrity_check` on the SOURCE before starting, so you never migrate an already-corrupt DB.
  6. Interruption caveat: an interrupted VACUUM INTO can leave an incomplete/corrupt output UNLESS `PRAGMA synchronous` is NORMAL or FULL (then it fsyncs after writing). Turso only supports synchronous OFF and FULL (NORMAL is unsupported).
strengths:
  - VACUUM INTO is documented by SQLite as an alternative to the backup API for live backups, and by the Turso author as not interfering with other writes.
  - A restorable-verified backup converts an unrecoverable mistake into a rollback.
weaknesses:
  - VACUUM INTO needs up to ~2x the DB size in free disk and may change ROWIDs of tables without an explicit INTEGER PRIMARY KEY.
  - Turso in-place `VACUUM` is experimental; only `VACUUM INTO` is supported there.
  - The online backup API can restart indefinitely if the source is written frequently ("may never run to completion").
  - `cp` best results require CoW filesystems (Btrfs/XFS/ZFS) or a proven quiescent/atomic snapshot.
references:
  - https://www.sqlite.org/lang_vacuum.html — §2.1 VACUUM INTO
  - https://www.sqlite.org/backup.html — online backup API; historical shared-lock+cp method
  - https://oldmoe.blog/2024/04/30/backup-strategies-for-sqlite-in-production/ — the deferred-txn + copy-both-files cp recipe
  - https://github.com/tursodatabase/turso/blob/main/COMPAT.md — VACUUM INTO ✅, in-place VACUUM experimental, backup API stub
  - https://litestream.io/ — continuous WAL shipping for point-in-time recovery
source: SQLite official docs + Oldmoe (Turso) + Turso COMPAT.md + Litestream
data_quality: verified
type: best-practice
