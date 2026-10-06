import type {
  DispatchToolConfig,
  FsToolConfig,
  McpServerConfig,
  NativeToolingConfig,
  ShellToolConfig,
} from '@adhd/agent-base-types';
import {
  DISPATCH_SERVER_KEY,
  FS_SERVER,
  SHELL_SERVER,
  wrapWithSandbox,
} from './catalog.js';

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
  /**
   * Wrap the builtin `fs` and `shell` servers with the adopted
   * `@anthropic-ai/sandbox-runtime` (`srt`) OS enforcement layer (ADR-0008 D7).
   * Defaults to `true` — D7 adopts `srt` "in the first cut … to wrap both
   * servers". Set `false` only where a provisioned `srt` policy is unavailable;
   * hard enforcement then degrades to the servers' own confinement (the shell
   * argv allowlist and the fs root scoping). Custom `McpServerConfig`
   * replacements and the `dispatch` self server are never wrapped.
   */
  sandbox?: boolean;
  /**
   * Explicit `srt` settings file for the sandbox-wrapped builtins. When set the
   * resolver emits `srt -s <path> …` for the `fs`/`shell` servers (finding
   * 535c1101 / A4), so the host can hand each spawn its OWN policy file (which
   * carries the per-spawn cwd allow) instead of accumulating it into the shared
   * `~/.srt-settings.json`. Absent ⇒ `srt` reads its own default path.
   */
  srtSettingsPath?: string;
}

function isMcpServerConfig(value: unknown): value is McpServerConfig {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>)['transport'] === 'string'
  );
}

/**
 * One resolved builtin server paired with the `mcpServers` KEY under which the
 * host must mount it. The key comes from the ONE catalog ({@link FS_SERVER},
 * {@link SHELL_SERVER}, {@link DISPATCH_SERVER_KEY}) — a host never invents a
 * divergent key (`filesystem` vs `fs`) for the same server.
 */
export interface ResolvedNativeServer {
  /** `mcpServers` key: `fs` | `shell` | `agent-mcp` (all catalog-owned). */
  serverKey: string;
  config: McpServerConfig;
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

/**
 * Wrap a resolved builtin stdio server with the adopted `srt` sandbox (D7),
 * unless the caller disabled it. Non-stdio configs are left untouched.
 */
function withSandbox(
  config: McpServerConfig,
  ctx: NativeResolveContext
): McpServerConfig {
  if (ctx.sandbox === false) return config;
  if (config.transport !== 'stdio') return config;
  const wrapped = wrapWithSandbox(
    { command: config.command, args: config.args },
    ctx.srtSettingsPath
  );
  return { ...config, command: wrapped.command, args: wrapped.args };
}

function resolveFs(
  fs: FsToolConfig | undefined,
  ctx: NativeResolveContext
): ResolvedNativeServer | undefined {
  if (fs === false) return undefined;
  // A full McpServerConfig REPLACES the builtin (D3) — respected as-is, never overridden.
  if (isMcpServerConfig(fs)) return { serverKey: FS_SERVER.key, config: { ...fs } };

  const overrides = fs === true || fs === undefined ? {} : fs;
  const config: McpServerConfig = {
    transport: 'stdio',
    command: FS_SERVER.command,
    args: [...FS_SERVER.args, overrides.root ?? ctx.cwd],
    cwd: ctx.cwd,
  };
  if (overrides.allowedTools) config.allowedTools = [...overrides.allowedTools];
  if (overrides.disallowedTools) config.disallowedTools = [...overrides.disallowedTools];
  return { serverKey: FS_SERVER.key, config: withSandbox(withBaseEnv(config, ctx), ctx) };
}

function resolveShell(
  shell: ShellToolConfig | undefined,
  ctx: NativeResolveContext
): ResolvedNativeServer | undefined {
  if (shell === false) return undefined;
  if (isMcpServerConfig(shell)) return { serverKey: SHELL_SERVER.key, config: { ...shell } };

  const overrides = shell === true || shell === undefined ? {} : shell;
  const env: Record<string, string> = {};
  if (overrides.allowCommands?.length) {
    env[SHELL_SERVER.envKeys.allowCommands] = overrides.allowCommands.join(',');
  }
  if (overrides.timeoutMs !== undefined) {
    env[SHELL_SERVER.envKeys.timeoutSeconds] = String(
      Math.ceil(overrides.timeoutMs / 1000)
    );
  }
  // NOTE: `overrides.denyCommands` is intentionally NOT emitted. The adopted
  // server (`tumf/mcp-shell-server`) exposes an allow-list ONLY — it has no
  // deny-list environment variable — and ADR-0008 D5 forbids the harness from
  // owning per-command deny semantics. Emitting a fictional `DENY_COMMANDS` var
  // would be a silent no-op (the server ignores it).
  if (overrides.env) Object.assign(env, overrides.env);

  const config: McpServerConfig = {
    transport: 'stdio',
    command: SHELL_SERVER.command,
    args: [...SHELL_SERVER.args],
    cwd: overrides.root ?? ctx.cwd,
  };
  if (Object.keys(env).length > 0) config.env = env;
  return { serverKey: SHELL_SERVER.key, config: withSandbox(withBaseEnv(config, ctx), ctx) };
}

function resolveDispatch(
  dispatch: DispatchToolConfig | undefined,
  ctx: NativeResolveContext
): ResolvedNativeServer | undefined {
  if (dispatch === false) return undefined;
  if (isMcpServerConfig(dispatch)) {
    return { serverKey: DISPATCH_SERVER_KEY, config: { ...dispatch } };
  }
  // `dispatch: true` (or default-present) means the REAL agent-mcp server the host
  // supplies — never an authored wrapper (D1). Absent `dispatchSelf` ⇒ omit.
  if (!ctx.dispatchSelf) return undefined;

  const overrides = dispatch === true || dispatch === undefined ? {} : dispatch;
  const config: McpServerConfig = { ...ctx.dispatchSelf };
  if (overrides.allowedTools) config.allowedTools = [...overrides.allowedTools];
  if (overrides.disallowedTools) config.disallowedTools = [...overrides.disallowedTools];
  return { serverKey: DISPATCH_SERVER_KEY, config };
}

/**
 * Resolve the standardized native toolset against a task-time context
 * (ADR-0008 D2/D4). Returns the builtin servers in a fixed order —
 * `fs`, `shell`, `dispatch` — omitting any member set to `false` (or, for
 * `dispatch`, any member with no `dispatchSelf` to reference).
 *
 * The `fs` and `shell` builtins are wrapped with the adopted `srt` sandbox by
 * default (D7); pass `ctx.sandbox === false` to disable. The stored `cfg` is
 * NEVER mutated, and no resolved root is persisted: the same definition fired
 * from `/P/a` then `/P/b` yields roots `/P/a` then `/P/b` while the definition
 * stays byte-identical (D4/D8).
 */
export function resolveNativeTooling(
  cfg: NativeToolingConfig | undefined,
  ctx: NativeResolveContext
): McpServerConfig[] {
  return resolveNativeToolingEntries(cfg, ctx).map((entry) => entry.config);
}

/**
 * The keyed form of {@link resolveNativeTooling}: the SAME resolution, returned
 * as the `mcpServers` map a host mounts on an agent. Every key comes from the ONE
 * catalog ({@link FS_SERVER}, {@link SHELL_SERVER}, {@link DISPATCH_SERVER_KEY}) —
 * `fs`, `shell`, `agent-mcp` — so no host authors a divergent key
 * (`filesystem` vs `fs`) for the same server. The array form and this map are the
 * same computation; neither is a second producer.
 */
export function resolveNativeToolingMap(
  cfg: NativeToolingConfig | undefined,
  ctx: NativeResolveContext
): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const entry of resolveNativeToolingEntries(cfg, ctx)) {
    out[entry.serverKey] = entry.config;
  }
  return out;
}

/**
 * The single internal resolution step: each member resolved ONCE, in fixed order
 * (`fs`, `shell`, `dispatch`), paired with its catalog key. Both public
 * projections ({@link resolveNativeTooling}, {@link resolveNativeToolingMap})
 * are derived from this — there is exactly one producer.
 */
function resolveNativeToolingEntries(
  cfg: NativeToolingConfig | undefined,
  ctx: NativeResolveContext
): ResolvedNativeServer[] {
  const config = cfg ?? {};
  const entries: ResolvedNativeServer[] = [];

  const fs = resolveFs(config.fs, ctx);
  if (fs) entries.push(fs);

  const shell = resolveShell(config.shell, ctx);
  if (shell) entries.push(shell);

  const dispatch = resolveDispatch(config.dispatch, ctx);
  if (dispatch) entries.push(dispatch);

  return entries;
}
