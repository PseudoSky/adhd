---
name: Atlas — versioned migration tool with a merkle migration-directory checksum
topic: tool-catalog
tags: [agent:approved, migration-tool, merkle-checksum, versioned, go, atlas-sum]
summary: Atlas (Apache-2.0, 8,748 stars) enforces linear migration history via an atlas.sum merkle checksum over the migration directory and records revisions in atlas_schema_revisions. Reference for migration-set integrity, --allow-dirty refusal, and --tx-mode stop-on-failure.
importance: 7
project_path: /Users/nix/dev/node/adhd
data_quality: verified
fallback_reason: "memory_write returned MCP -32001; memory server became unresponsive mid-Phase-5 on 2026-09-25"
---

name: Atlas — declarative+versioned migration tool with a merkle migration-directory checksum
description: Modern schema-management tool (Ariga). Its versioned workflow enforces linear migration history via a migration-directory integrity file (`atlas.sum`) and records applied revisions in an `atlas_schema_revisions` table.
features:
  - `atlas.sum` = checksum of each migration file plus a directory sum (reverse, one-branch merkle hash tree); adding a file changes both, so parallel additions conflict in VCS
  - `atlas migrate hash` / `atlas migrate rebase` recompute; a mismatch is reported on the next command (CI and locally)
  - Applied migrations recorded in `atlas_schema_revisions`
  - Advisory lock while applying (default 10s lock-timeout; `--skip-lock`); uses db-native locks
  - `--tx-mode file|all|none`: one txn per file (default, roll back + stop), one txn for all, or none (stop on failure but resume from the failed statement on retry)
  - `--exec-order linear|linear-skip|non-linear`; `--allow-dirty` refuses to run on a DB with resources but no revision info
  - Pre-execution `check` allow/deny policy blocks; `--dry-run`; `--format '{{ json . }}'` machine-readable report with per-file Error object
use_cases:
  - Reference for 'verify the migration set itself did not drift' and for stop-on-failure transaction modes
  - CI gate via `atlas migrate lint`
quality_signals:
  license: Apache-2.0
  github_url: https://github.com/ariga/atlas
  github_stars: 8748
  docs_url: https://atlasgo.io/concepts/migration-directory-integrity and https://atlasgo.io/versioned/apply
data_quality: verified
metrics_source:
  license/github_stars: "https://api.github.com/repos/ariga/atlas (SPDX Apache-2.0, 8748 stars)"
  docs: "https://atlasgo.io/concepts/migration-directory-integrity and https://atlasgo.io/versioned/apply (fetched live)"
