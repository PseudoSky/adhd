# BACKLOG — apigen-serve-core plan

Plan-level risks and open questions surfaced during authoring (2026-07-23). Code
defects belong in the repo-root `BACKLOG.md`; this file holds plan-scoped items per
the disclosure protocol. The epic + child decomposition live in the repo `BACKLOG.md`
§"apigen serve-core refactor" (`FEAT-APIGEN-SERVE-CORE-000`..`009`, `DEBT-…-011`).

## Open questions carried into execution (not defects)

### RISK-SERVE-CORE-PLAN-001 — shared parity-harness cross-package test-only export mechanism unresolved
- The parity harness is authored in `apigen-engine-runtime/src/test-support/` and imported by four other plugins' spec files. The exact export plumbing (a `@adhd/apigen-engine-runtime/testing` subpath export vs. a deep relative import vs. a tiny dedicated test-support entry) is left to the `parity-harness` executor within its reservation. Must NOT bloat the shipped `apigen-engine-runtime` public `index.ts` (production build inputs exclude tests, but a public subpath export would ship). Decide in `parity-harness`; if a new package turns out warranted, it MUST go through `npx nx g @adhd/workspace-codegen-nx:<tier> --group apigen` (never hand-created).
- Citations: [apigen-serve-core-planbuilder, claude (opus), apigen-serve-core, 1: docs/plan/apigen-serve-core/contexts/parity-harness.md; 2: docs/apigen/proposals/transport-serve-core-refactor.md §6]

### RISK-SERVE-CORE-PLAN-002 — py-grpc run/serve shape unverified until the preflight spike
- The architecture review did not read `apigen-plugin-py-grpc/src/lib/plugin.ts` or `apigen_python/grpc_server.py`. `py-grpc-serve-split`'s scope (and criterion `py-grpc-serve-split.2`'s `_route_for` deletion pattern) ASSUMES it mirrors py-flask. `py-extract-preflight` verifies this before `py-grpc-serve-split` runs; if it differs, that state amends (executor-class) the grpc criteria/scope.
- Citations: [apigen-serve-core-planbuilder, claude (opus), apigen-serve-core, 1: docs/plan/apigen-serve-core/contexts/py-extract-preflight.md; 2: docs/apigen/proposals/transport-serve-core-refactor.md §8.3,§8.4]

### RISK-SERVE-CORE-PLAN-003 — extractor.py import-time side-effect safety (proposal §8.3) unverified
- The two-phase extract/serve split assumes `apigen_python.extractor.extract_module()` is safe to run as a separate side-effect-free process from the serving process. Not verified in review (`extractor.py` not read). `py-extract-preflight` records a `DECISION:` verdict; a negative verdict is a PLANNER-CLASS escalation (a state may need inserting).
- Citations: [apigen-serve-core-planbuilder, claude (opus), apigen-serve-core, 1: docs/plan/apigen-serve-core/contexts/py-extract-preflight.md; 2: docs/apigen/proposals/transport-serve-core-refactor.md §8.3]

### RISK-SERVE-CORE-PLAN-004 — verify-dist-load target may not exist for every consumer-loaded package
- `[dod.10]` (audit-final) runs `verify-dist-load` for `apigen-engine-runtime` + the four TS plugins. If a target is not wired for a package, the audit reports a hard FAIL asking the executor to add it (AGENTS.md §5). Wiring any missing `verify-dist-load` target is in-scope for whichever adapter state ships that package.
- Citations: [apigen-serve-core-planbuilder, claude (opus), apigen-serve-core, 1: docs/plan/apigen-serve-core/scripts/audit_apigen-serve-core.py (verify_dist_load); 2: AGENTS.md §5]
