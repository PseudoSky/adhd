---
name: umzug — framework-agnostic Node/TypeScript migration runner
topic: tool-catalog
tags: [agent:approved, migration-tool, nodejs, typescript, database-agnostic]
summary: Sequelize team's framework-agnostic Node migration runner (MIT, 3.8.3, 1.56M weekly npm downloads, 2.2k stars). Pluggable storages = version ledger; `rerun:THROW` refuses re-runs; errors wrapped and re-thrown. Fits a Node one-shot migration with a durable ledger.
importance: 7
project_path: /Users/nix/dev/node/adhd
data_quality: verified
fallback_reason: "memory_write returned MCP -32001; memory server became unresponsive mid-Phase-5 on 2026-09-25"
---

name: umzug — framework-agnostic Node/TypeScript migration runner
description: Migration runner for Node built by the Sequelize team. Programmatic API + generated CLI; pluggable storage backends define where the version ledger lives.
features:
  - Programmatic API (up/down/pending/executed) plus a generated CLI via runAsCLI()
  - Pluggable storages: JSONStorage, memoryStorage, SequelizeStorage (SequelizeMeta table), MongoDBStorage, custom
  - `rerun: 'THROW' | 'SKIP' | 'ALLOW'` governs behavior when an already-applied migration is passed by name; default THROW = refuse
  - Migration errors wrapped in MigrationError (with .cause) and RE-THROWN — fail loud
  - Events: migrating/migrated/reverting/reverted + beforeCommand/afterCommand
  - FileLocker: filesystem-based locking via beforeAll/afterAll
  - `--step`, `--to`, and `pending --json` / `executed --json` for pipelines
  - Lexicographic file ordering (documented gotcha: m1, m10, m11, m2)
use_cases:
  - Node programmatic one-shot migration backed by a real storage ledger
  - Wrapping a table-copy step in an up()/down() pair with JSON or DB storage
quality_signals:
  weekly_downloads: 1558395
  last_update: 3.8.3
  license: MIT
  github_url: https://github.com/sequelize/umzug
  github_stars: 2215
  docs_url: https://github.com/sequelize/umzug (README)
data_quality: verified
metrics_source:
  weekly_downloads: "https://api.npmjs.org/downloads/point/last-week/umzug"
  version/license/repository: "npm view umzug version license repository.url"
  github_stars/license: "https://api.github.com/repos/sequelize/umzug"
