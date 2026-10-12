import type { ToolDefinition } from '../providers/types.js';

/**
 * R5-WEB-SIMPLE AC4 — short, plain constraint notes appended to the adopted builtin servers' own
 * tool descriptions so a model adapts instead of failing. Keyed by the ADVERTISED name
 * (`<server>__<tool>`; the builtin servers are named `shell` and `fs`).
 */
export const NATIVE_TOOL_GUIDANCE: Readonly<Record<string, string>> = Object.freeze({
  shell__shell_execute:
    'Default shell limits: argv list; `|` and `>` work only as their own argv items, no sed, ' +
    'python, node, sh, bash or env; available commands include cat ls cp mv mkdir rm touch head tail wc ' +
    'sort uniq tr cut diff awk grep rg echo printf git npm pnpm npx nx make tsc uv and curl. ' +
    'To read a web page use `curl -fsSL <url>` (raw HTML; pipe through `|` `head`/`grep`/`rg` as ' +
    'separate argv items, or save with `-o <file>` and read the file; a relative `-o` path needs its ' +
    'directory to exist). A failed fetch returns a ' +
    'non-zero `[exit status: N]` line.',
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
