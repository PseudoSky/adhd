/**
 * worktree-lib — shared helpers for scripts/worktree-{setup,merge,cleanup}.
 *
 * Plain ESM, node builtins only (runs before `pnpm install`). Every git spawn
 * scrubs ambient GIT_* variables (50e8c966) so a hook-exported GIT_DIR can never
 * redirect a call to the wrong repo.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { existsSync, lstatSync, realpathSync, statSync, writeFileSync, rmSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { cleanGitEnv } = require('../../tools/nx-plugins/lib/git-env.js');

/** Minimum git for `merge-tree --write-tree`. */
export const MIN_GIT = [2, 38];

/**
 * Run git. Never throws; returns `{ status, stdout, stderr }` (stdout/stderr trimmed of one trailing newline).
 * @param {string[]} args
 * @param {{ cwd?: string, input?: string }} [opts]
 */
export function git(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: opts.cwd, input: opts.input, encoding: 'utf8', env: cleanGitEnv(process.env), maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? 1, stdout: (r.stdout ?? '').replace(/\n$/, ''), stderr: (r.stderr ?? '').replace(/\n$/, '') };
}

/** Like {@link git} but throws an Error carrying git's stderr when the exit status is non-zero. */
export function gitOk(args, opts = {}) {
  const r = git(args, opts);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} (exit ${r.status}): ${r.stderr || r.stdout}`);
  return r.stdout;
}

/** True when the installed git supports `merge-tree --write-tree` (>= 2.38). */
export function gitVersionOk() {
  const m = /(\d+)\.(\d+)/.exec(git(['--version']).stdout);
  if (!m) return false;
  const [maj, min] = [Number(m[1]), Number(m[2])];
  return maj > MIN_GIT[0] || (maj === MIN_GIT[0] && min >= MIN_GIT[1]);
}

/** Absolute path of the MAIN checkout, from any worktree. */
export function mainRoot(cwd = process.cwd()) {
  const common = gitOk(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd });
  return dirname(common);
}

/** Absolute path of the shared git dir. */
export function commonDir(cwd = process.cwd()) {
  return gitOk(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd });
}

/**
 * Parsed `git worktree list --porcelain`.
 * @returns {{ path: string, head: string, branch: string|null, bare: boolean }[]}
 */
export function listWorktrees(root) {
  const out = gitOk(['worktree', 'list', '--porcelain'], { cwd: root });
  return out.split('\n\n').filter(Boolean).map((block) => {
    const wt = { path: '', head: '', branch: null, bare: false };
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) wt.path = line.slice(9);
      else if (line.startsWith('HEAD ')) wt.head = line.slice(5);
      else if (line.startsWith('branch ')) wt.branch = line.slice(7).replace(/^refs\/heads\//, '');
      else if (line === 'bare') wt.bare = true;
    }
    return wt;
  });
}

const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };

/** True when two paths name the same location (symlinks such as macOS /var -> /private/var resolved). */
export function samePath(a, b) {
  return real(a) === real(b);
}

/**
 * Content fingerprint of the given repo-relative files inside `cwd` (so an edit to an untracked file
 * changes it). Non-regular or missing paths (deletions) contribute only their name.
 */
export function fingerprint(cwd, paths) {
  const files = [];
  for (const p of paths) {
    try { if (lstatSync(join(cwd, p)).isFile()) files.push(p); } catch { /* deleted */ }
  }
  const hashes = files.length ? git(['hash-object', '--no-filters', '--stdin-paths'], { cwd, input: files.join('\n') + '\n' }).stdout : '';
  return digest([[...paths].sort(), hashes]);
}

/** True when `p` is strictly inside `<root>/.worktrees/`. */
export function isManagedWorktreePath(root, p) {
  const base = real(join(root, '.worktrees')) + sep;
  return real(p).startsWith(base);
}

/** Branch/worktree name for a backlog item: `plan-<8hex>` for kind PLAN, else `task-<8hex>`. */
export function nameForBacklog(uid, kind) {
  return `${String(kind).toUpperCase() === 'PLAN' ? 'plan' : 'task'}-${uid.replace(/-/g, '').slice(0, 8)}`;
}

/**
 * Resolve a backlog id through the backlog CLI (`WORKTREE_BACKLOG_CMD`, default `adhd-backlog`).
 * Reads the `{"ok":…}` JSON line on stdout; diagnostics on stderr are ignored.
 * @returns {{ uid: string, kind: string, title: string, name: string }}
 */
export function resolveBacklog(id) {
  const cmd = (process.env.WORKTREE_BACKLOG_CMD || 'adhd-backlog').split(/\s+/).filter(Boolean);
  const r = spawnSync(cmd[0], [...cmd.slice(1), 'get', id], { encoding: 'utf8' });
  const line = (r.stdout ?? '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{')).pop();
  if (!line) throw new Error(`backlog lookup of '${id}' produced no JSON (exit ${r.status}): ${(r.stderr ?? '').slice(0, 200)}`);
  const res = JSON.parse(line);
  if (!res.ok) throw new Error(`backlog lookup of '${id}' failed: ${res.error?.code ?? ''} ${res.error?.message ?? ''}`.trim());
  const { uid, kind, title } = res.data;
  return { uid, kind, title: title ?? '', name: nameForBacklog(uid, kind) };
}

/** Ticket-ish references in free text: full uuids, BUG-/DEBT-/FEAT- codes, `[psm:…]` tags. */
export function ticketsIn(text) {
  const found = new Set();
  for (const re of [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, /\b(?:BUG|DEBT|FEAT|TASK|PLAN)-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d+\b/g, /\[psm:[^\]]+\]/g]) {
    for (const m of text.matchAll(re)) found.add(m[0]);
  }
  return [...found];
}

/** Stable short digest used for force tokens. */
export function digest(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

/** Paths in `git status --porcelain` output (rename targets included). */
export function porcelainPaths(porcelain) {
  return porcelain.split('\n').filter(Boolean).map((l) => l.slice(3).split(' -> ').pop().replace(/^"|"$/g, ''));
}

/** Worktrees (never the main checkout, never outside .worktrees/) matching a target. */
export function matchTarget(root, all, target) {
  const hex = target.replace(/-/g, '').toLowerCase();
  const isId = /^[0-9a-f]{8,32}$/.test(hex);
  return all.filter((w) => {
    if (samePath(w.path, target)) return true;
    if (w.branch === target) return true;
    if (!target.includes('/') && basename(w.path) === target) return true; // directory name, e.g. `probe-share`
    if (!isId) return false;
    const short = hex.slice(0, 8);
    if (w.branch === nameForBacklog(short, 'PLAN') || w.branch === nameForBacklog(short, 'TASK')) return true;
    const uid = w.branch ? git(['config', '--get', `branch.${w.branch}.adhd-backlog-uid`], { cwd: root }).stdout.replace(/-/g, '') : '';
    return uid !== '' && uid.startsWith(hex);
  });
}

/**
 * 8-hex backlog-style ids in free text (e.g. "backlog 7b7d5e38"). Requires at least one digit
 * and one a-f letter (drops dates and words) and drops `exclude` (commit-hash prefixes).
 */
export function shortIdsIn(text, exclude = new Set()) {
  const out = new Set();
  for (const m of text.matchAll(/(?<![0-9a-zA-Z])[0-9a-f]{8}(?![0-9a-zA-Z])/g)) {
    if (/[0-9]/.test(m[0]) && /[a-f]/.test(m[0]) && !exclude.has(m[0])) out.add(m[0]);
  }
  return [...out];
}

/** A reindex lock older than this is treated as abandoned (the PostToolUse hook uses the same TTL). */
export const REINDEX_LOCK_TTL_MS = 10 * 60 * 1000;

/**
 * Refresh main's gitnexus index after a merge so the next worktree can copy a COMPLETE index
 * (see worktree-setup.sh). Starts a detached `gitnexus analyze --skip-agents-md --skip-skills`
 * in `root` under `<root>/.gitnexus/.reindex.lock` — the same lock the sox-tools PostToolUse
 * hook honours, so the two never write the index at once. Best-effort: never throws.
 * `WORKTREE_REFRESH_GITNEXUS=0` turns it off.
 * @returns {string} one human-readable line saying what happened
 */
export function startMainIndexRefresh(root) {
  try {
    if (process.env.WORKTREE_REFRESH_GITNEXUS === '0') return 'gitnexus refresh disabled (WORKTREE_REFRESH_GITNEXUS=0)';
    const dir = join(root, '.gitnexus');
    if (!existsSync(dir)) return 'gitnexus: main has no index; nothing to refresh';
    if (spawnSync('gitnexus', ['--version'], { stdio: 'ignore' }).status !== 0) return 'gitnexus not on PATH; main index not refreshed';
    const lock = join(dir, '.reindex.lock');
    if (existsSync(lock)) {
      if (Date.now() - statSync(lock).mtimeMs < REINDEX_LOCK_TTL_MS) return 'gitnexus: main is already re-indexing (lock held); not starting another';
      rmSync(lock, { force: true });
    }
    writeFileSync(lock, String(process.pid), { flag: 'wx' });
    const q = (x) => `'${x.replace(/'/g, `'\\''`)}'`;
    const child = spawn('/bin/sh', ['-c', `gitnexus analyze --skip-agents-md --skip-skills . ; rm -f ${q(lock)}`], { cwd: root, detached: true, stdio: 'ignore' });
    child.unref();
    return 'gitnexus: refreshing main\'s index in the background (~40s); new worktrees copy it once it finishes';
  } catch (e) {
    return `gitnexus refresh not started: ${e.message}`;
  }
}
