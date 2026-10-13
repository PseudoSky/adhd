/**
 * worktree-scripts.spec — real-process proofs for scripts/worktree-{setup,merge,cleanup}.
 *
 * Every test drives the actual shell entrypoints against throwaway repos (a bare `origin` plus a
 * `main` clone), a fake backlog CLI and a fake pnpm. Nothing touches this repo, its remotes or the
 * production backlog. Each spawn scrubs GIT_* (50e8c966).
 *
 * Run: node --test scripts/worktree-scripts.spec.mjs   (nx: `nx run @adhd/source:test`)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { cleanGitEnv } = require('../tools/nx-plugins/lib/git-env.js');
const here = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = here;

const PLAN_UID = '11111111-aaaa-4bbb-8ccc-000000000001';
const TASK_UID = '22222222-aaaa-4bbb-8ccc-000000000002';

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: 'utf8', ...opts, env: cleanGitEnv({ ...process.env, ...(opts.env ?? {}) }) });
const git = (cwd, ...args) => {
  const r = run('git', args, { cwd });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

/** A fresh sandbox: bare origin, a `main` clone with one commit, fake pnpm + fake backlog CLI. */
function sandbox() {
  const base = mkdtempSync(join(tmpdir(), 'wt-scripts-'));
  const origin = join(base, 'origin.git');
  const root = join(base, 'repo');
  run('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  run('git', ['clone', '-q', origin, root]);
  git(root, 'checkout', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'user.name', 'T');
  writeFileSync(join(root, '.gitignore'), '.worktrees\ntmp\nnode_modules\n');
  writeFileSync(join(root, 'app.txt'), 'line one\nline two\nline three\n');
  git(root, 'add', '.gitignore', 'app.txt');
  git(root, 'commit', '-q', '-m', 'init');
  git(root, 'push', '-q', '-u', 'origin', 'main');

  const pnpm = join(base, 'fake-pnpm');
  writeFileSync(pnpm, '#!/bin/sh\nmkdir -p node_modules\n');
  const backlog = join(base, 'fake-backlog');
  writeFileSync(
    backlog,
    `#!/bin/sh
echo '{"level":30,"msg":"log line on stderr"}' >&2
case "$2" in
  11111111*) echo '{"ok":true,"data":{"uid":"${PLAN_UID}","title":"Ship the thing","kind":"PLAN","status":"open"}}' ;;
  22222222*) echo '{"ok":true,"data":{"uid":"${TASK_UID}","title":"Small task","kind":"BUG","status":"open"}}' ;;
  *) echo '{"ok":false,"error":{"code":"not_found","message":"no such item"}}'; exit 1 ;;
esac
`,
  );
  chmodSync(pnpm, 0o755);
  chmodSync(backlog, 0o755);
  const env = { WORKTREE_SETUP_PNPM: pnpm, WORKTREE_BACKLOG_CMD: backlog, WORKTREE_MERGE_GATE: 'true' };
  const sh = (script, args, extra = {}) => run('bash', [join(SCRIPTS, script), ...args], { cwd: extra.cwd ?? root, env: { ...env, ...(extra.env ?? {}) } });
  return { base, origin, root, env, sh, wt: (n) => join(root, '.worktrees', n), done: () => rmSync(base, { recursive: true, force: true }) };
}

function commitIn(dir, file, text, msg) {
  writeFileSync(join(dir, file), text);
  git(dir, 'add', file);
  git(dir, 'commit', '-q', '-m', msg);
}

// ── setup --bl ───────────────────────────────────────────────────────────────
test('setup --bl: a PLAN gets plan-<8hex> for worktree AND branch, with a real node_modules and the uid recorded', () => {
  const s = sandbox();
  try {
    const r = s.sh('worktree-setup.sh', ['--bl', '11111111']);
    assert.equal(r.status, 0, r.stderr);
    const dir = s.wt('plan-11111111');
    assert.ok(existsSync(dir));
    assert.equal(git(dir, 'branch', '--show-current'), 'plan-11111111');
    assert.equal(lstatSync(join(dir, 'node_modules')).isSymbolicLink(), false);
    assert.equal(git(s.root, 'config', '--get', 'branch.plan-11111111.adhd-backlog-uid'), PLAN_UID);
    assert.equal(git(s.root, 'config', '--get', 'branch.plan-11111111.adhd-backlog-title'), 'Ship the thing');
  } finally { s.done(); }
});

test('setup --bl: any non-PLAN kind gets task-<8hex>; an unknown id creates nothing', () => {
  const s = sandbox();
  try {
    const r = s.sh('worktree-setup.sh', ['--bl', '22222222']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(s.wt('task-22222222')));
    const bad = s.sh('worktree-setup.sh', ['--bl', 'deadbeef']);
    assert.equal(bad.status, 1);
    assert.equal(git(s.root, 'worktree', 'list').split('\n').length, 2, 'only main + the task worktree');
  } finally { s.done(); }
});

test('setup: the bare <name> form keeps its feat/<name> branch, and --bl together with <name> is a usage error', () => {
  const s = sandbox();
  try {
    assert.equal(s.sh('worktree-setup.sh', ['plain']).status, 0);
    assert.equal(git(s.wt('plain'), 'branch', '--show-current'), 'feat/plain');
    assert.equal(s.sh('worktree-setup.sh', ['--bl', '11111111', 'extra', 'HEAD']).status, 2);
  } finally { s.done(); }
});

test('cleanup: a worktree is addressable by its directory name even when the branch is feat/<name>', () => {
  const s = sandbox();
  try {
    assert.equal(s.sh('worktree-setup.sh', ['plain']).status, 0);
    const r = s.sh('worktree-cleanup.sh', ['plain']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /removed .*plain/);
    assert.equal(existsSync(s.wt('plain')), false);
  } finally { s.done(); }
});

// ── gitnexus index handling ──────────────────────────────────────────────────
/** A fake `gitnexus` first on PATH. It appends "<args> @ <cwd>" to <base>/gx.log; `--version` exits 0. */
function withFakeGitnexus(s) {
  const bin = join(s.base, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gitnexus'), `#!/bin/sh\necho "$* @ $PWD" >> "${join(s.base, 'gx.log')}"\nexit 0\n`);
  chmodSync(join(bin, 'gitnexus'), 0o755);
  return { PATH: `${bin}:${process.env.PATH}` };
}
const gxLog = (s) => (existsSync(join(s.base, 'gx.log')) ? readFileSync(join(s.base, 'gx.log'), 'utf8').trim().split('\n').filter(Boolean) : []);
const samePathStr = (a, b) => realpathSync(a) === realpathSync(b);
/** Bounded wait (no sleep-based proof: it polls for the observable with a hard deadline). */
function waitFor(pred, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); }
  return pred();
}
/** Main's .gitnexus with a marker file and meta.json recording `commit` (default: main's HEAD). */
function mainIndex(s, commit = git(s.root, 'rev-parse', 'HEAD')) {
  const dir = join(s.root, '.gitnexus');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ lastCommit: commit }));
  writeFileSync(join(dir, 'lbug'), 'graph-bytes');
  return dir;
}

test('setup: main\'s index is current for the worktree\'s commit -> it is copied and REGISTERED with `gitnexus index` (no analyze)', () => {
  const s = sandbox();
  try {
    mainIndex(s);
    const r = s.sh('worktree-setup.sh', ['--bl', '11111111'], { env: withFakeGitnexus(s) });
    assert.equal(r.status, 0, r.stderr);
    const dir = s.wt('plan-11111111');
    assert.equal(readFileSync(join(dir, '.gitnexus', 'lbug'), 'utf8'), 'graph-bytes', 'index copied');
    const log = gxLog(s);
    assert.equal(log.length, 1, `exactly one gitnexus call, got ${JSON.stringify(log)}`);
    assert.match(log[0], /^index \. @ /);
    assert.ok(samePathStr(log[0].split(' @ ')[1], dir), 'registered from inside the worktree');
    assert.match(r.stdout, /copied from main/);
  } finally { s.done(); }
});

test('setup: main\'s index is at a different commit -> NOT copied; a standard background `analyze --index-only` runs in the worktree', () => {
  const s = sandbox();
  try {
    mainIndex(s, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    const r = s.sh('worktree-setup.sh', ['--bl', '11111111'], { env: withFakeGitnexus(s) });
    assert.equal(r.status, 0, r.stderr);
    const dir = s.wt('plan-11111111');
    assert.equal(existsSync(join(dir, '.gitnexus')), false, 'stale index is not copied');
    assert.ok(waitFor(() => gxLog(s).length > 0), 'analyze started');
    const log = gxLog(s);
    assert.match(log[0], /^analyze --index-only +\. @ /);
    assert.ok(samePathStr(log[0].split(' @ ')[1], dir));
    assert.match(r.stdout, /not at this commit/);
  } finally { s.done(); }
});

test('setup: main is re-indexing (lock held) -> NOT copied, so a half-written graph can never be captured; cold analyze runs instead', () => {
  const s = sandbox();
  try {
    const idx = mainIndex(s);
    writeFileSync(join(idx, '.reindex.lock'), '4242');
    const r = s.sh('worktree-setup.sh', ['--bl', '11111111'], { env: withFakeGitnexus(s) });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(join(s.wt('plan-11111111'), '.gitnexus')), false);
    assert.ok(waitFor(() => gxLog(s).length > 0));
    assert.match(gxLog(s)[0], /^analyze --index-only/);
    assert.match(r.stdout, /re-indexing right now/);
  } finally { s.done(); }
});

test('setup: WORKTREE_SEED_GITNEXUS=0 and a missing main index never fail setup or touch gitnexus', () => {
  const s = sandbox();
  try {
    mainIndex(s);
    const off = s.sh('worktree-setup.sh', ['--bl', '11111111'], { env: { ...withFakeGitnexus(s), WORKTREE_SEED_GITNEXUS: '0' } });
    assert.equal(off.status, 0, off.stderr);
    assert.equal(existsSync(join(s.wt('plan-11111111'), '.gitnexus')), false);
    rmSync(join(s.root, '.gitnexus'), { recursive: true });
    const none = s.sh('worktree-setup.sh', ['--bl', '22222222'], { env: withFakeGitnexus(s) });
    assert.equal(none.status, 0, none.stderr);
    assert.equal(existsSync(join(s.wt('task-22222222'), '.gitnexus')), false);
    assert.equal(gxLog(s).length, 0, 'no gitnexus call at all: SEED=0 skips, and a repo whose main has no index does not use gitnexus');
  } finally { s.done(); }
});

// ── merge ────────────────────────────────────────────────────────────────────
function planWorktree(s) {
  assert.equal(s.sh('worktree-setup.sh', ['--bl', '11111111']).status, 0);
  return s.wt('plan-11111111');
}

test('merge (clean): merge commit carries the plan id and referenced items, main is pushed BEFORE cleanup, worktree + branch are gone', () => {
  const s = sandbox();
  try {
    const wt = planWorktree(s);
    commitIn(wt, 'feature.txt', 'hello\n', 'feat(x): add feature (7b7d5e38, BUG-THING-001)');
    const r = s.sh('worktree-merge.sh', ['plan-11111111']);
    assert.equal(r.status, 0, r.stderr);
    const msg = git(s.root, 'log', '-1', '--format=%B', 'main');
    assert.match(msg, /^merge\(plan-11111111\): Ship the thing/);
    assert.match(msg, new RegExp(`Backlog: ${PLAN_UID}`));
    assert.match(msg, /Refs: .*BUG-THING-001/);
    assert.match(msg, /Refs: .*7b7d5e38/);
    assert.equal(git(s.root, 'rev-parse', 'main'), git(s.root, 'rev-parse', 'origin/main'), 'pushed');
    assert.equal(git(s.origin, 'rev-parse', 'main'), git(s.root, 'rev-parse', 'main'), 'origin received it');
    assert.equal(existsSync(wt), false, 'worktree removed');
    assert.equal(run('git', ['rev-parse', '--verify', '-q', 'plan-11111111'], { cwd: s.root }).status, 1, 'branch deleted');
    assert.equal(readFileSync(join(s.root, 'feature.txt'), 'utf8'), 'hello\n');
  } finally { s.done(); }
});

test('merge: a failing gate stops before main is touched and keeps the worktree', () => {
  const s = sandbox();
  try {
    const wt = planWorktree(s);
    commitIn(wt, 'feature.txt', 'x\n', 'feat: x');
    const before = git(s.root, 'rev-parse', 'main');
    const r = s.sh('worktree-merge.sh', [wt], { env: { WORKTREE_MERGE_GATE: 'false' } });
    assert.equal(r.status, 6, r.stderr);
    assert.equal(git(s.root, 'rev-parse', 'main'), before);
    assert.ok(existsSync(wt));
  } finally { s.done(); }
});

test('merge (conflict): JSON report with commit / authored / merged dates + tickets on stdout, conflict markers left in the WORKTREE, main untouched', () => {
  const s = sandbox();
  try {
    const wt = planWorktree(s);
    commitIn(wt, 'app.txt', 'line one\nBRANCH change\nline three\n', 'fix(app): branch edit [psm:thing-1]');
    commitIn(s.root, 'app.txt', 'line one\nMAIN change\nline three\n', 'fix(app): main edit BUG-MAIN-007');
    git(s.root, 'push', '-q', 'origin', 'main');
    const mainBefore = git(s.root, 'rev-parse', 'main');
    const r = s.sh('worktree-merge.sh', ['plan-11111111']);
    assert.equal(r.status, 10, r.stderr);
    const rep = JSON.parse(r.stdout);
    assert.equal(rep.status, 'conflict');
    assert.equal(rep.branch, 'plan-11111111');
    assert.equal(rep.files.length, 1);
    const f = rep.files[0];
    assert.equal(f.path, 'app.txt');
    assert.match(f.branch[0].commit, /^[0-9a-f]{12}$/);
    assert.ok(f.branch[0].authoredAt);
    assert.equal(f.branch[0].mergedAt, null, 'branch commits are not merged anywhere yet');
    assert.deepEqual(f.branch[0].tickets, ['[psm:thing-1]']);
    assert.deepEqual(f.main[0].tickets, ['BUG-MAIN-007']);
    assert.ok(f.main[0].mergedAt, 'main side reports when it landed on main');
    assert.match(readFileSync(join(wt, 'app.txt'), 'utf8'), /<<<<<<</, 'conflict left in the worktree for repair');
    assert.equal(git(s.root, 'rev-parse', 'main'), mainBefore, 'main untouched');
    assert.ok(existsSync(wt));
  } finally { s.done(); }
});

test('merge: refuses when main has uncommitted edits to a file the branch changes, and leaves those edits alone', () => {
  const s = sandbox();
  try {
    const wt = planWorktree(s);
    commitIn(wt, 'app.txt', 'line one\nline two\nbranch tail\n', 'feat: tail');
    writeFileSync(join(s.root, 'app.txt'), 'someone else is editing this\n');
    const r = s.sh('worktree-merge.sh', ['plan-11111111']);
    assert.equal(r.status, 5, r.stderr);
    assert.match(r.stderr, /app\.txt/);
    assert.equal(readFileSync(join(s.root, 'app.txt'), 'utf8'), 'someone else is editing this\n');
  } finally { s.done(); }
});

test('merge: dirty main files the branch does NOT touch do not block the merge, and stay dirty', () => {
  const s = sandbox();
  try {
    const wt = planWorktree(s);
    commitIn(wt, 'feature.txt', 'x\n', 'feat: x');
    writeFileSync(join(s.root, 'unrelated-wip.txt'), 'wip\n');
    writeFileSync(join(s.root, '.gitignore'), readFileSync(join(s.root, '.gitignore'), 'utf8') + '# wip\n');
    const r = s.sh('worktree-merge.sh', ['plan-11111111']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(s.root, 'unrelated-wip.txt'), 'utf8'), 'wip\n');
  } finally { s.done(); }
});

test('merge: uncommitted tracked changes in the worktree are refused (exit 3)', () => {
  const s = sandbox();
  try {
    const wt = planWorktree(s);
    commitIn(wt, 'feature.txt', 'x\n', 'feat: x');
    writeFileSync(join(wt, 'app.txt'), 'dirty\n');
    const r = s.sh('worktree-merge.sh', ['plan-11111111']);
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /app\.txt/);
  } finally { s.done(); }
});

test('merge: the tracked-changes refusal also lists the untracked files, which are NOT in the merge until added', () => {
  const s = sandbox();
  try {
    const wt = planWorktree(s);
    writeFileSync(join(wt, 'app.txt'), 'modified\n');
    writeFileSync(join(wt, 'brand-new.txt'), 'new deliverable\n');
    const r = s.sh('worktree-merge.sh', ['plan-11111111']);
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /app\.txt/);
    assert.match(r.stderr, /brand-new\.txt/);
    assert.match(r.stderr, /git add/);
  } finally { s.done(); }
});

test('merge: says how many unpushed commits on main this push will publish, and publishes them', () => {
  const s = sandbox();
  try {
    const wt = planWorktree(s);
    commitIn(wt, 'feature.txt', 'x\n', 'feat: x');
    commitIn(s.root, 'other-1.txt', 'o\n', 'docs: unpushed work one');
    commitIn(s.root, 'other-2.txt', 'o\n', 'docs: unpushed work two');
    const r = s.sh('worktree-merge.sh', ['plan-11111111']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /NOTICE: main is 2 commits ahead of origin\/main/);
    const published = git(s.origin, 'log', '--format=%s', 'main');
    assert.match(published, /unpushed work one/);
    assert.match(published, /unpushed work two/);
  } finally { s.done(); }
});

test('merge: untracked folders get a strong warning and survive (cleanup keeps the tree, exit 9); ignored tmp/ does not count', () => {
  const s = sandbox();
  try {
    const wt = planWorktree(s);
    commitIn(wt, 'feature.txt', 'x\n', 'feat: x');
    mkdirSync(join(wt, 'scratch-notes'));
    writeFileSync(join(wt, 'scratch-notes', 'a.txt'), 'keep me?\n');
    mkdirSync(join(wt, 'tmp'));
    writeFileSync(join(wt, 'tmp', 'junk.txt'), 'ignored\n');
    const r = s.sh('worktree-merge.sh', ['plan-11111111']);
    assert.equal(r.status, 9, r.stderr);
    assert.match(r.stderr, /WARNING: untracked paths/);
    assert.match(r.stderr, /scratch-notes\//);
    assert.doesNotMatch(r.stderr.split('cleanup:')[0], /tmp\/junk/);
    assert.ok(existsSync(join(wt, 'scratch-notes', 'a.txt')), 'untracked data not destroyed');
    assert.equal(git(s.origin, 'rev-parse', 'main'), git(s.root, 'rev-parse', 'main'), 'the merge itself was pushed');
    assert.match(r.stderr, /--force [0-9a-f]{16}/, 'cleanup offered the force token');
  } finally { s.done(); }
});

test('merge: a rejected push keeps the local merge commit and SKIPS cleanup', () => {
  const s = sandbox();
  try {
    const hook = join(s.origin, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\necho "rejected by test hook" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    const wt = planWorktree(s);
    commitIn(wt, 'feature.txt', 'x\n', 'feat: x');
    const r = s.sh('worktree-merge.sh', ['plan-11111111']);
    assert.equal(r.status, 8, r.stderr);
    assert.match(git(s.root, 'log', '-1', '--format=%s', 'main'), /^merge\(plan-11111111\)/);
    assert.ok(existsSync(wt), 'cleanup skipped');
    assert.notEqual(git(s.root, 'rev-parse', 'main'), git(s.origin, 'rev-parse', 'main'));
  } finally { s.done(); }
});

test('merge: short-circuits at the start when main is behind origin/main (no merge, no gate)', () => {
  const s = sandbox();
  try {
    const wt = planWorktree(s);
    commitIn(wt, 'feature.txt', 'x\n', 'feat: x');
    const other = join(s.base, 'other');
    run('git', ['clone', '-q', s.origin, other]);
    git(other, 'config', 'user.email', 'o@example.com');
    git(other, 'config', 'user.name', 'O');
    commitIn(other, 'remote.txt', 'r\n', 'feat: remote');
    git(other, 'push', '-q', 'origin', 'main');
    const before = git(s.root, 'rev-parse', 'main');
    const r = s.sh('worktree-merge.sh', ['plan-11111111'], { env: { WORKTREE_MERGE_GATE: 'echo GATE-RAN >&2; true' } });
    assert.equal(r.status, 5, r.stderr);
    assert.match(r.stderr, /pull --ff-only/);
    assert.doesNotMatch(r.stderr, /GATE-RAN/);
    assert.equal(git(s.root, 'rev-parse', 'main'), before);
  } finally { s.done(); }
});

// ── cleanup ──────────────────────────────────────────────────────────────────
function mergedWorktree(s, name = 'plan-11111111') {
  assert.equal(s.sh('worktree-setup.sh', ['--bl', name.replace(/^(plan|task)-/, '')]).status, 0);
  const wt = s.wt(name);
  commitIn(wt, `${name}.txt`, 'x\n', `feat: ${name}`);
  git(s.root, 'merge', '-q', '--no-ff', '-m', `merge ${name}`, name);
  return wt;
}

test('merge: after the push, main\'s index refresh starts in main, under the shared lock, and the lock is released when it ends', () => {
  const s = sandbox();
  try {
    writeFileSync(join(s.root, '.gitignore'), '.worktrees\ntmp\nnode_modules\n.gitnexus\n');
    git(s.root, 'commit', '-q', '-am', 'ignore index'); git(s.root, 'push', '-q', 'origin', 'main');
    const idx = mainIndex(s);
    const wt = planWorktree(s);
    commitIn(wt, 'feature.txt', 'hello\n', 'feat(x): add feature');
    const r = s.sh('worktree-merge.sh', ['plan-11111111'], { env: withFakeGitnexus(s) });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr + r.stdout, /refreshing main's index in the background/);
    const refresh = () => gxLog(s).find((l) => l.startsWith('analyze --skip-agents-md --skip-skills'));
    assert.ok(waitFor(() => refresh()), `refresh ran, log: ${JSON.stringify(gxLog(s))}`);
    assert.ok(samePathStr(refresh().split(' @ ')[1], s.root), 'ran in main, not the worktree');
    assert.ok(waitFor(() => !existsSync(join(idx, '.reindex.lock'))), 'lock released when analyze ends');
  } finally { s.done(); }
});

test('merge: a lock held by another reindex means no second analyze is started, and the merge still succeeds', () => {
  const s = sandbox();
  try {
    writeFileSync(join(s.root, '.gitignore'), '.worktrees\ntmp\nnode_modules\n.gitnexus\n');
    git(s.root, 'commit', '-q', '-am', 'ignore index'); git(s.root, 'push', '-q', 'origin', 'main');
    const idx = mainIndex(s);
    writeFileSync(join(idx, '.reindex.lock'), '4242');
    const wt = planWorktree(s);
    commitIn(wt, 'feature.txt', 'hello\n', 'feat(x): add feature');
    const r = s.sh('worktree-merge.sh', ['plan-11111111'], { env: withFakeGitnexus(s) });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr + r.stdout, /already re-indexing/);
    assert.equal(gxLog(s).filter((l) => l.startsWith('analyze')).length, 0);
    assert.equal(existsSync(join(idx, '.reindex.lock')), true, 'someone else\'s lock is left alone');
  } finally { s.done(); }
});

test('cleanup: removes a merged clean worktree + its local and remote branch, selected by backlog id', () => {
  const s = sandbox();
  try {
    const wt = mergedWorktree(s);
    git(s.root, 'push', '-q', 'origin', 'plan-11111111');
    const r = s.sh('worktree-cleanup.sh', ['11111111']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /removed .*plan-11111111/);
    assert.equal(existsSync(wt), false);
    assert.equal(run('git', ['rev-parse', '--verify', '-q', 'plan-11111111'], { cwd: s.root }).status, 1);
    assert.equal(run('git', ['ls-remote', '--exit-code', '--heads', s.origin, 'plan-11111111']).status, 2, 'remote branch deleted');
  } finally { s.done(); }
});

test('cleanup: removing a worktree also unregisters its gitnexus index (`gitnexus remove <path> --force`)', () => {
  const s = sandbox();
  try {
    assert.equal(s.sh('worktree-setup.sh', ['plain']).status, 0);
    const env = withFakeGitnexus(s);
    const r = s.sh('worktree-cleanup.sh', ['plain'], { env });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const call = gxLog(s).find((l) => l.startsWith('remove '));
    assert.ok(call, `gitnexus remove was called, log: ${JSON.stringify(gxLog(s))}`);
    assert.ok(call.split(' ')[1].endsWith('/.worktrees/plain'), `removes the worktree's own path, got ${call}`);
    assert.match(call, / --force @ /);
    assert.match(r.stdout, /gitnexus index unregistered/);
  } finally { s.done(); }
});

test('cleanup: a worktree holding ignored output (node_modules, tmp/) is still clean and is removed', () => {
  const s = sandbox();
  try {
    const wt = mergedWorktree(s);
    mkdirSync(join(wt, 'tmp'));
    writeFileSync(join(wt, 'tmp', 'x.log'), 'x');
    const r = s.sh('worktree-cleanup.sh', [wt]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(existsSync(wt), false);
  } finally { s.done(); }
});

test('cleanup: a dirty merged tree is kept with a token; a stale token is rejected; the fresh token removes it', () => {
  const s = sandbox();
  try {
    const wt = mergedWorktree(s);
    writeFileSync(join(wt, 'precious.txt'), 'v1\n');
    const first = s.sh('worktree-cleanup.sh', ['plan-11111111']);
    assert.equal(first.status, 3, first.stdout);
    assert.match(first.stdout, /uncommitted: precious\.txt/);
    const token = /--force ([0-9a-f]{16})/.exec(first.stdout)?.[1];
    assert.ok(token, first.stdout);
    assert.ok(existsSync(wt));

    writeFileSync(join(wt, 'precious.txt'), 'v2 — changed after the warning\n');
    const stale = s.sh('worktree-cleanup.sh', ['--force', token, 'plan-11111111']);
    assert.equal(stale.status, 4, stale.stderr);
    assert.ok(existsSync(wt), 'stale token removes nothing');
    const fresh = /--force ([0-9a-f]{16})/.exec(stale.stderr)?.[1];
    assert.ok(fresh && fresh !== token, 'a new token is issued for the new state');

    const forced = s.sh('worktree-cleanup.sh', ['--force', fresh, 'plan-11111111']);
    assert.equal(forced.status, 0, forced.stdout + forced.stderr);
    assert.equal(existsSync(wt), false);
    const reuse = s.sh('worktree-cleanup.sh', ['--force', fresh, 'plan-11111111']);
    assert.notEqual(reuse.status, 0, 'a used token cannot be replayed');
  } finally { s.done(); }
});

test('cleanup: an UNMERGED branch is never removed, even with a valid-looking --force', () => {
  const s = sandbox();
  try {
    assert.equal(s.sh('worktree-setup.sh', ['--bl', '22222222']).status, 0);
    const wt = s.wt('task-22222222');
    commitIn(wt, 'work.txt', 'unmerged\n', 'feat: unmerged work');
    writeFileSync(join(wt, 'dirty.txt'), 'd\n');
    const r = s.sh('worktree-cleanup.sh', ['task-22222222']);
    assert.equal(r.status, 3);
    assert.match(r.stdout, /unmerged: 1 commit/);
    assert.doesNotMatch(r.stdout, /--force/, 'no token is offered for unmerged work');
    const forced = s.sh('worktree-cleanup.sh', ['--force', '0000000000000000', 'task-22222222']);
    assert.equal(forced.status, 4);
    assert.ok(existsSync(join(wt, 'work.txt')));
    assert.equal(git(s.root, 'rev-parse', '--verify', 'task-22222222').length, 40);
  } finally { s.done(); }
});

test('cleanup: with no targets it removes every cleanable tree and reports the rest; the main checkout and outside paths are never targets', () => {
  const s = sandbox();
  try {
    const merged = mergedWorktree(s, 'plan-11111111');
    assert.equal(s.sh('worktree-setup.sh', ['--bl', '22222222']).status, 0);
    commitIn(s.wt('task-22222222'), 'w.txt', 'w\n', 'feat: w');
    const r = s.sh('worktree-cleanup.sh', []);
    assert.equal(r.status, 3);
    assert.equal(existsSync(merged), false);
    assert.ok(existsSync(s.wt('task-22222222')));
    const main = s.sh('worktree-cleanup.sh', [s.root]);
    assert.match(main.stdout, /not-found/);
    assert.ok(existsSync(join(s.root, 'app.txt')), 'main checkout untouched');
  } finally { s.done(); }
});
