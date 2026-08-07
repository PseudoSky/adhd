# dispatch-cli Capabilities

**Package:** `@adhd/dispatch-cli` (v0.0.4)  
**Location:** `entrypoint/dispatch-cli/`  
**Classification:** `entrypoint:cli` · `platform:node`  
**Last verified:** 2026-07-24T22:01:35-05:00 (`936d50dc`)

## Legend

- **Status:** ✅ shipped | 🟡 roadmap | ❌ deprecated | 🔴 UNVERIFIED
- **Substance:** ★ trivial | ★★★ moderate | ★★★★★ substantial
- **Provenance:** source-verified = function exists in source + tests pass | runtime-verified = actual CLI output captured

---

## CLI Commands (7 operations)

| # | ID | Name | Status | Substance | Provenance | Key Files |
|---|----|------|--------|-----------|------------|-----------|
| 1 | `cli-validate` | **validate** — structural dag.json validation | ✅ shipped | ★★★ | source + runtime | `src/api.ts:56`, `src/lib/core.ts:126`, `bin/cli.ts:60` |
| 2 | `cli-snapshot` | **snapshot** — compute fresh DagSnapshot | ✅ shipped | ★★★ | source | `src/api.ts:70`, `src/lib/core.ts:143`, `bin/cli.ts:72` |
| 3 | `cli-optimize` | **optimize** — compute next DispatchUnit batch | ✅ shipped | ★★★ | source | `src/api.ts:84`, `src/lib/core.ts:150`, `bin/cli.ts:84` |
| 4 | `cli-eligible` | **eligible** — list eligible milestone slugs | ✅ shipped | ★ | source | `src/api.ts:95`, `src/lib/core.ts:158`, `bin/cli.ts:96` |
| 5 | `cli-status` | **status** — per-milestone status report | ✅ shipped | ★★★ | source | `src/api.ts:108`, `src/lib/core.ts:184`, `bin/cli.ts:108` |
| 6 | `cli-run` | **run** — one orchestrator scheduling cycle | ✅ shipped | ★★★★★ | source | `src/api.ts:154`, `src/lib/core.ts:231`, `bin/cli.ts:120` |
| 7 | `cli-calibrate` | **calibrate** — measure baseline per-tier token cost ("B") | ✅ shipped | ★★★★★ | source | `src/api.ts:177`, `src/lib/core.ts:344`, `bin/cli.ts:133` |

## Supplementary Capabilities

| # | ID | Name | Status | Substance | Provenance | Key Files |
|---|----|------|--------|-----------|------------|-----------|
| 8 | `cli-apigen-generated` | **apigen-generated CLI artifact** (2/7 command working) | ✅ shipped | ★★★ | source + runtime | `project.json:64`, `dist/entrypoint/dispatch-cli/cli/cli.ts` |
| 9 | `cli-bin-absent` | **missing bin entry** in package.json | ✅ shipped | ★ | source + runtime | `package.json` (no `bin` field) |
| 10 | `cli-paid-boundary-run` | **run --no-dry-run** — paid AgentMcpRunner path | ✅ shipped | ★ | source | `src/lib/core.ts:117`, `bin/cli.ts:124` |
| 11 | `cli-e2e-real` | **real-e2e integration test harness** (8 scenarios) | ✅ shipped | ★★★★★ | source | `src/test/integration/real-e2e.ts` |
| 12 | `cli-publish-hygiene` | **publish life-cycle** (nx-release-publish) | ✅ shipped | ★ | source + runtime | `project.json:72`, npm registry v0.0.4 |

## Verification Notes

- All 30 tests pass (18 core.spec.ts + 12 cli-smoke.spec.ts)
- The hand-written `bin/cli.ts` (Commander) is the real, shipped CLI — all 7 commands work through it
- The apigen-generated CLI at `dist/entrypoint/dispatch-cli/cli/cli.ts` lists all 7 commands via `--help` but only `eligible` and `status` run without crashing
- No `bin` entry in `package.json` — CLI cannot be invoked via `npx` or `dispatch-cli` after npm install
- `run --no-dry-run` and `calibrate` are PAID BOUNDARIES (fire real billed model calls) — automatically verified for safe behavior only (all-complete dag, invalid tier fast-fail)
- Test coverage: 10 of 12 capabilities have `source-verified` provenance; 3 have `runtime-verified` via captured CLI output or npm registry check
