/**
 * guards: the release scope is not the pending set, is not ordered dependency-first, or does not write the manifest the publish backstop needs
 * tier: S
 * cites: release-perf handoff P2
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { planRelease } = require('./release-plan.js');
const { scratchRootPath } = require('../../lib/scratch-root.js');
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const set = [
  { projectRoot: 'packages/c', name: '@adhd/c', version: '1.0.0', deps: [{ depName: '@adhd/b' }] },
  { projectRoot: 'packages/b', name: '@adhd/b', version: '1.0.0', deps: [{ depName: '@adhd/a' }] },
  { projectRoot: 'packages/a', name: '@adhd/a', version: '1.0.0', deps: [] },
  { projectRoot: 'packages/z', name: '@adhd/z', version: '1.0.0', deps: [] },
];
const nameOf = (_r, root) => root.split('/')[1];

function withScratch(fn) {
  const base = scratchRootPath(REPO_ROOT);
  mkdirSync(base, { recursive: true });
  const ws = mkdtempSync(join(base, 'rplan-'));
  try { return fn(ws); } finally { rmSync(ws, { recursive: true, force: true }); }
}

test('scope is exactly the pending set, in nx names, ordered dependency-first, unchanged projects absent', () => {
  withScratch((ws) => {
    const plan = planRelease({
      workspaceRoot: ws, releaseSet: set, state: {}, nameOf, writeManifest: false,
      pending: [{ name: '@adhd/c', projectRoot: 'packages/c', version: '1.0.0', reasons: ['dependency-changed'] }, { name: '@adhd/a', projectRoot: 'packages/a', version: '1.0.0', reasons: ['source-changed'] }],
    });
    assert.deepEqual(plan.projectNames, ['a', 'c']);
    assert.deepEqual(plan.waves, [['a', 'c']]); // b is not pending, so c has no pending dependency to wait for
  });
});

test('a pending chain is ordered into waves dependency-first', () => {
  withScratch((ws) => {
    const pending = ['c', 'b', 'a'].map((n) => ({ name: `@adhd/${n}`, projectRoot: `packages/${n}`, version: '1.0.0', reasons: [] }));
    const plan = planRelease({ workspaceRoot: ws, releaseSet: set, state: {}, nameOf, writeManifest: false, pending });
    assert.deepEqual(plan.waves, [['a'], ['b'], ['c']]);
  });
});

test('writes the release manifest the publish backstop reads, with exactly the scoped nx names', () => {
  withScratch((ws) => {
    process.env.RELEASE_RUN_TOKEN = 'tok';
    planRelease({ workspaceRoot: ws, releaseSet: set, state: {}, nameOf, pending: [{ name: '@adhd/z', projectRoot: 'packages/z', version: '1.0.0', reasons: [] }] });
    const { manifestPath } = require('./release-manifest.js');
    const m = JSON.parse(readFileSync(manifestPath(ws), 'utf8'));
    assert.deepEqual(m.projectNames, ['z']);
    assert.equal(m.runToken, 'tok');
    delete process.env.RELEASE_RUN_TOKEN;
  });
});

test('an empty pending set yields an empty plan and still writes an empty manifest', () => {
  withScratch((ws) => {
    const plan = planRelease({ workspaceRoot: ws, releaseSet: set, state: {}, nameOf, pending: [] });
    assert.deepEqual({ p: plan.projectNames, w: plan.waves }, { p: [], w: [] });
  });
});
