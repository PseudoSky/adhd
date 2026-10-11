/**
 * `shell-exit-status.ts` — recover a shell command's exit status from the
 * adopted shell server's result (backlog 61358b6f).
 *
 * The unmodified `mcp-shell-server` drops each command's exit status. The
 * `@adhd/agent-core-native-tooling` exit shim appends one line,
 * `[exit status: N]`, to the stderr of a non-zero exit, which the server returns
 * as the LAST text content part. The engine parses it into a structured
 * `exitStatus` for telemetry (`post:tool_call`, `TOOL_RESULT`). It never alters
 * `isError` (a non-zero exit is not a fault: `grep` no-match, `diff`) and never
 * alters the model-visible text.
 *
 * The sentinel is mirrored, not imported: the engine does not depend on
 * native-tooling. `SHELL_EXIT_SENTINEL_RE` there and here are pinned equal by a
 * contract test in agent-mcp (which depends on both).
 */

/** The shell server's single tool name (its `listTools` surface). */
export const SHELL_EXECUTE_TOOL = 'shell_execute';

/** Whole-line trailer at the end of a text part: `[exit status: N]`. */
export const SHELL_EXIT_SENTINEL_RE = /(?:^|\n)\[exit status: (\d{1,3})\]\s*$/;

/**
 * The exit status carried by a successful `shell_execute` result, or `undefined`
 * (any other tool, a non-array result, no trailer). Reads ONLY the last text
 * content part, so a command that merely echoes the sentinel mid-output does
 * not register.
 */
export function parseShellExitStatus(tool: string, result: unknown): number | undefined {
  if (tool !== SHELL_EXECUTE_TOOL) return undefined;
  let last: string | undefined;
  if (typeof result === 'string') {
    last = result;
  } else if (Array.isArray(result)) {
    for (let i = result.length - 1; i >= 0; i--) {
      const part = result[i] as { type?: unknown; text?: unknown } | null;
      if (part?.type === 'text' && typeof part.text === 'string') {
        last = part.text;
        break;
      }
    }
  }
  if (last === undefined) return undefined;
  const m = SHELL_EXIT_SENTINEL_RE.exec(last);
  return m ? Number(m[1]) : undefined;
}
