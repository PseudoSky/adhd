---
name: "Antipattern: opt-in / weak verification (row-count-only, DDL-only, wrong driver)"
topic: tool-catalog
tags: [pattern:antipattern, opt-in-verification, row-count-only, wrong-driver, verification-teeth]
summary: Treating verification as optional (warning-only when absent), or verifying with row counts / DDL normalization / a non-production driver. A store can have exact counts and clean DDL and still be unreadable by the real driver.
importance: 8
project_path: /Users/nix/dev/node/adhd
data_quality: verified
fallback_reason: "memory_write returned MCP -32001; memory server became unresponsive mid-Phase-5 on 2026-09-25"
---

name: Antipattern — opt-in / weak verification
description: Four weak-verification shapes: (a) verification opt-in; (b) row-count-only; (c) DDL-normalization-only; (d) verification via a convenient (non-production) driver.
why_its_harmful:
  - Sqitch WARNS (does not fail) when a change has no verify script — a warning is not a gate.
  - Real incident: the store-adapter "acceptance" checked DDL normalization but never opened the rebuilt table with the production driver, and shipped a store the driver could not open. Row counts were EXACT (2,111 nodes / 1,207 edges) and `integrity_check` reported zero real errors, yet `SELECT count(*) FROM edge` failed with "no such table: edge".
  - better-sqlite3 read the file fine while the production Turso driver could not — a read by the wrong driver is not verification.
correct_alternative:
  - Verification is MANDATORY and fail-loud; assert content hashes + FK/invariant checks; drive the production entrypoint; prove the assertions have teeth (they must go red when the defect is reintroduced).
references:
  - "memory (this repo): 01KZSSM2RW78BZBAF153DBQWV9, 01KZSV4NMH7VTV2D55KPBRBK74"
  - https://sqitch.org/docs/manual/sqitch-verify/ — "If a change has no verify script, a warning is emitted, but it is not considered a failure."
source: prior incidents in memory + Sqitch docs
data_quality: verified
type: best-practice
