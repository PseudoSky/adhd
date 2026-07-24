# apigen transport-neutral serve-core + thin adapters

Centralize the op→wire serve loop into `OpPlan` + `createPackageInvoker` +
`dispatchForPlan` + a `TransportAdapter` port in `apigen-engine-runtime`, then
migrate every transport (fastify, express, mcp, cli, py-flask, py-grpc) onto it
under a **byte-identical parity gate**. Epic `FEAT-APIGEN-SERVE-CORE-000`.

Authoritative design: `docs/apigen/proposals/transport-serve-core-refactor.md`
(v0.2). Decomposition + citations: `BACKLOG.md` §"apigen serve-core refactor".

## Consumer

Two consumers, both exercised through their real seam, never a mock:
1. **A caller of a served apigen package** — an HTTP client (`fetch`), a real
   `@modelcontextprotocol/sdk` MCP client, a spawned CLI child process, and an
   HTTP/gRPC client of a spawned Python server. They must observe **the same
   bytes/status/tool-shape/exit-code after the refactor as before it**.
2. **An apigen plugin author** — writes one `TransportAdapter` (readCall /
   writeResult / writeError) instead of re-implementing the whole serve loop;
   reads `plan.http`/`plan.mcp`/`plan.cli`/`plan.envelope`/`plan.cliFlags`
   instead of re-deriving projection per plugin.

## Value delta

- **Before:** the op→wire projection is re-authored in each plugin — 4 near-identical
  TS route/tool shim call sites + a 5th Python reimplementation; MCP silently skips
  the validate layer; `--use` mount metadata is dropped and mount ops bypass the
  invoker; SSE/MCP streaming is built but dead; express drops `undefined→null`.
- **After:** one `OpPlan` authority feeds every transport; each transport is a thin
  adapter proven byte-identical by a live-driven parity gate with a mandatory
  negative control; MCP validates + can host `--use`; streaming is wired (HTTP+MCP)
  or explicitly rejected (CLI/py); the Python side carries zero re-derived projection.

## Glossary

The second consumer (the apigen plugin author, see `## Consumer`) owns this
vocabulary — these terms appear in DoD clauses as that consumer's outcomes:

- **OpPlan** — the transport-complete, computed-once projection of one `Operation`.
- **TransportAdapter** — the port a plugin implements (readCall / writeResult / writeError).
- **createPackageInvoker** — the shared factory that composes `--use` layers + the validate layer.
- **makeValidateLayer** — the existing runtime layer that validates domain args before dispatch.
- **dispatchForPlan** — the shared dispatch that branches mount-vs-source and streaming-vs-scalar.

## Definition of Done

- `[dod.1]` **OpPlan + createPackageInvoker + dispatchForPlan + the TransportAdapter port exist in apigen-engine-runtime and are exported; the 4 duplicated TS route/tool shim call sites collapse into OpPlan construction (route-projection resolveRoute/resolveOperation, express route.ts resolveRoute/buildOperationIndex, mcp tool-naming deriveToolName/findOperation, cli-output inline project() all gone). (structural)**
  - delivered-by: `serve-core-primitives, fastify-adapter, express-adapter, mcp-adapter, cli-adapter`
- `[dod.2]` **Every TS transport (fastify, express, mcp, cli) is a TransportAdapter consuming OpPlan and passes its parity gate: a pre-migration golden capture of the live server/CLI deep-equals the post-migration capture, driven through the REAL consumer protocol. (behavioral)**
  - given: the current (unmigrated) transport is captured to a committed golden snapshot
  - when: the migrated adapter-based server/CLI is driven through fetch / @modelcontextprotocol/sdk / a spawned child
  - then: the re-capture deep-equals the committed snapshot for every fixture class
  - entrypoint: `CI=true ./node_modules/.bin/nx run-many -t test -p apigen-plugin-api-fastify,apigen-plugin-api-express,apigen-plugin-mcp,apigen-plugin-cli-output`
  - observable: `all four transports' parity specs pass; each asserts deep-equality against its committed golden snapshot`
  - delivered-by: `fastify-adapter, express-adapter, mcp-adapter, cli-adapter, parity-harness`
- `[dod.3]` **Each transport migration has a recorded negative control: reverting the migration (or a one-line regression) turns that transport's parity suite RED, and restoring turns it GREEN. (behavioral)**
  - given: the migrated transport with its parity gate green
  - when: the state's committed neg-control patch is applied (regression) then reverted
  - then: the parity suite is RED under the patch and GREEN after restore
  - entrypoint: `python3 docs/plan/apigen-serve-core/scripts/audit_apigen-serve-core.py --phase final`
  - observable: `each adapter's negative-control criterion reports the mutate variant RED and the restored variant GREEN`
  - delivered-by: `fastify-adapter, express-adapter, mcp-adapter, cli-adapter, py-flask-serve-split, py-grpc-serve-split`
- `[dod.4]` **MCP composes createPackageInvoker/makeValidateLayer for the first time; malformed MCP tool input is rejected with invalid_argument (was silently accepted) — a flagged, tested behavior change closing BUG-APIGEN-SERVE-CORE-001. (behavioral)**
  - given: a built mcp server loaded by a real host
  - when: a real @modelcontextprotocol/sdk client sends schema-violating tool input
  - then: the call rejects with invalid_argument instead of reaching the domain fn
  - entrypoint: `CI=true ./node_modules/.bin/nx run apigen-plugin-mcp:test`
  - observable: `a real @modelcontextprotocol/sdk client sending schema-violating input receives an invalid_argument error instead of a domain result`
  - negative-control: `git apply docs/plan/apigen-serve-core/neg-control/mcp-adapter.patch` (perturbs the mcp validate/adapter path) must flip `CI=true ./node_modules/.bin/nx run apigen-plugin-mcp:test` RED; `git apply -R` restores GREEN
  - delivered-by: `mcp-adapter`
- `[dod.5]` **Streaming is wired live: a streaming:true op emits SSE frames over fastify and progressive content over MCP; CLI, py-flask, and py-grpc explicitly reject a streaming op rather than silently mis-serializing an AsyncIterable. (behavioral)**
  - given: a package exposing a streaming:true op
  - when: the op is driven over fastify, mcp, and cli/py
  - then: fastify yields SSE frames, mcp progressive content, cli/py an explicit rejection
  - entrypoint: `CI=true ./node_modules/.bin/nx run-many -t test -p apigen-plugin-api-fastify,apigen-plugin-mcp,apigen-plugin-cli-output`
  - observable: `fastify streaming fixture yields SSE frames; mcp yields progressive content; cli/py streaming fixture returns an explicit rejection`
  - negative-control: `git apply docs/plan/apigen-serve-core/neg-control/fastify-adapter.patch` (perturbs the streaming write path) must flip the fastify parity suite RED; `git apply -R` restores GREEN
  - delivered-by: `fastify-adapter, mcp-adapter, cli-adapter`
- `[dod.6]` **The express undefined→null response-encoding gap (DEBT-APIGEN-SERVE-CORE-003) is closed via the shared adapter writeResult, pinned by a void-return-op fixture flagged as an intentional, tested behavior change. (structural)**
  - delivered-by: `express-adapter`
- `[dod.7]` **The --use mount-metadata loss (DEBT-APIGEN-SERVE-CORE-004) is fixed: mount ops carry full kind/safe/input/text through OpPlan and flow through dispatchForPlan's mount branch (the lossy MountRoute/collectMountRoutes bottleneck is deleted); the mount-through-use-layers decision is resolved and documented. (structural)**
  - delivered-by: `serve-core-primitives, fastify-adapter`
- `[dod.8]` **py-flask and py-grpc serve from a TS-computed plan via a two-phase extract/serve split; the Python project() re-derivation (_route_for_op/_is_primitive_only_input_schema/_http_verb) is deleted; parity is green against the real spawned Python server. (behavioral)**
  - given: the current single-phase Python server that re-derives projection
  - when: the TS plugin injects a real-project()-computed plan and spawns the split server
  - then: py-flask + py-grpc parity is green and the re-derivation functions are gone
  - entrypoint: `CI=true ./node_modules/.bin/nx run-many -t test -p apigen-plugin-py-flask,apigen-plugin-py-grpc`
  - observable: `py-flask + py-grpc parity specs pass against real spawned servers, and grep shows the three re-derivation functions removed from flask_server.py/grpc_server.py`
  - negative-control: `git apply docs/plan/apigen-serve-core/neg-control/py-flask-serve-split.patch` (perturbs the injected-plan route map) must flip the py-flask parity suite RED; `git apply -R` restores GREEN
  - delivered-by: `py-flask-serve-split, py-grpc-serve-split, py-extract-preflight`
- `[dod.9]` **OUT OF SCOPE, pinned unchanged: BUG-APIGEN-SAFE-OP-MUTATIONS-OVER-GET-001 (GET-hoist of unsafe scalar-input ops) and BUG-APIGEN-CLI-SERVE-FRONT-PROXY-DOUBLE-SEGMENT-001 behave exactly as before this refactor — each has a parity fixture proving the current behavior is preserved, and neither is closed by this epic. (structural)**
  - delivered-by: `fastify-adapter, cli-adapter`
- `[dod.10]` **No regressions: CI=true npx nx affected -t test is green across all affected apigen packages, and verify-dist-load is green for every affected package a consumer loads dist from. (structural)**
  - delivered-by: `audit-final`

## Execution model

- **Parallel:** yes. Phase-2 (`express-adapter`, `mcp-adapter`, `cli-adapter`) is a
  write-disjoint wave (each rewrites a different plugin dir; all read the Phase-1
  runtime read-only). Phase-3 (Python track) is independent of Phase-2 and may run
  concurrently once `audit-foundation` clears.
- **Executors:** TypeScript states → a typescript-pro-class executor; Python states
  → a python-pro-class executor. One executor per track for the parallel waves.
  Model/effort tier per state is in `dag.json` `notes` and this README's phase table.
- **Review:** the plan itself was reviewed by `architect-reviewer` (Step 1c — new
  primitive + shared library + non-regression triggers all fired). Per-state teeth
  are the parity gate + mandatory negative control (AGENTS.md §7); audit hold points
  (`audit-foundation`, `audit-transports`, `audit-python`, `audit-final`) gate each
  phase boundary. Reviewer/acceptor of "done": **team-lead**.
- **Automatic dispatch:** NO. This planner is not the executor; hand off to
  `plan-orchestrator` (Dispatch line at the bottom of this file after publish).

## Phases, tiering, critical path

| State | Phase | Kind | Effort / tier |
|---|---|---|---|
| serve-core-primitives | 1 | work | Large / Opus |
| parity-harness | 1 | work | Medium / Sonnet |
| fastify-adapter | 1 | work | Large / Opus |
| audit-foundation | 1 | audit | Sonnet |
| express-adapter | 2 | work | Medium / Sonnet |
| mcp-adapter | 2 | work | Large / Opus |
| cli-adapter | 2 | work | Medium / Sonnet |
| audit-transports | 2 | audit | Sonnet |
| py-extract-preflight | 3 | work (spike) | Medium / Sonnet |
| py-flask-serve-split | 3 | work | Large / Opus |
| py-grpc-serve-split | 3 | work | Large / Sonnet-Opus |
| audit-python | 3 | audit | Sonnet |
| audit-final | final | audit | Sonnet |

**Critical path (8 hops):** serve-core-primitives → fastify-adapter →
audit-foundation → py-extract-preflight → py-flask-serve-split →
py-grpc-serve-split → audit-python → audit-final.

## Status & protocol

- `node "$SKILL/state-transition.js" <plan-dir> <state> --start` then do the work in
  `contexts/<state>.md` + `contexts/_shared.md` within the declared reservations,
  honor the Commit points, then `--complete --note '<what you did/verified>'`.
- Guards are red→green and pinned; audits are hold points with no deferrable items.
- Amend via `state-transition.js … --amend` (executor-class in place; planner-class
  halts and escalates). Never `git stash`/`git reset --hard`; commit each plan write.

## Out of scope / parked

- `DEBT-APIGEN-SERVE-CORE-011` (Phase 4: model `--source` as a source-plugin) is
  **PARKED** — not a schedulable state. Revisit only when a second real TS-side
  source kind lands. See its BACKLOG entry for the revisit condition.

- `[dod.11]` **Every transport's --use capability (BOTH layer AND mount) is explicitly RESOLVED and DOCUMENTED, never left implicit: cli-output either gains --use or is declared --use-incapable WITH a filed follow-up BACKLOG item; mcp states whether it now hosts --use mount ops and pins it (dod.4 covers validate-layer composition, NOT the mount capability). (structural)** — Every transport's --use capability (BOTH layer AND mount) is explicitly RESOLVED and DOCUMENTED, never left implicit: cli-output either gains --use or is declared --use-incapable WITH a filed follow-up BACKLOG item; mcp states whether it now hosts --use mount ops and pins it (dod.4 covers validate-layer composition, NOT the mount capability)..

- `[dod.12]` **The MCP tool table (toolMetas) is computed ONCE at startup from OpPlan, not rebuilt on every request in streaming-http mode (the latent perf defect at apigen-plugin-mcp/src/lib/run.ts:269-276) — an observable, tested clause so it cannot silently regress. (behavioral)** — The MCP tool table (toolMetas) is computed ONCE at startup from OpPlan, not rebuilt on every request in streaming-http mode (the latent perf defect at apigen-plugin-mcp/src/lib/run.ts:269-276) — an observable, tested clause so it cannot silently regress..
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `CI=true ./node_modules/.bin/nx run apigen-plugin-mcp:test`
  - observable: `the mcp server builds its tool table once at startup; a test asserting the build count stays 1 across multiple CallTool requests passes`
  - delivered-by: `mcp-adapter`

- `[dod.13]` **The UsePlugin/readUsePlugins/readUseOptions/adaptCoreLayer/buildInvokerForPackage block (~120 identical lines) is PROMOTED into apigen-engine-runtime (createPackageInvoker) and DELETED from apigen-plugin-api-fastify/src/lib/run.ts; express COLLAPSES onto createPackageInvoker instead of keeping its own copy. (structural)** — The UsePlugin/readUsePlugins/readUseOptions/adaptCoreLayer/buildInvokerForPackage block (~120 identical lines) is PROMOTED into apigen-engine-runtime (createPackageInvoker) and DELETED from apigen-plugin-api-fastify/src/lib/run.ts; express COLLAPSES onto createPackageInvoker instead of keeping its own copy..
