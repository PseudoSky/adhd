/**
 * Backlog 595965cc T32 (G4: every skip, todo and disabled marker has a tracking item and an unexpired date).
 *
 * guards: a skipped or todo test nobody tracks stays dark while the suite reads green, an expired tracking date is
 *   the same failure with a paper trail, and a scanner that reads fixtures, comments or strings as markers fails the
 *   repository for text that skips nothing.
 * tier: P (the CLI cases spawn the script and a git call runs in a temporary repository; the build-tools `node --test`
 *   lane, 10 s per test; the pure cases in this file are tier S and the file is classified by its heaviest case).
 * gap: This cannot be observed at tier S because the exit code, the stdout report and the commit read from a real
 *   repository exist only when the script runs as a process.
 * cites: 595965cc T32.AC1, T32.AC2, T32.AC3.
 * tags: regression:b87dcea0 (tier classification)
 * teeth: red: node --test tools/nx-plugins/test/executors/wiring/check-skip-expiry.spec.mjs -> exit 1; with the
 *   annotation check removed 20 cases fail, with dates never expiring 3 fail, with the baseline allowed to go stale 1 fails.
 */
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blank, collectSkipExpiry, findMarkers, isRealDate, parseAnnotation, scanSource } from './check-skip-expiry.mjs';

const require = createRequire(import.meta.url);
const { cleanGitEnv } = require('../../../lib/git-env.js');
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-skip-expiry.mjs');
const TODAY = '2026-10-14';
const NO_BASELINE = { reviewBy: null, files: {} };

let tmp;
let n = 0;
before(() => { tmp = mkdtempSync(join(tmpdir(), 'skip-expiry-')); });
after(() => { rmSync(tmp, { recursive: true, force: true }); });

/** A fixture workspace holding the given files; returns its root. */
function workspace(files) {
  const root = join(tmp, `ws-${n++}`);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}
const run = (root, extra = {}) => collectSkipExpiry(root, { baseline: NO_BASELINE, today: TODAY, ...extra });
const rules = (r) => r.violations.map((v) => v.rule);
const cli = (root, args = [], baselineFile = join(root, 'baseline.json')) =>
  spawnSync(process.execPath, [SCRIPT, '--workspace-root', root, '--baseline', baselineFile, '--today', TODAY, ...args], { encoding: 'utf8' });

describe('T32.AC1 — a marker without a tracking item and a date fails', () => {
  const SHAPES = {
    'it.skip': "it.skip('a', () => {});",
    'test.skip': "test.skip('a', () => {});",
    'describe.skip': "describe.skip('a', () => {});",
    'xit': "xit('a', () => {});",
    'it.todo': "it.todo('a');",
    'test.todo': "test.todo('a');",
    'skipIf': "it.skipIf(process.env.CI)('a', () => {});",
    'skip option': "it('a', { skip: 'no engine' }, () => {});",
    'todo option': "it('a', { todo: 'later' }, () => {});",
    'todo option with a variable': "it('a', { todo: REASON }, () => {});",
    't.skip': "it('a', (t) => { t.skip('later'); });",
  };
  for (const [name, line] of Object.entries(SHAPES)) {
    test(`T32.AC1 ${name} with no annotation fails (A-unannotated)`, () => {
      const r = run(workspace({ 'a.spec.mjs': `${line}\n` }));
      assert.deepEqual(rules(r), ['A-unannotated'], JSON.stringify(r.violations));
    });
    test(`T32.AC1 ${name} naming an item and an unexpired date passes`, () => {
      const r = run(workspace({ 'a.spec.mjs': `// backlog ca23e252 until 2026-12-31\n${line}\n` }));
      assert.deepEqual(r.violations, [], JSON.stringify(r.violations));
      assert.equal(r.report.counts.tracked, 1);
    });
  }

  test('T32.AC1 a date alone, or an item alone, is not enough', () => {
    assert.deepEqual(rules(run(workspace({ 'a.spec.mjs': "// until 2026-12-31\nit.skip('a', () => {});\n" }))), ['A-unannotated']);
    assert.deepEqual(rules(run(workspace({ 'a.spec.mjs': "// backlog ca23e252\nit.skip('a', () => {});\n" }))), ['A-unannotated']);
  });

  test('T32.AC1 the annotation may sit in the reason string of the statement', () => {
    const r = run(workspace({ 'a.spec.mjs': "it('a', { skip: 'backlog ca23e252 until 2026-12-31: no engine' }, () => {});\n" }));
    assert.deepEqual(r.violations, []);
  });

  test('T32.AC1 an annotation on a different statement does not cover this one', () => {
    const r = run(workspace({ 'a.spec.mjs': "it.skip('a', () => {}); // backlog ca23e252 until 2026-12-31\n\nconst x = 1;\nit.skip('b', () => {});\n" }));
    assert.deepEqual(rules(r), ['A-unannotated']);
    assert.match(r.violations[0].detail, /lines 4\)/);
  });

  test('T32.AC1 a skip-expiry pragma covers every marker in its file', () => {
    const r = run(workspace({ 'a.spec.mjs': "// skip-expiry: ca23e252 until 2026-12-31 the engine is not provisioned\nit.skip('a', () => {});\nit.todo('b');\nit('c', { todo: R }, () => {});\n" }));
    assert.deepEqual(r.violations, []);
    assert.equal(r.report.counts.tracked, 3);
  });

  test('T32.AC1 only test files are scanned; a marker in production code is not a marker', () => {
    const r = run(workspace({ 'src/lib.mjs': "it.skip('a');\n", 'a.spec.mjs': "it('a', () => {});\n" }));
    assert.deepEqual(r.violations, []);
    assert.equal(r.report.scannedFiles, 1);
  });

  test('T32.AC1 node_modules, dist and worktrees are never scanned', () => {
    const r = run(workspace({ 'node_modules/x/a.spec.mjs': "it.skip('a');\n", 'dist/a.spec.mjs': "it.skip('a');\n", '.worktrees/w/a.spec.mjs': "it.skip('a');\n" }));
    assert.equal(r.report.scannedFiles, 0);
  });
});

describe('T32.AC1 — text that skips nothing is not a marker', () => {
  test('T32.AC1 a marker in a line comment, block comment, string or template literal is ignored', () => {
    const src = [
      "// it.skip('a', () => {});",
      "/* it.todo('a'); */",
      "const s = \"it.skip('a')\";",
      'const t = `it.todo(\'a\') and xit(\'b\')`;',
      "it('real', () => {});",
    ].join('\n');
    assert.deepEqual(findMarkers(src), []);
  });
  test('T32.AC1 skip: false and todo: false are not markers', () => {
    assert.deepEqual(findMarkers("it('a', { skip: false }, () => {});\nit('b', { todo: false }, () => {});\n"), []);
  });
  test('T32.AC1 a skip: key outside an it/test/describe call is not a marker', () => {
    assert.deepEqual(findMarkers("const options = { skip: true };\nfoo({ todo: 'x' });\n"), []);
  });
  test('T32.AC1 line numbers survive blanking', () => {
    const src = "/* a\n   b */\n\nit.skip('a', () => {});\n";
    assert.equal(blank(src).split('\n').length, src.split('\n').length);
    assert.deepEqual(findMarkers(src), [{ kind: 'skip', line: 4 }]);
  });
});

describe('T32.AC2 — a marker past its date fails; one within its date passes', () => {
  const at = (date) => run(workspace({ 'a.spec.mjs': `// backlog ca23e252 until ${date}\nit.skip('a', () => {});\n` }));
  test('T32.AC2 yesterday fails (B-expired)', () => {
    const r = at('2026-10-13');
    assert.deepEqual(rules(r), ['B-expired']);
    assert.match(r.violations[0].detail, /before 2026-10-14/);
  });
  test('T32.AC2 today still passes; the item expires after its date', () => {
    assert.deepEqual(at(TODAY).violations, []);
  });
  test('T32.AC2 tomorrow passes', () => {
    assert.deepEqual(at('2026-10-15').violations, []);
  });
  test('T32.AC2 a date that is not on the calendar fails', () => {
    const r = at('2026-02-30');
    assert.deepEqual(rules(r), ['B-expired']);
    assert.match(r.violations[0].detail, /not a calendar date/);
  });
  test('T32.AC2 an expired pragma fails every marker it covers', () => {
    const r = run(workspace({ 'a.spec.mjs': "// skip-expiry: ca23e252 until 2026-01-01 reason\nit.skip('a', () => {});\nit.todo('b');\n" }));
    assert.deepEqual(rules(r), ['B-expired', 'B-expired']);
  });
  test('T32.AC2 the same file passes with --today before the date: the clock is an input', () => {
    const root = workspace({ 'a.spec.mjs': "// backlog ca23e252 until 2026-10-13\nit.skip('a', () => {});\n" });
    assert.deepEqual(run(root, { today: '2026-10-01' }).violations, []);
    assert.deepEqual(rules(run(root)), ['B-expired']);
  });
  test('isRealDate and parseAnnotation', () => {
    assert.equal(isRealDate('2026-02-28'), true);
    assert.equal(isRealDate('2026-02-29'), false);
    assert.equal(isRealDate('2028-02-29'), true);
    assert.deepEqual(parseAnnotation('see ca23e252 — until 2026-12-31'), { id: 'ca23e252', date: '2026-12-31' });
    assert.equal(parseAnnotation('until 2026-12-31'), null);
  });
});

describe('T32 — the legacy baseline only shrinks', () => {
  const ws = () => workspace({ 'a.spec.mjs': "it.todo('a');\nit.todo('b');\nit.skip('c', () => {});\n" });
  test('legacy markers up to the baseline pass', () => {
    const r = run(ws(), { baseline: { reviewBy: '2026-12-31', files: { 'a.spec.mjs': { todo: 2, skip: 1 } } } });
    assert.deepEqual(r.violations, []);
    assert.equal(r.report.legacyUntracked, 3);
  });
  test('one more untracked marker than the baseline allows fails (A)', () => {
    const r = run(ws(), { baseline: { reviewBy: '2026-12-31', files: { 'a.spec.mjs': { todo: 1, skip: 1 } } } });
    assert.deepEqual(rules(r), ['A-unannotated']);
  });
  test('a baseline larger than the file holds fails until it is lowered (C-baseline-stale)', () => {
    const r = run(ws(), { baseline: { reviewBy: '2026-12-31', files: { 'a.spec.mjs': { todo: 5, skip: 1 }, 'gone.spec.mjs': { todo: 1 } } } });
    assert.deepEqual(rules(r), ['C-baseline-stale', 'C-baseline-stale']);
  });
  test('past reviewBy any remaining legacy marker fails (D-baseline-expired)', () => {
    const r = run(ws(), { baseline: { reviewBy: '2026-10-13', files: { 'a.spec.mjs': { todo: 2, skip: 1 } } } });
    assert.deepEqual(rules(r), ['D-baseline-expired']);
  });
  test('an empty baseline past reviewBy is clean', () => {
    const r = run(workspace({ 'a.spec.mjs': "it('a', () => {});\n" }), { baseline: { reviewBy: '2026-10-13', files: {} } });
    assert.deepEqual(r.violations, []);
  });
});

describe('T32.AC3 — the run reports what it measured, on the commit it ran on, and records it as the baseline', () => {
  function repo(files) {
    const root = workspace(files);
    const g = (...a) => execFileSync('git', a, { cwd: root, env: cleanGitEnv(), encoding: 'utf8' }).trim();
    g('init', '-q');
    g('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'add', '-A');
    g('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'fixture');
    return { root, head: g('rev-parse', 'HEAD') };
  }
  const FILES = {
    'stub.spec.mjs': "it.todo('a');\nit.todo('b');\n",
    'mixed.spec.mjs': "it('real', () => {});\nit.todo('c');\n",
    'skipped.spec.mjs': "it.skip('d', () => {});\n",
  };

  test('T32.AC3 the report counts skip markers, todo markers and stub spec files, with the commit', () => {
    const { root, head } = repo(FILES);
    const r = run(root);
    assert.equal(r.report.commit, head);
    assert.equal(r.report.counts.skipMarkers, 1);
    assert.equal(r.report.counts.todoMarkers, 3);
    assert.equal(r.report.counts.stubSpecFiles, 1, 'stub.spec holds only todo; mixed.spec has a real test');
    assert.equal(r.report.scannedFiles, 3);
  });

  test('T32.AC3 --write-baseline records the counts and the commit; the next run is clean', () => {
    const { root, head } = repo(FILES);
    const file = join(root, 'baseline.json');
    const w = cli(root, ['--write-baseline', '--review-by', '2026-12-31'], file);
    assert.equal(w.status, 0, w.stderr);
    const b = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(b.commit, head);
    assert.equal(b.reviewBy, '2026-12-31');
    assert.deepEqual(b.counts, { skipMarkers: 1, todoMarkers: 3, stubSpecFiles: 1, tracked: 0, unannotated: 4, expired: 0 });
    assert.deepEqual(b.files, { 'mixed.spec.mjs': { todo: 1 }, 'skipped.spec.mjs': { skip: 1 }, 'stub.spec.mjs': { todo: 2 } });
    const again = cli(root, [], file);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(JSON.parse(again.stdout.trim().split('\n')[0]).legacyUntracked, 4);
  });

  test('T32.AC3 a new untracked marker after the baseline fails the CLI with exit 1 and names the file and line', () => {
    const { root } = repo(FILES);
    const file = join(root, 'baseline.json');
    assert.equal(cli(root, ['--write-baseline', '--review-by', '2026-12-31'], file).status, 0);
    writeFileSync(join(root, 'new.spec.mjs'), "it.skip('e', () => {});\n");
    execFileSync('git', ['add', 'new.spec.mjs'], { cwd: root, env: cleanGitEnv() }); // only tracked files are scanned
    const r = cli(root, [], file);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /\[A-unannotated\] new\.spec\.mjs has 1 skip marker/);
  });

  test('T32.AC3 --report writes the counts and the violations to a file', () => {
    const { root } = repo(FILES);
    const out = join(root, 'report.json');
    cli(root, ['--report', out]);
    const rep = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(rep.kind, 'skip-expiry-report');
    assert.ok(Array.isArray(rep.violations) && rep.violations.length > 0);
  });
});

describe('T32 — exit codes', () => {
  test('an unreadable baseline is exit 65, not a pass', () => {
    const root = workspace({ 'a.spec.mjs': "it('a', () => {});\n", 'baseline.json': '{not json' });
    assert.equal(cli(root).status, 65);
  });
  test('a --today that is not a date is exit 65', () => {
    const root = workspace({ 'a.spec.mjs': "it('a', () => {});\n" });
    const r = spawnSync(process.execPath, [SCRIPT, '--workspace-root', root, '--baseline', join(root, 'none.json'), '--today', 'soon'], { encoding: 'utf8' });
    assert.equal(r.status, 65);
  });
  test('a clean workspace is exit 0', () => {
    const root = workspace({ 'a.spec.mjs': "it('a', () => {});\n" });
    assert.equal(cli(root).status, 0);
  });
});

test('scanSource: a stub spec is all todo, a mixed file is not', () => {
  assert.equal(scanSource("it.todo('a');\n", TODAY).stub, true);
  assert.equal(scanSource("it('a', () => {});\nit.todo('b');\n", TODAY).stub, false);
  assert.equal(scanSource("it('a', () => {});\n", TODAY).stub, false);
});

describe('T32 blind-review findings — impossible months, regex literals, multi-line options', () => {
  test('an impossible month is not a real date and does not crash the scan (finding 3)', () => {
    assert.equal(isRealDate('2026-13-01'), false);
    assert.equal(isRealDate('2026-00-10'), false);
    const r = scanSource("// backlog ca23e252 until 2026-13-01\nit.skip('a', () => {});\n", TODAY).markers;
    assert.equal(r[0].state, 'expired');
  });

  test('a regex literal holding a quote or backtick does not hide a later marker (finding 4)', () => {
    for (const re of ['/`/', "/'/", '/"/', '/[`]/', '/a\\/`/']) {
      const src = `const re = ${re};\nit.skip('a', () => {});\n`;
      assert.equal(findMarkers(src).length, 1, re);
    }
    assert.equal(findMarkers('const x = a / b;\nit.skip("a", () => {});\nconst y = c / d;').length, 1, 'division stays division');
  });

  test('a comment above a multi-line it(..., { skip }) call annotates its option (finding 5)', () => {
    const src = "// backlog ca23e252 until 2026-12-31\nit('a', {\n  skip: 'x',\n}, () => {});\n";
    const r = scanSource(src, TODAY).markers;
    assert.equal(r.length, 1);
    assert.equal(r[0].state, 'tracked');
    const bare = scanSource("it('a', {\n  skip: 'x',\n}, () => {});\n", TODAY).markers;
    assert.equal(bare[0].state, 'unannotated');
  });
});

describe('b87dcea0 — only git-tracked test files decide the result', () => {
  test('an untracked scratch copy holding a bare marker is ignored; the same file tracked fails', () => {
    const root = workspace({ 'x/ok.spec.mjs': "it('a', () => {});\n", 'tmp/rescue/bad.spec.mjs': "it.skip('b', () => {});\n" });
    const git = (...a) => execFileSync('git', a, { cwd: root, env: cleanGitEnv(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }), encoding: 'utf8' });
    git('init', '-q');
    git('add', 'x/ok.spec.mjs');
    const clean = spawnSync(process.execPath, [SCRIPT, '--workspace-root', root, '--baseline', join(root, 'none.json'), '--today', TODAY], { encoding: 'utf8' });
    assert.equal(clean.status, 0, clean.stderr);
    git('add', 'tmp/rescue/bad.spec.mjs');
    const dirty = spawnSync(process.execPath, [SCRIPT, '--workspace-root', root, '--baseline', join(root, 'none.json'), '--today', TODAY], { encoding: 'utf8' });
    assert.equal(dirty.status, 1);
    assert.match(dirty.stderr, /tmp\/rescue\/bad\.spec\.mjs/);
  });
});


describe('c40c33e1 — scanning cost grows with the file, not with the square of it', () => {
  test('a large source full of blanked comments and slashes scans inside a fixed budget', () => {
    // Each line blanks a long comment into a run of spaces and then meets a `/`, which asks regexAllowed whether a
    // regex literal may start. Rescanning the whole output per `/` took 10.6 s of the 10.9 s the repo scan needed.
    const line = `/* ${'padding '.repeat(20)}*/ const r${'x'.repeat(10)} = total / count; // ${'note '.repeat(10)}\n`;
    const src = line.repeat(500);
    const t0 = process.hrtime.bigint();
    const { markers } = scanSource(src, TODAY);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.deepEqual(markers, []);
    assert.ok(ms < 1500, `scanning ${src.length} characters took ${Math.round(ms)} ms; the budget is 1500 ms`);
  });
});
