---
name: "Pattern (recommended, rank 5): Migration-set integrity (content checksums / merkle)"
topic: tool-catalog
tags: [pattern:recommended, checksum, merkle, migration-history, validate, drift]
summary: Store a content checksum with each applied migration and refuse to proceed on mismatch (Flyway CRC32 + validate; refinery checksums + abort divergent/missing), or checksum the whole directory as a merkle sum (Atlas atlas.sum) to catch parallel edits.
importance: 8
project_path: /Users/nix/dev/node/adhd
data_quality: verified
fallback_reason: "memory_write returned MCP -32001; memory server became unresponsive mid-Phase-5 on 2026-09-25"
---

name: Migration-set integrity — content checksums / merkle (rank 5)
description: Detect when the migration script itself drifted since it was applied.
how_it_works:
  1. Record a CONTENT CHECKSUM of each migration at apply time and compare it on the next run; refuse to proceed on mismatch. Flyway stores a CRC32 for SQL migrations and `validate` fails on differences in names/types/checksums, on applied-but-unresolved versions, and on resolved-but-unapplied versions; the repair is `repair` (rewrite the stored checksum), safe only when the migration logic is unchanged.
  2. For a migration DIRECTORY, use a whole-directory checksum/merkle: Atlas `atlas.sum` holds each file's checksum plus a directory sum; two branches each adding a migration conflict on the sum, which is exactly what prevents parallel/out-of-order history. `atlas migrate hash` / `rebase` recompute.
  3. Detect divergent and missing migrations and abort (refinery set_abort_divergent / set_abort_missing).
  4. If your tool records only the version (dbmate), YOU must add checksum + drift detection yourself if it matters.
  5. Keep the checksum representation stable — refinery documents that changing the version type to int8 breaks the checksums of all previously-applied migrations.
strengths:
  - Catches silent edits to an already-applied migration — the class that otherwise corrupts environment parity.
  - A directory merkle sum makes parallel migration creation a merge conflict instead of a runtime failure.
weaknesses:
  - Checksums protect HISTORY, not the DATA (pair with content verification, rank 2).
  - Any whitespace/comment edit changes the checksum; `repair` can paper over real, meaningful edits.
  - Directory sums intentionally create merge conflicts, which requires an autorebase workflow.
references:
  - https://documentation.red-gate.com/flyway/reference/commands/validate
  - https://atlasgo.io/concepts/migration-directory-integrity
  - https://github.com/rust-db/refinery (README: checksums, divergent/missing abort)
  - https://github.com/amacneil/dbmate (version-only ledger — the un-checksummed contrast)
source: Flyway docs + Atlas docs + refinery README + dbmate README
data_quality: verified
type: best-practice
