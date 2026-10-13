#!/usr/bin/env node
/**
 * worktree-merge — merge a worktree's branch into main, push, and clean up.
 *
 *   scripts/worktree-merge.sh <worktree-path | branch | backlog-id>
 *
 * Order (every step that can fail cheaply runs BEFORE main is touched):
 *   1. preflight   git >= 2.38; main checkout is on main; origin/main is an ancestor of
 *                  main (the push will fast-forward); the worktree has no uncommitted
 *                  tracked changes; none of main's dirty paths overlap the branch's changes.
 *   2. conflicts   `git merge-tree` (read-only). On conflict: print a JSON report on stdout,
 *                  merge main INTO THE WORKTREE so the conflicts sit there for repair, exit 10.
 *   3. gate        run the pre-push test gate inside the worktree. Failure leaves main
 *                  untouched. (The push hook runs the same gate again in the main checkout;
 *                  measured, nx does not carry the first run's cache over to it.)
 *   4. merge       `git merge --no-ff` in the main checkout with a structured message.
 *   5. push        `git push origin main` — BEFORE cleanup. If it fails, cleanup is skipped.
 *   6. cleanup     scripts/worktree-cleanup.sh <worktree>.
 *
 * Environment:
 *   WORKTREE_BACKLOG_CMD   backlog CLI (default `adhd-backlog`), used by worktree-setup only.
 *   WORKTREE_MERGE_GATE    shell command replacing the default gate (tests; an empty string skips).
 *
 * Exit: 0 merged+pushed+cleaned; 1 error; 2 usage; 3 worktree has uncommitted changes;
 *       5 preflight (origin/main / overlap) refused; 6 gate failed; 7 merge failed;
 *       8 push failed (merge commit stays local); 9 merged and pushed but cleanup kept the
 *       worktree (see its report); 10 conflicts (JSON on stdout).
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, gitOk, gitVersionOk, isManagedWorktreePath, listWorktrees, mainRoot, matchTarget, porcelainPaths, samePath, shortIdsIn, ticketsIn } from './lib/worktree-lib.mjs';

const MAIN = 'main';
const here = dirname(fileURLToPath(import.meta.url));
const say = (s) => console.error(s);

function die(code, msg) {
  say(`worktree-merge: ${msg}`);
  process.exit(code);
}

function hasOrigin(root) {
  return git(['remote', 'get-url', 'origin'], { cwd: root }).status === 0;
}

/** Commits touching `file` in `range`, newest first, as report entries. */
function commitsFor(root, range, file, { mergedInto } = {}) {
  const out = git(['log', '-n', '10', '--format=%H%x1f%aI%x1f%s%x1f%b%x1e', range, '--', file], { cwd: root }).stdout;
  return out.split('\x1e').map((r) => r.replace(/^\n/, '')).filter(Boolean).map((rec) => {
    const [commit, authoredAt, subject, body = ''] = rec.split('\x1f');
    const entry = { commit: commit.slice(0, 12), authoredAt, subject, tickets: ticketsIn(`${subject}\n${body}`) };
    if (mergedInto) {
      const path = git(['log', '--first-parent', '--ancestry-path', '--format=%H%x1f%cI%x1f%s', `${commit}..${mergedInto}`], { cwd: root }).stdout.split('\n').filter(Boolean);
      const first = path.pop(); // oldest first-parent commit on main that contains this commit
      if (first) {
        const [mc, md, ms] = first.split('\x1f');
        entry.mergedAt = md;
        entry.mergedBy = { commit: mc.slice(0, 12), subject: ms, tickets: ticketsIn(ms) };
      } else entry.mergedAt = git(['log', '-1', '--format=%cI', commit], { cwd: root }).stdout;
    } else entry.mergedAt = null;
    return entry;
  });
}

function main() {
  const target = process.argv[2];
  if (!target || target.startsWith('-') || process.argv.length > 3) {
    say('usage: scripts/worktree-merge.sh <worktree-path | branch | backlog-id>');
    process.exit(2);
  }
  if (!gitVersionOk()) die(1, 'git >= 2.38 is required (merge-tree --write-tree)');
  const root = mainRoot();

  const all = listWorktrees(root).filter((w) => !samePath(w.path, root) && isManagedWorktreePath(root, w.path));
  const found = matchTarget(root, all, target);
  if (found.length !== 1) die(2, found.length === 0 ? `no worktree under .worktrees/ matches '${target}'` : `'${target}' matches ${found.length} worktrees: ${found.map((w) => w.path).join(', ')}`);
  const wt = found[0];
  if (!wt.branch) die(2, `${wt.path} is on a detached HEAD; check out its branch first`);
  const branch = wt.branch;

  // ── 1. preflight ────────────────────────────────────────────────────────────
  const cur = git(['branch', '--show-current'], { cwd: root }).stdout;
  if (cur !== MAIN) die(5, `the main checkout (${root}) is on '${cur || 'detached HEAD'}', not '${MAIN}'`);

  if (hasOrigin(root)) {
    const f = git(['fetch', 'origin', MAIN], { cwd: root });
    if (f.status !== 0) die(5, `cannot fetch origin/${MAIN}, so a push would fail: ${f.stderr.split('\n').pop()}`);
    if (git(['merge-base', '--is-ancestor', `origin/${MAIN}`, MAIN], { cwd: root }).status !== 0) {
      die(5, `${MAIN} does not contain origin/${MAIN} (behind or diverged), so the push would be rejected. Bring ${MAIN} up to date first: git -C ${root} pull --ff-only`);
    }
  }

  if (hasOrigin(root)) {
    const unpushed = Number(gitOk(['rev-list', '--count', `origin/${MAIN}..${MAIN}`], { cwd: root }));
    if (unpushed > 0) {
      say(`NOTICE: ${MAIN} is ${unpushed} commit${unpushed === 1 ? '' : 's'} ahead of origin/${MAIN}. This push publishes them too, and the gate below tests them as well.`);
    }
  }

  const wtStatus = git(['status', '--porcelain'], { cwd: wt.path }).stdout;
  const tracked = wtStatus.split('\n').filter((l) => l && !l.startsWith('??'));
  const untracked = wtStatus.split('\n').filter((l) => l.startsWith('??')).map((l) => l.slice(3));
  if (tracked.length) {
    const untrackedNote = untracked.length
      ? `\nUntracked paths are also NOT in the merge until you \`git add\` and commit them (new files must be added explicitly):\n  ${untracked.join('\n  ')}`
      : '';
    die(3, `${wt.path} has uncommitted changes to tracked files — commit them first:\n  ${tracked.join('\n  ')}${untrackedNote}`);
  }
  if (untracked.length) {
    say('');
    say('WARNING: untracked paths in the worktree are not committed and are NOT part of this merge:');
    for (const p of untracked) say(`  ${p}`);
    say('Cleanup keeps a worktree that holds uncommitted files and then offers a force token that would DESTROY them.');
    say('Decide their fate now: commit them (then re-run), move them out of the worktree, or accept losing them.');
    say('');
  }

  const ahead = Number(gitOk(['rev-list', '--count', `${MAIN}..${branch}`], { cwd: root }));
  if (ahead === 0) {
    say(`${branch} has no commits that are not already in ${MAIN}; skipping the merge.`);
    process.exit(cleanup(wt.path));
  }

  const branchFiles = git(['diff', '--name-only', `${MAIN}...${branch}`], { cwd: root }).stdout.split('\n').filter(Boolean);
  const mainDirty = porcelainPaths(git(['status', '--porcelain'], { cwd: root }).stdout);
  const overlap = branchFiles.filter((f) => mainDirty.some((d) => d === f || (d.endsWith('/') && f.startsWith(d))));
  if (overlap.length) {
    die(5, `the main checkout has uncommitted changes to files this branch also changes — merging would clobber or tangle them. Commit or move them first:\n  ${overlap.join('\n  ')}`);
  }

  // ── 2. conflicts ────────────────────────────────────────────────────────────
  const mt = git(['merge-tree', '--write-tree', '--name-only', '--no-messages', MAIN, branch], { cwd: root });
  if (mt.status > 1) die(1, `git merge-tree failed: ${mt.stderr || mt.stdout}`);
  if (mt.status === 1) {
    const paths = mt.stdout.split('\n').slice(1).filter(Boolean);
    const base = gitOk(['merge-base', MAIN, branch], { cwd: root });
    const report = {
      status: 'conflict',
      branch,
      worktree: wt.path,
      base: base.slice(0, 12),
      mainHead: gitOk(['rev-parse', '--short=12', MAIN], { cwd: root }),
      branchHead: gitOk(['rev-parse', '--short=12', branch], { cwd: root }),
      branchTickets: ticketsIn(branch),
      files: paths.map((path) => ({
        path,
        branch: commitsFor(root, `${base}..${branch}`, path),
        main: commitsFor(root, `${base}..${MAIN}`, path, { mergedInto: MAIN }),
      })),
    };
    console.log(JSON.stringify(report, null, 2));
    const m = git(['merge', '--no-edit', MAIN], { cwd: wt.path });
    say('');
    if (m.status === 1) {
      say(`Conflicts exist in ${wt.path} (main was merged into the worktree; main itself is untouched).`);
      say('Resolve the files listed above, `git add` them, `git commit`, then re-run this script.');
    } else say(`Could not merge ${MAIN} into the worktree: ${m.stderr || m.stdout}`);
    process.exit(10);
  }

  // ── 3. gate (worktree must contain main so the gate sees the real result) ──────────
  if (git(['merge-base', '--is-ancestor', MAIN, branch], { cwd: root }).status !== 0) {
    const sync = git(['merge', '--no-edit', MAIN], { cwd: wt.path });
    if (sync.status !== 0) die(1, `merging ${MAIN} into ${branch} failed unexpectedly: ${sync.stderr || sync.stdout}`);
  }
  const gate = runGate(wt.path, hasOrigin(root) ? `origin/${MAIN}` : MAIN);
  if (gate !== 0) die(6, `the gate failed (exit ${gate}) in ${wt.path}; ${MAIN} was not touched. Fix it there and re-run.`);

  // ── 4. merge ──────────────────────────────────────────────────────────────────
  const message = buildMessage(root, branch);
  const mg = git(['merge', '--no-ff', '-m', message, branch], { cwd: root });
  if (mg.status !== 0) {
    git(['merge', '--abort'], { cwd: root });
    die(7, `merge into ${MAIN} failed (aborted): ${mg.stderr || mg.stdout}`);
  }
  const sha = gitOk(['rev-parse', '--short=12', 'HEAD'], { cwd: root });

  // ── 5. push, BEFORE cleanup ───────────────────────────────────────────────────────
  if (hasOrigin(root)) {
    const push = spawnSync('git', ['push', 'origin', MAIN], { cwd: root, stdio: 'inherit' });
    if (push.status !== 0) {
      die(8, `push failed (exit ${push.status}). The merge commit ${sha} exists locally and cleanup was skipped. Fix the cause, run: git -C ${root} push origin ${MAIN}, then: scripts/worktree-cleanup.sh ${branch}`);
    }
  } else say('no origin remote: nothing to push');

  // ── 6. cleanup ────────────────────────────────────────────────────────────────────
  const code = cleanup(wt.path);
  const uid = git(['config', '--get', `branch.${branch}.adhd-backlog-uid`], { cwd: root }).stdout;
  say('');
  say(`merged ${branch} into ${MAIN} at ${sha}`);
  say('Follow-ups: add the changelog entries for the packages you changed' + (uid ? `; resolve backlog ${uid} citing ${sha}.` : '.'));
  process.exit(code === 3 ? 9 : code); // 9: merged and pushed, but cleanup kept the worktree
}

function runGate(cwd, base) {
  const override = process.env.WORKTREE_MERGE_GATE;
  if (override === '') return 0;
  const cmd = override ?? `npx nx affected --base=${base} --head=HEAD $(node .githooks/lib/pre-push-flags.mjs)`;
  say(`gate: ${cmd}`);
  const t0 = Date.now();
  const r = spawnSync('sh', ['-c', cmd], { cwd, stdio: ['ignore', 2, 2] });
  say(`gate finished in ${Math.round((Date.now() - t0) / 1000)}s (exit ${r.status})`);
  return r.status ?? 1;
}

function buildMessage(root, branch) {
  const cfg = (k) => git(['config', '--get', `branch.${branch}.${k}`], { cwd: root }).stdout;
  const uid = cfg('adhd-backlog-uid');
  const title = cfg('adhd-backlog-title') || branch;
  const log = git(['log', '--format=%s%n%b', `${MAIN}..${branch}`], { cwd: root }).stdout;
  const hashes = new Set(git(['rev-list', `${MAIN}..${branch}`], { cwd: root }).stdout.split('\n').filter(Boolean).map((h) => h.slice(0, 8)));
  const refs = [...new Set([...ticketsIn(log), ...shortIdsIn(log, hashes)])].filter((r) => !uid || (r !== uid && !uid.startsWith(r)));
  const count = gitOk(['rev-list', '--count', '--no-merges', `${MAIN}..${branch}`], { cwd: root });
  return [
    `merge(${branch}): ${title}`,
    '',
    ...(uid ? [`Backlog: ${uid}`] : []),
    `Branch: ${branch} (${count} commit${count === '1' ? '' : 's'})`,
    ...(refs.length ? [`Refs: ${refs.join(' ')}`] : []),
  ].join('\n');
}

function cleanup(path) {
  say(`cleanup: ${path}`);
  const r = spawnSync('node', [join(here, 'worktree-cleanup.mjs'), path], { stdio: ['ignore', 2, 2], cwd: mainRoot() });
  return r.status ?? 1;
}

try { main(); } catch (e) { console.error(`worktree-merge: ${e.message}`); process.exit(1); }
