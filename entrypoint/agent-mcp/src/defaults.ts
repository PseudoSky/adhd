/**
 * Default MCP-server wiring for newly created agents (backlog 97acef07).
 *
 * RESCOPED scope: this is a DX/defaults gap, not a capability gap. The
 * filesystem and shell MCP servers are already adopted and already work
 * through `McpClientRegistry` (allowedTools/disallowedTools enforced at every
 * callTool); this module just wires them into `agent_create` so a newly
 * created agent is born with file read/write/glob/grep and shell exec
 * capabilities instead of every operator hand-authoring an `mcpServers`
 * block. No new executor code is introduced (adopt-not-build).
 *
 * An explicit non-empty `mcpServers` supplied by the caller always wins; the
 * defaults are only applied when the caller supplies none.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { McpServerConfig } from '@adhd/agent-engine-orchestrator';

/**
 * Filesystem MCP server tool names, covering the canonical fs capabilities
 * (`file_read`/`file_write`/`file_glob`/`file_grep`) the defaults must grant.
 * These are the server's OWN tool names (the `isToolHidden` filter compares
 * against them verbatim), so `read_text_file` is the wire name for the
 * canonical `file_read` capability.
 */
export const DEFAULT_FILESYSTEM_ALLOWED_TOOLS = [
  'read_text_file',
  'read_file',
  'read_multiple_files',
  'read_media_file',
  'write_file',
  'edit_file',
  'create_directory',
  'list_directory',
  'list_directory_with_sizes',
  'directory_tree',
  'move_file',
  'search_files',
  'get_file_info',
  'list_allowed_directories',
] as const;

/** `tools/mcp-shell/server.mjs` exposes a single tool named `shell`. */
export const DEFAULT_SHELL_ALLOWED_TOOLS = ['shell'] as const;

/** Env override for the in-repo shell MCP server path. */
export const SHELL_MCP_PATH_ENV = 'ADHD_AGENT_SHELL_MCP_PATH';

/**
 * Resolve `tools/mcp-shell/server.mjs` by walking up from this module. Returns
 * `undefined` when it cannot be found (e.g. the published package installed
 * outside the monorepo) — the shell default is then omitted rather than
 * pointing at a non-existent file.
 */
export function resolveShellServerPath(): string | undefined {
  const override = process.env[SHELL_MCP_PATH_ENV];
  if (override) return override;

  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, 'tools', 'mcp-shell', 'server.mjs');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export interface DefaultMcpServerOptions {
  /** Filesystem root the filesystem server is scoped to. Default `process.cwd()`. */
  root?: string;
  /** Explicit shell server path (tests inject one); `undefined` → auto-resolve. */
  shellServerPath?: string | undefined;
}

/**
 * Build the default MCP-server map: a `filesystem` server rooted at `root`
 * and (when resolvable) a `shell` server. Every tool the servers may expose
 * is allowlisted explicitly so `disallowedTools`/`allowedTools` mediation
 * still applies downstream.
 */
export function buildDefaultMcpServers(
  opts: DefaultMcpServerOptions = {}
): Record<string, McpServerConfig> {
  const root = opts.root ?? process.cwd();
  const shellPath =
    opts.shellServerPath !== undefined
      ? opts.shellServerPath
      : resolveShellServerPath();

  const servers: Record<string, McpServerConfig> = {
    filesystem: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', root],
      allowedTools: [...DEFAULT_FILESYSTEM_ALLOWED_TOOLS],
    },
  };

  if (shellPath) {
    servers['shell'] = {
      transport: 'stdio',
      command: 'node',
      args: [shellPath, root],
      allowedTools: [...DEFAULT_SHELL_ALLOWED_TOOLS],
    };
  }

  return servers;
}

/**
 * Apply the defaults to an `agent_create` payload ONLY when the caller
 * supplied no MCP servers. A caller-provided non-empty map (including one
 * with its own `allowedTools`/`disallowedTools`) is returned untouched.
 */
export function withDefaultMcpServers<
  T extends { mcpServers?: Record<string, McpServerConfig> },
>(input: T): T {
  const existing = input.mcpServers ?? {};
  if (Object.keys(existing).length > 0) return input;
  return { ...input, mcpServers: buildDefaultMcpServers() };
}
