# UNRESOLVED — adhd-environment v0.0.5 Demo

> Ledger of interface/scope unknowns. `open == 0` is required before the state machine
> is authored. The rows below were surfaced by the v0.0.5 gap-audit (GO-WITH-FIXES) and
> are all `resolved` — recorded here rather than asserted away as "None".

## Interfaces

| id | question | impact | status | resolution |
|----|----------|--------|--------|------------|
| I1 | How many CLI commands, and are `config-remap` / `config-hash` real? | CLI acceptance surface | resolved | The authoritative apigen surface is `interfaces-architect.md` §6.1 — **exactly 9 commands** (`init`, `build`, `set`, `status`, `verify`, `doctor`, `config-get`, `export`, `diff`). `config-remap` and `config-hash` are **deprecated / out of scope** for v0.0.5. SCOPE.md and `runtime-cli` acceptance criteria updated to 9; `runtime-cli.4` gates all 9 exports. |
| I2 | What is agent-mcp's real numeric port field? | typed-runtime probe correctness | resolved | `config.server.port` does **not** exist. Real numeric port fields are `transport.port` / `sse.port`; `server.*` holds `maxDepth`/`maxToolLoops`/`defaultMaxTokens`/`contextLimit`/`allowedAgents`/`registryDbPath`. Canonical typed example changed to `config.transport.port` across SCOPE.md, SPEC_0.0.5.md, interfaces-architect.md, CURRENT_CONFIG_PATTERNS.md. The demo's toy `server.port` config remains illustrative-only (self-defined in the demo YAML). Authoritative field table: CURRENT_CONFIG_PATTERNS.md §agent-mcp. |
| I3 | What env prefix must the agent-mcp refactor use? | deployed-secret resolution | resolved | Naive inference yields `ADHD_AGENT_MCP_PRODUCTION_`, which matches no deployed secret. Decision: **`envPrefixOverride: ADHD_AGENT`**, namespace NOT folded into the prefix, per-field `env:` overrides for non-inferrable legacy names (e.g. `db.path` → `ADHD_AGENT_DATABASE_PATH`). Gated by `refactor-agent-mcp.2` (`envPrefixOverride: ADHD_AGENT`) + `.6` (legacy names preserved) + human-blocker `agent-mcp-deployment-secrets`. |

## Scope gaps & open questions

| id | question | impact | status | resolution |
|----|----------|--------|--------|------------|
| G1 | Package identity: `@adhd/environment` vs `@adhd/environment-core-node`? | dod.5/dod.6 provability | resolved | Published npm name is **`@adhd/environment`** (SCOPE.md §3, interfaces-architect.md §4). The `core` generator defaults to `@adhd/environment-core-node`; `scaffold-workspace` now explicitly overrides `package.json` `name` to `@adhd/environment` and gates it (`scaffold-workspace.4`, `runtime-core-node.5`) so `require("@adhd/environment")` resolves at final audit. |

**Open questions: 0.** All rows above are `resolved`. Deferred/risk-accepted: none.
