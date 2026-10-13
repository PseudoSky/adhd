#!/usr/bin/env node
/**
 * worktree-cleanup — safely remove merged, clean worktrees and their branches.
 *
 *   scripts/worktree-cleanup.sh [--force <token>] [--no-remote] [target ...]
 *
 * target: a worktree path, a branch name, or a backlog id (uuid or 8+ hex prefix).
 * No targets: every worktree under <main>/.worktrees/.
 *
 * Cleanable = no uncommitted changes (gitignored output such as tmp/ and
 * node_modules does not count) AND its branch is merged into main. Cleanable trees
 * are removed with `git worktree remove` + `git branch -d` (+ the pushed remote
 * branch, if any). Nothing is removed with rm; git refuses anything it considers unsafe.
 *
 * A DIRTY merged tree is kept, and the report prints a force token: a digest of each
 * such tree's path, HEAD and status. `--force <token>` recomputes the digest and,
 * only if it still matches (the tree is exactly what the caller was shown), removes
 * those trees too. A tree whose branch is NOT merged into main is never removed by
 * this script, forced or not: its commits would be lost.
 *
 * Owner approval for scripted worktree/branch removal: given in the 2026-10-13
 * session that requested this script (AGENTS.md: scripts removing paths need approval).
 *
 * Exit: 0 everything requested removed; 3 something kept; 4 stale/invalid force token; 2 usage.
 */
import { spawnSync } from 'node:child_process';
import { digest, fingerprint, git, samePath, isManagedWorktreePath, listWorktrees, mainRoot, matchTarget, porcelainPaths } from './lib/worktree-lib.mjs';

const MAIN_BRANCH = 'main';

/** @returns {{ targets: string[], force: string|null, noRemote: boolean }} */
function parseArgs(argv) {
  const out = { targets: [], force: null, noRemote: !!process.env.WORKTREE_CLEANUP_NO_REMOTE };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') {
      out.force = argv[++i] ?? '';
      if (!out.force || out.force.startsWith('-')) usage('--force needs the token printed by a previous run');
    } else if (a === '--no-remote') out.noRemote = true;
    else if (a.startsWith('-')) usage(`unknown flag ${a}`);
    else out.targets.push(a);
  }
  return out;
}

function usage(msg) {
  if (msg) console.error(`worktree-cleanup: ${msg}`);
  console.error('usage: scripts/worktree-cleanup.sh [--force <token>] [--no-remote] [<worktree-path|branch|backlog-id> ...]');
  process.exit(2);
}

function inspect(root, w) {
  const porcelain = git(['status', '--porcelain', '-uall'], { cwd: w.path }).stdout;
  const ref = w.branch ?? w.head;
  const unmerged = git(['rev-list', '--count', `${MAIN_BRANCH}..${ref}`], { cwd: root });
  const ahead = unmerged.status === 0 ? Number(unmerged.stdout) : NaN;
  const dirty = porcelainPaths(porcelain);
  return { ...w, porcelain, dirty, fingerprint: dirty.length ? fingerprint(w.path, dirty) : '', ahead };
}

function remoteBranchExists(root, branch) {
  if (git(['remote', 'get-url', 'origin'], { cwd: root }).status !== 0) return false;
  return git(['ls-remote', '--exit-code', '--heads', 'origin', branch], { cwd: root }).status === 0;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = mainRoot();
  process.chdir(root); // the caller may be standing inside a tree that is about to disappear

  const all = listWorktrees(root).filter((w) => !samePath(w.path, root) && isManagedWorktreePath(root, w.path));
  const notFound = [];
  let picked;
  if (args.targets.length === 0) picked = all;
  else {
    picked = [];
    for (const t of args.targets) {
      const m = matchTarget(root, all, t);
      if (m.length === 0) notFound.push(t);
      for (const w of m) if (!picked.some((p) => p.path === w.path)) picked.push(w);
    }
  }
  const trees = picked.map((w) => inspect(root, w));

  const removable = [];
  const forceable = []; // dirty but merged
  const kept = []; //     { tree, why }
  for (const t of trees) {
    if (!Number.isFinite(t.ahead)) kept.push({ tree: t, why: 'cannot compare with main (git rev-list failed)' });
    else if (t.ahead > 0) kept.push({ tree: t, why: `unmerged: ${t.ahead} commit${t.ahead === 1 ? '' : 's'} not in ${MAIN_BRANCH}` });
    else if (t.dirty.length > 0) forceable.push(t);
    else removable.push(t);
  }

  const token = forceable.length ? digest(forceable.map((t) => [t.path, t.head, t.porcelain, t.fingerprint]).sort()) : null;
  if (args.force !== null) {
    if (token === null || args.force !== token) {
      console.error('worktree-cleanup: --force token does not match the current state of the dirty trees (it changed, or the token is not from this set).');
      for (const t of forceable) console.error(`  dirty: ${t.path} — ${t.dirty.slice(0, 5).join(', ')}${t.dirty.length > 5 ? ` … (+${t.dirty.length - 5})` : ''}`);
      if (token) console.error(`Review them, then re-run with: scripts/worktree-cleanup.sh --force ${token}${args.targets.length ? ' ' + args.targets.join(' ') : ''}`);
      process.exit(4);
    }
  }

  const doForce = args.force !== null;
  const toRemove = [...removable, ...(doForce ? forceable : [])];
  const removed = [];
  for (const t of toRemove) {
    const rm = git(['worktree', 'remove', ...(doForce ? ['--force'] : []), t.path], { cwd: root });
    if (rm.status !== 0) { kept.push({ tree: t, why: `git refused: ${rm.stderr.split('\n')[0]}` }); continue; }
    const notes = [];
    // Unregister the worktree's gitnexus index (documented `gitnexus remove`); the registry
    // otherwise keeps a dead entry for every removed worktree. Best-effort, never fatal.
    if (!process.env.WORKTREE_CLEANUP_NO_GITNEXUS) {
      const gx = spawnSync('gitnexus', ['remove', t.path, '--force'], { stdio: 'ignore' });
      if (gx.status === 0) notes.push('gitnexus index unregistered');
    }
    if (t.branch) {
      const br = git(['branch', '-d', t.branch], { cwd: root });
      if (br.status !== 0) notes.push(`branch kept (${br.stderr.split('\n')[0]})`);
      else if (!args.noRemote && remoteBranchExists(root, t.branch)) {
        const pr = git(['push', 'origin', '--delete', t.branch], { cwd: root });
        notes.push(pr.status === 0 ? 'remote branch deleted' : `remote branch NOT deleted (${pr.stderr.split('\n').pop()})`);
      }
    }
    removed.push({ t, notes });
  }
  git(['worktree', 'prune'], { cwd: root });

  for (const { t, notes } of removed) console.log(`removed  ${t.path}${t.branch ? ` (${t.branch})` : ''}${notes.length ? ` — ${notes.join('; ')}` : ''}`);
  for (const t of notFound) console.log(`not-found ${t}`);
  for (const { tree: t, why } of kept) console.log(`kept     ${t.path} — ${why}`);
  const stillDirty = forceable.filter((t) => !doForce);
  for (const t of stillDirty) {
    console.log(`kept     ${t.path} — uncommitted: ${t.dirty.slice(0, 5).join(', ')}${t.dirty.length > 5 ? ` … (+${t.dirty.length - 5})` : ''}`);
  }
  if (stillDirty.length) {
    console.log(`WARNING  ${stillDirty.length} merged tree(s) hold uncommitted files that removal would destroy. Commit or move what you need, then:`);
    console.log(`         scripts/worktree-cleanup.sh --force ${token}${args.targets.length ? ' ' + args.targets.join(' ') : ''}`);
  }
  if (trees.length === 0 && notFound.length === 0) console.log('nothing to clean');
  process.exit(kept.length || stillDirty.length || notFound.length ? 3 : 0);
}

try { main(); } catch (e) { console.error(`worktree-cleanup: ${e.message}`); process.exit(1); }
