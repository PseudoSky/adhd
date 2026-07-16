# Shared context — Dispatch Completion

> Single source of truth for definitions. Reference entries here from any
> context file instead of restating them. Every work state cites the invariants
> below rather than restating them.

## Glossary

- **[def:dispatch-projects]** — the ten nx projects this plan builds/greens: `dispatch-base-spec`, `dispatch-core-client`, `dispatch-serializer-json`, `dispatch-serializer-sqlite`, `dispatch-core-optimizer`, `dispatch-orchestrator`, `dispatch-plugin-io`, `dispatch-plugin-gitnexus`, `dispatch-tools`, `dispatch-cli`.
- **[def:import-alias]** — the standard package names imports must use: `@adhd/dispatch-base-spec` / `-core-client` / `-core-optimizer` (NOT the short `-spec`/`-client`/`-optimizer` — BUG-DISPATCH-PUBLISH-001 conformed these). `-orchestrator`/`-serializer-json`/`-cli` names already match their imports. New packages follow `<domain>-<tier>-<name>`.
- **[def:preconditions]** — BUG-DISPATCH-EXEC-001 (real tool-call execution wired) and BUG-DISPATCH-PUBLISH-001 (name/alias conformance) are fixed directly and land before this plan; Phase 0 `triage` verifies both (V0).
- **[def:debt-ledger]** — `BACKLOG.md` in this plan dir is the source of truth for the carried `DEBT-DISPATCH-*` items; each state closes the items its `## Notes` names.

## Cross-cutting invariants

- **[inv:worktree-required]** — This is an nx monorepo (`nx.json`). Every executor works in a git worktree under `.worktrees/` (`<actor>/<slug>` convention), never the main checkout — the shared build graph makes uncoordinated direct-checkout edits collide. When a worktree needs `node_modules`, **symlink** it from the main checkout: `ln -s <main-repo-root>/node_modules node_modules` — never reinstall (the tree is byte-identical until a `package.json` changes, at which point re-install only then).
- **[inv:nx-cache]** — Never pass `--skip-nx-cache` (or set `NX_SKIP_NX_CACHE`). The cache is correct; prove a hit by running a target twice. A stale-dist symptom is *caused by* `--skip-nx-cache`, not cured by it.
- **[inv:layer-purity]** — Layer/platform tags are load-bearing: `dispatch-base-spec` = shared/shared (zero-dep); `dispatch-core-optimizer`/`-core-client` = shared; plugins/`-serializer-sqlite`/`-tools`/`-cli` = node. A shared package must never import a node/logic/UI package. The optimizer stays pure — injected `IOptimizerDeps`, no I/O, graceful degradation when deps are null.
- **[inv:adapter-pattern]** — `IDagSerializer` + factory functions; the client never knows where the dag lives. The SQLite serializer must satisfy the identical `IDagSerializer` contract as JSON (parity is the acceptance). `DagClient` is the single CRUD authority; `dispatch-tools` MCP tools wrap it, never write `dag.json` raw.
- **[inv:no-agent-mcp]** — This plan touches **no** file under `entrypoint/agent-mcp` or `packages/agent/**`. Every reserved path is under `packages/dispatch/**` or `entrypoint/dispatch-cli/**`. Zero cross-plan overlap with the concurrent agent-* stream.
- **[inv:teeth]** — Every behavioral acceptance test must FAIL if the fix is reverted (a real negative control), drive the REAL component (real optimizer/client/orchestrator/serializer — mock only the paid LLM boundary), be deterministic without timing (latches/reopen, never `sleep`), and gate on the runner's exit code, never `| grep -q passed`. Grep/"symbol present" is insufficient for a behavioral clause.
- **[inv:live-gate]** — The only env-gated tests are paid-LLM paths (`run --no-dry-run`, `calibrate`, real-e2e S4) behind `DISPATCH_E2E_LIVE=1`, documented (owner: plan-builder) in README + CLAUDE.md + test header. Everything else runs by default with `MockAgentRunner` exercising the same code paths.
- **[inv:resolve-at-dispatch]** — Pin the acceptance signal + invariants + interface contracts; RESOLVE current line numbers and file contents by grep at dispatch time (they drift). Never pin a stale line number or a pre-PUBLISH-001 short import name.
- **[inv:ephemeral-tmp]** — Test/scratch artifacts write only under `tmp/<package>/…` (gitignored), cleaned on teardown. Never write a runtime/test DB to a tracked path.
