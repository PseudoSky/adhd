/**
 * check-test-headers.e2e.mjs — 595965cc T34 (G9 header lint, the header half of G12), prompted by b87dcea0.
 *
 * guards: a test is filed under a lighter tier than the code does (a spawning spec headed tier S), a tier P, H or X
 *   test has no fidelity-gap statement, or a new test has no header, and nobody notices because the claim is prose.
 * tier: P (the CLI cases spawn the script; the build-tools `node --test` e2e (`test:build-tools-e2e`, CI only) lane, 10 s per test; the judge cases are
 *   tier S and the file is classified by its heaviest case).
 * gap: This cannot be observed at tier S because the exit code and the report on stdout exist only when the script
 *   runs as a process over a real directory tree.
 * cites: 595965cc T34; b87dcea0.
 * teeth: red: node --test tools/nx-plugins/test/executors/wiring/check-test-headers.e2e.mjs -> exit 1 with the H4
 *   rule removed (the spawn-in-tier-S cases fail), with H3 removed (the gap cases fail), with the baseline allowed to
 *   go stale (the shrink case fails).
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { evaluate, headerOf, judge, spawnsProcess } from './check-test-headers.mjs';

const { cleanGitEnv } = createRequire(import.meta.url)('../../../lib/git-env.js');

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-test-headers.mjs');
const hdr = (lines) => `/**\n${lines.map((l) => ` * ${l}`).join('\n')}\n */\n`;
const GOOD_S = ['guards: a duplicate id is rejected', 'tier: S', 'cites: ITEM-1 AC1'];
const GAP = 'gap: This cannot be observed at tier S because the exit code exists only in a process.';
const SPAWN = "import { spawnSync } from 'node:child_process';\nspawnSync('git', ['status']);\n";

describe('b87dcea0 — the header is read, and the tier is judged against the code', () => {
  test('a complete tier S header on a pure file passes', () => {
    assert.deepEqual(judge(`${hdr(GOOD_S)}import x from 'y';\n`), []);
  });

  test('H1: a missing header, or one without guards, tier or cites', () => {
    assert.deepEqual(judge("import x from 'y';\n"), ['H1']);
    assert.deepEqual(judge(hdr(['guards: g', 'tier: S'])), ['H1']);
  });

  test('H2: a tier that is not S, P, H or X', () => {
    assert.ok(judge(hdr(['guards: g', 'tier: Q', 'cites: c'])).includes('H2'));
  });

  test('H3: tier P, H and X need a fidelity-gap statement naming a concrete property', () => {
    assert.ok(judge(hdr(['guards: g', 'tier: P', 'cites: c'])).includes('H3'));
    assert.ok(judge(hdr(['guards: g', 'tier: P', 'cites: c', 'gap: more realistic'])).includes('H3'), 'a bare claim is not a gap');
    assert.deepEqual(judge(hdr(['guards: g', 'tier: P', 'cites: c', GAP])), []);
  });

  test('H4: a spawning file headed tier S fails; the same file headed tier P with a gap passes (b87dcea0)', () => {
    assert.deepEqual(judge(hdr(GOOD_S) + SPAWN), ['H4']);
    assert.deepEqual(judge(hdr(['guards: g', 'tier: P', 'cites: c', GAP]) + SPAWN), []);
  });

  test('a comment, a string or a regex that mentions spawning is not spawning', () => {
    const body = "// spawnSync('git')\nconst s = \"execSync('x')\";\nconst r = /spawn\\(/;\nconst m = /a(b)/.exec(s);\n";
    assert.equal(spawnsProcess(`import { spawnSync } from 'node:child_process';\n${body}`), false);
    assert.equal(spawnsProcess(body), false, 'no child_process import: regex.exec is not a process');
    assert.equal(spawnsProcess(SPAWN), true);
  });

  test('headerOf reads both comment styles and stops at the first block', () => {
    assert.match(headerOf('// guards: g\n// tier: S\nconst x = 1;\n'), /tier: S/);
    assert.doesNotMatch(headerOf(`${hdr(GOOD_S)}/* later */\n`), /later/);
  });
});

describe('b87dcea0 — the baseline only shrinks', () => {
  test('a violation the baseline does not record fails; a recorded one passes', () => {
    assert.equal(evaluate({ 'a.spec.ts': ['H1'] }, { files: {} }).length, 1);
    assert.equal(evaluate({ 'a.spec.ts': ['H1'] }, { files: { 'a.spec.ts': ['H1'] } }).length, 0);
  });

  test('a baselined violation that no longer occurs fails until the baseline is lowered', () => {
    const v = evaluate({}, { files: { 'a.spec.ts': ['H1'] } });
    assert.equal(v.length, 1);
    assert.match(v[0].detail, /no longer violates H1/);
  });

  test('a new rule on a baselined file still fails (the baseline records rules, not files)', () => {
    assert.equal(evaluate({ 'a.spec.ts': ['H1', 'H4'] }, { files: { 'a.spec.ts': ['H1'] } }).length, 1);
  });
});

describe('b87dcea0 — the CLI', () => {
  const ws = (files) => {
    const root = mkdtempSync(join(tmpdir(), 'test-headers-'));
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    return root;
  };
  const run = (root, extra = []) => spawnSync(process.execPath, [SCRIPT, '--workspace-root', root, '--baseline', join(root, 'b.json'), ...extra], { encoding: 'utf8' });

  test('exit 1 naming the file for a spawning tier S spec, exit 0 once the tier is corrected', () => {
    const root = ws({ 'x/a.spec.mjs': hdr(GOOD_S) + SPAWN });
    try {
      const bad = run(root);
      assert.equal(bad.status, 1);
      assert.match(bad.stderr, /x\/a\.spec\.mjs violates H4/);
      // corrected tier P belongs in the e2e lane by name (H5), so the corrected file is a.e2e.mjs
      rmSync(join(root, 'x/a.spec.mjs'));
      writeFileSync(join(root, 'x/a.e2e.mjs'), hdr(['guards: g', 'tier: P', 'cites: c', GAP]) + SPAWN);
      assert.equal(run(root).status, 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('--write-baseline records today\'s violations and the next run is clean; a bad argument exits 65', () => {
    const root = ws({ 'x/legacy.spec.mjs': 'it();\n' });
    try {
      assert.equal(run(root).status, 1);
      assert.equal(run(root, ['--write-baseline']).status, 0);
      assert.equal(run(root).status, 0);
      assert.equal(run(root, ['--bogus']).status, 65);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('the real repository is clean against its committed baseline', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  });

  test('only git-tracked test files decide the result: an untracked scratch copy is ignored, the same file tracked fails', () => {
    const root = ws({ 'x/ok.spec.mjs': hdr(GOOD_S), 'tmp/rescue/bad.spec.mjs': 'it();\n' });
    const git = (...a) => execFileSync('git', a, { cwd: root, env: cleanGitEnv(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }), encoding: 'utf8' });
    try {
      git('init', '-q');
      git('add', 'x/ok.spec.mjs');
      assert.equal(run(root).status, 0, 'the untracked tmp/rescue copy is not scanned');
      git('add', 'tmp/rescue/bad.spec.mjs');
      const r = run(root);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /tmp\/rescue\/bad\.spec\.mjs violates H1/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

