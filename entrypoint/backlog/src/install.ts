/**
 * install.ts — `backlog install` (BUG-013 feature half). Supersedes
 * `install-skill` as the primary onboarding command: by default it BOTH
 * drops the packaged skill (`installSkillToHosts`, `install-skill.ts`) AND
 * registers the `backlog` MCP server into the selected host config(s) at the
 * selected scope, so `npx @adhd/backlog@latest install` alone is enough to
 * get an agent host talking to this server — no manual `.mcp.json`/
 * `opencode.json` editing required.
 *
 * `install-skill` remains a working back-compat alias (`cli.ts` still routes
 * it to `install-skill.ts`'s own `runInstallSkillCommand`, preserving its
 * exact historical `{ installed: [...] }` stdout JSON shape and argv
 * grammar) that behaves exactly like `install --skill-only`: both paths
 * ultimately call the SAME `installSkillToHosts()` (`install-skill.ts`)
 * with the same `{ hosts, scope }`, so no existing consumer of `backlog
 * install-skill` sees any behavior change — it just no longer duplicates
 * the skill-copy logic this module also needs.
 *
 * No new external dependency: the two MUST-HAVE hosts (Claude Code,
 * OpenCode) both use plain JSON, handled with `JSON.parse`/
 * `JSON.stringify` — nothing to add. Codex uses TOML; no `toml` package is a
 * declared dependency of ANY package in this workspace today (confirmed by
 * grepping every `package.json`), and this repo's rule (AGENTS.md: "You
 * always get human approval before installing external tools") means one
 * can't be added here without that approval. Because the TOML edit needed is
 * narrow and fully self-contained — replace-or-append exactly ONE known
 * table, `[mcp_servers.backlog]`, whose own contents this file fully
 * controls — a small hand-rolled line-oriented editor (`upsertTomlTable`
 * below) is safe here in a way a general TOML *parser* substitute would not
 * be, and needs no dependency at all.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ALL_HOSTS,
  installSkillToHosts,
  resolveCodexHomeDir,
  type InstallSkillResult,
  type SkillHost,
  type SkillScope,
} from './install-skill.js';

export type McpHost = SkillHost;
export type McpScope = SkillScope;

/** The one, portable invocation every host's registration entry points at —
 *  `npx -y @adhd/backlog@latest serve --transport mcp` — so a written config
 *  works on any machine with `npx` and network access, never tied to this
 *  monorepo's own local `dist/index.js` path (that local-path form is what
 *  THIS repo's own checked-in `.mcp.json` uses for its own dev loop, which is
 *  deliberately NOT what a published `install` command should write for a
 *  third-party consumer). */
export const BACKLOG_MCP_NPX_ARGS: readonly string[] = ['-y', '@adhd/backlog@latest', 'serve', '--transport', 'mcp'];

export type McpInstallStatus = 'written' | 'manual';

export interface McpInstallResult {
  host: McpHost;
  scope: McpScope;
  configPath: string;
  status: McpInstallStatus;
  note?: string;
}

function readJsonFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8').trim();
  if (raw === '') return {};
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`backlog install: expected ${path} to contain a JSON object, got ${Array.isArray(parsed) ? 'an array' : typeof parsed}`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Deep-merges ONE entry (`entryKey` -> `entryValue`) into the object living
 * at `containerKey` inside the JSON file at `path`, preserving every other
 * top-level key in the file AND every other entry already inside the
 * container object. Creates the file (and the container object) if either
 * is absent. Re-serializes with a stable 2-space indent (matching every
 * hand-authored config this repo already ships — `.mcp.json`,
 * `opencode.json`, `~/.claude.json`) and a trailing newline.
 */
function upsertJsonMcpEntry(path: string, containerKey: string, entryKey: string, entryValue: unknown): void {
  const doc = readJsonFile(path);
  const containerRaw = doc[containerKey];
  const container: Record<string, unknown> =
    typeof containerRaw === 'object' && containerRaw !== null && !Array.isArray(containerRaw)
      ? (containerRaw as Record<string, unknown>)
      : {};
  container[entryKey] = entryValue;
  doc[containerKey] = container;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n', 'utf8');
}

function claudeConfigPath(scope: McpScope, cwd: string, homeOverride?: string): string {
  if (scope === 'project') return join(cwd, '.mcp.json');
  const home = homeOverride ?? homedir();
  return join(home, '.claude.json');
}

function opencodeConfigPath(scope: McpScope, cwd: string, homeOverride?: string): string {
  if (scope === 'project') return join(cwd, 'opencode.json');
  const home = homeOverride ?? homedir();
  return join(home, '.config', 'opencode', 'opencode.json');
}

function codexConfigPath(scope: McpScope, cwd: string, homeOverride?: string): string {
  if (scope === 'project') return join(cwd, '.codex', 'config.toml');
  const home = homeOverride ?? homedir();
  return join(resolveCodexHomeDir(home, homeOverride), 'config.toml');
}

/**
 * Replaces (or appends) exactly one `[tableHeader]` table in a TOML
 * document's text, leaving every other line — including every OTHER
 * table — byte-for-byte untouched. Scoped deliberately narrow (see this
 * file's header doc): it finds the line matching `[tableHeader]` exactly,
 * then treats everything up to (but not including) the next line that
 * starts a new table (`[...`) — or end of file — as "this table's body",
 * and swaps that whole span for `newBodyLines`. If the table doesn't exist
 * yet, the new table is appended at the end (separated by a single blank
 * line from any existing content).
 *
 * This is intentionally NOT a general TOML parser/editor — it only
 * recognizes bracketed table headers on their own line, which is exactly
 * (and only) the shape this file ever writes or looks for.
 */
export function upsertTomlTable(text: string, tableHeader: string, newBodyLines: readonly string[]): string {
  const headerLine = `[${tableHeader}]`;
  const lines = text.length > 0 ? text.split('\n') : [];
  const headerIndex = lines.findIndex((line) => line.trim() === headerLine);
  const newBlock = [headerLine, ...newBodyLines];

  if (headerIndex === -1) {
    if (lines.length === 0 || lines.every((line) => line.trim() === '')) {
      return newBlock.join('\n') + '\n';
    }
    // Trim any trailing blank lines before appending, then separate with
    // exactly one blank line — keeps re-running this idempotent (never
    // accumulates extra blank lines on repeat appends elsewhere).
    while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') lines.pop();
    return [...lines, '', ...newBlock].join('\n') + '\n';
  }

  let endIndex = headerIndex + 1;
  while (endIndex < lines.length && !(lines[endIndex]?.trim().startsWith('[') ?? true)) endIndex++;
  const result = [...lines.slice(0, headerIndex), ...newBlock, ...lines.slice(endIndex)];
  // Normalize a possible trailing empty entry produced by a trailing
  // newline in the original file, then always end with exactly one.
  while (result.length > 0 && result[result.length - 1] === '') result.pop();
  return result.join('\n') + '\n';
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map((v) => JSON.stringify(v)).join(', ')}]`;
}

function registerMcpClaude(scope: McpScope, cwd: string, homeOverride?: string): McpInstallResult {
  const configPath = claudeConfigPath(scope, cwd, homeOverride);
  upsertJsonMcpEntry(configPath, 'mcpServers', 'backlog', {
    type: 'stdio',
    command: 'npx',
    args: [...BACKLOG_MCP_NPX_ARGS],
  });
  return { host: 'claude', scope, configPath, status: 'written' };
}

function registerMcpOpencode(scope: McpScope, cwd: string, homeOverride?: string): McpInstallResult {
  const configPath = opencodeConfigPath(scope, cwd, homeOverride);
  upsertJsonMcpEntry(configPath, 'mcp', 'backlog', {
    type: 'local',
    command: ['npx', ...BACKLOG_MCP_NPX_ARGS],
  });
  return { host: 'opencode', scope, configPath, status: 'written' };
}

function registerMcpCodex(scope: McpScope, cwd: string, homeOverride?: string): McpInstallResult {
  const configPath = codexConfigPath(scope, cwd, homeOverride);
  const existing = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  const updated = upsertTomlTable(existing, 'mcp_servers.backlog', [
    'command = "npx"',
    `args = ${tomlStringArray(BACKLOG_MCP_NPX_ARGS)}`,
  ]);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, updated, 'utf8');
  return { host: 'codex', scope, configPath, status: 'written' };
}

function registerMcp(host: McpHost, scope: McpScope, cwd: string, homeOverride?: string): McpInstallResult {
  if (host === 'claude') return registerMcpClaude(scope, cwd, homeOverride);
  if (host === 'opencode') return registerMcpOpencode(scope, cwd, homeOverride);
  return registerMcpCodex(scope, cwd, homeOverride);
}

interface ParsedInstallArgs {
  hosts: McpHost[];
  scope: McpScope;
  skillOnly: boolean;
  mcpOnly: boolean;
}

function parseInstallArgs(argv: string[], commandName: string): ParsedInstallArgs {
  let hostArg = 'all';
  let scope: McpScope = 'user';
  let skillOnly = false;
  let mcpOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--host') hostArg = argv[++i] ?? 'all';
    else if (arg === '--scope') scope = (argv[++i] as McpScope) ?? 'user';
    else if (arg === '--skill-only') skillOnly = true;
    else if (arg === '--mcp-only') mcpOnly = true;
    else throw new Error(`backlog ${commandName}: unknown argument "${arg}" (expected --host/--scope/--skill-only/--mcp-only)`);
  }
  if (skillOnly && mcpOnly) {
    throw new Error(`backlog ${commandName}: --skill-only and --mcp-only are mutually exclusive`);
  }
  if (scope !== 'user' && scope !== 'project') {
    throw new Error(`backlog ${commandName}: --scope must be "user" or "project", got "${scope}"`);
  }
  const hosts = hostArg === 'all' ? [...ALL_HOSTS] : [hostArg as McpHost];
  for (const h of hosts) {
    if (!ALL_HOSTS.includes(h)) {
      throw new Error(`backlog ${commandName}: --host must be one of ${ALL_HOSTS.join('|')}|all, got "${hostArg}"`);
    }
  }
  return { hosts, scope, skillOnly, mcpOnly };
}

export const INSTALL_HELP_TEXT = `backlog install [--host claude|opencode|codex|all] [--scope user|project] [--skill-only | --mcp-only]

Installs the backlog skill AND registers the backlog MCP server into an agent
host's config, in one step.

  --host <name>   claude | opencode | codex | all (default: all)
  --scope <name>  user | project (default: user)
  --skill-only    only install the skill — never touch any MCP config
  --mcp-only      only register the MCP server — never touch any skill dir

Examples:
  backlog install
  backlog install --host claude --scope project
  backlog install --mcp-only --host opencode

Back-compat: \`backlog install-skill\` remains available and behaves exactly
like \`backlog install --skill-only\` (original --host/--scope grammar only).
`;

export interface InstallResult {
  skill: InstallSkillResult[];
  mcp: McpInstallResult[];
}

/**
 * Installs the backlog skill and/or registers the `backlog` MCP server into
 * the requested host config(s), per `--host`/`--scope`/`--skill-only`/
 * `--mcp-only`. Both halves are idempotent and non-destructive: re-running
 * overwrites only the `backlog` skill files / the `backlog` MCP entry,
 * never touching anything else already present.
 *
 * `homeOverride` is a TEST-ISOLATION ESCAPE HATCH ONLY, mirroring
 * `installSkill`'s own parameter — never passed by `runInstallCommand`/the
 * real CLI.
 */
export function install(argv: string[], cwd: string = process.cwd(), homeOverride?: string): InstallResult {
  const { hosts, scope, skillOnly, mcpOnly } = parseInstallArgs(argv, 'install');
  const skill = mcpOnly ? [] : installSkillToHosts(hosts, scope, cwd, homeOverride);
  const mcp = skillOnly ? [] : hosts.map((host) => registerMcp(host, scope, cwd, homeOverride));
  return { skill, mcp };
}

/** CLI entry for `backlog install` — same `console.log(JSON.stringify(...))`
 *  output convention as `install-skill`, plus a short human-readable summary
 *  of what was written where (this command's own explicit DoD requirement),
 *  printed to stderr so it never disturbs the machine-readable stdout JSON
 *  a script might parse. */
export async function runInstallCommand(argv: string[]): Promise<void> {
  if (argv[0] === '--help' || argv[0] === '-h') {
    console.log(INSTALL_HELP_TEXT);
    return;
  }
  const result = install(argv);
  for (const s of result.skill) {
    console.error(`[backlog install] skill -> ${s.host} (${s.scope}): ${s.path}`);
  }
  for (const m of result.mcp) {
    const suffix = m.note ? ` — ${m.note}` : '';
    console.error(`[backlog install] mcp   -> ${m.host} (${m.scope}) [${m.status}]: ${m.configPath}${suffix}`);
  }
  console.log(JSON.stringify(result));
}
