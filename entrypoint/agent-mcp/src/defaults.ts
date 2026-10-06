/**
 * Task-time native-tooling resolution for the agent-mcp host (ADR-0008 D1/D4).
 *
 * This module REPLACES the retired definition-creation-time defaults
 * (`buildDefaultMcpServers` / `withDefaultMcpServers`, backlog 97acef07) with a
 * task-time resolver over `AgentDefinition.nativeTooling`. It is the single
 * choke point through which the host consumes `resolveNativeTooling`
 * (`@adhd/agent-core-native-tooling`, ADR-0008 D2).
 *
 * Merge precedence, highest first (ADR-0008 D1/D4):
 *     explicit `mcpServers`  >  `nativeTooling`  >  `dispatch` self floor.
 *
 * Resolution is TASK time, against the dispatching cwd: the stored definition is
 * NEVER mutated and never carries a resolved root, so the same definition fired
 * from `/P/a` then `/P/b` yields fs root `/P/a` then `/P/b` while its stored JSON
 * stays byte-identical (ADR-0008 D4/D8).
 */
import {
  DISPATCH_SERVER_KEY,
  FS_SERVER,
  SHELL_SERVER,
  resolveNativeTooling,
  type NativeToolName,
} from '@adhd/agent-core-native-tooling';
import type {
  AgentDefinition,
  McpServerConfig,
  NativeToolingConfig,
} from '@adhd/agent-base-types';

import { ensureBinDirOnPath, resolveNativeBinDir } from './srt-policy.js';

/** Runtime context for host-side native-tooling resolution (task time). */
export interface NativeToolingHostContext {
  /** The dispatching host's working directory; becomes the builtin root. */
  cwd: string;
  /** The REAL agent-mcp MCP server config, surfaced for `dispatch: true` (D1). */
  dispatchSelf?: McpServerConfig;
  /** Base env merged into every resolved stdio server (D9). */
  env?: Record<string, string>;
  /**
   * Wrap the builtin `fs`/`shell` servers with the adopted `srt` sandbox
   * (ADR-0008 D7). Defaults to `true`; the host provisions the matching srt
   * policy (`srt-policy.ts`, deferral `a5a2f1d4`) so the builtins can spawn.
   */
  sandbox?: boolean;
}

/**
 * `mcpServers` key each resolved native member is mounted under, from the
 * resolver's own catalog. `dispatch` surfaces the real agent-mcp server (D1).
 */
const SERVER_KEY_BY_MEMBER: Record<NativeToolName, string> = {
  fs: FS_SERVER.key,
  shell: SHELL_SERVER.key,
  dispatch: DISPATCH_SERVER_KEY,
};

/** A custom `McpServerConfig` (transport-bearing) — as opposed to an overrides object. */
function isTransportObject(value: unknown): value is McpServerConfig {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>)['transport'] === 'string'
  );
}

/**
 * The members `resolveNativeTooling` will emit, in its documented fixed order
 * (`fs`, `shell`, `dispatch`). Mirrors the resolver's own omission rules so the
 * host can key each returned server without the resolver carrying key metadata:
 * `false` omits a member; `dispatch` is additionally omitted when no real
 * `dispatchSelf` is available (a wrapper is never authored instead).
 */
export function enabledNativeMembers(
  cfg: NativeToolingConfig | undefined,
  ctx: Pick<NativeToolingHostContext, 'dispatchSelf'>
): NativeToolName[] {
  const c = cfg ?? {};
  const members: NativeToolName[] = [];
  if (c.fs !== false) members.push('fs');
  if (c.shell !== false) members.push('shell');
  const dispatch = c.dispatch;
  if (
    dispatch !== false &&
    (isTransportObject(dispatch) || !!ctx.dispatchSelf)
  ) {
    members.push('dispatch');
  }
  return members;
}

/**
 * Resolve a definition's `nativeTooling` against the task-time context into a
 * keyed `mcpServers` map, applying merge precedence (explicit > native >
 * dispatch floor). Pure — the passed definition is never mutated.
 */
export function resolveAgentMcpServers(
  def: Pick<AgentDefinition, 'mcpServers' | 'nativeTooling'>,
  ctx: NativeToolingHostContext
): Record<string, McpServerConfig> {
  const cfg = def.nativeTooling ?? {};
  const resolved = resolveNativeTooling(cfg, {
    cwd: ctx.cwd,
    env: ctx.env,
    dispatchSelf: ctx.dispatchSelf,
    sandbox: ctx.sandbox,
  });
  const members = enabledNativeMembers(cfg, ctx);
  if (resolved.length !== members.length) {
    throw new Error(
      `resolveAgentMcpServers: resolver returned ${resolved.length} server(s) for ` +
        `${members.length} expected member(s) [${members.join(', ')}] — the resolver's ` +
        `fixed member order (ADR-0008 D2) changed; update this keying.`
    );
  }

  const native: Record<string, McpServerConfig> = {};
  members.forEach((member, i) => {
    const server = resolved[i];
    if (!server) {
      throw new Error(
        `resolveAgentMcpServers: no resolved server for member "${member}"`
      );
    }
    native[SERVER_KEY_BY_MEMBER[member]] = server;
  });

  // Explicit `mcpServers` WIN over nativeTooling > dispatch floor (D1/D4).
  return { ...native, ...(def.mcpServers ?? {}) };
}

/**
 * Return a shallow copy of `def` whose `mcpServers` is the task-time resolved
 * map. The input is never mutated (ADR-0008 D4).
 */
export function resolveDefinitionNativeTooling(
  def: AgentDefinition,
  ctx: NativeToolingHostContext
): AgentDefinition {
  return { ...def, mcpServers: resolveAgentMcpServers(def, ctx) };
}

/** Env override for the real agent-mcp server command surfaced as `dispatch` (D1). */
export const AGENT_MCP_SELF_COMMAND_ENV = 'ADHD_AGENT_MCP_COMMAND';
/** Env override (whitespace-separated) for the `dispatch` server args. */
export const AGENT_MCP_SELF_ARGS_ENV = 'ADHD_AGENT_MCP_ARGS';

/**
 * The REAL agent-mcp MCP server config surfaced as the `dispatch` member (D1).
 * Defaults to the documented launch (`npx -y @adhd/agent-mcp`), overridable by
 * env so a hermetic host/e2e can point at a local build. The registry routes
 * the `agent-mcp` name to its in-process tool surface (never a spawn), so this
 * config documents the surface rather than re-authoring it.
 */
export function buildDispatchSelf(env: NodeJS.ProcessEnv = process.env): McpServerConfig {
  const command = env[AGENT_MCP_SELF_COMMAND_ENV] || 'npx';
  const rawArgs = env[AGENT_MCP_SELF_ARGS_ENV];
  const args = rawArgs
    ? rawArgs.split(/\s+/).filter(Boolean)
    : ['-y', '@adhd/agent-mcp'];
  return { transport: 'stdio', command, args };
}

export interface BuildNativeToolingContextOptions {
  /** Dispatching cwd; defaults to `process.cwd()` read per call. */
  cwd?: string;
  dispatchSelf?: McpServerConfig;
  env?: Record<string, string>;
  sandbox?: boolean;
}

/**
 * Assemble the task-time context, injecting the local `node_modules/.bin` on
 * `PATH` so the `srt`-wrapped `npx`/`uvx` children resolve their launchers.
 */
export function buildNativeToolingContext(
  opts: BuildNativeToolingContextOptions = {}
): NativeToolingHostContext {
  const path = ensureBinDirOnPath(process.env['PATH'], resolveNativeBinDir());
  const env: Record<string, string> = { ...(opts.env ?? {}) };
  if (path) env['PATH'] = path;
  return {
    cwd: opts.cwd ?? process.cwd(),
    dispatchSelf: opts.dispatchSelf ?? buildDispatchSelf(),
    env: Object.keys(env).length > 0 ? env : undefined,
    sandbox: opts.sandbox,
  };
}

type AgentReader = { read(name: string): AgentDefinition };
type SessionAgentReader = { getAgentDefinition(sessionId: string): unknown };

/**
 * Wrap an `AgentStore` so its `read` returns a definition whose `mcpServers` are
 * resolved at READ time (task time) against the current context. All other
 * methods pass through untouched, and the stored definition is never mutated.
 *
 * The CRUD surface (`agent_read`/`agent_list`) deliberately keeps using the RAW
 * store, so a stored definition is returned byte-identically and portability is
 * preserved (ADR-0008 D4).
 */
export function withResolvedNativeTooling<T extends AgentReader>(
  store: T,
  context: () => NativeToolingHostContext
): T {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === 'read') {
        const bound = target.read.bind(target);
        return (name: string) =>
          resolveDefinitionNativeTooling(bound(name), context());
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/**
 * Wrap a session store so `getAgentDefinition` resolves the session's snapshot
 * (which carries the stored `nativeTooling`, never a resolved root) against the
 * current task-time context. All other methods pass through.
 */
export function withResolvedNativeToolingSession<T extends SessionAgentReader>(
  store: T,
  context: () => NativeToolingHostContext
): T {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === 'getAgentDefinition') {
        const bound = target.getAgentDefinition.bind(target);
        return (sessionId: string) =>
          resolveDefinitionNativeTooling(
            bound(sessionId) as AgentDefinition,
            context()
          );
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
