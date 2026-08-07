# State: docs-and-publish

## Goal

Bump both packages to `0.0.6`. Update documentation (CLAUDE.md, README.md, GAPS.md) to cover all new env vars, error codes, OAuth/keychain trust requirement, and recovery workflow. Publish both packages to npm following PUBLISHING.md.

## Semantic distillation

All code work is complete. This state is purely documentation + version management. Follow PUBLISHING.md exactly — it has the authoritative publish workflow including the npm OTP flow. The documentation scope has expanded beyond the original plan: all 20 DoD items have documentation consequences.

## File ownership

**mutates:**
- `packages/ai/agent-mcp/package.json`
- `packages/ai/agent-mcp-types/package.json`
- `packages/ai/agent-mcp/CLAUDE.md`
- `packages/ai/agent-mcp/README.md`
- `packages/ai/agent-mcp/GAPS.md`

## Steps

1. **Bump `agent-mcp-types`:** `"version": "0.0.2"` → `"0.0.6"` in `packages/ai/agent-mcp-types/package.json`

2. **Bump `agent-mcp`:** `"version": "0.0.5"` → `"0.0.6"` in `packages/ai/agent-mcp/package.json`

3. **Update `CLAUDE.md` — Environment variables table:**

   Add rows (in alphabetical order or at end of the table):
   ```
   | `AGENT_MCP_CONTEXT_LIMIT`       | `0` (disabled) | Estimated token limit for the message window. When > 0, oldest non-system messages are dropped before each provider call. Set 10% below the model's actual context limit. |
   | `AGENT_MCP_DEFAULT_MAX_TOKENS`  | `8192`          | Default `max_tokens` for providers that do not set `maxTokens` in their agent config. Replaces the old hard-coded 4096. |
   | `AGENT_MCP_MAX_DEPTH`           | `5`             | Maximum agent nesting depth (was bare `MAX_DEPTH` in 0.0.5 — update deployments). |
   | `AGENT_MCP_MAX_TOOL_LOOPS`      | `50`            | Maximum tool-call iterations per task (was bare `MAX_TOOL_LOOPS` in 0.0.5, default was 10 — now 50). |
   ```

4. **Update `CLAUDE.md` — Error codes table:**

   Add rows:
   ```
   | `CONTEXT_WINDOW_EXCEEDED` | Orchestrator — context overflow detected |
   | `PROVIDER_TIMEOUT`        | Orchestrator — provider call timed out or aborted |
   | `PROVIDER_AUTH_ERROR`     | Provider — HTTP 401, keychain denial, or OAuth fallback exhausted |
   | `PROVIDER_RATE_LIMITED`   | Provider — HTTP 429 after retries exhausted |
   ```

5. **Update `CLAUDE.md` — OAuth / claudecli keychain trust section:**

   Add a section (or subsection under provider config) documenting:
   - `useClaudeOauth: true` requires that the MCP host process inherits the Claude Code keychain trust context.
   - If the keychain read fails, the Anthropic provider falls back to `ANTHROPIC_API_KEY` then `ANTHROPIC_AUTH_TOKEN` env vars before throwing `PROVIDER_AUTH_ERROR`.
   - Manual injection: run `claude setup-token` to obtain an OAuth access token, then set `ANTHROPIC_AUTH_TOKEN=<token>` in the environment, or set `authTokenEnv: "MY_TOKEN_VAR"` in the provider config.

6. **Update `README.md`:** Mirror the env var table additions (steps 3-4) and add a brief note about `PROVIDER_AUTH_ERROR` recovery in the troubleshooting section.

7. **Update `GAPS.md`:** Mark Gap #6 and Gap #7 as `**Status: implemented (0.0.6)**`.

8. **Build and publish (follow PUBLISHING.md):**
   ```bash
   npx nx build agent-mcp-types
   cd packages/ai/agent-mcp-types && npm publish --access public
   # (enter OTP when prompted)

   npx nx build agent-mcp
   cd packages/ai/agent-mcp && npm publish --access public
   # (enter OTP when prompted)
   ```

## Acceptance criteria

[docs-and-publish.1] `agent-mcp/package.json` version is `0.0.6`

[docs-and-publish.2] `npm info @adhd/agent-mcp version` returns `0.0.6`

## Commit points

**R2 (post-guard):**
```
chore(agent-mcp): bump to 0.0.6; document new env vars, error codes, and OAuth recovery
```

## Notes

- Publish `agent-mcp-types` first so the new error codes (`CONTEXT_WINDOW_EXCEEDED`, `PROVIDER_TIMEOUT`, `PROVIDER_AUTH_ERROR`, `PROVIDER_RATE_LIMITED`) are available before `agent-mcp` 0.0.6 is published.
- If `npm info @adhd/agent-mcp version` still shows `0.0.5` after publishing, wait 60s for the registry to update and retry.
- After publishing, run the smoke test from PUBLISHING.md to confirm `npx @adhd/agent-mcp@latest --help` (or server start) works.
- The env var rename from bare `MAX_DEPTH`/`MAX_TOOL_LOOPS` to `AGENT_MCP_MAX_DEPTH`/`AGENT_MCP_MAX_TOOL_LOOPS` is a breaking change for existing deployments. Note this in the CHANGELOG or GAPS.md.
- `audit-final.dod.19` checks that `CLAUDE.md` contains all six new items: `AGENT_MCP_CONTEXT_LIMIT`, `AGENT_MCP_DEFAULT_MAX_TOKENS`, `CONTEXT_WINDOW_EXCEEDED`, `PROVIDER_TIMEOUT`, `PROVIDER_AUTH_ERROR`, `PROVIDER_RATE_LIMITED`. Ensure all are present before the audit guard passes.
