/**
 * test-routing.e2e.mjs — 595965cc T43 (AC1-AC8): the pure functions, the real CLI as a consumer runs it, and a
 * throwaway git repository for the history-driven modes. Every negative control asserts the refusal it names; none
 * skips the failing case.
 *
 * guards: a change reaches main with no rigor record, a record below the derived rigor, or a rigor derived from the
 *   wrong commits and paths.
 * tier: P (spawns the CLI and git in temporary repositories; the build-tools `node --test` e2e (`test:build-tools-e2e`, CI only) lane, 10 s per test; the
 *   pure-function cases are tier S and the file is classified by its heaviest case).
 * gap: This cannot be observed at tier S because the commit range, the merge-base and the committer dates exist only
 *   in a real git history.
 * cites: 595965cc T43.AC1-AC8.
 * teeth: red: node --test tools/nx-plugins/test/routing/test-routing.e2e.mjs -> exit 1 for the follow-up push, the
 *   committer-date and the gate-source cases with their fixes disabled (b4bbd215); red evidence for AC1-AC8 was not
 *   captured against a stub commit (authorship was not separated).
 */
import { spawnSync, execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  CLASSES, DEFAULT_IMPLEMENTATION, NEVER_RELAXED, REPO_ROOT, checkRange, checkRecord, deriveRigor, distribution,
  globToRegExp, isBehaviorBearing, loadImplementation, parseTriggers, route,
} from './test-routing.mjs';

const require = createRequire(import.meta.url);
const { cleanGitEnv } = require('../../lib/git-env.js');
const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, 'test-routing.mjs');
const impl = loadImplementation();

const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: REPO_ROOT, encoding: 'utf8', env: cleanGitEnv() });
const json = (r) => JSON.parse(r.stdout);

const record = (fields) => `## Testing record\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')}\n`;
const base = { 'change-class': 'new-behavior', rigor: 'standard', triggers: 'none', ac: 'AC1 does the thing', 'not-testing': 'none', plan: 'x -> S -> AC1' };

test('the IMPLEMENTATION supplies the triggers: seven rows, ids and rigor from docs/standards/testing.md', () => {
  assert.deepEqual(impl.triggers.map((t) => t.id), ['boundary', 'entrypoint', 'persistence', 'security', 'published-interface', 'data-migration', 'irreversible']);
  assert.equal(impl.triggers.find((t) => t.id === 'persistence').minRigor, 'deep');
  assert.equal(impl.window, 30);
  assert.ok(impl.triggers.every((t) => t.globs.length > 0));
  assert.equal(DEFAULT_IMPLEMENTATION, impl.file);
});

test('T43.AC1: route prints one JSON object with rigor, triggers, authorship, playbook and gates', () => {
  const r = cli('route', '--class', 'new-behavior', '--scope', 'entrypoint/backlog/src/query/a.ts');
  assert.equal(r.status, 0, r.stderr);
  const out = json(r);
  for (const key of ['rigor', 'triggers', 'authorship', 'playbook', 'gates']) assert.ok(key in out, `missing ${key}`);
  assert.equal(out.rigor, 'standard');
  assert.equal(out.authorship, 'separated');
  assert.equal(out.playbook, 'author-new-behavior');
});

test('T43.AC2: a boundary-or-contract class is Deep', () => {
  const out = route({ cls: 'boundary-contract', implementation: impl, coordinator: true, testAuthor: true });
  assert.equal(out.rigor, 'deep');
  assert.equal(out.exit, 0);
});

test('T43.AC2: a refactor whose write scope hits a persistence trigger is Deep (class default Light)', () => {
  const d = deriveRigor({ cls: 'refactor', paths: ['entrypoint/backlog/src/store/sqlite.ts'], triggers: impl.triggers });
  assert.equal(d.classDefault, 'light');
  assert.equal(d.rigor, 'deep');
  assert.deepEqual(d.triggers.map((t) => t.id), ['persistence']);
});

test('T43.AC2: an unknown class exits non-zero and names the valid classes', () => {
  const r = cli('route', '--class', 'bogus');
  assert.notEqual(r.status, 0);
  assert.equal(r.status, 65);
  assert.match(JSON.parse(r.stderr).error.message, /unknown change class "bogus"/);
});

test('T43.AC3: a Light record on a Deep trigger fails the checker', () => {
  const r = checkRecord({ body: record({ ...base, 'change-class': 'refactor', rigor: 'light' }), paths: ['entrypoint/backlog/src/store/sqlite.ts'], implementation: impl });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /recorded rigor light is below the derived rigor deep/);
});

test('T43.AC3: an absent rigor record fails the checker', () => {
  const r = checkRecord({ body: 'just a description', paths: [], implementation: impl });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /rigor record is absent/);
});

test('T43.AC3: a Standard change with no "not-testing" list fails (G12), and "none" passes', () => {
  const { 'not-testing': _omit, ...without } = base;
  const failing = checkRecord({ body: record(without), paths: [], implementation: impl });
  assert.equal(failing.ok, false);
  assert.match(failing.errors.join('\n'), /no "not-testing:" list/);
  assert.equal(checkRecord({ body: record(base), paths: [], implementation: impl }).ok, true);
});

test('T43.AC3: a record whose rigor meets the derived rigor passes', () => {
  const r = checkRecord({ body: record({ ...base, 'change-class': 'refactor', rigor: 'deep', triggers: 'persistence' }), paths: ['entrypoint/backlog/src/store/sqlite.ts'], implementation: impl });
  assert.equal(r.ok, true, r.errors.join('; '));
});

test('T43.AC4: every class carries G1, G2, G4 and G12; G10 joins when an artifact ships, even for no-code', () => {
  for (const cls of Object.keys(CLASSES)) {
    const out = route({ cls, implementation: impl, coordinator: true, testAuthor: true, artifact: true });
    for (const g of NEVER_RELAXED) assert.ok(out.gates.includes(g), `${cls} lost ${g}`);
    assert.ok(out.gates.includes('G10'), `${cls} lost G10 for a shipped artifact`);
    const without = route({ cls, implementation: impl, coordinator: true, testAuthor: true });
    assert.equal(without.gates.includes('G10'), false, `${cls} gained G10 with no artifact`);
  }
});

test('T43.AC4: skipping the review and QA dispatches for class none is stated separately from the gates', () => {
  const out = route({ cls: 'no-code', paths: ['docs/notes.md'], implementation: impl });
  assert.equal(out.rigor, 'none');
  assert.deepEqual(out.dispatch.skipped, ['static-review', 'qa']);
  assert.match(out.dispatch.note, /dispatch choice/);
  for (const g of NEVER_RELAXED) assert.ok(out.gates.includes(g));
});

test('T43.AC7: no-code with a write scope touching source or test paths exits non-zero', () => {
  for (const p of ['entrypoint/backlog/src/a.ts', 'entrypoint/backlog/src/a.spec.ts']) {
    const r = cli('route', '--class', 'no-code', '--scope', p);
    assert.equal(r.status, 1, `${p}: ${r.stdout}`);
    assert.match(json(r).inconsistent[0], /no-code touches source or test paths/);
  }
});

test('T43.AC7: refactor with an added behavior-bearing file exits non-zero; an added test file does not', () => {
  const bad = cli('route', '--class', 'refactor', '--scope', 'entrypoint/backlog/src/new.ts', '--added', 'entrypoint/backlog/src/new.ts');
  assert.equal(bad.status, 1);
  assert.match(json(bad).inconsistent[0], /refactor adds behavior-bearing files/);
  const ok = cli('route', '--class', 'refactor', '--scope', 'entrypoint/backlog/src/new.spec.ts', '--added', 'entrypoint/backlog/src/new.spec.ts');
  assert.equal(ok.status, 0, ok.stdout);
});

test('T43.AC7: an asserted trigger raises the derived rigor and never lowers it', () => {
  const raised = deriveRigor({ cls: 'refactor', asserted: ['published-interface'], triggers: impl.triggers });
  assert.equal(raised.rigor, 'deep');
  assert.equal(raised.triggers[0].source, 'asserted');
  const kept = deriveRigor({ cls: 'boundary-contract', asserted: ['boundary'], triggers: impl.triggers });
  assert.equal(kept.rigor, 'deep');
  const none = deriveRigor({ cls: 'new-behavior', asserted: ['none'], triggers: impl.triggers });
  assert.equal(none.rigor, 'standard');
  assert.throws(() => deriveRigor({ cls: 'refactor', asserted: ['nonsense'], triggers: impl.triggers }), /unknown trigger "nonsense"/);
});

test('T43.AC8: Deep with no coordinator, or with no test author, exits non-zero with the reason', () => {
  const noCoordinator = cli('route', '--class', 'boundary-contract', '--test-author', 'yes');
  assert.equal(noCoordinator.status, 3);
  assert.match(json(noCoordinator).reason, /no coordinator is declared/);
  const noAuthor = cli('route', '--class', 'boundary-contract', '--coordinator', 'yes');
  assert.equal(noAuthor.status, 3);
  assert.match(json(noAuthor).reason, /no available test author is declared/);
  const both = cli('route', '--class', 'boundary-contract', '--coordinator', 'yes', '--test-author', 'yes');
  assert.equal(both.status, 0, both.stdout);
});

test('globs: ** crosses directories, * does not, and a literal dot is literal', () => {
  assert.ok(globToRegExp('**/migrations/**').test('a/b/migrations/001.sql'));
  assert.ok(globToRegExp('**/migrations/**').test('migrations/001.sql'));
  assert.ok(globToRegExp('entrypoint/*/src/index.ts').test('entrypoint/backlog/src/index.ts'));
  assert.equal(globToRegExp('entrypoint/*/src/index.ts').test('entrypoint/a/b/src/index.ts'), false);
  assert.equal(globToRegExp('a.ts').test('abts'), false);
});

test('the triggers come from the document: a different table changes the derivation', () => {
  const md = '| id | Trigger | Minimum rigor | Path patterns |\n|---|---|---|---|\n| custom | x | Deep | `only/here/**` |\n';
  const triggers = parseTriggers(md);
  assert.equal(deriveRigor({ cls: 'configuration', paths: ['only/here/a'], triggers }).rigor, 'deep');
  assert.equal(deriveRigor({ cls: 'configuration', paths: ['entrypoint/backlog/src/store/a.ts'], triggers }).rigor, 'light');
  assert.equal(parseTriggers('no table here'), null);
});

// ---- history-driven modes, against a throwaway repository -------------------------------------

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-routing-'));
  const env = cleanGitEnv(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });
  const git = (...a) => execFileSync('git', a, { cwd: dir, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  const commit = (file, message, date = '2026-10-21T10:00:00Z') => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), `${Math.random()}\n`);
    git('add', file);
    execFileSync('git', ['commit', '-q', '-m', message], { cwd: dir, env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
    return git('rev-parse', 'HEAD').trim();
  };
  return { dir, git, commit, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const withDoc = (extra) => ({ ...impl, ...extra });

test('T43.AC6: distribution derives rigor over the last N merged changes from git history, counting unrecorded', () => {
  const s = sandbox();
  try {
    s.commit('README.md', 'chore: start');
    s.commit('db/migrations/001.sql', `fix: schema\n\n${record({ ...base, 'change-class': 'refactor', rigor: 'deep', triggers: 'persistence' })}`);
    s.commit('notes.md', `docs: notes\n\n${record({ ...base, 'change-class': 'no-code', rigor: 'none' })}`);
    s.commit('lib/a.ts', `feat: a\n\n${record(base)}`);
    const d = distribution({ last: 4, implementation: impl, cwd: s.dir });
    assert.equal(d.n, 4);
    assert.deepEqual(d.distribution, { none: 1, light: 0, standard: 2, deep: 1 });
    assert.equal(d.unrecorded, 1);
    assert.equal(distribution({ last: 2, implementation: impl, cwd: s.dir }).n, 2);
  } finally { s.done(); }
});

test('T43.AC5: the range check fails a change with no record, passes one with a valid record, and exempts commits before the enforcement date', () => {
  const s = sandbox();
  try {
    const first = s.commit('README.md', 'chore: start');
    s.commit('lib/a.ts', 'feat: a with no record');
    const failing = checkRange({ range: `${first}..HEAD`, implementation: withDoc({ enforcedFrom: '2026-10-20' }), cwd: s.dir });
    assert.equal(failing.ok, false);
    assert.match(failing.errors[0], /rigor record is absent/);

    s.commit('lib/b.ts', `feat: b\n\n${record(base)}`);
    const passing = checkRange({ range: `${first}..HEAD`, implementation: withDoc({ enforcedFrom: '2026-10-20' }), cwd: s.dir });
    assert.equal(passing.ok, true, passing.errors.join('; '));

    const exempt = checkRange({ range: `${first}..HEAD`, implementation: withDoc({ enforcedFrom: '2999-01-01' }), cwd: s.dir });
    assert.equal(exempt.ok, true);
    assert.equal(exempt.exempt, true);
  } finally { s.done(); }
});

test('T43.AC5: a three-dot range is the branch\'s own change: commits and paths that only the base gained are not its', () => {
  const s = sandbox();
  try {
    const fork = s.commit('README.md', 'chore: start');
    s.git('branch', 'feat');
    s.commit('db/migrations/002.sql', 'fix: base-side migration with no record'); // main moves on after the fork
    s.git('checkout', '-q', 'feat');
    s.commit('lib/b.ts', `feat: b\n\n${record(base)}`);
    const r = checkRange({ range: 'main...feat', implementation: withDoc({ enforcedFrom: '2026-10-20' }), cwd: s.dir });
    assert.equal(r.ok, true, r.errors.join('; '));
    assert.equal(r.commits, 1, 'only the branch\'s own commit is in scope');
    assert.deepEqual(r.derived.triggers, [], 'the base-side migration is not a trigger of this change');
    assert.ok(fork);
  } finally { s.done(); }
});

test('T43.AC5 (blind-review 1): a follow-up push is judged on the branch\'s record, not only on the commits pushed since', () => {
  const s = sandbox();
  try {
    s.commit('README.md', 'chore: start');
    s.git('checkout', '-q', '-b', 'feat');
    const pushed = s.commit('lib/a.ts', `feat: a\n\n${record(base)}`);
    s.commit('lib/b.ts', 'fix: review follow-up, no record of its own');
    // the remote already holds `pushed`; the hook's range is only the new commit
    const r = checkRange({ range: `${pushed}..HEAD`, implementation: withDoc({ enforcedFrom: '2026-10-20' }), cwd: s.dir });
    assert.equal(r.ok, true, r.errors.join('; '));
    assert.ok(r.recordCommit, 'the record is found on the branch');
    // and a branch with no record anywhere still fails on the same shape of range
    s.git('checkout', '-q', 'main');
    s.git('checkout', '-q', '-b', 'bare');
    const bare = s.commit('lib/c.ts', 'feat: c with no record');
    s.commit('lib/d.ts', 'fix: d');
    const f = checkRange({ range: `${bare}..HEAD`, implementation: withDoc({ enforcedFrom: '2026-10-20' }), cwd: s.dir });
    assert.equal(f.ok, false);
    assert.match(f.errors[0], /rigor record is absent/);
  } finally { s.done(); }
});

test('T43.AC5 (blind-review 12): enforcement keys on the committer date, so a backdated author date does not exempt a commit', () => {
  const s = sandbox();
  try {
    const first = s.commit('README.md', 'chore: start', '2026-10-21T10:00:00Z');
    fs.writeFileSync(path.join(s.dir, 'lib.ts'), 'x\n');
    s.git('add', 'lib.ts');
    const env = cleanGitEnv(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-21T10:00:00Z' });
    execFileSync('git', ['commit', '-q', '-m', 'feat: backdated, no record'], { cwd: s.dir, env });
    const r = checkRange({ range: `${first}..HEAD`, implementation: withDoc({ enforcedFrom: '2026-10-20' }), cwd: s.dir });
    assert.equal(r.ok, false, 'a backdated author date must not exempt the commit');
  } finally { s.done(); }
});

test('T43.AC5: the range check runs git in the caller\'s directory, not the hook\'s repository', () => {
  const s = sandbox();
  try {
    const first = s.commit('README.md', 'chore: start');
    s.commit('lib/a.ts', 'feat: a with no record');
    const impl2 = path.join(s.dir, 'IMPLEMENTATION.md');
    fs.writeFileSync(impl2, `${fs.readFileSync(DEFAULT_IMPLEMENTATION, 'utf8')}\nEnforced from: 2026-10-20\n`);
    // the CLI is launched from the sandbox: the range exists only there, so a REPO_ROOT-bound git would exit 65
    const r = spawnSync(process.execPath, [CLI, 'check', '--range', `${first}..HEAD`, '--implementation', impl2], { cwd: s.dir, encoding: 'utf8', env: cleanGitEnv() });
    assert.equal(r.status, 1, r.stderr);
    assert.match(JSON.parse(r.stdout).errors[0], /rigor record is absent/);
  } finally { s.done(); }
});

test('T43.AC5: the CLI check mode exits 1 on a seeded Light record over a Deep trigger and 0 on the corrected record', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-routing-rec-'));
  try {
    const bad = path.join(dir, 'bad.md');
    const good = path.join(dir, 'good.md');
    fs.writeFileSync(bad, record({ ...base, 'change-class': 'refactor', rigor: 'light' }));
    fs.writeFileSync(good, record({ ...base, 'change-class': 'refactor', rigor: 'deep', triggers: 'persistence' }));
    const scope = ['--scope', 'entrypoint/backlog/src/store/sqlite.ts'];
    assert.equal(cli('check', '--record-file', bad, ...scope).status, 1);
    assert.equal(cli('check', '--record-file', good, ...scope).status, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('T43 (blind-review 10): gate source under tools/nx-plugins/test/ is behavior-bearing; spec files and test dirs elsewhere are not', () => {
  assert.equal(isBehaviorBearing('tools/nx-plugins/test/routing/test-routing.mjs'), true);
  assert.equal(isBehaviorBearing('tools/nx-plugins/test/gates/run-gates.mjs'), true);
  assert.equal(isBehaviorBearing('tools/nx-plugins/test/gates/run-gates.spec.mjs'), false);
  assert.equal(isBehaviorBearing('entrypoint/backlog/src/test/helpers/ci-env.ts'), false);
  assert.equal(isBehaviorBearing('entrypoint/backlog/src/store/a.ts'), true);
});
