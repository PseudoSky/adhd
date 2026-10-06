/**
 * Task-time native-tooling resolution for the agent-mcp host (ADR-0008 D1/D4).
 *
 * This module is the host's SINGLE resolution point for an agent's MCP servers.
 * It does NOT author any fs/shell server config of its own: every builtin comes
 * from `resolveNativeToolingMap` (`@adhd/agent-core-native-tooling`), whose one
 * catalog (`packages/agent/agent-core-native-tooling/src/lib/catalog.ts`) owns
 * the keys (`fs`/`shell`/`agent-mcp`) and commands. There is exactly ONE
 * producer, and exactly ONE merge ( {@link withDefaultMcpServers} ).
 *
 * Merge precedence, highest first (ADR-0008 D1/D4):
 *     explicit `mcpServers`  >  `nativeTooling`  >  `dispatch` self floor.
 *
 * Resolution is TASK time, against the dispatching cwd: the stored definition is
 * NEVER mutated and never carries a resolved root, so the same definition fired
 * from `/P/a` then `/P/b` yields fs root `/P/a` then `/P/b` while its stored JSON
 * stays byte-identical (ADR-0008 D4/D8). `agent_create` deliberately does NOT
 * call this module — it stores only the declarative `nativeTooling` — so there is
 * no create-time/second-timing behaviour.
 */
import {
  matchPermission,
  resolveNativeToolingMap,
} from '@adhd/agent-core-native-tooling';
import type {
  AgentDefinition,
  McpServerConfig,
  NativeToolingConfig,
  PermissionAction,
  PermissionRuleMap,
} from '@adhd/agent-base-types';
import type { PermissionGate } from '@adhd/agent-engine-orchestrator';

import { AGENT_MCP_NPX_ARGS } from './install.js';
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

/** An agent definition carrying at least the two fields resolution reads. */
type ResolvableDefinition = {
  mcpServers?: Record<string, McpServerConfig>;
  nativeTooling?: NativeToolingConfig;
};

/**
 * The ONE resolution path (ADR-0008 D1/D4): resolve `def.nativeTooling` against
 * the task-time context into the keyed builtin map, then let an explicit
 * `def.mcpServers` entry WIN over a native/dispatch member of the same name.
 *
 * Pure — the passed definition is never mutated; the returned object is a new
 * definition whose `mcpServers` is the merged map. This is called at TASK time
 * only (`buildTaskDeps`/`agent_verify_mcp`); `agent_create` never calls it, so no
 * resolved root is ever persisted.
 *
 * The name is preserved from the pre-NAT-TOOL-4 create-time helper, but its
 * behaviour is now a MERGE at task time — not the old "return explicit untouched
 * then ignore native" no-op.
 */
export function withDefaultMcpServers<T extends ResolvableDefinition>(
  def: T,
  ctx: NativeToolingHostContext
): T & { mcpServers: Record<string, McpServerConfig> } {
  const native = resolveNativeToolingMap(def.nativeTooling ?? {}, {
    cwd: ctx.cwd,
    env: ctx.env,
    dispatchSelf: ctx.dispatchSelf,
    sandbox: ctx.sandbox,
  });
  // explicit `mcpServers` WIN over nativeTooling > dispatch floor (D1/D4).
  return { ...def, mcpServers: { ...native, ...(def.mcpServers ?? {}) } };
}

/**
 * The keyed `mcpServers` map for a definition at task time — the accessor form of
 * {@link withDefaultMcpServers}. Exposed because the store wrappers and the real
 * host tests need the map, not the wrapped definition.
 */
export function resolveAgentMcpServers(
  def: ResolvableDefinition,
  ctx: NativeToolingHostContext
): Record<string, McpServerConfig> {
  return withDefaultMcpServers(def, ctx).mcpServers;
}

/**
 * Return a shallow copy of `def` whose `mcpServers` is the task-time resolved
 * map. The input is never mutated (ADR-0008 D4).
 */
export function resolveDefinitionNativeTooling(
  def: AgentDefinition,
  ctx: NativeToolingHostContext
): AgentDefinition {
  return withDefaultMcpServers(def, ctx);
}

/** Env override for the real agent-mcp server command surfaced as `dispatch` (D1). */
export const AGENT_MCP_SELF_COMMAND_ENV = 'ADHD_AGENT_MCP_COMMAND';
/** Env override (whitespace-separated) for the `dispatch` server args. */
export const AGENT_MCP_SELF_ARGS_ENV = 'ADHD_AGENT_MCP_ARGS';

/**
 * The REAL agent-mcp MCP server config surfaced as the `dispatch` member (D1).
 * Defaults to the ONE canonical launch config (`AGENT_MCP_NPX_ARGS`,
 * `npx -y @adhd/agent-mcp@latest` — the same argv `agent-mcp-install` writes),
 * overridable by env so a hermetic host/e2e can point at a local build. The
 * registry routes the `agent-mcp` name to its in-process tool surface (never a
 * spawn), so this config documents the surface rather than re-authoring it.
 */
export function buildDispatchSelf(env: NodeJS.ProcessEnv = process.env): McpServerConfig {
  const command = env[AGENT_MCP_SELF_COMMAND_ENV] || 'npx';
  const rawArgs = env[AGENT_MCP_SELF_ARGS_ENV];
  const args = rawArgs
    ? rawArgs.split(/\s+/).filter(Boolean)
    : [...AGENT_MCP_NPX_ARGS];
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
 * It ALSO exposes `readUnresolved` — the raw store's (unresolved) `read` — so a
 * session snapshot persists the DECLARATIVE definition and never a task-time
 * resolved root (ADR-0008 D4/D8); the engine's `task.ts`/`session.ts` call it
 * when creating a session.
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
      // The DECLARATIVE read (ADR-0008 D4/D8): the raw store's `read` is the
      // stored, unresolved definition — expose it so callers that snapshot a
      // definition (session creation) never persist a resolved root.
      if (prop === 'readUnresolved') {
        return target.read.bind(target);
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

// ============================================================================
// The resolved permission map + the injected gate (ADR-0008 D5/D6)
// ============================================================================

/**
 * The engine-wide DEFAULT permission rule map (ADR-0008 D5: "base tools `allow`;
 * explicit tool-name `deny` guardrails"). Deliberately permissive — the default
 * toolset must be usable without an interactive answer — and deliberately free of
 * any command pattern: the gate matches TOOL NAMES only and agent-mcp owns no
 * dangerous-command catalog or command segmentation (D5).
 *
 * Rules are keyed by the **server-qualified tool name** (`<server>.<tool>`, e.g.
 * `agent-mcp.task`, `shell.shell_execute`; a whole server is `<server>.*`). This
 * is the ADR's documented example form (`agent-mcp.*`, ADR-0008 :129) and the
 * resource `matchPermission` is called with.
 *
 * FROZEN: this baseline is a shared, process-wide constant. It is `Object.freeze`d
 * (and typed `Readonly`) so a consumer cannot mutate engine-wide defaults in
 * place; {@link resolvePermissionRules} returns a fresh copy for per-agent edits.
 */
export const DEFAULT_PERMISSION_RULES: Readonly<PermissionRuleMap> = Object.freeze({
  '*': 'allow',
});

/**
 * Resolve an agent's effective permission rule map: the {@link DEFAULT_PERMISSION_RULES}
 * baseline overlaid, in a fixed order (`fs` → `shell` → `dispatch`), with the
 * `permissions` maps declared on each `nativeTooling` member. Later rules win and
 * a matched `deny` is terminal — exactly the semantics `matchPermission` implements
 * (last-match-wins, `deny` terminal; ADR-0008 D5, Q1 ratified).
 *
 * Pure; never mutates the input config.
 */
export function resolvePermissionRules(
  nativeTooling?: NativeToolingConfig,
  baseline: PermissionRuleMap = DEFAULT_PERMISSION_RULES
): PermissionRuleMap {
  const merged: PermissionRuleMap = { ...baseline };
  for (const member of [
    nativeTooling?.fs,
    nativeTooling?.shell,
    nativeTooling?.dispatch,
  ]) {
    if (member && typeof member === 'object' && !('transport' in member)) {
      const permissions = (member as { permissions?: PermissionRuleMap })
        .permissions;
      if (permissions) {
        for (const [pattern, action] of Object.entries(permissions)) {
          merged[pattern] = action;
        }
      }
    }
  }
  return merged;
}

/**
 * Evaluate the resolved permission action for one native tool call (ADR-0008 D5).
 * The matched resource is the server-qualified **tool name**; command text is
 * never passed or parsed.
 */
export function evaluateNativePermission(
  nativeTooling: NativeToolingConfig | undefined,
  server: string,
  tool: string
): PermissionAction {
  return matchPermission(
    resolvePermissionRules(nativeTooling),
    `${server}.${tool}`
  );
}

/**
 * The production {@link PermissionGate} the host injects into the engine via
 * `toEngineConfig()` (ADR-0008 D5). Resolves the calling agent's permission map
 * at call time and matches the server-qualified tool name; the engine owns the
 * enforcement (and the ask chain the decision `'ask'` triggers).
 */
export const defaultPermissionGate: PermissionGate = (ctx) =>
  evaluateNativePermission(
    ctx.agentDefinition.nativeTooling,
    ctx.server,
    ctx.tool
  );
