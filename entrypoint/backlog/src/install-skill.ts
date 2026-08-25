/**
 * install-skill.ts — `backlog install-skill` (MIGRATION.md §4.2). A PURE
 * filesystem operation: copy the packaged `skill/SKILL.md` (this package's
 * OWN single source of truth for the skill's content, versioned in lockstep
 * with `client.ts` in the exact same publish — see `package.json`'s `files`
 * array) into the per-host skill directory table already surveyed in this
 * repo's own `docs/environment/adoption-survey/sox-ecosystem/sox-host-
 * registry.md`. Deliberately NOT an apigen-dispatched `client.ts` export —
 * it needs no store/ctx at all, so `cli.ts` special-cases it before ever
 * building the apigen package, the same way `cliPlugin.run()` itself
 * special-cases `--help`/`-h` before consulting its own route table.
 *
 * No new external dependency (`soxe` et al.) — MIGRATION.md §4.2's explicit
 * design decision: a second published package or a hard dependency on an
 * external installer CLI both need human approval this repo has NOT granted
 * (`AGENTS.md`: "You always get human approval before installing external
 * tools"). This is the zero-new-dependency fallback the plan itself
 * recommends.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type SkillHost = 'claude' | 'codex' | 'opencode';
export type SkillScope = 'user' | 'project';

export const ALL_HOSTS: readonly SkillHost[] = ['claude', 'codex', 'opencode'];

/**
 * Per-host skill directory table (verified against `sox-host-registry.md`'s
 * own survey, not guessed): `.claude/skills/` / `~/.claude/skills/` for
 * Claude Code, `.codex/skills/` / `$CODEX_HOME/skills/` (default
 * `~/.codex/skills/`) for Codex, `.opencode/skills/` /
 * `~/.config/opencode/skills/` for OpenCode (OpenCode's user config root is
 * `~/.config/opencode/`, mirroring its own `.opencode/` project-root
 * convention — `sox-host-registry.md` lines 78-81).
 */
const PROJECT_DIR_BY_HOST: Record<SkillHost, string> = { claude: '.claude', codex: '.codex', opencode: '.opencode' };

/** Exported so `install.ts`'s codex MCP-registration path (which needs the
 *  SAME `~/.codex` (or `$CODEX_HOME`) root as the skill installer, but the
 *  file `config.toml` rather than a `skills/` subdirectory) never
 *  re-derives — and risks desyncing from — this resolution rule. */
export function resolveCodexHomeDir(home: string, homeOverride?: string): string {
  // `CODEX_HOME` is only honored for the REAL machine home (never under a
  // test's isolated `homeOverride`, which must be fully self-contained).
  return homeOverride ? join(home, '.codex') : (process.env['CODEX_HOME'] ?? join(home, '.codex'));
}

export function hostSkillsDir(host: SkillHost, scope: SkillScope, cwd: string, homeOverride?: string): string {
  if (scope === 'project') {
    return join(cwd, PROJECT_DIR_BY_HOST[host], 'skills');
  }
  const home = homeOverride ?? homedir();
  if (host === 'claude') return join(home, '.claude', 'skills');
  if (host === 'codex') {
    return join(resolveCodexHomeDir(home, homeOverride), 'skills');
  }
  return join(home, '.config', 'opencode', 'skills');
}

/**
 * BUG-013 (FIX B): resolves the packaged `skill/SKILL.md` across BOTH real
 * layouts this file ever runs from — same layout-probing shape as
 * `server.ts`'s `backlogDistDir()`, and for the identical underlying reason.
 *
 * `@adhd/nx-build`'s `dist-manifest`/`publish` executors run
 * `npm publish <distDir>` — the CONTENTS of `{projectRoot}/dist` are packed
 * as the package ROOT, not as a `dist/` subdirectory. So in a REAL installed
 * package, `install-skill.js` and `skill/SKILL.md` are SIBLINGS at the
 * package root (`node_modules/@adhd/backlog/install-skill.js`,
 * `.../skill/SKILL.md`) — there is no `dist/` folder at all, and `join(here,
 * '..', 'skill', 'SKILL.md')` escapes one level too far past the package
 * root into a nonexistent `node_modules/@adhd/skill/SKILL.md` (reproduced
 * live: `install-skill` exited 1 with exactly that ENOENT path). The
 * project.json `build.assets` entry (BUG-013 FIX A) also copies
 * `skill/**` to `dist/skill/**`, so the LOCAL monorepo dev-built layout
 * (`dist/install-skill.js` next to `dist/skill/SKILL.md`) has the identical
 * "siblings at this file's own directory" shape as the published layout.
 *
 * Only vitest running directly against `src/install-skill.ts` (never built)
 * needs the OLD `../skill/SKILL.md` shape (`src/` -> `skill/` is a sibling
 * of `src/`'s PARENT, the package root) — so that remains the fallback,
 * tried only once the sibling-of-`here` path has been confirmed absent.
 */
function packagedSkillMdPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const sibling = join(here, 'skill', 'SKILL.md');
  if (existsSync(sibling)) return sibling;
  return join(here, '..', 'skill', 'SKILL.md');
}

/**
 * A USAGE error — the caller typed something wrong — as opposed to a genuine
 * internal fault. BUG-BACKLOG-INSTALLSKILL-UX-001: `install-skill`/`install`
 * are special-cased in `cli.ts` BEFORE the apigen command table is built, so
 * they never get the outcome-envelope error handling the six mounted verbs
 * get. Their argument errors used to propagate to the bin entry-guard, which
 * prints `err.stack` — burying a perfectly good one-line message under ten
 * frames of minified dist. Distinguishing usage errors by TYPE (rather than
 * catching everything) keeps real faults loud and stack-bearing while giving
 * typos the short, actionable output the mounted verbs already produce.
 */
export class BacklogUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BacklogUsageError';
  }
}

/**
 * Prints a usage error the SAME way the apigen-mounted verbs and
 * `runMigrationPhaseCommand` already do — a machine-readable
 * `{"code":"invalid_argument","message":…}` as the last stderr line, exit
 * code 2 (`CLI_EXIT_CODE['invalid_argument']`) — plus the human-readable
 * usage text, so a reader gets both the parse and the fix in one screen.
 */
export function failUsage(err: BacklogUsageError, helpText: string): void {
  console.error(JSON.stringify({ code: 'invalid_argument', message: err.message }));
  console.error('');
  console.error(helpText);
  process.exitCode = 2;
}

export const INSTALL_SKILL_HELP_TEXT = `backlog install-skill [--host claude|codex|opencode|all] [--scope user|project]

Copies the packaged backlog SKILL.md into an agent host's skills directory.
(\`backlog install\` is the richer successor — it also registers the MCP server.)

  --host <name>   claude | codex | opencode | all (default: all)
  --scope <name>  user | project (default: user)
                  "user" is the machine-wide install (~/.claude/skills/...);
                  there is no "global" — that is spelled "user" here.

Examples:
  backlog install-skill
  backlog install-skill --host opencode --scope user
  backlog install-skill --host claude --scope project
`;

interface ParsedInstallSkillArgs {
  hosts: SkillHost[];
  scope: SkillScope;
}

function parseArgs(argv: string[]): ParsedInstallSkillArgs {
  let hostArg = 'all';
  let scope: SkillScope = 'user';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--host') hostArg = argv[++i] ?? 'all';
    else if (arg === '--scope') scope = (argv[++i] as SkillScope) ?? 'user';
    else throw new BacklogUsageError(`backlog install-skill: unknown argument "${arg}" (expected --host/--scope)`);
  }
  if (scope !== 'user' && scope !== 'project') {
    // "global" is the single most common wrong guess (it is what every other
    // install tool calls this), so name the correct spelling rather than only
    // listing the valid set. Deliberately NOT silently aliased to "user":
    // silent coercion of a caller's stated intent is the defect shape this
    // codebase treats as a bug (see BUG-BACKLOG-UPDATE-ITEM-SILENT-DISCARD-001).
    const hint = scope === 'global' ? ' — the machine-wide scope is spelled "user"' : '';
    throw new BacklogUsageError(
      `backlog install-skill: --scope must be "user" or "project", got "${scope}"${hint}`
    );
  }
  const hosts = hostArg === 'all' ? [...ALL_HOSTS] : [hostArg as SkillHost];
  for (const h of hosts) {
    if (!ALL_HOSTS.includes(h)) {
      throw new BacklogUsageError(`backlog install-skill: --host must be one of ${ALL_HOSTS.join('|')}|all, got "${hostArg}"`);
    }
  }
  return { hosts, scope };
}

export interface InstallSkillResult {
  host: SkillHost;
  scope: SkillScope;
  path: string;
}

/**
 * Copies the packaged `SKILL.md` into every requested host's skill
 * directory, under a `backlog/` subdirectory (matching the `memory-usage`
 * precedent's per-skill-named-directory shape). Also drops a thin
 * `extension.json` (`{ name, version, type: "skill", entrypoint: "SKILL.md"
 * }`) alongside it, matching that same precedent's shape for hosts that
 * consume it — additive, never required for Claude Code's own
 * description-based auto-surfacing to work.
 *
 * `homeOverride` is a TEST-ISOLATION ESCAPE HATCH ONLY (mirrors
 * `BuildBacklogEnvOptions.adhdRoot`/`BacklogCtx.adhdRoot` elsewhere in this
 * package) — never passed by `runInstallSkillCommand`/the real CLI, which
 * always resolves the genuine machine home directory for `--scope user`.
 */
export function installSkill(argv: string[], cwd: string = process.cwd(), homeOverride?: string): InstallSkillResult[] {
  const { hosts, scope } = parseArgs(argv);
  return installSkillToHosts(hosts, scope, cwd, homeOverride);
}

/**
 * The actual filesystem work behind `installSkill` — pulled out so
 * `install.ts`'s richer `backlog install` parser (which additionally
 * accepts `--skill-only`/`--mcp-only`) can drive it directly with an
 * already-parsed `{ hosts, scope }` instead of re-parsing (and risking a
 * DIFFERENT `--host`/`--scope` grammar from) a raw argv a second time.
 */
export function installSkillToHosts(hosts: SkillHost[], scope: SkillScope, cwd: string, homeOverride?: string): InstallSkillResult[] {
  const skillMdSource = packagedSkillMdPath();
  if (!existsSync(skillMdSource)) {
    throw new Error(`backlog install-skill: packaged skill file not found at ${skillMdSource} — was @adhd/backlog built/installed correctly?`);
  }
  const skillMdContent = readFileSync(skillMdSource, 'utf8');

  // BUG-013 (FIX B) applies identically here: in a PUBLISHED install,
  // `package.json` is a SIBLING of this file's own directory (both at the
  // package root, `npm publish <distDir>` shape); only in the local
  // monorepo dev-built layout is it one level up from `dist/`. Same
  // sibling-first probe as `packagedSkillMdPath()`.
  const hereForPkg = dirname(fileURLToPath(import.meta.url));
  const siblingPkgJson = join(hereForPkg, 'package.json');
  const pkgJsonPath = existsSync(siblingPkgJson) ? siblingPkgJson : join(hereForPkg, '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { name: string; version: string };

  const results: InstallSkillResult[] = [];
  for (const host of hosts) {
    const targetDir = join(hostSkillsDir(host, scope, cwd, homeOverride), 'backlog');
    mkdirSync(targetDir, { recursive: true });
    const targetSkillMd = join(targetDir, 'SKILL.md');
    writeFileSync(targetSkillMd, skillMdContent, 'utf8');
    writeFileSync(
      join(targetDir, 'extension.json'),
      JSON.stringify({ name: pkg.name, version: pkg.version, type: 'skill', entrypoint: 'SKILL.md' }, null, 2) + '\n',
      'utf8',
    );
    results.push({ host, scope, path: targetSkillMd });
  }
  return results;
}

/** CLI entry — parses argv, runs the install, prints the same
 *  `console.log(JSON.stringify(...))` shape every other CLI command uses
 *  (BUG-APIGEN-015 parity), so scripting `backlog install-skill` composes
 *  with the rest of the CLI's output convention despite bypassing apigen
 *  dispatch entirely. */
export async function runInstallSkillCommand(argv: string[]): Promise<void> {
  // `--help`/`-h` ANYWHERE in argv is a usage request, never an unknown
  // argument — matching `runMigrationPhaseCommand`'s `rest.includes('--help')`
  // and cli-output's own pre-dispatch check. Previously `--help` fell through
  // to parseArgs and came back as `unknown argument "--help"` on a stack
  // trace, which is the exact opposite of what the reader asked for.
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(INSTALL_SKILL_HELP_TEXT);
    return;
  }
  let results: InstallSkillResult[];
  try {
    results = installSkill(argv);
  } catch (err) {
    if (err instanceof BacklogUsageError) return failUsage(err, INSTALL_SKILL_HELP_TEXT);
    throw err;
  }
  console.log(JSON.stringify({ installed: results }));
}
