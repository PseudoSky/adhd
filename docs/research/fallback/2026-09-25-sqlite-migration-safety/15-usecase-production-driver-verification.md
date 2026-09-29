---
name: "Use case: verify a migration with the production driver (store-adapter fiasco)"
topic: tool-catalog
tags: [use-case:reference, turso, verification, production-driver, sqlite-master, incident]
summary: A real Turso/libSQL incident where a schema-rebuild "heal" migration kept exact row counts and clean integrity_check but moved a table's sqlite_master row after rows the production driver could not parse — silently blinding the store. The transferable rule: drive the production entrypoint to verify, never row counts or a convenient driver.
importance: 8
project_path: /Users/nix/dev/node/adhd
data_quality: verified
fallback_reason: "memory_write returned MCP -32001; memory server became unresponsive mid-Phase-5 on 2026-09-25"
---

name: Verify a migration with the production driver (store-adapter fiasco)
description: How the adhd/sox backlog store was blinded by a self-heal migration that looked green on every count-based check.
context: The backlog store (~/.adhd/backlog/production/data/backlog.db) runs on the Turso (libSQL) Rust driver. A graph-store 0.8.2 FK-heal (rebuildTable / ALTER-RENAME) rebuilt the `edge` table, moving its sqlite_master row to a position AFTER Drizzle-era fts5 residue rows.
approach:
  - The Turso Rust engine parses sqlite_master in rowid order and ABORTS SILENTLY at the first unparseable row (no fts5 module); every later object (edge, indexes) never registers → `SELECT count(*) FROM edge` returns "Parse error: no such table: edge".
  - The pre-incident and post-incident counts were IDENTICAL (2,111 nodes / 1,207 edges), fk_check was 0, and integrity_check reported zero real errors — yet the store was unusable through the production driver.
  - The heal's own acceptance artifact only checked DDL normalization; it never re-opened the result with the Turso driver.
  - Repair: delete the 8 fts5-residue rows from sqlite_master using the authorized better-sqlite3 escape hatch (unsafeMode + PRAGMA writable_schema=ON) ON A COPY, verify post-repair Turso readability, then apply live; sha256-verified backups retained.
key_takeaway: Verification must drive the production entrypoint. Row-count, DDL, and integrity_check parity are NOT proof a migration worked; a rebuild that relocates a schema row can be worse than no migration at all.
source:
  - "memory (this repo/project): 01KZSV4NMH7VTV2D55KPBRBK74, 01KZSSM2RW78BZBAF153DBQWV9, 01KZSYYAWE9AZDS3NDSB75RB6K"
data_quality: verified
type: production-implementation
