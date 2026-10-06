#!/usr/bin/env node
/**
 * check-tree-clean.mjs — CI tree-clean gate (backlog e92e2b92).
 *
 * Exits 1 when `git status --porcelain` is non-empty. Run as the LAST step of a
 * CI job (`nx run @adhd/source:check-tree-clean`): a job whose commands rewrite
 * a tracked file (a regenerated lockfile, a formatter, a codegen step) or leave
 * a stray untracked file has produced output nobody committed, and a green run
 * hides it. Gitignored output (dist/, tmp/, .nx/) never shows in porcelain and
 * is not a violation.
 *
 * Usage: node check-tree-clean.mjs [--cwd <dir>]   (default: the current dir)
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * @param {string} cwd
 * @returns {{ clean: boolean, lines: string[] }}
 */
export function treeStatus(cwd) {
  const res = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git status failed in ${cwd}: ${res.stderr || res.stdout}`);
  const lines = res.stdout.split('\n').filter(Boolean);
  return { clean: lines.length === 0, lines };
}

function main() {
  const i = process.argv.indexOf('--cwd');
  const cwd = i > -1 ? process.argv[i + 1] : process.cwd();
  const { clean, lines } = treeStatus(cwd);
  if (clean) {
    console.error('tree-clean: OK — `git status --porcelain` is empty.');
    return 0;
  }
  console.error(`tree-clean: FAILED — ${lines.length} path(s) changed by this job's commands:`);
  for (const l of lines) console.error(`  ${l}`);
  console.error('tree-clean: commit the generated change, ignore it, or fix the step that wrote it.');
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main());
