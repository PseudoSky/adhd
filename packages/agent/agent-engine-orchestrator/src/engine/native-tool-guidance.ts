import type { McpServerConfig } from '@adhd/agent-base-types';
import {
  DEFAULT_SHELL_ALLOW_COMMANDS,
  EXIT_SHIM_ORIG_PATH_ENV,
  SHELL_SERVER,
  resolveFsServerLaunch,
} from '@adhd/agent-core-native-tooling';
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
 * What the shell guidance may truthfully promise for ONE effective shell server (cafe9a17 AC1). The text is
 * generated from these facts, never from the catalog defaults alone: an agent that overrides `allowCommands`,
 * a custom shell server, or a host that runs without the exit-status shim must not be told about commands or
 * trailers the server will not honour.
 */
export interface IShellGuidanceFacts {
  /** The effective `shell` server is the adopted catalog server (`mcp-shell-server`, also under the `srt` wrapper). */
  catalog: boolean;
  /** The commands the server was configured to allow by name (`ALLOW_COMMANDS`); empty when unknown or unset. */
  allow: readonly string[];
  /** The server also allows commands by regex (`ALLOW_PATTERNS`), so `allow` is not the whole set. */
  hasPatterns: boolean;
  /** The exit-status launcher is active, so a non-zero exit returns a `[exit status: N]` line. */
  exitStatus: boolean;
}

/** Everything the notes in {@link NATIVE_TOOL_GUIDANCE} depend on. Derive it with {@link nativeGuidanceContextOf}. */
export interface INativeGuidanceContext {
  shell: IShellGuidanceFacts;
  /** The effective `fs` server is the adopted catalog server (the same predicate as the host note hook). */
  fsCatalog: boolean;
}

/** The context when the effective server config cannot be determined: fail closed, promise nothing server-specific. */
export const UNKNOWN_GUIDANCE_CONTEXT: INativeGuidanceContext = Object.freeze({
  shell: Object.freeze({ catalog: false, allow: Object.freeze([]), hasPatterns: false, exitStatus: false }),
  fsCatalog: false,
});

/** R7-guidance AC1/AC2 — the shell facts of a default catalog shell with the exit shim (the reference text). */
const CATALOG_DEFAULT_CONTEXT: INativeGuidanceContext = Object.freeze({
  shell: Object.freeze({ catalog: true, allow: DEFAULT_SHELL_ALLOW_COMMANDS, hasPatterns: false, exitStatus: true }),
  fsCatalog: true,
});

/**
 * R7-guidance AC1/AC2 — the shell tool note. The command list is GENERATED from `allow` (default:
 * `DEFAULT_SHELL_ALLOW_COMMANDS`, the one source the shell server is configured from) so the text cannot drift
 * from what the server accepts. Recipes are verified against the real mcp-shell-server
 * (`default-shell-allowlist.e2e.test.ts`, "R7-guidance AC1"). A recipe is emitted only when every command it
 * pipes through is allowed, and the `[exit status: N]` promise only when the exit shim is active (cafe9a17 AC1).
 *
 * @param allow The shell allowlist the server was configured with (default: the catalog default).
 * @param facts Further facts about the effective server; the default is a catalog shell with the exit shim.
 */
export function shellGuidance(
  allow: readonly string[] = DEFAULT_SHELL_ALLOW_COMMANDS,
  facts: Pick<IShellGuidanceFacts, 'hasPatterns' | 'exitStatus'> = { hasPatterns: false, exitStatus: true }
): string {
  const runners = shellRunners(allow);
  const has = (c: string): boolean => allow.includes(c);
  const sentences: string[] = [
    'Default shell: the command is an argv list, not a shell line; `|` and `>` work only as their own argv items. ' +
      `NOT available (always rejected): ${SHELL_UNAVAILABLE_COMMANDS.join(', ')}; the shell server's default security ` +
      'policy rejects them even though they look installed. Use the fs tools ' +
      '(`fs__edit_file`, `fs__write_file`, `fs__create_directory`) for file edits and reads instead of sed or scripts' +
      (runners.length > 0
        ? `, and run the project's own scripts through an allowed runner (${runners.join(', ')}).`
        : '.'),
    SHELL_ORDERING_SENTENCE,
  ];
  if (allow.length > 0) {
    sentences.push(
      `Available commands: ${allow.join(' ')}.` +
        (facts.hasPatterns ? ' Commands matching the configured allow patterns are also accepted.' : '')
    );
  }
  if (has('curl')) {
    sentences.push('To read a web page use `curl -fsSL <url>`: it returns RAW HTML, not text.');
    if (has('grep')) {
      sentences.push(
        'Page title, as argv: ["curl","-fsSL",URL,"|","grep","-o","<title>[^<]*"]' +
          (has('cut') ? ' (append "|","cut","-c8-" to drop the tag).' : '.'),
        'Headings: ["curl","-fsSL",URL,"|","grep","-oE","<h[12][^>]*>[^<]*"]' +
          (has('head') ? ' (append "|","head","-n","3" to limit).' : '.')
      );
    }
    sentences.push('Save with `-o <file>` and read the file for large pages (a relative `-o` path needs its directory to exist).');
    if (has('grep')) {
      sentences.push('A grep with no match exits 1 and shows as an error: that means "not found", not a broken command.');
    }
    sentences.push(
      'If the element you were asked for (e.g. an h1) is missing from the page, say it is missing and quote what the page ' +
        'does contain (e.g. its title); never invent content.'
    );
    if (facts.exitStatus) sentences.push('A failed fetch returns a non-zero `[exit status: N]` line.');
  } else if (facts.exitStatus) {
    sentences.push('A command that exits non-zero returns a `[exit status: N]` line.');
  }
  return sentences.join(' ');
}

/** Package-script runners worth naming in recovery advice; only those actually in the allowlist are ever named. */
const SHELL_RUNNER_CANDIDATES: readonly string[] = ['npm', 'pnpm', 'npx', 'nx', 'make', 'uv'];

function shellRunners(allow: readonly string[]): string[] {
  return SHELL_RUNNER_CANDIDATES.filter((c) => allow.includes(c));
}

/** True when `v` is an explicit allowlist (an array of command names) rather than a resolved `mcpServers` map. */
function isAllowList(v: unknown): v is readonly string[] {
  return Array.isArray(v);
}

/**
 * R10 S4 P4 — the actionable recovery line the host appends to a shell policy rejection. It names the
 * policy, the command that was rejected, what to use instead (the fs tools; the project's own scripts
 * through an allowed runner) and never a repo-specific target such as a particular test script.
 *
 * The runner list is GENERATED from the commands the EFFECTIVE shell server allows, never from the catalog
 * defaults (cafe9a17 AC1): an agent that overrides `allowCommands` must not be pointed at a runner its server
 * refuses. `effective` is either that allowlist, or the agent's RESOLVED `mcpServers` map, from which the
 * allowlist is derived by {@link nativeGuidanceContextOf} (the same derivation that shapes the tool guidance).
 * It FAILS CLOSED: with no `effective`, a custom (non-catalog) shell server, or a catalog shell whose
 * allowlist cannot be read from its config, no runner is named. Runners allowed only by `ALLOW_PATTERNS` are
 * not named either, since a pattern says nothing certain about a given runner.
 *
 * @param command The rejected command name (first argv item), when it could be read from the error.
 * @param effective The shell allowlist the server was configured with, or the agent's resolved `mcpServers`.
 */
export function shellRejectionNote(
  command: string | undefined,
  effective?: readonly string[] | Readonly<Record<string, McpServerConfig>>
): string {
  const allow = isAllowList(effective) ? effective : nativeGuidanceContextOf(effective).shell.allow;
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

/** The notes for one effective server configuration. Pure. */
function guidanceNotes(ctx: INativeGuidanceContext): Readonly<Record<string, string>> {
  const notes: Record<string, string> = {
    // The ordering rule is engine semantics (`classifyTool`) and holds for any shell server; everything
    // server-specific is added only for the adopted catalog server.
    shell__shell_execute: ctx.shell.catalog ? shellGuidance(ctx.shell.allow, ctx.shell) : SHELL_ORDERING_SENTENCE,
  };
  if (ctx.fsCatalog) {
    notes['fs__write_file'] =
      'Does NOT create missing parent directories: call `fs__create_directory` (or shell `mkdir`) for the ' +
      'parent first. A successful write needs no read-back to verify it.';
    notes['fs__edit_file'] =
      'Line endings: `oldText` matches CRLF and LF files alike and the file keeps its original line endings; ' +
      'do not probe for or write `\\r` yourself. A successful edit needs no read-back to verify it.';
    notes['fs__read_text_file'] = LINE_ENDING_READ_NOTE;
    notes['fs__read_multiple_files'] = LINE_ENDING_READ_NOTE;
  }
  return Object.freeze(notes);
}

/**
 * R5-WEB-SIMPLE AC4 — short, plain constraint notes appended to the adopted builtin servers' own
 * tool descriptions so a model adapts instead of failing. Keyed by the ADVERTISED name
 * (`<server>__<tool>`; the builtin servers are named `shell` and `fs`). This is the REFERENCE set for a default
 * catalog configuration with the exit shim; what a task actually receives is {@link withNativeToolGuidance}'s
 * context-derived set.
 */
export const NATIVE_TOOL_GUIDANCE: Readonly<Record<string, string>> = guidanceNotes(CATALOG_DEFAULT_CONTEXT);

let pinnedFsBin: string | null | undefined;

/** The pinned catalog fs server bin path, or `null` when it cannot be resolved (then no fs note is ever added). */
function catalogFsBin(): string | null {
  if (pinnedFsBin === undefined) {
    try {
      pinnedFsBin = resolveFsServerLaunch().args[0] ?? null;
    } catch {
      pinnedFsBin = null;
    }
  }
  return pinnedFsBin;
}

function stdioArgv(cfg: McpServerConfig | undefined): string[] | undefined {
  return cfg?.transport === 'stdio' ? [cfg.command, ...(cfg.args ?? [])] : undefined;
}

function csv(value: string | undefined): string[] {
  return (value ?? '').split(',').map((v) => v.trim()).filter((v) => v.length > 0);
}

/**
 * Derive the guidance facts from the agent's RESOLVED `mcpServers` (the same map the host note hook reads;
 * `isCatalogFsServer` in agent-mcp is the fs twin of the check here). Fails closed: anything that cannot be
 * established from the config yields {@link UNKNOWN_GUIDANCE_CONTEXT}'s answer for that server.
 */
export function nativeGuidanceContextOf(
  mcpServers: Readonly<Record<string, McpServerConfig>> | undefined
): INativeGuidanceContext {
  try {
    const shellCfg = mcpServers?.['shell'];
    const shellArgv = stdioArgv(shellCfg);
    const catalogShell = shellArgv !== undefined && SHELL_SERVER.args.every((a) => shellArgv.includes(a));
    const env = shellCfg?.transport === 'stdio' ? shellCfg.env : undefined;
    const bin = catalogFsBin();
    const fsArgv = stdioArgv(mcpServers?.['fs']);
    return {
      shell: catalogShell
        ? {
            catalog: true,
            allow: csv(env?.[SHELL_SERVER.envKeys.allowCommands]),
            hasPatterns: csv(env?.[SHELL_SERVER.envKeys.allowPatterns]).length > 0,
            exitStatus: (env?.[EXIT_SHIM_ORIG_PATH_ENV] ?? '').length > 0,
          }
        : UNKNOWN_GUIDANCE_CONTEXT.shell,
      fsCatalog: bin !== null && (fsArgv?.includes(bin) ?? false),
    };
  } catch {
    return UNKNOWN_GUIDANCE_CONTEXT;
  }
}

/**
 * Return `tools` with the guidance for `ctx` appended to matching descriptions. Pure; inputs untouched.
 * Without a context (the effective server config is unknown) only server-independent guidance is added.
 */
export function withNativeToolGuidance(
  tools: ToolDefinition[],
  ctx: INativeGuidanceContext = UNKNOWN_GUIDANCE_CONTEXT
): ToolDefinition[] {
  const notes = guidanceNotes(ctx);
  return tools.map((tool) => {
    const note = notes[tool.name];
    if (!note) return tool;
    const base = tool.description?.trim() ?? '';
    return { ...tool, description: base ? `${base}\n\n${note}` : note };
  });
}
