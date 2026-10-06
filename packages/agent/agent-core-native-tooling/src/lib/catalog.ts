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

/** The three native tool members (ADR-0008 D1). */
export const NATIVE_TOOL_NAMES = ['fs', 'shell', 'dispatch'] as const;
export type NativeToolName = (typeof NATIVE_TOOL_NAMES)[number];

/** `mcpServers` key the dispatch self tools are surfaced under (agent-mcp's real server). */
export const DISPATCH_SERVER_KEY = 'agent-mcp';

/** Reference filesystem MCP server — ADOPTED, first cut (ADR-0008 D7). */
export const FS_SERVER = {
  /** `mcpServers` key the builtin fs server is mounted under. */
  key: 'fs',
  command: 'npx',
  /** Args preceding the resolved root: `npx -y @modelcontextprotocol/server-filesystem <root>`. */
  args: ['-y', '@modelcontextprotocol/server-filesystem'],
} as const;

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
export const SHELL_SERVER = {
  key: 'shell',
  command: 'uvx',
  args: ['mcp-shell-server'],
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
  },
} as const;

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
 */
export function wrapWithSandbox(spec: WrappableCommand): {
  command: string;
  args: string[];
} {
  return { command: SRT_SANDBOX.command, args: [spec.command, ...(spec.args ?? [])] };
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
  fs: { name: 'fs', serverKey: FS_SERVER.key, command: FS_SERVER.command, args: FS_SERVER.args },
  shell: {
    name: 'shell',
    serverKey: SHELL_SERVER.key,
    command: SHELL_SERVER.command,
    args: SHELL_SERVER.args,
  },
  dispatch: { name: 'dispatch', serverKey: DISPATCH_SERVER_KEY },
};
