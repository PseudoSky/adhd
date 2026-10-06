#!/usr/bin/env node
/**
 * commit-mine — commit ONLY the paths this agent changed (backlog 65788fd8,
 * 27fc3814). In a repo shared with concurrent agents, `git add -A` / `git commit
 * -a` sweep another agent's in-flight work into your commit.
 *
 *   node tools/evidence/commit-mine.mjs snapshot [--file <path>]      # at the START of your work
 *   node tools/evidence/commit-mine.mjs commit -m <message> [--file <path>] [--dry-run]
 *
 * `snapshot` records every dirty path (tracked edits, deletions AND untracked
 * files) with a content hash. `commit` stages and commits exactly the paths whose
 * state differs from that baseline — including NEW untracked files, which a
 * `git diff HEAD`-based approach cannot see (27fc3814) — with an explicit
 * pathspec commit so other staged work stays staged. Paths dirty in the baseline
 * and unchanged since are someone else's and are never touched.
 * Exit 0 on success (incl. nothing to commit), 1 on git failure, 2 on usage error.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';


/** @returns {Record<string,string>} dirty path -> content hash | DELETED */
export function dirtySnapshot(cwd) {
  const r = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git status failed: ${r.stderr}`);
  const out = {};
  for (const line of r.stdout.split('\n').filter(Boolean)) {
    const path = line.slice(3).split(' -> ').pop();
    const abs = join(cwd, path);
    out[path] = existsSync(abs) ? createHash('sha1').update(readFileSync(abs)).digest('hex') : 'DELETED';
  }
  return out;
}

/** Paths that are dirty now and differ from (or are absent in) the baseline. */
export function minePaths(baseline, current) {
  return Object.keys(current).filter((p) => baseline[p] !== current[p]).sort();
}

/** Baseline lives inside the git dir by default, so it is never itself a dirty path. */
function defaultBaselineFile(cwd) {
  const r = spawnSync('git', ['rev-parse', '--absolute-git-dir'], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git rev-parse failed: ${r.stderr}`);
  return join(r.stdout.trim(), 'commit-mine-baseline.json');
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : undefined;
}

function main(argv) {
  const [verb] = argv;
  const cwd = process.cwd();
  const explicit = arg(argv, '--file');
  const file = explicit ? join(cwd, explicit) : defaultBaselineFile(cwd);
  if (verb === 'snapshot') {
    mkdirSync(dirname(file), { recursive: true });
    const snap = dirtySnapshot(cwd);
    writeFileSync(file, JSON.stringify(snap, null, 2));
    console.error(`commit-mine: baseline recorded — ${Object.keys(snap).length} pre-existing dirty path(s) are NOT yours`);
    return 0;
  }
  if (verb === 'commit') {
    const message = arg(argv, '-m');
    if (!message) { console.error('commit-mine: -m <message> is required'); return 2; }
    if (!existsSync(file)) { console.error(`commit-mine: no baseline at ${file} — run \`snapshot\` first`); return 2; }
    const baseline = JSON.parse(readFileSync(file, 'utf8'));
    const mine = minePaths(baseline, dirtySnapshot(cwd));
    if (mine.length === 0) { console.error('commit-mine: nothing of yours to commit'); return 0; }
    console.error(`commit-mine: ${argv.includes('--dry-run') ? '[dry-run] would commit' : 'committing'} ${mine.length} path(s):`);
    for (const p of mine) console.error(`  ${p}`);
    if (argv.includes('--dry-run')) return 0;
    // `git add` cannot name a deleted path; `--all -- <paths>` handles deletions, edits and new files alike.
    const add = spawnSync('git', ['add', '--all', '--', ...mine], { cwd, encoding: 'utf8' });
    if (add.status !== 0) { console.error(add.stderr); return 1; }
    const commit = spawnSync('git', ['commit', '-m', message, '--', ...mine], { cwd, encoding: 'utf8' });
    process.stderr.write(commit.stdout ?? '');
    if (commit.status !== 0) { console.error(commit.stderr); return 1; }
    return 0;
  }
  console.error('usage: commit-mine.mjs snapshot | commit -m <message> [--file <path>] [--dry-run]');
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
