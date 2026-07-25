### RISK-SERVE-CORE-PLAN-002 — py-grpc run/serve shape unverified until the preflight spike

**Status:** UNKNOWN
**Plan:** apigen-serve-core

- The architecture review did not read `apigen-plugin-py-grpc/src/lib/plugin.ts` or `apigen_python/grpc_server.py`. `py-grpc-serve-split`'s scope (and criterion `py-grpc-serve-split.2`'s `_route_for` deletion pattern) ASSUMES it mirrors py-flask. `py-extract-preflight` verifies this before `py-grpc-serve-split` runs; if it differs, that state amends (executor-class) the grpc criteria/scope.
- Citations: [apigen-serve-core-planbuilder, claude (opus), apigen-serve-core, 1: docs/plan/apigen-serve-core/contexts/py-extract-preflight.md; 2: docs/apigen/proposals/transport-serve-core-refactor.md §8.3,§8.4]

### RISK-SERVE-CORE-PLAN-003 — extractor.py import-time side-effect safety (proposal §8.3) unverified

**Status:** UNKNOWN
**Plan:** apigen-serve-core

- The two-phase extract/serve split assumes `apigen_python.extractor.extract_module()` is safe to run as a separate side-effect-free process from the serving process. Not verified in review (`extractor.py` not read). `py-extract-preflight` records a `DECISION:` verdict; a negative verdict is a PLANNER-CLASS escalation (a state may need inserting).
- Citations: [apigen-serve-core-planbuilder, claude (opus), apigen-serve-core, 1: docs/plan/apigen-serve-core/contexts/py-extract-preflight.md; 2: docs/apigen/proposals/transport-serve-core-refactor.md §8.3]

### RISK-SERVE-CORE-PLAN-004 — verify-dist-load target may not exist for every consumer-loaded package

**Status:** UNKNOWN
**Plan:** apigen-serve-core

- `[dod.10]` (audit-final) runs `verify-dist-load` for `apigen-engine-runtime` + the four TS plugins. If a target is not wired for a package, the audit reports a hard FAIL asking the executor to add it (AGENTS.md §5). Wiring any missing `verify-dist-load` target is in-scope for whichever adapter state ships that package.
- Citations: [apigen-serve-core-planbuilder, claude (opus), apigen-serve-core, 1: docs/plan/apigen-serve-core/scripts/audit_apigen-serve-core.py (verify_dist_load); 2: AGENTS.md §5]

### DEFER-APIGEN-SERVE-CORE-PYGRPC-STREAMING-001 — py-grpc does not serve streaming ops (scope boundary, not a capability verdict)

**Status:** UNKNOWN
**Plan:** apigen-serve-core

- This epic's py-grpc extract/serve split (`FEAT-APIGEN-SERVE-CORE-009`) explicitly REJECTS `streaming:true` ops rather than serving them, matching CLI. gRPC natively supports server streaming and a consumer will want it — so this is a DOCUMENTED, tracked deferral (dod.5, [fix:pygrpc-streaming-deferral]), NOT a permanent no. Re-open as its own item to wire gRPC server-streaming through the injected plan once a consumer needs it.
- Citations: [apigen-serve-core-planbuilder, claude (opus), apigen-serve-core, 1: docs/plan/apigen-serve-core/contexts/py-grpc-serve-split.md (Review folds); 2: docs/plan/apigen-serve-core/README.md dod.5]

### DEFER-APIGEN-SERVE-CORE-CLI-USE-001 — cli-output `--use` capability (CONDITIONAL — file only if the executor declares cli `--use`-incapable)

**Status:** UNKNOWN
**Plan:** apigen-serve-core

- `FEAT-APIGEN-SERVE-CORE-008` (cli-adapter) MUST resolve cli-output's `--use` capability (it has zero today): either ADD `--use` layer/mount support (consistent with fastify/express/mcp) — in which case this deferral is void — OR explicitly declare cli-output `--use`-incapable, in which case promote THIS item to the repo BACKLOG.md as a real open follow-up with the rationale. dod.11 forbids leaving it an unstated gap. Recorded here so the decision is never silent.
- Citations: [apigen-serve-core-planbuilder, claude (opus), apigen-serve-core, 1: docs/plan/apigen-serve-core/contexts/cli-adapter.md (Review folds); 2: docs/plan/apigen-serve-core/README.md dod.11]

### BUG-APIGEN-MCP-STREAMING-HTTP-NO-ERROR-GUARD-001 — folded into mcp-adapter (dod.15)

**Status:** UNKNOWN
**Plan:** apigen-serve-core

- Filed in the repo BACKLOG.md under FEAT-007's scope. The mcp streaming-http handler (`run.ts:269-276`) lacks the try/catch the sse handler has (`243-249`) → an unhandled rejection can crash the process. The mcp-adapter migration fixes it (route both HTTP transports' errors through the adapter `writeError`) AND adds the missing real-client SSE + StreamableHTTP transport parity coverage. Proven by dod.15 + criteria mcp-adapter.9/.10 + the negative control.
- Citations: [apigen-serve-core-planbuilder, claude (opus), apigen-serve-core, 1: packages/apigen/apigen-plugin-mcp/src/lib/run.ts:243-249,269-276; 2: docs/plan/apigen-serve-core/contexts/mcp-adapter.md (MCP SSE / streaming-http transport); 3: BACKLOG.md BUG-APIGEN-SERVE-CORE-001 fold]
