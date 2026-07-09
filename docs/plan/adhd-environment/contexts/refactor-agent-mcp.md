# refactor-agent-mcp

**Phase:** refactor · **Kind:** work · **Depends on:** runtime-core-node, runtime-cli, audit-builder · **Guard:** `test ! -f entrypoint/agent-mcp/src/config.ts && npx --yes nx test agent-mcp`

---

## Goal

`entrypoint/agent-mcp/src/config.ts` (299 lines of Zod schema + manual env var reading + deepFreeze + PROVIDER_DEFAULTS) is replaced with an `adhd.environment.yaml` spec file and a typed `new Environment<AgentMcpConfig>({ project: "agent-mcp", namespace: "production" })` runtime client. `getProviderConfig()` and `isEnvNameAllowed()` are preserved as thin wrappers over `env.get()`.

---

## Acceptance criteria

- [refactor-agent-mcp.1] Old 299-line config.ts is removed
- [refactor-agent-mcp.2] adhd.environment.yaml exists with project name agent-mcp and orgNamespace adhd
- [refactor-agent-mcp.3] load-env.ts is removed (no more dotenv loading) — real path `entrypoint/agent-mcp/src/utils/load-env.ts`
- [refactor-agent-mcp.4] agent-mcp test suite still passes after refactor (`npx nx test agent-mcp`) — SCOPE.md §6 probe "Agent-mcp test suite still passes"
- [refactor-agent-mcp.5] `getProviderConfig()` is preserved and exercised for ≥1 provider — SCOPE.md §6 probe `getProviderConfig({ provider: "openai" })` still works
- [refactor-agent-mcp.6] All 27 legacy `ADHD_AGENT_*` env vars still resolve after refactor — SCOPE.md §6 probe "All 27 env vars map to inferred vars"

---

## Decision — env prefix (B4, non-negotiable)

The live agent-mcp reads env vars named `ADHD_AGENT_*` (e.g. `ADHD_AGENT_OPENAI_SECRET`,
`ADHD_AGENT_DATABASE_PATH`, `ADHD_AGENT_LOG_LEVEL`). The default prefix inference for a namespaced
build would yield `ADHD_AGENT_MCP_PRODUCTION_`, which **does not match any deployed secret** — every
provider key and DB path would silently stop resolving.

- **`envPrefixOverride: ADHD_AGENT`** MUST be set in `adhd.environment.yaml`. Do NOT accept the
  inferred `ADHD_AGENT_MCP` prefix.
- **Namespace strategy:** the namespace (`production`) is used only for the on-disk snapshot path
  (`~/.adhd/agent-mcp/production/…`). It MUST NOT be folded into the env var prefix — the resolved
  env var names stay `ADHD_AGENT_*` with no `_PRODUCTION_` (or `_MCP_`) segment.
- Several legacy names are **not** naive-inferrable from the field path (e.g. `db.path` →
  `ADHD_AGENT_DATABASE_PATH`, `transport.port` → `ADHD_AGENT_PORT`, `providers.openai.secret` →
  `ADHD_AGENT_OPENAI_SECRET`). Each such field MUST carry an explicit `env:` override so the exact
  legacy name is preserved. Use CURRENT_CONFIG_PATTERNS.md §agent-mcp "Env vars used" table as the
  authoritative name mapping.
- Human blocker `agent-mcp-deployment-secrets` (human-blockers.json) gates this state on the
  deployment-secret owner confirming the `ADHD_AGENT_*` contract before cutover.

---

## Reservations

```text
read_only:  []
mutates:    ["entrypoint/agent-mcp/adhd.environment.yaml", "entrypoint/agent-mcp/src/environment.ts", "entrypoint/agent-mcp/src/config.ts", "entrypoint/agent-mcp/src/index.ts", "entrypoint/agent-mcp/src/server.ts", "entrypoint/agent-mcp/src/logger.ts", "entrypoint/agent-mcp/src/streaming/sse-server.ts", "entrypoint/agent-mcp/src/db/client.ts"]
```

---

## Notes for executor

1. This is a pure deletion+replacement refactor — no new features, no behavioral changes.
2. The YAML file defines all fields that the old config.ts managed. Use the **real** field names from
   CURRENT_CONFIG_PATTERNS.md (`transport.port`/`sse.port` for ports; `server.*` holds
   `maxDepth`/`maxToolLoops`/`defaultMaxTokens`/`contextLimit`/`allowedAgents`/`registryDbPath`),
   `db.path`, `logging.level`, `providers.*`, etc. There is **no** `server.port` field.
3. Secrets are set via `adhd-env set` (in production) or via `env.get("env.*")` fallback (for existing env vars).
4. **Env prefix: `envPrefixOverride: ADHD_AGENT`** — see the Decision block above. The old note that
   claimed `ADHD_AGENT_MCP_PRODUCTION_` was wrong and would break every deployed secret.
5. Run `adhd-env build --namespace production` and verify agent-mcp starts before declaring done.
6. The completion guard now runs `npx nx test agent-mcp` — a broken agent-mcp cannot go green. Your
   agent-mcp tests MUST include a case that exercises `getProviderConfig` for a provider and a case
   that asserts all 27 legacy `ADHD_AGENT_*` env vars resolve.
7. See `SCOPE.md` §In scope — agent-mcp refactor for the detailed preservation requirements.