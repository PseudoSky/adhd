# State: env-var-fixes

## Goal

Fix the three environment variable bugs in `index.ts`: rename bare `MAX_DEPTH` → `AGENT_MCP_MAX_DEPTH`, `MAX_TOOL_LOOPS` → `AGENT_MCP_MAX_TOOL_LOOPS`, reconcile `MAX_TOOL_LOOPS` default from 10 to 50, and add `AGENT_MCP_DEFAULT_MAX_TOKENS` (default 8192) for use by the Anthropic provider fallback.

## Semantic distillation

`index.ts` line 39 reads `process.env["MAX_DEPTH"]` and line 40 reads `process.env["MAX_TOOL_LOOPS"]`. Both should be `AGENT_MCP_`-prefixed per the established naming convention for this package (all other env vars use this prefix). The MAX_TOOL_LOOPS default in code is 10 but CLAUDE.md documents 50 — reconcile to 50. The new `AGENT_MCP_DEFAULT_MAX_TOKENS` env var will be used by the Anthropic provider (`provider.maxTokens ?? AGENT_MCP_DEFAULT_MAX_TOKENS`) so agents without an explicit maxTokens get a sensible default instead of the hard-coded 4096.

## File ownership

**mutates:**
- `packages/ai/agent-mcp/src/index.ts`

**read_only:**
- `packages/ai/agent-mcp/CLAUDE.md` (env table — will be updated in docs-and-publish)
- `packages/ai/agent-mcp/src/engine/policy.ts` (PolicyEngine constructor receives serverMaxToolLoops — no change needed)

## Contract

**Modified: `packages/ai/agent-mcp/src/index.ts`**

Change lines 39-40 from:
```typescript
serverMaxDepth: parseInt(process.env["MAX_DEPTH"] ?? "5", 10),
serverMaxToolLoops: parseInt(process.env["MAX_TOOL_LOOPS"] ?? "10", 10),
```

To:
```typescript
serverMaxDepth: parseInt(process.env["AGENT_MCP_MAX_DEPTH"] ?? "5", 10),
serverMaxToolLoops: parseInt(process.env["AGENT_MCP_MAX_TOOL_LOOPS"] ?? "50", 10),
```

Also add after the imports or before `main()`:
```typescript
/** Default max_tokens for providers that do not set maxTokens in their config. */
export const AGENT_MCP_DEFAULT_MAX_TOKENS = parseInt(
  process.env["AGENT_MCP_DEFAULT_MAX_TOKENS"] ?? "8192",
  10
);
```

This constant is imported by `anthropic.ts` in the `cache-tokens` state to replace the hard-coded `4096` default.

## Acceptance criteria

[env-var-fixes.1] `AGENT_MCP_MAX_DEPTH` is read in `packages/ai/agent-mcp/src/index.ts`

[env-var-fixes.2] `AGENT_MCP_MAX_TOOL_LOOPS` is read in `packages/ai/agent-mcp/src/index.ts`

[env-var-fixes.3] `AGENT_MCP_DEFAULT_MAX_TOKENS` is defined or read in `packages/ai/agent-mcp/src/index.ts`

[env-var-fixes.4] The `MAX_TOOL_LOOPS` default value in `index.ts` is `"50"` (not `"10"`)

## Commit points

**R2 (post-guard):**
```
fix(agent-mcp): use AGENT_MCP_ prefixed env vars; reconcile MAX_TOOL_LOOPS default to 50
```

## Notes

- The old `MAX_DEPTH` / `MAX_TOOL_LOOPS` names will silently not be picked up after this change. This is intentional — they were never documented with those names; the CLAUDE.md table already used `AGENT_MCP_MAX_DEPTH` / `AGENT_MCP_MAX_TOOL_LOOPS`. Existing deployments should update their env config.
- `AGENT_MCP_DEFAULT_MAX_TOKENS` default of 8192 was chosen as a conservative value that works across all Anthropic models. Users running against Claude 3 Haiku (max 4096 output) should set this lower explicitly.
- The exported constant must be named exactly `AGENT_MCP_DEFAULT_MAX_TOKENS` so `cache-tokens` state can import it without creating a circular dependency.
