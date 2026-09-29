---
name: rusqlite_migration — SQLite migration library using PRAGMA user_version
topic: tool-catalog
tags: [agent:approved, migration-tool, rust, sqlite, user-version]
summary: Apache-2.0 SQLite migration library (2.6.0, 4.2M total crates.io downloads, 1.7M recent) that stamps state in PRAGMA user_version rather than a ledger table, with Migrations::validate() built in. Reference for the lightweight version-stamp idiom.
importance: 6
project_path: /Users/nix/dev/node/adhd
data_quality: verified
fallback_reason: "memory_write returned MCP -32001; memory server became unresponsive mid-Phase-5 on 2026-09-25"
---

name: rusqlite_migration — SQLite migration library using PRAGMA user_version
description: Minimal, performant schema-migration library for rusqlite that records migration state in SQLite's built-in `PRAGMA user_version` integer instead of a ledger table.
features:
  - Tracks current migration state with user_version (an i32 at a fixed file offset) — no extra table to parse or query
  - Migrations::new([...]) / to_latest(&mut conn) applies migrations atomically
  - Migrations::validate() — a built-in test asserting the migration set is consistent
  - Supports downward migrations and async; optional from-directory feature to load *.sql files
  - No CLI required; no macros
  - Documented limits: if any other code changes user_version, behavior is unspecified; the version is an i32
use_cases:
  - Embedded Rust/SQLite apps wanting a lightweight migration stamp without a ledger table
  - Reference for the version-stamp idiom (PRAGMA user_version) as an alternative to a schema_migrations table
quality_signals:
  total_downloads: 4208073
  recent_downloads: 1704785
  last_update: 2.6.0
  license: Apache-2.0
  github_url: https://github.com/cljoly/rusqlite_migration
  github_stars: 114
  docs_url: https://docs.rs/rusqlite_migration/
data_quality: verified
metrics_source:
  total_downloads/recent_downloads: "https://crates.io/api/v1/crates/rusqlite_migration"
  license: "https://api.github.com/repos/cljoly/rusqlite_migration (SPDX Apache-2.0)"
  github_stars: "https://api.github.com/repos/cljoly/rusqlite_migration"
  version: "crates.io API newest_version"
