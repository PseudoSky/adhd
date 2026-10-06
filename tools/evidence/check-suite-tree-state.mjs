#!/usr/bin/env node
/**
 * check-suite-tree-state — attribute a test suite's result to the tree state it
 * ran against, and FAIL when the suite left the tree dirty (backlog 65788fd8,
 * 5b759112, 53ec220e; the BL-456 tree-state attribution quote).
 *
 *   node tools/evidence/check-suite-tree-state.mjs [--fresh] -- <command> [args...]
 *
 * Snapshots `git status --porcelain=v1 --untracked-files=all` before and after
 * the command and prints the attribution quote:
 *   tree-state: HEAD <sha> | dirty-before <n> | dirty-after <n> | delta <n>
 * Exit codes:
 *   0  suite passed and left the tree exactly as it found it
 *   1  the suite introduced or changed dirty paths (a suite must not write tracked/untracked files)
 *   2  usage error
 *   3  `--fresh` was given and the output shows the result was an nx CACHE REPLAY, not a fresh run
 *   N  the command's own non-zero exit code is passed through
 * A cached replay is always LABELLED `cache-replay: yes` — a green replayed from
 * cache is not a fresh attribution (53ec220e).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @returns {Map<string,string>} path -> content hash (or DELETED) for every dirty path. */
export function snapshotTree(cwd) {
  const r = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git status failed: ${r.stderr}`);
  const snap = new Map();
  for (const line of r.stdout.split('\n').filter(Boolean)) {
    const path = line.slice(3).split(' -> ').pop();
    const abs = join(cwd, path);
    snap.set(path, existsSync(abs) ? createHash('sha1').update(readFileSync(abs)).digest('hex') : 'DELETED');
  }
  return snap;
}

/** Paths whose state differs between two snapshots (new, changed or newly clean). */
export function treeDelta(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((p) => before.get(p) !== after.get(p)).sort();
}

export const CACHE_REPLAY_RE = /\[local cache\]|Nx read the output from the cache|\bFrom cache\b/i;

function main(argv) {
  const sep = argv.indexOf('--');
  if (sep === -1 || sep === argv.length - 1) {
    console.error('usage: check-suite-tree-state.mjs [--fresh] -- <command> [args...]');
    return 2;
  }
  const fresh = argv.slice(0, sep).includes('--fresh');
  const [cmd, ...args] = argv.slice(sep + 1);
  const cwd = process.cwd();
  const head = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim();
  const before = snapshotTree(cwd);
  const run = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  process.stdout.write(run.stdout ?? '');
  process.stderr.write(run.stderr ?? '');
  const after = snapshotTree(cwd);
  const delta = treeDelta(before, after);
  const replay = CACHE_REPLAY_RE.test(`${run.stdout}\n${run.stderr}`);
  console.error(`tree-state: HEAD ${head} | dirty-before ${before.size} | dirty-after ${after.size} | delta ${delta.length} | cache-replay: ${replay ? 'yes' : 'no'}`);
  if ((run.status ?? 1) !== 0) return run.status ?? 1;
  if (delta.length > 0) {
    console.error('tree-state: FAILED — the suite left the tree changed:');
    for (const p of delta) console.error(`  ${p}`);
    return 1;
  }
  if (fresh && replay) {
    console.error('tree-state: FAILED — --fresh requested but the result is an nx cache replay, not a fresh run');
    return 3;
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
