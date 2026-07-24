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

## Filed deferrals (review folds)

### DEFER-APIGEN-SERVE-CORE-PYGRPC-STREAMING-001 — py-grpc does not serve streaming ops (scope boundary, not a capability verdict)
- This epic's py-grpc extract/serve split (`FEAT-APIGEN-SERVE-CORE-009`) explicitly REJECTS `streaming:true` ops rather than serving them, matching CLI. gRPC natively supports server streaming and a consumer will want it — so this is a DOCUMENTED, tracked deferral (dod.5, [fix:pygrpc-streaming-deferral]), NOT a permanent no. Re-open as its own item to wire gRPC server-streaming through the injected plan once a consumer needs it.
- Citations: [apigen-serve-core-planbuilder, claude (opus), apigen-serve-core, 1: docs/plan/apigen-serve-core/contexts/py-grpc-serve-split.md (Review folds); 2: docs/plan/apigen-serve-core/README.md dod.5]

### DEFER-APIGEN-SERVE-CORE-CLI-USE-001 — cli-output `--use` capability (CONDITIONAL — file only if the executor declares cli `--use`-incapable)
- `FEAT-APIGEN-SERVE-CORE-008` (cli-adapter) MUST resolve cli-output's `--use` capability (it has zero today): either ADD `--use` layer/mount support (consistent with fastify/express/mcp) — in which case this deferral is void — OR explicitly declare cli-output `--use`-incapable, in which case promote THIS item to the repo BACKLOG.md as a real open follow-up with the rationale. dod.11 forbids leaving it an unstated gap. Recorded here so the decision is never silent.
- Citations: [apigen-serve-core-planbuilder, claude (opus), apigen-serve-core, 1: docs/plan/apigen-serve-core/contexts/cli-adapter.md (Review folds); 2: docs/plan/apigen-serve-core/README.md dod.11]

### BUG-APIGEN-MCP-STREAMING-HTTP-NO-ERROR-GUARD-001 — folded into mcp-adapter (dod.15)
- Filed in the repo BACKLOG.md under FEAT-007's scope. The mcp streaming-http handler (`run.ts:269-276`) lacks the try/catch the sse handler has (`243-249`) → an unhandled rejection can crash the process. The mcp-adapter migration fixes it (route both HTTP transports' errors through the adapter `writeError`) AND adds the missing real-client SSE + StreamableHTTP transport parity coverage. Proven by dod.15 + criteria mcp-adapter.9/.10 + the negative control.
- Citations: [apigen-serve-core-planbuilder, claude (opus), apigen-serve-core, 1: packages/apigen/apigen-plugin-mcp/src/lib/run.ts:243-249,269-276; 2: docs/plan/apigen-serve-core/contexts/mcp-adapter.md (MCP SSE / streaming-http transport); 3: BACKLOG.md BUG-APIGEN-SERVE-CORE-001 fold]

## Bugs discovered during execution

> **BUG-APIGEN-SERVE-CORE-CRITERIA-CWD-001 — RESOLVED 2026-07-24 by apigen-serve-core-orchestrator.**
> Root cause (confirmed empirically): `run-audit.js`'s `resolveBase()` (`scripts/run-audit.js:229-231`)
> resolves a criterion's `paths`/`cmd` against the runner's own cwd unless the criterion opts in with
> `"cwd":"repo-root"` (BL-96(1), `run-audit.js:19-41`); `state-transition.js`'s `runAudit()` always spawns
> the runner with `{cwd: planDir}` while forwarding `--repo-root`, and all 59 criteria in
> `scripts/criteria.json` are repo-root-relative but NONE set `cwd` → every `present`/`command`/`negative-control`
> check false-FAILed (`serve-core-primitives --complete` reported `audit_criteria_passed:3/21` despite the guard
> passing 180/180 and every pattern present). **Fix:** added `"cwd":"repo-root"` to all 59 entries (mechanical,
> scriptable). **Verified:** re-running `run-audit.js --phase phase-1 --repo-root <repo>` from `cwd=planDir`
> (exactly as `state-transition.js` invokes it) now passes all 8 path-resolving `serve-core-primitives` criteria
> (exit 0). This restores a trustworthy audit signal for every remaining state's `--complete` and the final
> `[dod.*]` gate. See repo CHANGELOG.md.
> Citations: [apigen-serve-core, serve-core-primitives→orchestrator, claude (opus/sonnet-5), 1: scripts/run-audit.js:19-41,229-231; 2: scripts/criteria.json (now 59/59 `cwd:"repo-root"`); 3: state-transition.js `runAudit()` (`spawnSync("node",[...],{cwd:planDir})` + `--repo-root`); 4: scripts/audit_apigen-serve-core.py:103-111 (`--repo-root` forwarded); 5: state.json (`serve-core-primitives.status:"complete"`); 6: `CI=true ./node_modules/.bin/nx run apigen-engine-runtime:test` → exit 0, 180/180]
