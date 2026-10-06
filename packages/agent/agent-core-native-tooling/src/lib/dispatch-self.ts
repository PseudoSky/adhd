/**
 * The ONE producer of the agent-mcp self launch config (the `dispatch` native
 * tool member, ADR-0008 D1).
 *
 * Before this module there were TWO producers of the same launch config with two
 * different default argvs (`-y @adhd/agent-mcp@latest` in agent-mcp vs
 * `-y @adhd/agent-mcp` in dispatch-cli) and two different env-var pairs
 * (`ADHD_AGENT_MCP_*` vs `ADHD_DISPATCH_AGENT_MCP_*`). Both hosts now derive the
 * config from this one function, so the default argv and the env-var pair are
 * single-sourced — finding A2. A third producer is caught by the agent-mcp
 * one-producer guard (`default-mcp-producer.guard.test.ts`), which scans
 * `entrypoint/dispatch-cli/src` as well.
 *
 * This lives in the native-tooling package (not in either host) because the
 * package already owns the `dispatch` member's `mcpServers` key
 * ({@link DISPATCH_SERVER_KEY}) and is a shared dependency of BOTH hosts —
 * importing a host's server entrypoint for one launch helper would drag its
 * boot side effects (env load, DB open) into the other host.
 */
import type { McpServerConfig } from '@adhd/agent-base-types';

/**
 * Env override for the agent-mcp server command (the `dispatch` member's
 * `command`). Default: `npx`.
 */
export const DISPATCH_SELF_COMMAND_ENV = 'ADHD_AGENT_MCP_COMMAND';
/** Env override (whitespace-separated argv) for the `dispatch` member's args. */
export const DISPATCH_SELF_ARGS_ENV = 'ADHD_AGENT_MCP_ARGS';

/**
 * The ONE canonical default argv every host launches the REAL agent-mcp server
 * with — `npx -y @adhd/agent-mcp@latest`. The same argv `agent-mcp-install`
 * writes into a consumer host's config (`AGENT_MCP_NPX_ARGS` aliases this).
 */
export const DISPATCH_SELF_DEFAULT_ARGS: readonly string[] = ['-y', '@adhd/agent-mcp@latest'];

/**
 * The REAL agent-mcp MCP server config surfaced as the `dispatch` member (D1).
 * Defaults to the ONE canonical launch config ({@link DISPATCH_SELF_DEFAULT_ARGS}),
 * overridable by env so a hermetic host/e2e can point at a local build. The
 * registry routes the `agent-mcp` name to its in-process tool surface (never a
 * spawn), so this config documents the surface rather than re-authoring it.
 */
export function buildDispatchSelf(env: NodeJS.ProcessEnv = process.env): McpServerConfig {
  const command = env[DISPATCH_SELF_COMMAND_ENV] || 'npx';
  const rawArgs = env[DISPATCH_SELF_ARGS_ENV];
  const args = rawArgs
    ? rawArgs.split(/\s+/).filter(Boolean)
    : [...DISPATCH_SELF_DEFAULT_ARGS];
  return { transport: 'stdio', command, args };
}
