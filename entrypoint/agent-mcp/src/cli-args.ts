/**
 * Pure command-line argument handling for the `agent-mcp` server bin.
 *
 * Kept free of any heavy import (no DB, no config, no logger) so it can be
 * evaluated before the server's module graph — see `cli-preflight.ts`.
 */

/** What the bin should do for a given argv tail (`process.argv.slice(2)`). */
export type CliAction =
  | { kind: 'start' }
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'unknown'; args: string[] };

/**
 * Classify the argv tail. No arguments starts the stdio server (unchanged
 * behaviour); `--help`/`-h` and `--version`/`-v` are informational; anything
 * else is rejected rather than silently booting a server.
 */
export function parseServerArgs(args: readonly string[]): CliAction {
  if (args.length === 0) return { kind: 'start' };
  if (args.includes('--help') || args.includes('-h')) return { kind: 'help' };
  if (args.includes('--version') || args.includes('-v')) return { kind: 'version' };
  return { kind: 'unknown', args: [...args] };
}

/** Usage text printed for `--help` and after an unknown-flag error. */
export function usageText(): string {
  return [
    'Usage: agent-mcp [--help] [--version]',
    '',
    'Starts the agent-mcp MCP server on stdio (no arguments).',
    '',
    'Options:',
    '  -h, --help       Print this usage and exit',
    '  -v, --version    Print the version and exit',
    '',
    'Configuration is via environment variables / config files, e.g.',
    '  ADHD_AGENT_DATABASE_PATH       operational database (agents.db)',
    '  ADHD_AGENT_REGISTRY_DB_PATH    agent registry database (registry.db)',
    '',
    'Related bins: agent-mcp-install, agent-mcp-tail, agent-mcp-follow',
    '',
  ].join('\n');
}
