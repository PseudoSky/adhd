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

const ALL_HOSTS: readonly SkillHost[] = ['claude', 'codex', 'opencode'];

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

function hostSkillsDir(host: SkillHost, scope: SkillScope, cwd: string, homeOverride?: string): string {
  if (scope === 'project') {
    return join(cwd, PROJECT_DIR_BY_HOST[host], 'skills');
  }
  const home = homeOverride ?? homedir();
  if (host === 'claude') return join(home, '.claude', 'skills');
  if (host === 'codex') {
    // `CODEX_HOME` is only honored for the REAL machine home (never under a
    // test's isolated `homeOverride`, which must be fully self-contained).
    const codexHome = homeOverride ? join(home, '.codex') : (process.env['CODEX_HOME'] ?? join(home, '.codex'));
    return join(codexHome, 'skills');
  }
  return join(home, '.config', 'opencode', 'skills');
}

function packagedSkillMdPath(): string {
  // This file lives at `dist/install-skill.{js,mjs}` (or `src/` pre-build);
  // the packaged `skill/` directory is always a SIBLING of `dist/` — both in
  // the local monorepo layout AND in a published/installed npm package
  // (package.json's `files: ["dist","CHANGELOG.md","skill"]` publishes them
  // as siblings at the package root).
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', 'skill', 'SKILL.md');
}

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
    else throw new Error(`backlog install-skill: unknown argument "${arg}" (expected --host/--scope)`);
  }
  if (scope !== 'user' && scope !== 'project') {
    throw new Error(`backlog install-skill: --scope must be "user" or "project", got "${scope}"`);
  }
  const hosts = hostArg === 'all' ? [...ALL_HOSTS] : [hostArg as SkillHost];
  for (const h of hosts) {
    if (!ALL_HOSTS.includes(h)) {
      throw new Error(`backlog install-skill: --host must be one of ${ALL_HOSTS.join('|')}|all, got "${hostArg}"`);
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
  const skillMdSource = packagedSkillMdPath();
  if (!existsSync(skillMdSource)) {
    throw new Error(`backlog install-skill: packaged skill file not found at ${skillMdSource} — was @adhd/backlog built/installed correctly?`);
  }
  const skillMdContent = readFileSync(skillMdSource, 'utf8');

  // package.json is a sibling of dist/ in both the monorepo and the
  // published layout, same reasoning as packagedSkillMdPath().
  const pkgJsonPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
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
  const results = installSkill(argv);
  console.log(JSON.stringify({ installed: results }));
}
