/**
 * P4b: model-facing text for a shell allowlist denial. The shell server only says
 * `Command not allowed: <cmd>`; the model then guesses at other commands (or at pipes and
 * redirects) turn after turn. This appends the allowed commands and the argv-only rule.
 * It never changes allow/deny behaviour and adds no default allowlist (ADR-0008 D5).
 */

/** Max allowed commands listed before the list is elided (keeps the result small). */
export const MAX_LISTED_ALLOWED_COMMANDS = 50;

/** The allowlist the shell server was actually started with, read from its resolved env. */
export interface IShellAllowlist {
  commands: string[];
  /** True when the server also has `ALLOW_PATTERNS`, so `commands` is not the complete set. */
  hasPatterns: boolean;
}

/**
 * Read the allowlist from the resolved MCP server config of the server that denied the call.
 * Uses the SAME env keys the native-tooling resolver writes (`ALLOW_COMMANDS`, `ALLOW_PATTERNS`),
 * so the list shown is the one the server enforces; a server without `ALLOW_COMMANDS` yields
 * undefined (no allowlist info: the denial text stays unchanged).
 *
 * @param mcpServers - the resolved definition's `mcpServers` map.
 * @param server - the server key the denied call targeted.
 */
export function shellAllowlistOf(
  mcpServers: Record<string, unknown> | undefined,
  server: string
): IShellAllowlist | undefined {
  const cfg = mcpServers?.[server] as { env?: Record<string, string | undefined> } | undefined;
  const raw = cfg?.env?.['ALLOW_COMMANDS'];
  if (typeof raw !== 'string') return undefined;
  const commands = raw.split(',').map((c) => c.trim()).filter((c) => c.length > 0);
  if (commands.length === 0) return undefined;
  const patterns = cfg?.env?.['ALLOW_PATTERNS'];
  return { commands: [...new Set(commands)], hasPatterns: typeof patterns === 'string' && patterns.trim().length > 0 };
}

/**
 * Append allowlist guidance to a denial message.
 *
 * @param message - the original denial text (contains `Command not allowed:`).
 * @param allowlist - the enforcing server's allowlist, if known.
 * @returns the message unchanged when no allowlist is known, else the message followed by the
 * allowed commands (marked non-exhaustive when patterns also apply) and a statement that pipes,
 * redirects and shell operators are not supported.
 */
export function augmentAllowlistDenial(message: string, allowlist: IShellAllowlist | undefined): string {
  if (!allowlist || allowlist.commands.length === 0) return message;
  const shown = allowlist.commands.slice(0, MAX_LISTED_ALLOWED_COMMANDS);
  const more = allowlist.commands.length - shown.length;
  return (
    `${message}\n` +
    `Allowed commands: ${shown.join(', ')}${more > 0 ? `, ... (+${more} more)` : ''}` +
    `${allowlist.hasPatterns ? ' (plus commands matching the configured allow patterns)' : ''}. ` +
    'Pipes, redirects and shell operators (|, >, <, &&, ;) are not supported: ' +
    'run one allowed command per call with plain arguments.'
  );
}
