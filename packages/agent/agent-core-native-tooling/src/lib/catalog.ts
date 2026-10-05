/**
 * The server catalog for the standardized native toolset (ADR-0008 D1/D2/D7).
 *
 * adhd ADOPTS upstream MCP servers and authors only this thin resolver/config
 * adapter — it never authors a bespoke fs/shell server nor a wrapper for the
 * dispatch surface (D1/D7).
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
 */
export const SHELL_SERVER = {
  key: 'shell',
  command: 'uvx',
  args: ['mcp-shell-server'],
  /** Env names the adopted server reads (argv allowlist passthrough; D5/D7). */
  envKeys: {
    allowCommands: 'ALLOW_COMMANDS',
    denyCommands: 'DENY_COMMANDS',
    timeoutSeconds: 'MCP_SHELL_DEFAULT_TIMEOUT_SECONDS',
  },
} as const;

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
