import { isAbsolute, resolve, sep } from 'node:path';

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
  SHELL_PROXY_ENV_KEYS,
  SHELL_SERVER,
  resolveFsServerLaunch,
  wrapWithSandbox,
} from './catalog.js';

/**
 * A typed failure resolving an `fs` root HINT (ADR-0008 D7; the multi-root /
 * portability contract). Thrown at TASK time, when `resolveFsRoots` turns a
 * definition's portable hint into a concrete directory — never at definition
 * storage time (the definition carries only hints; D4/D8).
 *
 * Two codes:
 *  - `ABSOLUTE_ROOT_NOT_PORTABLE` — the hint is an absolute path. An absolute
 *    path in a definition welds a host path into a record that must be reusable
 *    from any directory, so it is rejected (the fs analogue of the welded
 *    `provider` bug). Absolute machine directories belong in the GLOBAL
 *    allowed-root map, referenced by a named alias.
 *  - `ROOT_ESCAPES_CALLER_CWD` — a relative hint resolves outside the caller
 *    cwd (e.g. `..`); containment is the point of scoping the server.
 */
export class NativeToolingRootError extends Error {
  constructor(
    public readonly code:
      | 'ABSOLUTE_ROOT_NOT_PORTABLE'
      | 'ROOT_ESCAPES_CALLER_CWD',
    message: string,
    public readonly root: string
  ) {
    super(message);
    this.name = 'NativeToolingRootError';
  }
}

/**
 * Runtime context for native-tooling resolution — known only at TASK time
 * (ADR-0008 D4). The resolver NEVER mutates the stored definition and NEVER
 * persists the resolved root.
 */
export interface NativeResolveContext {
  /** The dispatching working directory; the base for relative root hints. */
  cwd: string;
  /**
   * Where `cwd` came from (ADR-0008 D4; caller-cwd contract).
   *  - `'caller'` — supplied by the MCP caller or inherited from a parent
   *    dispatch (the portable, correct case).
   *  - `'host-fallback'` — absent from the caller, so the host process's own
   *    cwd was used; this "may not be the agent's cwd" and is flagged so a
   *    caller can surface the ambiguity.
   * Absent ⇒ treated as `'caller'` for a bare resolver call (hosts set it).
   */
  cwdSource?: 'caller' | 'host-fallback';
  /**
   * The GLOBAL allowed-root map: a named alias → the machine-specific,
   * operator-owned ABSOLUTE directory it resolves to (the fs analogue of the
   * provider registry). A definition references an alias portably (e.g.
   * `fs: { roots: ['project'] }`); the operator's global config owns the
   * mapping `{ project: '/Users/me/proj' }`. This is the ONLY place an absolute
   * directory lives in the resolution path — never the definition.
   */
  roots?: Record<string, string>;
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

/**
 * Resolve ONE portable root hint to a concrete directory (ADR-0008 D7; the
 * multi-root / caller-cwd contract). Pure. Used for BOTH an `fs` root hint and
 * the `shell` working-directory hint — the ONE resolution contract, so an
 * absolute/`..`/alias `shell.root` behaves exactly like `fs.root` (#3).
 *
 *  1. A named alias present in the GLOBAL allowed-root map (`ctx.roots`) wins —
 *     the operator owns the absolute target, the definition stays portable. The
 *     lookup is OWN-property only (`hasOwnProperty`) and accepts ONLY a string
 *     value, so an inherited member (`constructor`, `__proto__`, `toString`, …)
 *     or a non-string mapping never leaks into the resolved path (#7).
 *  2. An ABSOLUTE path is rejected with a typed {@link NativeToolingRootError}:
 *     it welds a host path into the record (the fs analogue of the welded
 *     `provider` bug). Absolute machine dirs belong in the global map.
 *  3. A relative subpath resolves against the caller cwd, and MUST stay within
 *     it — a `..` subpath that escapes is rejected (containment is the point).
 */
function resolveRootHint(hint: string, ctx: NativeResolveContext): string {
  const mapped =
    ctx.roots && Object.prototype.hasOwnProperty.call(ctx.roots, hint)
      ? ctx.roots[hint]
      : undefined;
  if (typeof mapped === 'string') return mapped;
  if (isAbsolute(hint)) {
    throw new NativeToolingRootError(
      'ABSOLUTE_ROOT_NOT_PORTABLE',
      `fs root hint '${hint}' is an absolute path — fs roots must be portable ` +
        `(a relative subpath of the caller cwd, or a named alias in the global ` +
        `allowed-root map); absolute machine directories belong in the global map`,
      hint
    );
  }
  const resolved = resolve(ctx.cwd, hint);
  if (!isWithin(ctx.cwd, resolved)) {
    throw new NativeToolingRootError(
      'ROOT_ESCAPES_CALLER_CWD',
      `fs root hint '${hint}' resolves to '${resolved}', which escapes the ` +
        `caller cwd '${ctx.cwd}'`,
      hint
    );
  }
  return resolved;
}

/**
 * True when `child` is `parent` itself or sits beneath it (path-segment safe).
 *
 * LEXICAL, NOT SYMLINK-SAFE (#10). This is a pure string/segment check on the
 * RESOLVED paths — it does not `realpath()` either side, so a symlink under the
 * caller cwd that points outside it passes here. That is deliberate: the hint
 * may not exist on disk yet (no `realpath` possible), and the check's job is a
 * portable, cheap, pure rejection of a definition that literally escapes its cwd
 * (`..`). SYMLINK-ESCAPE ENFORCEMENT is the `srt` sandbox's job (ADR-0008 D7),
 * which scopes the spawned `fs`/`shell` children at the OS layer; the reference
 * fs server independently re-confines to its resolved root argv. This function
 * is a portability guard, not the security boundary.
 */
function isWithin(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p + sep);
}

/**
 * The filesystem roots a resolved `fs` config exposes, in argv order — the ONE
 * producer of the root list (ADR-0008 D7). A non-empty `roots` array WINS and
 * `root` is ignored; otherwise the list is `[root]`. When neither is given the
 * list is `[ctx.cwd]` (the caller cwd is the default scope). A disabled
 * (`false`) or custom (`McpServerConfig`) member yields `[]` (the builtin owns
 * no roots). Pure — never mutates the config.
 *
 * Each hint is resolved through {@link resolveRootHint}: an alias from the
 * global map, or a cwd-relative subpath, `..`-contained; an absolute hint
 * throws a typed {@link NativeToolingRootError}.
 *
 * Exported so a host provisions the matching per-run `srt` policy from the SAME
 * list the resolver emits (finding 535c1101 / A3) rather than a second,
 * divergent derivation.
 */
export function resolveFsRoots(
  fs: FsToolConfig | undefined,
  ctx: NativeResolveContext
): string[] {
  if (fs === false || isMcpServerConfig(fs)) return [];
  const overrides = fs === true || fs === undefined ? {} : fs;
  let hints: string[];
  if (overrides.roots && overrides.roots.length > 0) {
    hints = [...overrides.roots];
  } else if (overrides.root !== undefined) {
    hints = [overrides.root];
  } else {
    hints = [];
  }
  if (hints.length === 0) return [ctx.cwd];
  return hints.map((hint) => resolveRootHint(hint, ctx));
}

function resolveFs(
  fs: FsToolConfig | undefined,
  ctx: NativeResolveContext
): ResolvedNativeServer | undefined {
  if (fs === false) return undefined;
  // A full McpServerConfig REPLACES the builtin (D3) — respected as-is, never overridden.
  if (isMcpServerConfig(fs)) return { serverKey: FS_SERVER.key, config: { ...fs } };

  const overrides = fs === true || fs === undefined ? {} : fs;
  const launch = resolveFsServerLaunch();
  const config: McpServerConfig = {
    transport: 'stdio',
    command: launch.command,
    // MULTI-ROOT: every resolved root becomes one argv entry — the reference fs
    // server accepts `process.argv.slice(2)` as its allowed-directory allow-list
    // (ADR-0008 D7). `roots` wins; else `[root]`; else `[callerCwd]` (resolveFsRoots).
    args: [...launch.args, ...resolveFsRoots(fs, ctx)],
    cwd: ctx.cwd,
  };
  if (overrides.allowedTools) config.allowedTools = [...overrides.allowedTools];
  if (overrides.disallowedTools) config.disallowedTools = [...overrides.disallowedTools];
  return { serverKey: FS_SERVER.key, config: withSandbox(withBaseEnv(config, ctx), ctx) };
}

/**
 * The resolved working directory a `shell` member runs in — the singular shell
 * analogue of {@link resolveFsRoots}. Returns the resolved `shell.root` hint
 * (alias → absolute, absolute-rejected, or a `..`-contained cwd-relative
 * subpath — the SAME {@link resolveRootHint} contract `fs.root` uses), or
 * `undefined` when the member is disabled/custom or carries no explicit `root`
 * (then the spawned shell inherits the caller cwd). Exported so the host unions
 * this exact directory into the per-run `srt` policy: a `shell.root` alias
 * outside the dispatching cwd would otherwise be sandbox-DENIED the same way a
 * second fs root would be (AC6 / finding 535c1101), and so the "same contract"
 * is honest end to end. Pure.
 */
export function resolveShellRoot(
  shell: ShellToolConfig | undefined,
  ctx: NativeResolveContext
): string | undefined {
  if (shell === false || isMcpServerConfig(shell)) return undefined;
  const overrides = shell === true || shell === undefined ? {} : shell;
  if (overrides.root === undefined) return undefined;
  return resolveRootHint(overrides.root, ctx);
}

/** CSV-merge: `existing` entries first (trimmed, empties dropped), then `extra`, de-duplicated. */
function mergeCsv(existing: string | undefined, extra: readonly string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...(existing ? existing.split(',') : []), ...extra]) {
    const name = raw.trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out.join(',');
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
  // Pattern allow-list passthrough (ADR-0008 D5): the adopted server `fullmatch`es
  // each regex against the command NAME (`re.fullmatch(pattern, command[0])`),
  // OR'd with `ALLOW_COMMANDS`. The harness only plumbs the config through — it
  // owns no parser and evaluates no pattern. A pattern containing a comma is
  // REJECTED at the zod boundary (the env is CSV-joined), so a comma can never
  // reach this join and corrupt a neighbouring pattern (#9).
  if (overrides.allowPatterns?.length) {
    env[SHELL_SERVER.envKeys.allowPatterns] = overrides.allowPatterns.join(',');
  }
  if (overrides.timeoutMs !== undefined) {
    env[SHELL_SERVER.envKeys.timeoutSeconds] = String(
      Math.ceil(overrides.timeoutMs / 1000)
    );
  }
  // NOTE: no deny-list env is emitted, and there is no `denyCommands` override
  // (it was removed — a silent no-op). The adopted server
  // (`tumf/mcp-shell-server`) exposes an allow-list ONLY — it has no deny-list
  // environment variable — and ADR-0008 D5 forbids the harness from owning
  // per-command deny semantics. Emitting a fictional `DENY_COMMANDS` var would
  // be ignored by the server.
  if (overrides.env) Object.assign(env, overrides.env);
  // Proxy passthrough (0ba70e47 AC1/AC3): under `srt` the sandbox injects
  // HTTP(S)_PROXY into the server process, but the adopted server hands its
  // children `PATH` only, so allowlisted egress (`curl`) fails DNS. Name the
  // proxy vars in the server's child-env allowlist. MERGED with a user-supplied
  // value (user entries first, de-duplicated) — never overwritten. Absent when
  // the sandbox is off: there is no injected proxy to pass through.
  if (ctx.sandbox !== false) {
    const key = SHELL_SERVER.envKeys.childEnvAllowlist;
    // A value may arrive via `shell.env` OR the ambient `ctx.env` (which
    // `withBaseEnv` would otherwise let this key shadow); keep both.
    const existing = [env[key], ctx.env?.[key]].filter(Boolean).join(',');
    env[key] = mergeCsv(existing, SHELL_PROXY_ENV_KEYS);
  }

  const config: McpServerConfig = {
    transport: 'stdio',
    command: SHELL_SERVER.command,
    args: [...SHELL_SERVER.args],
    // The shell cwd is a PORTABLE HINT resolved through the SAME contract as
    // `fs.root` (#3): an alias from the global map, or a `..`-contained
    // cwd-relative subpath; an absolute hint throws a typed
    // `NativeToolingRootError`. Falls back to the caller cwd when no hint.
    cwd: resolveShellRoot(shell, ctx) ?? ctx.cwd,
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
