---
name: dbmate — standalone SQL migration CLI (SQLite-capable)
topic: tool-catalog
tags: [agent:approved, migration-tool, sqlite, cli, plain-sql, go]
summary: Language-agnostic plain-SQL migration CLI (MIT, 2.36.0, 179.7k weekly npm downloads, 7.4k stars). SQLite driver; atomic per-migration transaction; `transaction:false` for PRAGMA journal_mode=WAL; `status --exit-code` for CI. Stores version only — no content checksum, so it cannot detect an edited applied migration.
importance: 7
project_path: /Users/nix/dev/node/adhd
data_quality: verified
fallback_reason: "memory_write returned MCP -32001; memory server became unresponsive (even memory_ping timed out) mid-Phase-5 on 2026-09-25"
---

name: dbmate — standalone SQL migration CLI (SQLite-capable)
description: Language-agnostic, single-binary SQL migration CLI (Go) supporting SQLite, Postgres, MySQL, ClickHouse. Plain-SQL, timestamp-versioned migrations run atomically in a transaction.
features:
  - Plain-SQL files with `-- migrate:up` / `-- migrate:down` sections
  - Timestamp-versioned filenames avoid cross-developer version conflicts
  - Each migration runs atomically inside a transaction by default
  - Per-migration `transaction:false` option for statements that cannot run in a txn (e.g. `PRAGMA journal_mode = WAL`)
  - Stores ONLY the version in schema_migrations(version VARCHAR(255) PRIMARY KEY) — no content checksum
  - `--strict` fails if migrations would be applied out of order
  - `status --exit-code` for CI gating; `wait`/`--wait` for DB readiness; schema.sql dump
use_cases:
  - A one-shot SQLite/Turso table-copy expressed as a versioned up/down SQL file
  - CI gate on migration state via `dbmate status --exit-code`
  - Setting journal_mode=WAL via `transaction:false` (the pragma cannot run inside a transaction)
quality_signals:
  weekly_downloads: 179678
  last_update: 2.36.0
  license: MIT
  github_url: https://github.com/amacneil/dbmate
  github_stars: 7415
  docs_url: https://github.com/amacneil/dbmate (README)
data_quality: verified
metrics_source:
  weekly_downloads: "https://api.npmjs.org/downloads/point/last-week/dbmate"
  version/license/repository: "npm view dbmate version license repository.url"
  github_stars/license: "https://api.github.com/repos/amacneil/dbmate"
