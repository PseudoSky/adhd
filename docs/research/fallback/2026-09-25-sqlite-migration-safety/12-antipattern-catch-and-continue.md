---
name: "Antipattern: catch-and-continue per-table migration (silent partial success)"
topic: tool-catalog
tags: [pattern:antipattern, catch-and-continue, silent-failure, partial-migration, exit-code]
summary: Wrapping each table/item copy in try/catch and logging+continuing leaves a partially-migrated database that exits 0 and looks successful. The fix is abort-on-first-error (or collect-and-exit-nonzero with a persisted failure marker).
importance: 8
project_path: /Users/nix/dev/node/adhd
data_quality: verified
fallback_reason: "memory_write returned MCP -32001; memory server became unresponsive mid-Phase-5 on 2026-09-25"
---

name: Antipattern — catch-and-continue per-table migration
description: Catching an error per table/item, logging it, and continuing, so a partially-migrated database exits 0 and reports success.
why_its_harmful:
  - It leaves a partial state that later reads treat as complete, and the failure is invisible to CI.
  - Real precedent: a Turso catalog build aborted SILENTLY at the first unparseable sqlite_master row, dropping every object after it with NO error on open — "no error on open does not mean the store works" (memory BL-508).
  - The golang-migrate dirty-flag pattern exists precisely to prevent this: a failed migration must block the next one.
correct_alternative:
  - Abort on first error with a non-zero exit, OR collect all errors, report them, persist a failure marker, and exit non-zero.
  - Never convert a per-item error into a success exit code.
references:
  - "memory (this repo): 01KZSV4NMH7VTV2D55KPBRBK74 (silent abort; BL-508), 01KZSSM2RW78BZBAF153DBQWV9"
  - https://github.com/golang-migrate/migrate — dirty flag; "When in doubt, fail."
source: prior incidents in memory + golang-migrate README
data_quality: verified
type: best-practice
