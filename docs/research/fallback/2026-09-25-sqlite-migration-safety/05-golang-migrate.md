---
name: golang-migrate — Go migration CLI/library with a dirty flag
topic: tool-catalog
tags: [agent:approved, migration-tool, go, sqlite, dirty-flag, fail-loud]
summary: Canonical 'dirty flag' migrator (18,940 stars). Marks the DB dirty before running, leaves it dirty on failure, refuses to continue until `force` is run. Philosophy: "When in doubt, fail." Supports SQLite.
importance: 7
project_path: /Users/nix/dev/node/adhd
data_quality: verified
fallback_reason: "memory_write returned MCP -32001; memory server became unresponsive mid-Phase-5 on 2026-09-25"
---

name: golang-migrate — Go migration CLI/library with SQLite support and a dirty flag
description: Go database-migration CLI + library. It sets a 'dirty' flag before each migration and, on failure, leaves it set — refusing further migrations until the operator resolves it.
features:
  - up/down with paired up.sql/down.sql migration files
  - schema_migrations table tracking version + dirty flag
  - On failure the dirty state PERSISTS, preventing further migrations running on top of a failed one
  - `migrate force <version>` clears dirty after manual repair
  - Graceful stop via GracefulStop chan bool 'to help prevent database corruptions'
  - Stated philosophy: drivers are 'dumb' and "don't assume things or try to correct user input — When in doubt, fail."
  - Database drivers include SQLite and SQLCipher
use_cases:
  - Reference for the dirty-flag fail-stop pattern in a CLI migrator
  - Simple Go/CLI SQLite migration driver
quality_signals:
  license: MIT (repo LICENSE; GitHub API reports NOASSERTION)
  github_url: https://github.com/golang-migrate/migrate
  github_stars: 18940
  docs_url: https://github.com/golang-migrate/migrate (README + FAQ.md + MIGRATIONS.md)
data_quality: verified
metrics_source:
  github_stars/forks: "https://api.github.com/repos/golang-migrate/migrate (18940 stars)"
  license: "https://api.github.com/repos/golang-migrate/migrate returns NOASSERTION; repo ships a LICENSE file (MIT)"
