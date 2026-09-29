---
name: "Pattern (recommended, rank 2): Post-migration verification beyond row counts"
topic: tool-catalog
tags: [pattern:recommended, sqlite, turso, verification, content-hash, invariant, integrity-check, foreign-key]
summary: Verify with content hashes and invariant assertions, not counts; run PRAGMA integrity_check / foreign_key_check; and verify through the PRODUCTION driver. Row-count parity can be green while the store is unreadable by the real driver.
importance: 9
project_path: /Users/nix/dev/node/adhd
data_quality: verified
fallback_reason: "memory_write returned MCP -32001; memory server became unresponsive mid-Phase-5 on 2026-09-25"
---

name: Post-migration verification beyond row counts (rank 2)
description: Replace "did the row counts match?" with content-level, invariant-level, and production-driver verification.
how_it_works:
  1. Prove the copy with CONTENT: compute a per-row content hash (e.g. sha256 over a canonical serialization of the columns) on source and target and compare an aggregate digest; or a SQL-level aggregate over key columns. Counts are necessary but never sufficient.
  2. Assert INVARIANTS, not just cardinality. For every foreign key assert the SQLite equation `child_key IS NULL OR EXISTS(SELECT 1 FROM parent WHERE parent_key = child_key)` — the "every parent has a child / no orphans" check — implemented as NOT EXISTS anti-joins.
  3. Run engine integrity checks: `PRAGMA integrity_check` (verifies b-tree structure AND index-vs-table consistency) and `PRAGMA foreign_key_check` (returns one row per FK violation). `quick_check` is a faster subset that SKIPS the index-vs-table check.
  4. Verify with the PRODUCTION driver/host, never a convenient one. A real incident had exact row counts and clean DDL while the production driver could not even open a rebuilt table.
  5. Enable FK enforcement explicitly (`PRAGMA foreign_keys = ON`) per connection — it is OFF by default, so FK violations pass silently during the copy.
  6. Make verification assertions fail loudly (non-zero exit) and non-optional. A "change with no verify script emits a warning, not a failure" default is insufficient.
strengths:
  - Catches the failure class row counts cannot: a structurally broken or driver-invisible target holding the right number of rows.
weaknesses:
  - Content hashing is O(rows); the serialization must be canonical/deterministic (null handling, numeric formatting, ordering).
  - Turso stores text as UTF-8 and substitutes U+FFFD for invalid UTF-8 where SQLite preserves raw bytes — a text hash computed on one engine can differ on the other. Hash blobs/keys or normalize first.
  - Turso does NOT support `PRAGMA foreign_key_check`; use explicit SQL anti-joins there.
  - `VACUUM` can change ROWIDs of tables lacking an explicit INTEGER PRIMARY KEY — never verify by rowid.
  - `integrity_check` is O(N log N) and can false-positive on stale expression indexes.
references:
  - https://www.sqlite.org/pragma.html#pragma_integrity_check
  - https://www.sqlite.org/foreignkeys.html (§2: FK enforcement off by default; §1: the child/parent invariant)
  - https://sqitch.org/docs/manual/sqitch-verify/ — per-change verify scripts that must exit non-zero
  - https://github.com/tursodatabase/turso/blob/main/COMPAT.md — integrity_check ✅, quick_check ✅, foreign_key_check ❌
  - prior art (memory): 01M35BE3DPY1R1KNXAYHZKH1GW (integrity_check) ; store-adapter fiasco 01KZSV4NMH7VTV2D55KPBRBK74 (verify with the production driver)
source: SQLite docs + Sqitch docs + Turso COMPAT.md + prior incidents
data_quality: verified
type: best-practice
