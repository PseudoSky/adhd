import type {
  DispatchToolConfig,
  FsToolConfig,
  McpServerConfig,
  NativeToolingConfig,
  ShellToolConfig,
} from '@adhd/agent-base-types';
import { FS_SERVER, SHELL_SERVER } from './catalog.js';

/**
 * Runtime context for native-tooling resolution — known only at TASK time
 * (ADR-0008 D4). The resolver NEVER mutates the stored definition and NEVER
 * persists the resolved root.
 */
export interface NativeResolveContext {
  /** The dispatching host's working directory; injected as the builtin root. */
  cwd: string;
  /** Base environment merged into every resolved stdio server (D9). */
  env?: Record<string, string>;
  /**
   * The REAL agent-mcp MCP server config (the same entry the host loads), supplied
   * so `dispatch` can surface agent-mcp's own `task`/`agent` tools (D1). When absent,
   * no dispatch server can be resolved — a wrapper is never authored instead.
   */
  dispatchSelf?: McpServerConfig;
}

function isMcpServerConfig(value: unknown): value is McpServerConfig {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>)['transport'] === 'string'
  );
}

/** Merge the ambient env under a stdio server's own env (server values win). */
function withBaseEnv(
  config: McpServerConfig,
  ctx: NativeResolveContext
): McpServerConfig {
  if (config.transport !== 'stdio') return config;
  if (!ctx.env || Object.keys(ctx.env).length === 0) return config;
  return { ...config, env: { ...ctx.env, ...(config.env ?? {}) } };
}

function resolveFs(
  fs: FsToolConfig | undefined,
  ctx: NativeResolveContext
): McpServerConfig | undefined {
  if (fs === false) return undefined;
  // A full McpServerConfig REPLACES the builtin (D3) — respected as-is, never overridden.
  if (isMcpServerConfig(fs)) return { ...fs };

  const overrides = fs === true || fs === undefined ? {} : fs;
  const config: McpServerConfig = {
    transport: 'stdio',
    command: FS_SERVER.command,
    args: [...FS_SERVER.args, overrides.root ?? ctx.cwd],
    cwd: ctx.cwd,
  };
  if (overrides.allowedTools) config.allowedTools = [...overrides.allowedTools];
  if (overrides.disallowedTools) config.disallowedTools = [...overrides.disallowedTools];
  return withBaseEnv(config, ctx);
}

function resolveShell(
  shell: ShellToolConfig | undefined,
  ctx: NativeResolveContext
): McpServerConfig | undefined {
  if (shell === false) return undefined;
  if (isMcpServerConfig(shell)) return { ...shell };

  const overrides = shell === true || shell === undefined ? {} : shell;
  const env: Record<string, string> = {};
  if (overrides.allowCommands?.length) {
    env[SHELL_SERVER.envKeys.allowCommands] = overrides.allowCommands.join(',');
  }
  if (overrides.denyCommands?.length) {
    env[SHELL_SERVER.envKeys.denyCommands] = overrides.denyCommands.join(',');
  }
  if (overrides.timeoutMs !== undefined) {
    env[SHELL_SERVER.envKeys.timeoutSeconds] = String(
      Math.ceil(overrides.timeoutMs / 1000)
    );
  }
  if (overrides.env) Object.assign(env, overrides.env);

  const config: McpServerConfig = {
    transport: 'stdio',
    command: SHELL_SERVER.command,
    args: [...SHELL_SERVER.args],
    cwd: overrides.root ?? ctx.cwd,
  };
  if (Object.keys(env).length > 0) config.env = env;
  return withBaseEnv(config, ctx);
}

function resolveDispatch(
  dispatch: DispatchToolConfig | undefined,
  ctx: NativeResolveContext
): McpServerConfig | undefined {
  if (dispatch === false) return undefined;
  if (isMcpServerConfig(dispatch)) return { ...dispatch };
  // `dispatch: true` (or default-present) means the REAL agent-mcp server the host
  // supplies — never an authored wrapper (D1). Absent `dispatchSelf` ⇒ omit.
  if (!ctx.dispatchSelf) return undefined;

  const overrides = dispatch === true || dispatch === undefined ? {} : dispatch;
  const config: McpServerConfig = { ...ctx.dispatchSelf };
  if (overrides.allowedTools) config.allowedTools = [...overrides.allowedTools];
  if (overrides.disallowedTools) config.disallowedTools = [...overrides.disallowedTools];
  return config;
}

/**
 * Resolve the standardized native toolset against a task-time context
 * (ADR-0008 D2/D4). Returns the builtin servers in a fixed order —
 * `fs`, `shell`, `dispatch` — omitting any member set to `false` (or, for
 * `dispatch`, any member with no `dispatchSelf` to reference).
 *
 * The stored `cfg` is NEVER mutated, and no resolved root is persisted: the same
 * definition fired from `/P/a` then `/P/b` yields roots `/P/a` then `/P/b` while
 * the definition stays byte-identical (D4/D8).
 */
export function resolveNativeTooling(
  cfg: NativeToolingConfig | undefined,
  ctx: NativeResolveContext
): McpServerConfig[] {
  const config = cfg ?? {};
  const servers: McpServerConfig[] = [];

  const fs = resolveFs(config.fs, ctx);
  if (fs) servers.push(fs);

  const shell = resolveShell(config.shell, ctx);
  if (shell) servers.push(shell);

  const dispatch = resolveDispatch(config.dispatch, ctx);
  if (dispatch) servers.push(dispatch);

  return servers;
}
