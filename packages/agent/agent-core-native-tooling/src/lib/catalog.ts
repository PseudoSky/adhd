/**
 * The server catalog for the standardized native toolset (ADR-0008 D1/D2/D7).
 *
 * adhd ADOPTS upstream MCP servers and authors only this thin resolver/config
 * adapter — it never authors a bespoke fs/shell server nor a wrapper for the
 * dispatch surface (D1/D7).
 *
 * ── HUMAN-GATED ADOPTION (NAT-TOOL-8) — APPROVED ─────────────────────────────
 * The upstream-server adoption in ADR-0008 D7 is a human-gated decision. It is
 * APPROVED:
 *   - Approved by:  pseudosky (repo owner)
 *   - Date:         2026-10-05
 *   - Directive:    "Finish the project" (the owner's written approval recorded
 *                   for these third-party adoptions, NAT-TOOL-8)
 *   - Adopted set:  `@modelcontextprotocol/server-filesystem` (fs),
 *                   `tumf/mcp-shell-server` (shell; allowlisted argv — never a
 *                   shell string), `@anthropic-ai/sandbox-runtime` (`srt`, wraps
 *                   BOTH servers). `unbash` DROPPED; `rust-mcp-filesystem` deferred.
 * The same approval record is in this package's `README.md` and in the gated
 * live-test header
 * (`entrypoint/agent-mcp/src/__tests__/integration/native-tooling-adoption.e2e.test.ts`),
 * per AGENTS.md §7 / ADR-0008 D7 (README + AGENTS.md + gated test header).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve as resolvePath } from 'node:path';

/** The three native tool members (ADR-0008 D1). */
export const NATIVE_TOOL_NAMES = ['fs', 'shell', 'dispatch'] as const;
export type NativeToolName = (typeof NATIVE_TOOL_NAMES)[number];

/** `mcpServers` key the dispatch self tools are surfaced under (agent-mcp's real server). */
export const DISPATCH_SERVER_KEY = 'agent-mcp';

/**
 * Reference filesystem MCP server — ADOPTED, first cut (ADR-0008 D7).
 *
 * Launched DIRECTLY with `node <resolved bin>` (c9f0a791): a pinned runtime
 * dependency of this package, never `npx -y …`. `npx` burns ~9s of CPU in
 * `npm exec` per spawn (27-42s under load), which exceeded the MCP request
 * budget on the first fs call. The bin is ESM, so it is executed by node, not
 * required (this package itself stays CJS-only, ADR-0003).
 */
export const FS_SERVER = {
  /** `mcpServers` key the builtin fs server is mounted under. */
  key: 'fs',
  /** npm package that ships the server; an EXACT-pinned dependency of this package. */
  packageName: '@modelcontextprotocol/server-filesystem',
  /** Key of the package's `bin` map naming the server entry. */
  binName: 'mcp-server-filesystem',
} as const;

/** A resolved, directly-executable launch (`command` + the args preceding the roots). */
export interface ResolvedFsLaunch {
  command: string;
  args: string[];
}

/**
 * The ONE producer of the builtin fs launch (ADR-0008 D2 single-producer):
 * `process.execPath` + the absolute path of the pinned package's bin, resolved
 * from THIS package's own dependency tree (so it works from any caller cwd and
 * in a published install). Resolution failure throws a loud error naming the
 * package — there is deliberately NO fallback to `npx` (that fallback is the
 * 27-42s spawn this replaces; c9f0a791).
 */
export function resolveFsServerLaunch(): ResolvedFsLaunch {
  const req = createRequire(__filename);
  const pkgJsonPath = (() => {
    try {
      return req.resolve(`${FS_SERVER.packageName}/package.json`);
    } catch (cause) {
      throw new Error(
        `Cannot resolve the pinned filesystem MCP server "${FS_SERVER.packageName}" ` +
          `(a dependency of @adhd/agent-core-native-tooling): ${(cause as Error).message}. ` +
          'Reinstall dependencies; this package never falls back to npx.'
      );
    }
  })();
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
    bin?: string | Record<string, string>;
  };
  const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[FS_SERVER.binName];
  if (!rel) {
    throw new Error(
      `"${FS_SERVER.packageName}" at ${pkgJsonPath} declares no bin "${FS_SERVER.binName}"; ` +
        'cannot launch the builtin fs server.'
    );
  }
  const bin = resolvePath(dirname(pkgJsonPath), rel);
  if (!existsSync(bin)) {
    throw new Error(
      `"${FS_SERVER.packageName}" bin ${bin} does not exist; reinstall dependencies ` +
        '(this package never falls back to npx).'
    );
  }
  return { command: process.execPath, args: [bin] };
}

/**
 * Adopted argv-allowlist shell MCP server (`tumf/mcp-shell-server`, ADR-0008 D7).
 * Runs allowlisted command NAMES as argv arrays — never a shell string. This is NOT
 * the permission gate; it is safe execution only (the gate is agent-mcp's own, D5).
 *
 * `envKeys` are the server's OWN, real environment variables (verified against
 * `mcp_shell_server/command_validator.py` / `server.py` / `process_manager.py`,
 * v1.1.12). It exposes an ALLOW-list ONLY — there is no deny-list env, so the
 * harness must not pretend to pass one (ADR-0008 D5: no per-command deny).
 */
/** Pinned PyPI version of the adopted shell server (verified against v1.1.12 sources). */
const SHELL_SERVER_VERSION = '1.1.12';

export const SHELL_SERVER = {
  key: 'shell',
  command: 'uvx',
  /** Version-pinned (`==1.1.12`): no registry resolution drift per spawn (c9f0a791). */
  args: ['--from', `mcp-shell-server==${SHELL_SERVER_VERSION}`, 'mcp-shell-server'],
  /** The adopted server's single tool name (its `listTools` surface). */
  toolName: 'shell_execute',
  /** Env names the adopted server reads (argv allowlist passthrough; D5/D7). */
  envKeys: {
    allowCommands: 'ALLOW_COMMANDS',
    /** Regex fullmatch allow-list against command NAMES (server default policy). */
    allowPatterns: 'ALLOW_PATTERNS',
    timeoutSeconds: 'MCP_SHELL_DEFAULT_TIMEOUT_SECONDS',
    /** Upper bound the per-call `timeout` is clamped to. */
    maxTimeoutSeconds: 'MCP_SHELL_MAX_TIMEOUT_SECONDS',
    outputLimitBytes: 'MCP_SHELL_OUTPUT_LIMIT_BYTES',
    /**
     * CSV of env var NAMES the server copies into each spawned command's
     * environment. The server's default child env is `PATH` only, so without
     * this the `srt`-injected proxy variables never reach `curl` et al. and
     * every allowlisted network call fails DNS inside the sandbox (0ba70e47).
     */
    childEnvAllowlist: 'MCP_SHELL_CHILD_ENV_ALLOWLIST',
    /**
     * Original `PATH` handed to the exit-status launcher (61358b6f). It travels
     * through the server's own child-env allowlist, never a server patch.
     */
    origPath: 'ADHD_SHIM_ORIG_PATH',
  },
} as const;

/**
 * Default shell argv allowlist (069316e5; ADR-0008 D5 policy change, owner-approved).
 * The single source: `resolveShell` emits it as `ALLOW_COMMANDS` ONLY when the
 * caller supplies neither `allowCommands` nor `allowPatterns`; any caller-supplied
 * list replaces it in full (never merged). `curl` is the ONE network tool in the
 * default (R5-WEB-SIMPLE AC1: every provider can fetch a page through the shell);
 * `wget`, `ssh`, `scp`, `sudo` and `nc` stay absent. Whether `curl` can reach the
 * network is the srt egress policy's call (agent-mcp: open by default, restrict
 * with `agent.shell.sandbox.allowedDomains`).
 *
 * Every entry is a name the adopted server ACCEPTS under its own default policy
 * (verified against the real `mcp-shell-server==1.1.12`, 61358b6f follow-through):
 * the server rejects `sed`, `node`, `python3` (and `env`, `xargs`, `timeout`, `sh`,
 * `bash`, other interpreters …) as "rejected by default security policy" even when
 * allowlisted, so listing them only advertised commands that always fail. They
 * are therefore NOT in the default; `default-shell-allowlist.e2e.test.ts` drives
 * every entry through the real server so a rejected name cannot be re-added.
 */
export const DEFAULT_SHELL_ALLOW_COMMANDS: readonly string[] = Object.freeze([
  // file operations
  'cat', 'ls', 'cp', 'mv', 'mkdir', 'rm', 'touch', 'head', 'tail', 'wc', 'sort',
  'uniq', 'tr', 'cut', 'diff', 'awk', 'grep', 'rg', 'echo', 'printf', 'pwd',
  'test', 'true', 'false', 'basename', 'dirname', 'realpath', 'stat', 'tee', 'chmod',
  // toolchains
  'git', 'npm', 'pnpm', 'npx', 'nx', 'make', 'tsc', 'uv',
  // web fetch (R5-WEB-SIMPLE AC1): the one network tool in the default
  'curl',
]);

/**
 * The proxy variables `srt` injects into the sandboxed process so allowlisted
 * egress goes through its filtering proxy (upper and lower case: tools differ
 * on which they read). Emitted in `MCP_SHELL_CHILD_ENV_ALLOWLIST` whenever the
 * shell server runs under `srt` (0ba70e47 AC1).
 */
export const SHELL_PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
] as const;

/**
 * Adopted OS-enforcement wrapper — `@anthropic-ai/sandbox-runtime` (`srt`,
 * Apache-2.0; ADR-0008 D7). It is NOT a server; it WRAPS both the adopted fs and
 * shell servers with OS-enforced filesystem + network confinement (macOS
 * Seatbelt / Linux bubblewrap / Windows WFP). Hard enforcement lives here, not
 * in the harness (D5).
 *
 * `srt` reads its policy from `~/.srt-settings.json` (override `srt -s <path>`).
 * A real deployment MUST provision a policy that lets the wrapped servers reach
 * their own caches/registries (e.g. `~/.cache/uv` and PyPI for the shell server).
 */
export const SRT_SANDBOX = { command: 'srt' } as const;

/** A command + argv that `srt` can wrap. */
export interface WrappableCommand {
  command: string;
  args?: readonly string[];
}

/**
 * Wrap a command + argv with the adopted `srt` sandbox: `srt <command> <args…>`.
 * Pure — returns a fresh object; the input is never mutated.
 *
 * When `settingsPath` is supplied the explicit `srt -s <path>` override is
 * emitted (`srt -s <path> <command> <args…>`), so the wrapped server reads a
 * PER-RUN policy file rather than the shared `~/.srt-settings.json` default.
 * This is how the host keeps a per-spawn cwd allow out of the global file
 * (ADR-0008 D7 / finding 535c1101 / A4). Absent ⇒ the pre-existing behavior
 * (`srt` reads its own default path).
 */
export function wrapWithSandbox(
  spec: WrappableCommand,
  settingsPath?: string
): {
  command: string;
  args: string[];
} {
  const prefix = settingsPath ? ['-s', settingsPath] : [];
  return {
    command: SRT_SANDBOX.command,
    args: [...prefix, spec.command, ...(spec.args ?? [])],
  };
}

/** One catalog entry describing a builtin native server. */
export interface NativeServerCatalogEntry {
  name: NativeToolName;
  /** `mcpServers` key under which the server is mounted. */
  serverKey: string;
  /**
   * Launch command for the builtin, when the catalog itself owns one. `dispatch`
   * deliberately has none: its server is supplied by the host as `dispatchSelf`
   * (the REAL agent-mcp surface), never authored here (ADR-0008 D1).
   */
  command?: string;
  args?: readonly string[];
}

/** The resolved server catalog (fs/shell/dispatch specs; ADR-0008 D2). */
export const NATIVE_SERVER_CATALOG: Readonly<
  Record<NativeToolName, NativeServerCatalogEntry>
> = {
  fs: {
    name: 'fs',
    serverKey: FS_SERVER.key,
    // Lazy: resolving the pinned package at module load would make a broken
    // install fail every import of this package, not just the fs spawn.
    get command() {
      return resolveFsServerLaunch().command;
    },
    get args() {
      return resolveFsServerLaunch().args;
    },
  },
  shell: {
    name: 'shell',
    serverKey: SHELL_SERVER.key,
    command: SHELL_SERVER.command,
    args: SHELL_SERVER.args,
  },
  dispatch: { name: 'dispatch', serverKey: DISPATCH_SERVER_KEY },
};
