/**
 * Teeth tests for reconcile-core.js — the integrity-gated npm backfill core
 * (PUBLISHED-STATE-CACHE-001, Deliverable 4).
 *
 * Mocking boundary: ONLY `../../lib/npm-registry` (the network/tarball
 * boundary) is mocked. `normalizedHash` (compare-published.js) and all file
 * I/O run for real against real temp directories, so a regression in the
 * hash computation or the gate's branching logic would still be caught here.
 *
 * Run: node --test tools/nx-plugins/build/executors/reconcile/reconcile-core.spec.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const registryAbs = require.resolve('../../lib/npm-registry.js');
const coreAbs = require.resolve('./reconcile-core.js');

function makeDir(files) {
  const root = mkdtempSync(join(tmpdir(), 'reconcile-core-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

/** Install a fake npm-registry module in the require cache, then load a fresh reconcile-core against it. */
function loadWithMockedRegistry(mockRegistry) {
  delete require.cache[coreAbs];
  delete require.cache[registryAbs];
  require.cache[registryAbs] = { id: registryAbs, filename: registryAbs, loaded: true, exports: mockRegistry };
  return require(coreAbs);
}

const PKG = JSON.stringify({ name: '@adhd/x', version: '1.0.0', main: './index.js', dependencies: {} }, null, 2);

test('pending: package not yet on npm -> status "pending", no tarball pull, no entry', () => {
  const distDir = makeDir({ 'package.json': PKG, 'index.js': 'x\n' });
  const { reconcilePackage } = loadWithMockedRegistry({
    publishedVersions: () => [],
    fetchPublishedIntegrity: () => { throw new Error('must not be called when not yet published'); },
    fetchPublished: () => { throw new Error('must not be called when not yet published'); },
    packLocalDir: () => { throw new Error('must not be called when not yet published'); },
    tarballIntegrity: () => { throw new Error('must not be called when not yet published'); },
  });
  try {
    const result = reconcilePackage({ name: '@adhd/x', version: '1.0.0', distDir, workDir: '/tmp/unused' });
    assert.equal(result.status, 'pending');
    assert.equal(result.tarballPulled, false);
    assert.equal(result.entry, undefined);
  } finally { rmSync(distDir, { recursive: true, force: true }); }
});

test('fast path: local pack integrity MATCHES published dist.integrity -> no tarball pull, caches normalizedHash(local)', () => {
  const distDir = makeDir({ 'package.json': PKG, 'index.js': 'x\n' });
  let fetchPublishedCalled = false;
  const { reconcilePackage } = loadWithMockedRegistry({
    publishedVersions: () => ['1.0.0'],
    fetchPublishedIntegrity: () => 'sha512-MATCH',
    fetchPublished: () => { fetchPublishedCalled = true; return null; },
    packLocalDir: () => '/fake/local.tgz',
    tarballIntegrity: (p) => (p === '/fake/local.tgz' ? 'sha512-MATCH' : 'sha512-WRONG'),
  });
  try {
    const result = reconcilePackage({ name: '@adhd/x', version: '1.0.0', distDir, workDir: '/tmp/unused' });
    assert.equal(result.status, 'fast');
    assert.equal(result.tarballPulled, false);
    assert.equal(fetchPublishedCalled, false, 'the FULL tarball must NEVER be pulled on the fast path');
    assert.equal(result.entry.version, '1.0.0');
    assert.equal(result.entry.publishedIntegrity, 'sha512-MATCH');
    assert.match(result.entry.normalizedHash, /^sha256:[0-9a-f]{64}$/);
  } finally { rmSync(distDir, { recursive: true, force: true }); }
});

test('slow path: local pack integrity DIFFERS from published -> tarball IS pulled, caches normalizedHash(PUBLISHED content)', () => {
  const localDist = makeDir({ 'package.json': PKG, 'index.js': 'local-newer-code\n' });
  const publishedDist = makeDir({ 'package.json': PKG, 'index.js': 'published-older-code\n' });
  let fetchPublishedCalled = false;
  const { reconcilePackage } = loadWithMockedRegistry({
    publishedVersions: () => ['1.0.0'],
    fetchPublishedIntegrity: () => 'sha512-PUBLISHED',
    fetchPublished: (name, version, workDir) => { fetchPublishedCalled = true; assert.equal(name, '@adhd/x'); assert.equal(version, '1.0.0'); return publishedDist; },
    packLocalDir: () => '/fake/local.tgz',
    tarballIntegrity: () => 'sha512-LOCAL-DIFFERENT',
  });
  try {
    const result = reconcilePackage({ name: '@adhd/x', version: '1.0.0', distDir: localDist, workDir: '/tmp/unused' });
    assert.equal(result.status, 'slow');
    assert.equal(result.tarballPulled, true);
    assert.equal(fetchPublishedCalled, true, 'a real content divergence MUST pull the tarball');
    // The cached hash must reflect the PUBLISHED content, not local.
    const { normalizedHash } = require('../version/compare-published.js');
    assert.equal(result.entry.normalizedHash, normalizedHash(publishedDist));
    assert.notEqual(result.entry.normalizedHash, normalizedHash(localDist), 'must NOT cache the local (unpublished) content as if it were published');
    assert.equal(result.entry.publishedIntegrity, 'sha512-PUBLISHED');
  } finally {
    rmSync(localDist, { recursive: true, force: true });
    rmSync(publishedDist, { recursive: true, force: true });
  }
});

test('slow path: integrity metadata unavailable (null) -> treated as a mismatch, tarball pulled', () => {
  const localDist = makeDir({ 'package.json': PKG, 'index.js': 'x\n' });
  const publishedDist = makeDir({ 'package.json': PKG, 'index.js': 'x\n' });
  let fetchPublishedCalled = false;
  const { reconcilePackage } = loadWithMockedRegistry({
    publishedVersions: () => ['1.0.0'],
    fetchPublishedIntegrity: () => null, // registry didn't return dist.integrity
    fetchPublished: () => { fetchPublishedCalled = true; return publishedDist; },
    packLocalDir: () => '/fake/local.tgz',
    tarballIntegrity: () => 'sha512-LOCAL',
  });
  try {
    const result = reconcilePackage({ name: '@adhd/x', version: '1.0.0', distDir: localDist, workDir: '/tmp/unused' });
    assert.equal(result.status, 'slow');
    assert.equal(fetchPublishedCalled, true, 'unavailable integrity metadata must never be treated as an optimistic match');
  } finally {
    rmSync(localDist, { recursive: true, force: true });
    rmSync(publishedDist, { recursive: true, force: true });
  }
});

test('error: dist missing -> status "error", no network call at all', () => {
  const { reconcilePackage } = loadWithMockedRegistry({
    publishedVersions: () => { throw new Error('must not be called when dist is missing'); },
    fetchPublishedIntegrity: () => { throw new Error('unreachable'); },
    fetchPublished: () => { throw new Error('unreachable'); },
    packLocalDir: () => { throw new Error('unreachable'); },
    tarballIntegrity: () => { throw new Error('unreachable'); },
  });
  const result = reconcilePackage({ name: '@adhd/x', version: '1.0.0', distDir: '/does/not/exist', workDir: '/tmp/unused' });
  assert.equal(result.status, 'error');
  assert.match(result.error, /no built dist/);
});

test('error: tarball fetch fails on the slow path -> status "error", tarballPulled true', () => {
  const distDir = makeDir({ 'package.json': PKG, 'index.js': 'x\n' });
  const { reconcilePackage } = loadWithMockedRegistry({
    publishedVersions: () => ['1.0.0'],
    fetchPublishedIntegrity: () => 'sha512-PUBLISHED',
    fetchPublished: () => null, // network failure
    packLocalDir: () => '/fake/local.tgz',
    tarballIntegrity: () => 'sha512-LOCAL-DIFFERENT',
  });
  try {
    const result = reconcilePackage({ name: '@adhd/x', version: '1.0.0', distDir, workDir: '/tmp/unused' });
    assert.equal(result.status, 'error');
    assert.equal(result.tarballPulled, true);
    assert.match(result.error, /could not fetch published tarball/);
  } finally { rmSync(distDir, { recursive: true, force: true }); }
});
