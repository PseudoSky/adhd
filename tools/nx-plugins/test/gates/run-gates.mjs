#!/usr/bin/env node
/**
 * run-gates — this repository's entry point to the workspace-standards gate engine (595965cc T30).
 *
 * Binds the engine to this repository's command table (`gates.table.json`) and writes the one JSON
 * report to `.nx/test-gates/gate-report.json`. The engine is the harness's, installed with the
 * `workspace-standards` skill; this wrapper only finds it. Resolution order:
 *   1. $WORKSPACE_STANDARDS_ENGINE (a path to engine/cli.mjs);
 *   2. the skill installed for any host: ~/.claude, ~/.config/opencode, ~/.codex.
 * With none found it exits 70 and names every path it looked at; it never guesses.
 *
 * usage: node tools/nx-plugins/test/gates/run-gates.mjs --step <A-H> [--class c] [--rigor r]
 *                                                       [--changed path]... [--table f] [--report f]
 * Exit status is the engine's: the worst selected gate's exit status.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '../../../..');
export const DEFAULT_TABLE = join(here, 'gates.table.json');
export const DEFAULT_REPORT = join(REPO_ROOT, '.nx', 'test-gates', 'gate-report.json');

export function engineCandidates(env = process.env, home = homedir()) {
  const rel = join('skills', 'workspace-standards', 'engine', 'cli.mjs');
  return [
    ...(env.WORKSPACE_STANDARDS_ENGINE ? [env.WORKSPACE_STANDARDS_ENGINE] : []),
    join(home, '.claude', rel),
    join(home, '.config', 'opencode', rel),
    join(home, '.codex', rel),
  ];
}

export function findEngine(env = process.env, home = homedir()) {
  const tried = engineCandidates(env, home);
  return { engine: tried.find((p) => existsSync(p)) ?? null, tried };
}

/** `--flag=value` becomes `--flag value`: the engine reads only the two-token form. */
export function splitEqualsFlags(args) {
  return args.flatMap((a) => {
    const m = /^(--[A-Za-z][\w-]*)=(.*)$/s.exec(a);
    return m ? [m[1], m[2]] : [a];
  });
}

/** The engine argv for `args`, with this repository's table, root and report as defaults. */
export function engineArgv(engine, rawArgs) {
  const args = splitEqualsFlags(rawArgs);
  const has = (flag) => args.some((a) => a === flag || a.startsWith(`${flag}=`));
  return [
    engine,
    'run',
    ...(has('--root') ? [] : ['--root', REPO_ROOT]),
    ...(has('--table') ? [] : ['--table', DEFAULT_TABLE]),
    ...(has('--report') ? [] : ['--report', DEFAULT_REPORT]),
    ...args,
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { engine, tried } = findEngine();
  if (engine === null) {
    process.stderr.write(`run-gates: the workspace-standards engine was not found. Looked at:\n${tried.map((p) => `  ${p}`).join('\n')}\nInstall the skill (soxe install workspace-standards) or set WORKSPACE_STANDARDS_ENGINE.\n`);
    process.exit(70);
  }
  const r = spawnSync(process.execPath, engineArgv(engine, process.argv.slice(2)), { cwd: REPO_ROOT, stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
