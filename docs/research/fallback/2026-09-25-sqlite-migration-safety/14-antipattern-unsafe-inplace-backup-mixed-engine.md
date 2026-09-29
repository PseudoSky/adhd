---
name: "Antipattern: in-place-on-source / naive cp without WAL / mixed-engine access"
topic: tool-catalog
tags: [pattern:antipattern, in-place, naive-cp, wal-sidecar, mixed-engine, sqlite]
summary: Three related hazards — mutating the source DB in place with no rollback; backing up by copying only the .db file without the -wal/-shm sidecars; opening the same file with two engines (better-sqlite3 + Turso).
importance: 8
project_path: /Users/nix/dev/node/adhd
data_quality: verified
fallback_reason: "memory_write returned MCP -32001; memory server became unresponsive mid-Phase-5 on 2026-09-25"
---

name: Antipattern — unsafe in-place migration / naive cp / mixed-engine
description: (a) opening the target on the source path and mutating in place; (b) a naive `cp` of the main DB file without `-wal`/`-shm`; (c) mixing engines on the same file.
why_its_harmful:
  - In-place mutation removes any rollback path. A schema rebuild (ALTER-RENAME) can relocate a table's sqlite_master row after an unparseable row, blinding the production driver. Row counts stay correct while the store becomes unusable. "A migration that can blind the production driver is worse than no migration." (real incident)
  - `cp` of only the `.db` while in WAL mode loses committed-but-uncheckpointed data and can capture a torn snapshot; SQLite's historical "shared lock + cp" method can also corrupt the backup on power loss.
  - Turso guarantee #4: "We don't support mixed SQLite and Turso in multi-process scenarios." A raw better-sqlite3 connection does NOT interoperate with Turso's multiprocess WAL and mixing them corrupts the file (verified empirically in this repo).
correct_alternative:
  - Copy into a NEW target path (or temp DB) and atomically swap; never mutate the source in place without a verified backup.
  - Back up via VACUUM INTO, or the documented cp recipe that copies BOTH files inside a deferred read transaction.
  - Never open the same file with two engines concurrently; verify with the one production driver.
references:
  - "memory (this repo): 01KZSSM2RW78BZBAF153DBQWV9, 01KZQ90T0MKG86ND0EAG3EK22R (mixing engines corrupts the file)"
  - https://github.com/tursodatabase/turso/blob/main/COMPAT.md — Guarantees §4
  - https://www.sqlite.org/backup.html — historical cp method shortcomings
  - https://oldmoe.blog/2024/04/30/backup-strategies-for-sqlite-in-production/ — cp must copy both files in a deferred txn
source: prior incidents in memory + Turso COMPAT.md + SQLite docs + Oldmoe
data_quality: verified
type: best-practice
