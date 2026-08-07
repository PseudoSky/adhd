# refactor-agent-mcp

**Phase:** refactor · **Kind:** work · **Depends on:** runtime-core-node, runtime-cli, audit-builder · **Guard:** `test ! -f entrypoint/agent-mcp/src/config.ts && npx --yes nx test agent-mcp`

---

## Goal

`entrypoint/agent-mcp/src/config.ts` (299 lines of Zod schema + manual env var reading + deepFreeze + PROVIDER_DEFAULTS) is **deleted** and replaced by two artifacts: (a) an `adhd.environment.yaml` spec file, and (b) a new runtime module `entrypoint/agent-mcp/src/environment.ts` that constructs the typed `new Environment<AgentMcpConfig>({ project: "agent-mcp", namespace: "production" })` client, re-exports a `config` accessor with the same shape the old module exported, and preserves `getProviderConfig()` and `isEnvNameAllowed()` as thin wrappers over `env.get()`.

Deleting `config.ts` breaks every current importer of `./config.js`. **All five consumers MUST be rewired off `config.ts` onto the new `environment.ts` module** — the refactor is not complete (and the guard `nx test agent-mcp` cannot pass) until they compile against the new module:

- `entrypoint/agent-mcp/src/index.ts:6` — `import { config } from "./config.js"`
- `entrypoint/agent-mcp/src/server.ts:18` — `import { config } from './config.js'`
- `entrypoint/agent-mcp/src/logger.ts` — `import { config } from "./config.js"`
- `entrypoint/agent-mcp/src/streaming/sse-server.ts` — `import { config } from "../config.js"`
- `entrypoint/agent-mcp/src/db/client.ts` — `import { config } from "../config.js"`

(The `__tests__/*` and `scripts/*` references to `../config.js` / `loadConfig` are test/tooling files outside this state's write reservation — they are updated by the executor's own test edits under the `nx test agent-mcp` guard, not reserved here, to keep the reservation surface to the production source graph.)

---

## Acceptance criteria

- [refactor-agent-mcp.1] Old 299-line config.ts is removed
- [refactor-agent-mcp.2] adhd.environment.yaml exists with project name agent-mcp and orgNamespace adhd
- [refactor-agent-mcp.3] load-env.ts is removed (no more dotenv loading) — real path `entrypoint/agent-mcp/src/utils/load-env.ts`
- [refactor-agent-mcp.4] agent-mcp test suite still passes after refactor (`npx nx test agent-mcp`) — SCOPE.md §6 probe "Agent-mcp test suite still passes"
- [refactor-agent-mcp.5] `getProviderConfig()` is preserved and exercised for ≥1 provider — asserted against the **new** module `entrypoint/agent-mcp/src/environment.ts` (NOT a tree-wide grep of `src/`, which today matches test/tooling files that mention the symbol and would pass regardless of whether the refactor preserved it). Discriminating check: `getProviderConfig` is defined/exported in `environment.ts`; SCOPE.md §6 probe `getProviderConfig({ provider: "openai" })` still works (exercised by the `nx test agent-mcp` guard).
- [refactor-agent-mcp.6] All 26 legacy `ADHD_AGENT_*` env vars still resolve after refactor — asserted against the **new** `adhd.environment.yaml` (NOT a tree-wide grep of `entrypoint/agent-mcp`, which today matches `__tests__/`, `scripts/`, and doc comments and would pass even if the yaml omitted the mapping). Discriminating check: the non-inferrable legacy names (`ADHD_AGENT_DATABASE_PATH`, `ADHD_AGENT_OPENAI_SECRET`, `ADHD_AGENT_LOG_LEVEL`) appear as explicit per-field `env:` overrides in `adhd.environment.yaml`; SCOPE.md §6 probe "All 26 env vars map to inferred vars".

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
   that asserts all 26 legacy `ADHD_AGENT_*` env vars resolve.
7. **Rewire the five `./config.js` consumers** (index.ts, server.ts, logger.ts, streaming/sse-server.ts,
   db/client.ts) to import `{ config }` (and `getProviderConfig`/`isEnvNameAllowed` where used) from the
   new `./environment.js` module. `config.ts` is deleted, so any lingering `./config.js` import is a hard
   compile failure the guard will catch. Verify with
   `grep -rL "config.js" entrypoint/agent-mcp/src` (no production source should still reference it).
8. There are **26** unique legacy `ADHD_AGENT_*` env vars (verified by direct enumeration of the old
   `config.ts`: 17 in `rawFromEnv` + 9 provider defaults). `ADHD_AGENT_SSE_BASE_URL` (`sse.baseUrl`) is
   one of them — see CURRENT_CONFIG_PATTERNS.md §agent-mcp "Env vars used".
9. If `nx show`/`nx build`/`nx test` fails workspace-wide with "Failed to process project graph" (a stale
   daemon graph, e.g. a phantom project), run `npx nx reset` and retry before diagnosing further.
10. See `SCOPE.md` §In scope — agent-mcp refactor for the detailed preservation requirements.