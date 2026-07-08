# refactor-agent-mcp

**Phase:** refactor · **Kind:** work · **Depends on:** runtime-core-node, runtime-cli, audit-builder · **Guard:** `true`

---

## Goal

`entrypoint/agent-mcp/src/config.ts` (299 lines of Zod schema + manual env var reading + deepFreeze + PROVIDER_DEFAULTS) is replaced with an `adhd.environment.yaml` spec file and a typed `new Environment<AgentMcpConfig>({ project: "agent-mcp", namespace: "production" })` runtime client. `getProviderConfig()` and `isEnvNameAllowed()` are preserved as thin wrappers over `env.get()`.

---

## Acceptance criteria

- [refactor-agent-mcp.1] `entrypoint/agent-mcp/src/config.ts` is removed (old file gone)
- [refactor-agent-mcp.2] `entrypoint/agent-mcp/adhd.environment.yaml` exists with project name `agent-mcp`, `orgNamespace: adhd`, and all 10 config fields
- [refactor-agent-mcp.4] `getProviderConfig("openai")` reads from `env.get("config.providers.openai.*")` + `env.get("env.OPENAI_API_KEY")`
- [refactor-agent-mcp.6] All 27 env vars from old `rawFromEnv()` are accessible via `env.get("env.*")`
- [refactor-agent-mcp.8] `load-env.ts`, `deepFreeze()`, `resolveEnvRef()`, `verifyEnvRefs()`, `subprocessEnv()` are removed
---
## Reservations
```text
read_only:  []
mutates:    ["entrypoint/agent-mcp/adhd.environment.yaml", "entrypoint/agent-mcp/src/config.ts"]
```

---

## Notes for executor

1. This is a pure deletion+replacement refactor — no new features, no behavioral changes.
2. The YAML file defines all fields that the old config.ts managed: server.port, db.path, log.level, providers.*, etc.
3. Secrets are set via `adhd-env set` (in production) or via `env.get("env.*")` fallback (for existing env vars).
4. The `env.prefix` for agent-mcp/production will be `ADHD_AGENT_MCP_PRODUCTION_`.
5. Run `adhd-env build --namespace production` and verify agent-mcp starts before declaring done.
6. See `SCOPE.md` §In scope — agent-mcp refactor for the detailed preservation requirements.