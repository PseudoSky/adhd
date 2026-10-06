/**
 * 65788fd8 D-AC4 — the three evidence tools, each driven as a REAL child process
 * against a real throwaway git repo, each with a NEGATIVE CONTROL: the same
 * assertions run against a deliberately-broken copy of the script and must go red.
 * Copies live under os.tmpdir() and are removed in `finally`.
 *
 *   check-suite-tree-state  (5b759112, 53ec220e)  fails when a suite leaves the tree dirty
 *   commit-mine             (27fc3814)            stages only author-owned paths, new files included
 *   audit-closed-items      (2e8f9646)            reports resolved items lacking a commit citation
 *
 * Run: node --test tools/evidence/evidence.spec.mjs   (nx run @adhd/source:evidence-gates)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = {
  tree: join(here, 'check-suite-tree-state.mjs'),
  mine: join(here, 'commit-mine.mjs'),
  audit: join(here, 'audit-closed-items.mjs'),
};
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });
const git = (cwd, ...args) => sh('git', args, { cwd });

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'evidence-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'user.name', 'T');
  writeFileSync(join(root, 'tracked.txt'), 'a\n');
  writeFileSync(join(root, 'foreign.txt'), 'f\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}

/** A broken copy of `script` with `from` replaced by `to`; the mutation must actually change it. */
function mutated(script, from, to) {
  const src = readFileSync(script, 'utf8');
  const next = src.replace(from, to);
  assert.notEqual(next, src, `mutation ${String(from)} must change the script`);
  // realpath: the scripts' `is main` check compares import.meta.url (symlinks resolved) to argv[1]
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'evidence-wrong-')));
  const path = join(dir, 'wrong.mjs');
  writeFileSync(path, next);
  return { path, dir };
}

// ── check-suite-tree-state ──────────────────────────────────────────────────
function assertTreeStateGate(script) {
  const root = repo();
  try {
    const clean = sh(process.execPath, [script, '--', process.execPath, '-e', '0'], { cwd: root });
    assert.equal(clean.status, 0, `a clean suite passes: ${clean.stderr}`);
    assert.match(clean.stderr, /tree-state: HEAD [0-9a-f]+ \| dirty-before 0 \| dirty-after 0 \| delta 0 \| cache-replay: no/);
    const dirty = sh(process.execPath, [script, '--', process.execPath, '-e', "require('fs').writeFileSync('leak.txt','x')"], { cwd: root });
    assert.equal(dirty.status, 1, 'a suite that leaves the tree dirty must fail');
    assert.match(dirty.stderr, /leak\.txt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('65788fd8 D-AC4 check-suite-tree-state: passes a clean suite, fails a suite that leaves the tree dirty, passes through the suite exit code', () => {
  assertTreeStateGate(SCRIPTS.tree);
  const root = repo();
  try {
    const failing = sh(process.execPath, [SCRIPTS.tree, '--', process.execPath, '-e', 'process.exit(7)'], { cwd: root });
    assert.equal(failing.status, 7);
    assert.equal(sh(process.execPath, [SCRIPTS.tree], { cwd: root }).status, 2, 'usage error');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('65788fd8 D-AC4 check-suite-tree-state: a cached replay is LABELLED, and --fresh rejects it (53ec220e)', () => {
  const root = repo();
  try {
    const replay = ['-e', "console.log('[local cache] replayed')"];
    const labelled = sh(process.execPath, [SCRIPTS.tree, '--', process.execPath, ...replay], { cwd: root });
    assert.equal(labelled.status, 0);
    assert.match(labelled.stderr, /cache-replay: yes/);
    const fresh = sh(process.execPath, [SCRIPTS.tree, '--fresh', '--', process.execPath, ...replay], { cwd: root });
    assert.equal(fresh.status, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('65788fd8 D-AC4 check-suite-tree-state NEGATIVE CONTROL: a copy whose dirty-delta check is removed lets the dirty suite through and trips the assertions', () => {
  const m = mutated(SCRIPTS.tree, 'if (delta.length > 0) {', 'if (false) {');
  try {
    assert.throws(() => assertTreeStateGate(m.path), /must fail/);
  } finally {
    rmSync(m.dir, { recursive: true, force: true });
  }
});

// ── commit-mine ─────────────────────────────────────────────────────────────
function assertCommitMine(script) {
  const root = repo();
  try {
    // Someone else's in-flight edit exists BEFORE my baseline.
    writeFileSync(join(root, 'foreign.txt'), 'someone else is editing\n');
    assert.equal(sh(process.execPath, [script, 'snapshot'], { cwd: root }).status, 0);
    // My work: edit a tracked file AND create a brand-new untracked file.
    writeFileSync(join(root, 'tracked.txt'), 'mine\n');
    writeFileSync(join(root, 'new-file.txt'), 'brand new\n');
    const res = sh(process.execPath, [script, 'commit', '-m', 'feat: mine'], { cwd: root });
    assert.equal(res.status, 0, res.stderr);
    const files = git(root, 'show', '--name-only', '--format=', 'HEAD').stdout.split('\n').filter(Boolean).sort();
    assert.deepEqual(files, ['new-file.txt', 'tracked.txt'], 'the commit holds exactly my paths, new untracked file included');
    const status = git(root, 'status', '--porcelain').stdout;
    assert.match(status, / M foreign\.txt/, "the other agent's edit stays uncommitted");
    assert.doesNotMatch(status, /new-file|tracked\.txt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('65788fd8 D-AC4 commit-mine: stages only author-owned paths (new files included) and leaves foreign edits alone', () => {
  assertCommitMine(SCRIPTS.mine);
  const root = repo();
  try {
    assert.equal(sh(process.execPath, [SCRIPTS.mine, 'commit', '-m', 'x'], { cwd: root }).status, 2, 'no baseline: refuses');
    sh(process.execPath, [SCRIPTS.mine, 'snapshot'], { cwd: root });
    const none = sh(process.execPath, [SCRIPTS.mine, 'commit', '-m', 'x'], { cwd: root });
    assert.equal(none.status, 0);
    assert.match(none.stderr, /nothing of yours/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('65788fd8 D-AC4 commit-mine NEGATIVE CONTROL: a copy blind to untracked files (the 27fc3814 defect) drops the new file and trips the assertion', () => {
  const m = mutated(SCRIPTS.mine, "'--untracked-files=all'", "'--untracked-files=no'");
  try {
    assert.throws(() => assertCommitMine(m.path), /exactly my paths/);
  } finally {
    rmSync(m.dir, { recursive: true, force: true });
  }
});

// ── audit-closed-items ──────────────────────────────────────────────────────
function assertAudit(script) {
  const root = repo();
  const dir = mkdtempSync(join(tmpdir(), 'evidence-items-'));
  try {
    const sha = git(root, 'rev-parse', 'HEAD').stdout.trim();
    const items = [
      { uid: 'aaaaaaaa-1', title: 'cited', status: 'resolved', citations: [{ file: 'x', context: `fixed in ${sha.slice(0, 10)}` }] },
      { uid: 'bbbbbbbb-2', title: 'no citation', status: 'resolved', citations: [], auditTrail: [] },
      { uid: 'cccccccc-3', title: 'fake sha', status: 'closed', citations: [{ file: 'x', context: 'fixed in deadbeefcafe' }] },
      { uid: 'dddddddd-4', title: 'still open', status: 'open', citations: [] },
      { uid: 'eeeeeeee-5', title: 'trail note', status: 'resolved', auditTrail: [{ note: `commit ${sha}` }] },
    ];
    const file = join(dir, 'items.json');
    writeFileSync(file, JSON.stringify({ ok: true, data: { items } }));
    const r = sh(process.execPath, [script, '--input', file, '--repo', root]);
    assert.equal(r.status, 1, 'uncited resolved items make the audit fail');
    assert.match(r.stderr, /4 resolved\/closed item\(s\) audited, 2 without a commit citation/);
    assert.match(r.stderr, /bbbbbbbb/);
    assert.match(r.stderr, /cccccccc.*does not resolve to a commit/);
    assert.doesNotMatch(r.stderr, /aaaaaaaa|dddddddd|eeeeeeee/);
    writeFileSync(file, JSON.stringify(items.filter((i) => ['aaaaaaaa-1', 'eeeeeeee-5', 'dddddddd-4'].includes(i.uid))));
    assert.equal(sh(process.execPath, [script, '--input', file, '--repo', root]).status, 0, 'all cited: passes');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
}

test('65788fd8 D-AC4 audit-closed-items: reports resolved/closed items lacking a RESOLVABLE commit citation; open items are ignored', () => {
  assertAudit(SCRIPTS.audit);
});

test('65788fd8 D-AC4 audit-closed-items NEGATIVE CONTROL: a copy that counts any sha-like text (the 2e8f9646 grep-hit defect) accepts the fake sha and trips the assertion', () => {
  const m = mutated(SCRIPTS.audit, 'if ([...candidates].some(isCommit)) continue;', 'if (candidates.size > 0) continue;');
  try {
    assert.throws(() => assertAudit(m.path), /2 without a commit citation|does not resolve/);
  } finally {
    rmSync(m.dir, { recursive: true, force: true });
  }
});

// ── D-AC5: backlog-remediation keys on uid; S0 coverage is computable ───────
const REPO = join(here, '..', '..');
const S0 = join(REPO, '.claude/skills/backlog-remediation/s0-coverage.mjs');
const SKILL = join(REPO, '.claude/skills/backlog-remediation/SKILL.md');

function assertS0Gate(script) {
  const dir = mkdtempSync(join(tmpdir(), 's0-'));
  try {
    const items = [
      { uid: 'u1', project: 'p', component: 'c', kind: 'bug' },
      { uid: 'u2', project: 'p', component: 'c', kind: 'bug' },
      { uid: 'u3', project: 'p', component: null }, // no kind: must still be covered
    ];
    const file = join(dir, 'items.json');
    writeFileSync(file, JSON.stringify(items));
    const out = join(dir, 'run');
    const r = sh(process.execPath, [script, '--input', file, '--out', out]);
    assert.equal(r.status, 0, `S0 must pass on full coverage: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /S0 coverage: 3\/3 \(100\.0%\) duplicates=0 clusters=2/);
    const clusters = JSON.parse(readFileSync(join(out, 'clusters.json'), 'utf8'));
    assert.deepEqual(Object.values(clusters).flat().sort(), ['u1', 'u2', 'u3']);
    const dry = sh(process.execPath, [script, '--input', file, '--out', join(dir, 'dry'), '--dry-run']);
    assert.equal(dry.status, 0);
    assert.match(dry.stdout, /S0 coverage: 3\/3/, 'a dry run prints the number');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('025d3239 D-AC5: the remediation skill keys on uid (no humanId) and its S0 coverage gate is computable (dry run prints a number)', () => {
  const skill = readFileSync(SKILL, 'utf8');
  assert.doesNotMatch(skill, /humanId/, 'the removed key must not appear');
  assert.match(skill, /\{"<cluster>": \["<uid>"/);
  assert.match(skill, /s0-coverage\.mjs --dry-run/);
  assertS0Gate(S0);
});

test('025d3239 D-AC5: the pure gate flags a missing uid, an unexpected uid and a duplicate', async () => {
  const { assertCoverage } = await import(S0);
  assert.equal(assertCoverage({ a: ['u1', 'u2'] }, ['u1', 'u2']).ok, true);
  assert.deepEqual(assertCoverage({ a: ['u1'] }, ['u1', 'u2']).missing, ['u2']);
  assert.deepEqual(assertCoverage({ a: ['u1', 'u9'] }, ['u1']).extra, ['u9']);
  assert.deepEqual(assertCoverage({ a: ['u1'], b: ['u1'] }, ['u1']).duplicates, ['u1']);
});

test('025d3239 D-AC5 NEGATIVE CONTROL: a clusterer that drops kind-less items (the silent-drop S0 exists to catch) fails the gate', () => {
  const m = mutated(S0, '(clusters[clusterKey(item)] ??= []).push(item.uid);', 'if (item.kind) (clusters[clusterKey(item)] ??= []).push(item.uid);');
  try {
    assert.throws(() => assertS0Gate(m.path), /S0 must pass on full coverage/);
  } finally {
    rmSync(m.dir, { recursive: true, force: true });
  }
});

// ── D-AC6: the refuted spec-lanes count is gone from the cited docs ─────────
const REFUTED = /43 spawn-based specs|across 13 projects/;
const CITED_DOCS = ['docs/plan/backlog-completion/HANDOFF.md', 'docs/plan/backlog-completion/TASKS.md'];

test('f613472b D-AC6: the refuted "43 spawn-based specs across 13 projects" count appears in neither cited doc', () => {
  for (const rel of CITED_DOCS) assert.doesNotMatch(readFileSync(join(REPO, rel), 'utf8'), REFUTED, rel);
});

test('f613472b D-AC6 NEGATIVE CONTROL: the scan matches the old text', () => {
  assert.match('- Test-lane pattern applied nowhere; 43 spawn-based specs across 13 projects.', REFUTED);
});
