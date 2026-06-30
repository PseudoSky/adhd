# Dispatch Ecosystem — Handoff

Session state as of 2026-06-29, ready for restart with configured agents.

## Restart

Quit and restart opencode from the adhd project root:

```bash
cd /Users/nix/dev/node/adhd
opencode
```

The 3 ADHD-specialist agents auto-load from `~/.config/opencode/agents/`. The
agent-mcp MCP server auto-loads from `.opencode/opencode.json`. Ask the
implementer agents to `/mcp` list to confirm agent-mcp tools are available.

## Agents available

| Agent | Model | Role | Steps | Permissions |
|---|---|---|---|---|
| `adhd-pro` | deepseek/deepseek-v4-pro | Orchestrator: reads dag.json state, decomposes into dispatch.json, dispatches implement/flash/reviewer agents, collects reports, appends dispatch_log. No code editing. | 20 | bash, task, webfetch, websearch, memory |
| `adhd-implementer-deepseek` | deepseek/deepseek-v4-pro | Complex: multi-file, interface design, algorithm ports, cross-package refactors | 40 | edit, bash, task, gitnexus, memory |
| `adhd-implementer-flash` | deepseek/deepseek-v4-flash | Fast: single-file, tests, config, scaffolding, well-specified functions | 30 | edit, bash, task, memory |
| `adhd-reviewer-flash` | deepseek/deepseek-v4-flash | Read-only: spec compliance, platform isolation, test coverage, style audit | 25 | bash (read-only), webfetch, memory |

The pro agent bridges the sox dispatch.json pattern with our dag.json system.
It knows the plan, reads eligible milestones, decomposes into agent assignments,
and records results. It's the orchestrator's brain — the orchestrator we're
building automates the loop the pro agent does manually today.

## What's done

- `@adhd/dispatch-spec` — **complete, built, 18 tests pass**. Types, validators (`validateDagJson`, `validateSnapshot`), schema migration (`migrateDag`), op/kind mapping (`VALID_OPS_BY_KIND`, `isValidOpForKind`), JSON Schema documents (`dag-v4.schema.json`, `valid-ops-by-kind.json`). Location: `packages/shared/dispatch-spec/`. Design tenets documented in its README.

- `@adhd/dispatch-client` — **scaffolded, need source code**. Location: `packages/shared/dispatch-client/`. Has project.json, package.json, vite.config.ts, tsconfig files. Needs: `src/lib/serializer.ts` (IDagSerializer interface), `src/lib/client.ts` (IDagClient interface + DagClient class + createDagClient factory), `src/test/client.spec.ts` (in-memory serializer tests), `src/index.ts` (barrel).

- Plan dag.json — **validated, 23 operations, 362 shape ops**. Location: `docs/plan/dispatch-production/dag.json`. Represents 16 milestones across 7 phases. Every op uses proper `shape.kind` with field-level ops (196 add-field, 140 add-export, 11 add-param, 15 set-key, 0 add-section).

- Design decisions — D-01 through D-18 in `/Users/nix/dev/ai/sox-ecosystem/docs/plan/dispatch-optimizer/DECISIONS.md`. D-18 (automated operation type) is the most recent.

## What's next

Build order (respect dependency graph):

```bash
# Batch 1: Client (depends on spec)
# Write src/lib/serializer.ts, src/lib/client.ts, src/test/client.spec.ts, src/index.ts
npx nx build shared-dispatch-client && npx nx test shared-dispatch-client

# Batch 2: Optimizer (depends on spec, NOT on client)
./scripts/generate-lib.sh lib dispatch-optimizer logic shared
# Port snapshot() + optimize() from /Users/nix/dev/ai/sox-ecosystem/docs/plan/dispatch-optimizer/src/compiler.ts
# Remove ALL I/O — inject fileSizes/readFiles via IOptimizerDeps
# Keep 4 algorithms: Bitmask DP, Tree DP, Simulated Annealing, HLFET
npx nx build shared-dispatch-optimizer && npx nx test shared-dispatch-optimizer

# Batch 3: IO Plugin (depends on optimizer) + JSON Serializer (depends on client)
./scripts/generate-lib.sh lib dispatch-plugin-io logic node
# createIOPlugin(rootDir) → { fileSizes, readFiles }
./scripts/generate-lib.sh lib dispatch-serializer-json data node
# createJsonFileSerializer(filePath) → IDagSerializer with atomic writes

# Batch 4: Orchestrator (depends on client + optimizer + plugins)
./scripts/generate-lib.sh lib dispatch-orchestrator workflows node
# orchestrateCycle(deps) → snapshot → enrich → optimize → dispatch → poll → record
# Handles guards, replan injection, pending-surfaced gate, resumption

# Batch 5: Tools + CLI
./scripts/generate-lib.sh lib dispatch-tools data node
# MCP server wrapping IDagClient — agents author plans through typed tools
./scripts/generate-lib.sh app dispatch-cli entrypoints node
# CLI: dispatch init, snapshot, optimize, run, status, calibrate, validate

# Verify end-to-end
npx nx test dispatch-spec && npx nx test dispatch-client && npx nx test dispatch-optimizer && npx nx test dispatch-serializer-json && npx nx test dispatch-plugin-io && npx nx test dispatch-orchestrator && npx nx test dispatch-tools
```

## Key references

| File | Purpose |
|---|---|
| `docs/plan/dispatch-production/dag.json` | The plan — 16 milestones, 23 ops, 362 shape ops |
| `docs/plan/dispatch-production/README.md` | Architecture diagram, package table, tenets reference |
| `packages/shared/dispatch-spec/README.md` | Six design tenets governing every package |
| `/Users/nix/dev/ai/sox-ecosystem/docs/plan/dispatch-optimizer/DECISIONS.md` | D-01 through D-18 |
| `/Users/nix/dev/ai/sox-ecosystem/docs/plan/dispatch-optimizer/SCOPE.md` | Cost model, algorithm selection, N1/N2 specs |
| `/Users/nix/dev/ai/sox-ecosystem/docs/plan/dispatch-optimizer/PROPOSED_DAG_STRUCTURE.md` | Complete dag.json + snapshot schema |
| `/Users/nix/dev/ai/sox-ecosystem/docs/plan/dispatch-optimizer/src/compiler.ts` | 2,033-line proof-of-concept to port |
| `packages/shared/dispatch-spec/src/lib/types.ts` | All 40+ types (D-18 included) |
| `packages/shared/dispatch-spec/src/lib/validate.ts` | Structural validators with op/kind constraints |

## Suggested dispatch

Ask `adhd-implementer-deepseek` to build `@adhd/dispatch-optimizer` (complex port from compiler.ts with algorithm extraction). In parallel, ask `adhd-implementer-flash` to build `@adhd/dispatch-client` (straightforward CRUD + interface definitions). Then ask `adhd-reviewer-flash` to audit both against D-07, D-11, D-17, and platform isolation rules.
