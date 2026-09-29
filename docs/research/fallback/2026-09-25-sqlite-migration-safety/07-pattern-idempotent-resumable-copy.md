---
name: "Pattern (recommended, rank 1): Idempotent & resumable table copy"
topic: tool-catalog
tags: [pattern:recommended, sqlite, idempotent, resumable, upsert, checkpoint, migration-stamp]
summary: Make the copy safe to re-run: wrap it in one transaction where feasible, use UPSERT (ON CONFLICT DO UPDATE) rather than INSERT OR IGNORE, checkpoint by a stable key for long copies, and stamp a version/checksum ledger that refuses a silent re-run.
importance: 9
project_path: /Users/nix/dev/node/adhd
data_quality: verified
fallback_reason: "memory_write returned MCP -32001; memory server became unresponsive mid-Phase-5 on 2026-09-25"
---

name: Idempotent & resumable table copy (rank 1)
description: The single highest-value pattern for a one-shot table-copy migration — make it safe to re-run and safe to crash.
how_it_works:
  1. Wrap the whole copy in ONE transaction where feasible. SQLite auto-rolls-back an interrupted transaction, so a crash leaves neither partial rows nor a half-state. In better-sqlite3 use db.transaction(fn) (commit-on-return / rollback-on-throw).
  2. Make every write re-runnable. For a copy use UPSERT: `INSERT ... ON CONFLICT(<key>) DO UPDATE SET ...`, so a re-run converges AND genuinely refreshes changed rows. Reserve `INSERT ... ON CONFLICT DO NOTHING` for append-only/seed data. Do NOT use `INSERT OR IGNORE`, which silently swallows NOT NULL/CHECK/FK violations, not just uniqueness conflicts.
  3. For copies too large for one transaction, batch by a stable key range and persist a CHECKPOINT (the max key copied) plus a migration version stamp; resume from the checkpoint.
  4. Stamp a version in a ledger (schema_migrations / refinery_schema_history / atlas_schema_revisions) or `PRAGMA user_version`. Refuse to re-run unless the stamp is absent or `--force` is passed.
  5. Make the first step a no-op when the stamp already matches, so re-running against the migrated target is safe.
strengths:
  - A transaction removes the poisoned-partial-state class entirely; UPSERT makes retry safe even if the txn is killed (SQLite auto-rolls-back a killed process's txn).
  - Works identically on better-sqlite3 and libSQL/Turso (same SQLite SQL).
weaknesses:
  - ON CONFLICT only intervenes for UNIQUE/PK conflicts — NOT NULL/CHECK/FK still abort (by design; that is fail-loud, but it means the copy must satisfy those by construction).
  - `DO UPDATE` uses ABORT conflict resolution: if the update body violates a constraint the whole INSERT rolls back.
  - A long transaction holds the write lock and can starve other writers.
  - Requires a real primary/natural key to detect duplicates; the upsert key must be immutable.
references:
  - https://www.sqlite.org/lang_upsert.html — ON CONFLICT only intervenes for uniqueness; DO UPDATE is always ABORT
  - https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md — transaction() semantics
  - https://github.com/golang-migrate/migrate — dirty flag / refuse-to-continue
  - https://atlasgo.io/versioned/apply — baseline / --allow-dirty / --tx-mode
  - prior art (memory): crash-safe idempotent seeding episode 01M3CZS849EG40SMF8S8QD7XEQ
source: SQLite UPSERT docs + better-sqlite3 api.md + golang-migrate + Atlas docs + prior memory episode
data_quality: verified
type: best-practice
