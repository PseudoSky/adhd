---
name: "Pattern (recommended, rank 4): Fail-loud exit codes & refuse-rerun gates"
topic: tool-catalog
tags: [pattern:recommended, cli, exit-code, fail-loud, dirty-flag, dry-run, migration-gate]
summary: Abort on first error with a non-zero exit and a persistent failure marker; provide a dry-run; emit a machine-readable failure report naming the exact failed statement; and refuse to run against an unknown/dirty target.
importance: 8
project_path: /Users/nix/dev/node/adhd
data_quality: verified
fallback_reason: "memory_write returned MCP -32001; memory server became unresponsive mid-Phase-5 on 2026-09-25"
---

name: Fail-loud exit codes & refuse-rerun gates (rank 4)
description: How mature migration CLIs surface partial failure — and what a one-shot script should copy.
how_it_works:
  1. Default to ABORT-ON-FIRST-ERROR with a non-zero exit. Do not catch per-item and continue (golang-migrate: "When in doubt, fail."; Atlas --tx-mode file rolls back and stops; Sqitch verify scripts must exit non-zero).
  2. Persist a FAILURE MARKER so a subsequent run refuses to proceed until a human resolves it: golang-migrate's `dirty` flag (cleared only by `force`); Flyway leaves failed migrations and blocks until `repair`.
  3. If batch-continue is genuinely wanted, make it explicit and counted (Atlas rollout `on_error = CONTINUE`) and still exit non-zero if anything failed — never silently.
  4. Emit a MACHINE-READABLE failure report naming the exact failed statement/migration (Atlas `--format '{{ json . }}'` with a per-file Error object; Flyway has structured validate output + JSON).
  5. Provide `--dry-run` that reports pending work without executing it.
  6. Use a documented EXIT-CODE taxonomy so CI can branch on the failure class (Flyway documents its error/exit codes).
  7. Refuse to run against an unknown/dirty target: Atlas `--allow-dirty` gate; Flyway `NON_EMPTY_SCHEMA_WITHOUT_SCHEMA_HISTORY_TABLE` → run `baseline`.
strengths:
  - A persisted failure marker prevents compounding a partial migration with a second one.
  - Machine-readable errors let automation act on the exact failing migration.
weaknesses:
  - Collect-all-errors is the right shape for bulk batch jobs but must still surface a non-zero exit and a failure count.
  - A dirty/blocked state can itself strand a system; it needs a documented, deliberate recovery command (`force`/`repair`).
references:
  - https://documentation.red-gate.com/flyway/reference/commands/validate — validate failure conditions
  - https://documentation.red-gate.com/fd/reference/exit-codes-and-error-codes/general-error-codes — error-code taxonomy
  - https://atlasgo.io/versioned/apply — --tx-mode, --allow-dirty, --format json, dry-run, on_error
  - https://github.com/golang-migrate/migrate — dirty flag; "When in doubt, fail."
  - https://sqitch.org/docs/manual/sqitch-verify/ — verify scripts exit non-zero on failure
source: Flyway docs + Atlas docs + golang-migrate README + Sqitch docs
data_quality: verified
type: best-practice
