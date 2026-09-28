/**
 * Teeth tests for the PII / data-dump layer of `check-no-credentials.js`.
 *
 * Motivating incident: a real 9,820,552-byte dating-app export was committed as
 * a JSON test fixture. The credential scanner never saw it — `sanitize()` skips
 * files > 4 MiB and the per-line loop skips lines > 4096 chars, and the file
 * was a single-line 9.8 MB blob. These tests prove the new pass catches the
 * exact SHAPE that leaked, and that ordinary source does NOT trip it.
 *
 * Unit-tests `lib/pii-rules.js` directly, then drives the REAL CLI against a
 * disposable git repo under `os.tmpdir()` (staged index), asserting the exit
 * code AND that the block names a `pii:` rule (so a pass/fail is not
 * accidentally attributable to gitleaks).
 *
 * Run: `node --test .githooks/check-no-credentials.spec.mjs`
 * (also wired into `pnpm test:build-tools` — see package.json).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pii = require('./lib/pii-rules.js');
const SCANNER = fileURLToPath(new URL('./check-no-credentials.js', import.meta.url));

/** A single-line JSON export of 30 person records with sensitive fields. */
function personDump() {
  const recs = [];
  for (let i = 0; i < 30; i++) {
    recs.push({
      _id: `id-${i}`,
      person: {
        name: `Person ${i}`,
        birth_date: `199${i % 10}-0${(i % 9) + 1}-1${i % 10}`,
        gender: i % 2 ? 'M' : 'F',
        bio: `Hello from person ${i}`,
      },
      messages: [{ text: `hey ${i}` }],
    });
  }
  return JSON.stringify(recs); // no indent -> ONE very long line
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'pii-scan-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'teeth');
  g('commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}

/** Run the real CLI against `dir`; returns {status, stdout, stderr}. */
function runCli(dir, args) {
  const r = spawnSync('node', [SCANNER, ...args], { cwd: dir, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// ── unit: the shape that actually leaked ─────────────────────────────────────
test('pii: catches a structured person-record dump (the leaked shape)', () => {
  const rules = pii.scanContent(personDump()).map((f) => f.rule);
  assert.ok(rules.includes('pii:structured-person-dump'), `got ${rules}`);
});

test('pii: catches a known third-party data host', () => {
  const rules = pii.scanContent('{"photo":"https://images-ssl.gotinder.com/abc/x.jpg"}')
    .map((f) => f.rule);
  assert.ok(rules.includes('pii:vendor-data-domain'), `got ${rules}`);
});

test('pii: does NOT flag ordinary source with a mention of an email/phone', () => {
  const src = [
    "export const author = 'dev@example.com';",
    "// contact: dev@example.com, +14155552671",
    "interface User { name: string; gender: string; }",
  ].join('\n');
  assert.deepEqual(pii.scanContent(src), []);
});

test('pii: flags a card in context, ignores a mistyped one and UUID fragments', () => {
  assert.ok(pii.scanContent('card_number: 4111 1111 1111 1111')
    .some((f) => f.rule === 'pii:credit-card'));
  assert.ok(!pii.scanContent('card_number: 4111 1111 1111 1112')
    .some((f) => f.rule === 'pii:credit-card'));
  // A UUID fragment is Luhn-valid (all zeros) but has no card context.
  assert.ok(!pii.scanContent('id = "00000000-0000-0000-"')
    .some((f) => f.rule === 'pii:credit-card'));
});

test('pii: flags a valid-shaped SSN, ignores the reserved 000 area', () => {
  assert.ok(pii.scanContent('ssn 321-54-9876').some((f) => f.rule === 'pii:us-ssn'));
  assert.ok(!pii.scanContent('ssn 000-12-3456').some((f) => f.rule === 'pii:us-ssn'));
});

test('pii: flags a mod-97-valid IBAN', () => {
  assert.ok(pii.scanContent('iban DE89370400440532013000 end')
    .some((f) => f.rule === 'pii:iban'));
});

test('pii: email density fires at >=25 distinct, not at 3', () => {
  const many = Array.from({ length: 25 }, (_, i) => `u${i}@example.com`).join(' ');
  assert.ok(pii.scanContent(many).some((f) => f.rule === 'pii:email-dump'));
  assert.ok(!pii.scanContent('a@x.com b@x.com c@x.com').some((f) => f.rule === 'pii:email-dump'));
});

test('pii: shape flags a newly-ADDED large file, not a modified one', () => {
  const big = 2 * 1024 * 1024;
  assert.ok(pii.scanShape({ path: 'x', status: 'A', size: big })
    .some((f) => f.rule === 'pii:large-added-file'));
  assert.deepEqual(pii.scanShape({ path: 'x', status: 'M', size: big }), []);
});

// ── integration: the REAL CLI, staged index ─────────────────────────────────
test('cli: blocks a staged single-line person dump via a pii: rule', () => {
  const dir = makeRepo();
  try {
    const dump = personDump();
    // Prove the credential pass alone could not have caught it: it is one line
    // far longer than the 4096-char skip threshold in the per-line loop.
    assert.ok(dump.length > 4096 && !dump.includes('\n'));
    writeFileSync(join(dir, 'export.json'), dump);
    execFileSync('git', ['add', 'export.json'], { cwd: dir });
    const { status, stderr } = runCli(dir, ['--staged']);
    assert.equal(status, 1, `expected block, got ${status}\n${stderr}`);
    assert.match(stderr, /pii:structured-person-dump/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: a deliberate fixture with the file-level pragma is allowed', () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, 'fixture.json'), `// pragma: allowlist pii\n${personDump()}`);
    execFileSync('git', ['add', 'fixture.json'], { cwd: dir });
    const { status, stderr } = runCli(dir, ['--staged']);
    assert.equal(status, 0, `expected pass, got ${status}\n${stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: ordinary staged source passes', () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, 'index.ts'), "export const x = 1; // dev@example.com\n");
    execFileSync('git', ['add', 'index.ts'], { cwd: dir });
    const { status, stderr } = runCli(dir, ['--staged']);
    assert.equal(status, 0, `expected pass, got ${status}\n${stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
