/**
 * P4b: model-facing text for a shell allowlist denial. The shell server only says
 * `Command not allowed: <cmd>`; the model then guesses at other commands (or at pipes and
 * redirects) turn after turn. This appends the allowed commands and the argv-only rule.
 * It never changes allow/deny behaviour and adds no default allowlist (ADR-0008 D5).
 */

/** Max allowed commands listed before the list is elided (keeps the result small). */
export const MAX_LISTED_ALLOWED_COMMANDS = 50;

/**
 * Append allowlist guidance to a denial message.
 *
 * @param message - the original denial text (contains `Command not allowed:`).
 * @param allowCommands - the agent's configured allowed shell commands, if known.
 * @returns the message unchanged when no (non-empty) allowlist is known, else the message
 * followed by the allowed commands and a statement that pipes, redirects and shell operators
 * are not supported.
 */
export function augmentAllowlistDenial(
  message: string,
  allowCommands: readonly string[] | undefined
): string {
  const allowed = [...new Set((allowCommands ?? []).map((c) => c.trim()).filter((c) => c.length > 0))];
  if (allowed.length === 0) return message;
  const shown = allowed.slice(0, MAX_LISTED_ALLOWED_COMMANDS);
  const more = allowed.length - shown.length;
  return (
    `${message}\n` +
    `Allowed commands: ${shown.join(', ')}${more > 0 ? `, ... (+${more} more)` : ''}. ` +
    'Pipes, redirects and shell operators (|, >, <, &&, ;) are not supported: ' +
    'run one allowed command per call with plain arguments.'
  );
}
