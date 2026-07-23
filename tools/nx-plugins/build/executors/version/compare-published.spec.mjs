/**
 * Teeth tests for compare-published.js — the version task's change detector.
 * Run: node --test tools/nx-plugins/build/executors/version/
 *
 * Each asserts a real release decision. If the normalization regresses (e.g. an
 * internal-dep version bump starts counting as a change → cascade churn; or a
 * real code change stops counting → a change ships without a bump), the matching
 * test goes red.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { comparePublishedToLocal, normalizeManifest, bumpVersion, normalizedHash } = require('./compare-published.js');

/** Materialize a package dir from a {relpath: contents} map. */
function makeDir(files) {
  const root = mkdtempSync(join(tmpdir(), 'cmp-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

const PKG = (over = {}) => JSON.stringify({
  name: '@adhd/x', version: '1.2.3', main: './index.js',
  dependencies: { 'better-sqlite3': '12.10.0', '@adhd/apigen-core-client': '^0.1.0' },
  ...over,
}, null, 2);

test('identical dist vs published -> NOT changed', () => {
  const a = makeDir({ 'package.json': PKG(), 'index.js': 'export const x=1;\n' });
  const b = makeDir({ 'package.json': PKG(), 'index.js': 'export const x=1;\n' });
  try { assert.equal(comparePublishedToLocal(a, b).changed, false); }
  finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});

test('code file differs -> changed', () => {
  const a = makeDir({ 'package.json': PKG(), 'index.js': 'export const x=2;\n' });
  const b = makeDir({ 'package.json': PKG(), 'index.js': 'export const x=1;\n' });
  try {
    const r = comparePublishedToLocal(a, b);
    assert.equal(r.changed, true);
    assert.ok(r.reasons.some((x) => x.includes('index.js')));
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});

test('only the version field differs -> NOT changed', () => {
  const a = makeDir({ 'package.json': PKG({ version: '1.2.4' }), 'index.js': 'x\n' });
  const b = makeDir({ 'package.json': PKG({ version: '1.2.3' }), 'index.js': 'x\n' });
  try { assert.equal(comparePublishedToLocal(a, b).changed, false); }
  finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});

test('only an internal @adhd/* dep RANGE differs -> NOT changed (no cascade churn)', () => {
  const a = makeDir({ 'package.json': PKG({ dependencies: { 'better-sqlite3': '12.10.0', '@adhd/apigen-core-client': '^0.2.0' } }), 'index.js': 'x\n' });
  const b = makeDir({ 'package.json': PKG({ dependencies: { 'better-sqlite3': '12.10.0', '@adhd/apigen-core-client': '^0.1.0' } }), 'index.js': 'x\n' });
  try { assert.equal(comparePublishedToLocal(a, b).changed, false); }
  finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});

test('an EXTERNAL dep change DOES count -> changed', () => {
  const a = makeDir({ 'package.json': PKG({ dependencies: { 'better-sqlite3': '13.0.0', '@adhd/apigen-core-client': '^0.1.0' } }), 'index.js': 'x\n' });
  const b = makeDir({ 'package.json': PKG(), 'index.js': 'x\n' });
  try { assert.equal(comparePublishedToLocal(a, b).changed, true); }
  finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});

test('added / removed files count as changed', () => {
  const a = makeDir({ 'package.json': PKG(), 'index.js': 'x\n', 'extra.js': 'y\n' });
  const b = makeDir({ 'package.json': PKG(), 'index.js': 'x\n' });
  try {
    assert.equal(comparePublishedToLocal(a, b).changed, true); // added extra.js
    assert.equal(comparePublishedToLocal(b, a).changed, true); // removed extra.js
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});

test('normalizeManifest strips version + all @adhd/* dep entries', () => {
  const n = normalizeManifest(JSON.parse(PKG()));
  assert.equal(n.version, undefined);
  assert.equal(n.dependencies['@adhd/apigen-core-client'], undefined);
  assert.equal(n.dependencies['better-sqlite3'], '12.10.0');
});

// ---------------------------------------------------------------------------
// normalizedHash equivalence proof (PUBLISHED-STATE-CACHE-001, Deliverable 1):
// the published-state cache stores `normalizedHash(dist)` instead of the full
// directory it's compared against. These tests prove, for every scenario
// compare-published.spec.mjs above already covers, that
//   normalizedHash(A) === normalizedHash(B)  <=>  comparePublishedToLocal(A, B).changed === false
// in BOTH directions — i.e. reverting the cache lookup to the legacy
// directory-diff path can never change a decision.
// ---------------------------------------------------------------------------

/** Assert the equivalence for one (a, b) pair in both directions. */
function assertEquivalent(a, b) {
  const legacy = comparePublishedToLocal(a, b);
  const legacyReversed = comparePublishedToLocal(b, a);
  const ha = normalizedHash(a);
  const hb = normalizedHash(b);
  assert.equal(legacy.changed, legacyReversed.changed, 'comparePublishedToLocal must itself be symmetric for these fixtures');
  assert.equal(ha === hb, !legacy.changed, `normalizedHash equality (${ha === hb}) must match "not changed" (${!legacy.changed})`);
}

test('normalizedHash equivalence: identical dist vs published -> hashes EQUAL (matches changed=false)', () => {
  const a = makeDir({ 'package.json': PKG(), 'index.js': 'export const x=1;\n' });
  const b = makeDir({ 'package.json': PKG(), 'index.js': 'export const x=1;\n' });
  try {
    assertEquivalent(a, b);
    assert.equal(normalizedHash(a), normalizedHash(b));
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});

test('normalizedHash equivalence: real code change -> hashes DIFFERENT (matches changed=true)', () => {
  const a = makeDir({ 'package.json': PKG(), 'index.js': 'export const x=2;\n' });
  const b = makeDir({ 'package.json': PKG(), 'index.js': 'export const x=1;\n' });
  try {
    assertEquivalent(a, b);
    assert.notEqual(normalizedHash(a), normalizedHash(b));
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});

test('normalizedHash equivalence: only the version field differs -> hashes EQUAL', () => {
  const a = makeDir({ 'package.json': PKG({ version: '1.2.4' }), 'index.js': 'x\n' });
  const b = makeDir({ 'package.json': PKG({ version: '1.2.3' }), 'index.js': 'x\n' });
  try {
    assertEquivalent(a, b);
    assert.equal(normalizedHash(a), normalizedHash(b));
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});

test('normalizedHash equivalence: moved internal @adhd/* dep RANGE -> hashes EQUAL (no cascade churn)', () => {
  const a = makeDir({ 'package.json': PKG({ dependencies: { 'better-sqlite3': '12.10.0', '@adhd/apigen-core-client': '^0.2.0' } }), 'index.js': 'x\n' });
  const b = makeDir({ 'package.json': PKG({ dependencies: { 'better-sqlite3': '12.10.0', '@adhd/apigen-core-client': '^0.1.0' } }), 'index.js': 'x\n' });
  try {
    assertEquivalent(a, b);
    assert.equal(normalizedHash(a), normalizedHash(b), 'a moved internal @adhd/* range must hash EQUAL — it must never look like a change to the cache');
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});

test('normalizedHash equivalence: an EXTERNAL dep change -> hashes DIFFERENT', () => {
  const a = makeDir({ 'package.json': PKG({ dependencies: { 'better-sqlite3': '13.0.0', '@adhd/apigen-core-client': '^0.1.0' } }), 'index.js': 'x\n' });
  const b = makeDir({ 'package.json': PKG(), 'index.js': 'x\n' });
  try {
    assertEquivalent(a, b);
    assert.notEqual(normalizedHash(a), normalizedHash(b));
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});

test('normalizedHash equivalence: added/removed files -> hashes DIFFERENT, both directions', () => {
  const a = makeDir({ 'package.json': PKG(), 'index.js': 'x\n', 'extra.js': 'y\n' });
  const b = makeDir({ 'package.json': PKG(), 'index.js': 'x\n' });
  try {
    assertEquivalent(a, b);
    assert.notEqual(normalizedHash(a), normalizedHash(b));
    assert.notEqual(normalizedHash(b), normalizedHash(a)); // symmetry
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});

test('normalizedHash is deterministic (same input -> same digest, repeated calls)', () => {
  const a = makeDir({ 'package.json': PKG(), 'index.js': 'export const x=1;\n', 'nested/deep.js': 'y\n' });
  try {
    const h1 = normalizedHash(a);
    const h2 = normalizedHash(a);
    assert.equal(h1, h2);
    assert.match(h1, /^sha256:[0-9a-f]{64}$/);
  } finally { rmSync(a, { recursive: true, force: true }); }
});

test('bumpVersion patch/minor/major', () => {
  assert.equal(bumpVersion('1.2.3', 'patch'), '1.2.4');
  assert.equal(bumpVersion('1.2.3', 'minor'), '1.3.0');
  assert.equal(bumpVersion('1.2.3', 'major'), '2.0.0');
  assert.throws(() => bumpVersion('1.2.3-beta.1', 'patch'));
  assert.throws(() => bumpVersion('workspace:*', 'patch'));
});
