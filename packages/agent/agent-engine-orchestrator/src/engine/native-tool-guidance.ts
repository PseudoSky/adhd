import { DEFAULT_SHELL_ALLOW_COMMANDS } from '@adhd/agent-core-native-tooling';
import type { ToolDefinition } from '../providers/types.js';

/** Commands the real mcp-shell-server rejects by default policy even if allowlisted (verified: `default-shell-allowlist.e2e.test.ts` control). */
export const SHELL_UNAVAILABLE_COMMANDS: readonly string[] = Object.freeze([
  'node', 'python3', 'sed', 'sh', 'bash', 'env',
]);

/**
 * R7-guidance AC1/AC2 — the shell tool note. The command list is GENERATED from `allow` (default:
 * `DEFAULT_SHELL_ALLOW_COMMANDS`, the one source the shell server is configured from) so the text cannot drift
 * from what the server accepts. Recipes are verified against the real mcp-shell-server
 * (`default-shell-allowlist.e2e.test.ts`, "R7-guidance AC1").
 */
export function shellGuidance(allow: readonly string[] = DEFAULT_SHELL_ALLOW_COMMANDS): string {
  return (
    'Default shell: the command is an argv list, not a shell line; `|` and `>` work only as their own argv items. ' +
    `Available commands: ${allow.join(' ')}. ` +
    `NOT available (always rejected): ${SHELL_UNAVAILABLE_COMMANDS.join(', ')}; use the fs tools ` +
    '(`fs__edit_file`, `fs__write_file`, `fs__create_directory`) for edits instead of sed or scripts. ' +
    'To read a web page use `curl -fsSL <url>`: it returns RAW HTML, not text. Page title, as argv: ' +
    '["curl","-fsSL",URL,"|","grep","-o","<title>[^<]*"] (append "|","cut","-c8-" to drop the tag). ' +
    'Headings: ["curl","-fsSL",URL,"|","grep","-oE","<h[12][^>]*>[^<]*"] (append "|","head","-n","3" to limit). ' +
    'Save with `-o <file>` and read the file for large pages (a relative `-o` path needs its directory to exist). ' +
    'A grep with no match exits 1 and shows as an error: that means "not found", not a broken command. ' +
    'If the element you were asked for (e.g. an h1) is missing from the page, say it is missing and quote what the page ' +
    'does contain (e.g. its title); never invent content. A failed fetch returns a non-zero `[exit status: N]` line.'
  );
}

/**
 * R5-WEB-SIMPLE AC4 — short, plain constraint notes appended to the adopted builtin servers' own
 * tool descriptions so a model adapts instead of failing. Keyed by the ADVERTISED name
 * (`<server>__<tool>`; the builtin servers are named `shell` and `fs`).
 */
export const NATIVE_TOOL_GUIDANCE: Readonly<Record<string, string>> = Object.freeze({
  shell__shell_execute: shellGuidance(),
  fs__write_file:
    'Does NOT create missing parent directories: call `fs__create_directory` (or shell `mkdir`) for the ' +
    'parent first.',
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
