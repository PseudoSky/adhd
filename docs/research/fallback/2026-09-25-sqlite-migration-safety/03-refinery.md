---
name: refinery — versioned SQL migration toolkit for Rust
topic: tool-catalog
tags: [agent:approved, migration-tool, rust, sqlite, checksum, versioned]
summary: Versioned Rust migration toolkit (MIT, 0.9.2, 10.4M total crates.io downloads, 1.7M recent, 1.7k stars) with a refinery_schema_history checksum ledger and explicit abort on divergent/missing migrations. Per-migration transaction by default; grouped option available.
importance: 7
project_path: /Users/nix/dev/node/adhd
data_quality: verified
fallback_reason: "memory_write returned MCP -32001; memory server became unresponsive mid-Phase-5 on 2026-09-25"
---

name: refinery — versioned SQL migration toolkit for Rust
description: Rust migration toolkit (postgres/mysql/rusqlite/tiberius) that records each applied migration's version + checksum in a `refinery_schema_history` table and aborts on divergent or missing migrations.
features:
  - Migration files `[U|V]{version}__{name}.sql`: V = contiguous/strictly-versioned; U = non-contiguous (tolerant of out-of-order development)
  - `refinery_schema_history` table stores applied versions + checksums; Runner compares applied vs to-apply
  - set_abort_divergent(true) / set_abort_missing(true) — refuse to proceed when history diverges or a migration is missing
  - Runs each migration in its own transaction by default; set_grouped(true) wraps ALL migrations in one transaction
  - refinery_cli for out-of-code runs; embed_migrations! bakes migrations into the binary
  - Roll-forward philosophy (based on Flyway's original): undo by writing a new migration
  - Documented hazard: switching version type to int8 breaks checksums on all previously-applied migrations
use_cases:
  - Rust services with embedded SQLite needing a checksum-verified migration ledger
  - Reference reading for 'abort on divergent/missing migration' semantics
quality_signals:
  total_downloads: 10418527
  recent_downloads: 1937727
  last_update: 0.9.2
  license: MIT
  github_url: https://github.com/rust-db/refinery
  github_stars: 1703
  docs_url: https://docs.rs/refinery/
data_quality: verified
metrics_source:
  total_downloads/recent_downloads: "https://crates.io/api/v1/crates/refinery"
  license: "https://api.github.com/repos/rust-db/refinery (SPDX MIT)"
  github_stars: "https://api.github.com/repos/rust-db/refinery"
  version: "crates.io API newest_version"
