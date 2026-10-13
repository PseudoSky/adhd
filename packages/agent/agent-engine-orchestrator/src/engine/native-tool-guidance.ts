import { DEFAULT_SHELL_ALLOW_COMMANDS } from '@adhd/agent-core-native-tooling';
import type { ToolDefinition } from '../providers/types.js';

/** Commands the real mcp-shell-server rejects by default policy even if allowlisted (verified: `default-shell-allowlist.e2e.test.ts` control). */
export const SHELL_UNAVAILABLE_COMMANDS: readonly string[] = Object.freeze([
  'node', 'python3', 'sed', 'sh', 'bash', 'env',
]);

/**
 * R10 W1 — tells the model the same-turn rule it cannot otherwise see: shell calls are ordered barriers
 * (`classifyTool`), so two independent long commands cost the SUM of their durations unless one command overlaps
 * them. The exact text is pinned by `native-tool-guidance.test.ts` and by the per-adapter wire proof in agent-mcp.
 */
const SHELL_ORDERING_SENTENCE =
  'Shell calls in one turn run one after another; to overlap independent long commands use one command that does it ' +
  '(e.g. `make -j2 test lint`) or a tasks_batch.';

/**
 * R7-guidance AC1/AC2 — the shell tool note. The command list is GENERATED from `allow` (default:
 * `DEFAULT_SHELL_ALLOW_COMMANDS`, the one source the shell server is configured from) so the text cannot drift
 * from what the server accepts. Recipes are verified against the real mcp-shell-server
 * (`default-shell-allowlist.e2e.test.ts`, "R7-guidance AC1").
 */
export function shellGuidance(allow: readonly string[] = DEFAULT_SHELL_ALLOW_COMMANDS): string {
  const runners = shellRunners(allow);
  return (
    'Default shell: the command is an argv list, not a shell line; `|` and `>` work only as their own argv items. ' +
    `NOT available (always rejected): ${SHELL_UNAVAILABLE_COMMANDS.join(', ')}; the shell server's default security ` +
    'policy rejects them even though they look installed. Use the fs tools ' +
    '(`fs__edit_file`, `fs__write_file`, `fs__create_directory`) for file edits and reads instead of sed or scripts' +
    (runners.length > 0
      ? `, and run the project's own scripts through an allowed runner (${runners.join(', ')}).`
      : '.') +
    ' ' +
    SHELL_ORDERING_SENTENCE +
    ' ' +
    `Available commands: ${allow.join(' ')}. ` +
    'To read a web page use `curl -fsSL <url>`: it returns RAW HTML, not text. Page title, as argv: ' +
    '["curl","-fsSL",URL,"|","grep","-o","<title>[^<]*"] (append "|","cut","-c8-" to drop the tag). ' +
    'Headings: ["curl","-fsSL",URL,"|","grep","-oE","<h[12][^>]*>[^<]*"] (append "|","head","-n","3" to limit). ' +
    'Save with `-o <file>` and read the file for large pages (a relative `-o` path needs its directory to exist). ' +
    'A grep with no match exits 1 and shows as an error: that means "not found", not a broken command. ' +
    'If the element you were asked for (e.g. an h1) is missing from the page, say it is missing and quote what the page ' +
    'does contain (e.g. its title); never invent content. A failed fetch returns a non-zero `[exit status: N]` line.'
  );
}

/** Package-script runners worth naming in recovery advice; only those actually in the allowlist are ever named. */
const SHELL_RUNNER_CANDIDATES: readonly string[] = ['npm', 'pnpm', 'npx', 'nx', 'make', 'uv'];

function shellRunners(allow: readonly string[]): string[] {
  return SHELL_RUNNER_CANDIDATES.filter((c) => allow.includes(c));
}

/**
 * R10 S4 P4 — the actionable recovery line the host appends to a shell policy rejection. It names the
 * policy, the command that was rejected, what to use instead (the fs tools; the project's own scripts
 * through an allowed runner) and never a repo-specific target such as a particular test script: the
 * runner list is GENERATED from `allow`, so it cannot name a runner the server does not accept.
 *
 * @param command The rejected command name (first argv item), when it could be read from the error.
 * @param allow The shell allowlist the server was configured with (default: the catalog default).
 */
export function shellRejectionNote(
  command: string | undefined,
  allow: readonly string[] = DEFAULT_SHELL_ALLOW_COMMANDS
): string {
  const runners = shellRunners(allow);
  const subject = command ? `"${command}"` : 'That command';
  return (
    `${subject} is rejected by the shell server's default security policy, which never runs ` +
    `${SHELL_UNAVAILABLE_COMMANDS.join(', ')}. Do not retry it. Use the fs tools (fs__edit_file, fs__write_file, ` +
    'fs__create_directory) for file edits and reads' +
    (runners.length > 0
      ? `, or run the project's own scripts through an allowed runner (${runners.join(', ')}).`
      : '.')
  );
}

/** R10 S4 P3 — line-ending note for the fs read tools (true whether or not carriage returns are shown). */
const LINE_ENDING_READ_NOTE =
  'Line endings are reported as stored in the file. Edits match CRLF and LF alike, so do not probe for or add `\\r` yourself.';

/**
 * R5-WEB-SIMPLE AC4 — short, plain constraint notes appended to the adopted builtin servers' own
 * tool descriptions so a model adapts instead of failing. Keyed by the ADVERTISED name
 * (`<server>__<tool>`; the builtin servers are named `shell` and `fs`).
 */
export const NATIVE_TOOL_GUIDANCE: Readonly<Record<string, string>> = Object.freeze({
  shell__shell_execute: shellGuidance(),
  fs__write_file:
    'Does NOT create missing parent directories: call `fs__create_directory` (or shell `mkdir`) for the ' +
    'parent first. A successful write needs no read-back to verify it.',
  fs__edit_file:
    'Line endings: `oldText` matches CRLF and LF files alike and the file keeps its original line endings; ' +
    'do not probe for or write `\\r` yourself. A successful edit needs no read-back to verify it.',
  fs__read_text_file: LINE_ENDING_READ_NOTE,
  fs__read_multiple_files: LINE_ENDING_READ_NOTE,
});

/** Return `tools` with {@link NATIVE_TOOL_GUIDANCE} appended to matching descriptions. Pure; inputs untouched. */
export function withNativeToolGuidance(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.map((tool) => {
    const note = NATIVE_TOOL_GUIDANCE[tool.name];
    if (!note) return tool;
    const base = tool.description?.trim() ?? '';
    return { ...tool, description: base ? `${base}\n\n${note}` : note };
  });
}
