/**
 * Teeth tests for release-manifest.js — the standalone manifest read/write/
 * decision logic behind the publish executor's backstop (Phase 3,
 * `tmp/release-pipeline-audit.md`). Integration proof that the REAL
 * `publish` executor actually refuses/allows lives in
 * `executors/publish/manifest-backstop.spec.mjs`; this file exercises the
 * decision function in isolation with full control over time.
 *
 * Run: node --test tools/nx-plugins/build/lib/release-manifest.spec.mjs
 * (also wired into `pnpm test:build-tools`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const {
  writeReleaseManifest,
  readReleaseManifest,
  manifestAgeMs,
  checkPublishAllowed,
  MANIFEST_MAX_AGE_MS,
  MANIFEST_RELATIVE_PATH,
  OVERRIDE_LOG_RELATIVE_PATH,
} = require('./release-manifest.js');

function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'release-manifest-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('writeReleaseManifest writes a well-formed manifest at tmp/release-manifest.json, readable back verbatim', () => {
  withTmpDir((dir) => {
    const written = writeReleaseManifest(dir, ['pkg-b', 'pkg-a'], { baseRef: 'HEAD~1', now: 1_700_000_000_000 });
    assert.deepEqual(written.projectNames, ['pkg-a', 'pkg-b'], 'must be sorted for a stable diff');
    assert.equal(written.baseRef, 'HEAD~1');
    assert.ok(existsSync(join(dir, MANIFEST_RELATIVE_PATH)));

    const read = readReleaseManifest(dir);
    assert.deepEqual(read, written);
  });
});

test('readReleaseManifest returns null (never throws) for a missing manifest', () => {
  withTmpDir((dir) => {
    assert.equal(readReleaseManifest(dir), null);
  });
});

test('readReleaseManifest returns null (never throws) for a corrupt manifest file', () => {
  withTmpDir((dir) => {
    const { mkdirSync, writeFileSync } = require('node:fs');
    mkdirSync(join(dir, 'tmp'), { recursive: true });
    writeFileSync(join(dir, MANIFEST_RELATIVE_PATH), 'not json {{{');
    assert.equal(readReleaseManifest(dir), null);
  });
});

test('manifestAgeMs computes elapsed time from generatedAt', () => {
  const manifest = { generatedAt: new Date(1_000_000).toISOString(), projectNames: [] };
  assert.equal(manifestAgeMs(manifest, 1_005_000), 5000);
});

test('checkPublishAllowed: REFUSES when no manifest exists at all', () => {
  withTmpDir((dir) => {
    const result = checkPublishAllowed({ workspaceRoot: dir, projectName: 'pkg-b', env: {} });
    assert.equal(result.allowed, false);
    assert.match(result.reason, /no release manifest found/);
  });
});

test('checkPublishAllowed: REFUSES when the project is not listed in a fresh manifest', () => {
  withTmpDir((dir) => {
    writeReleaseManifest(dir, ['some-other-pkg'], { now: Date.now() });
    const result = checkPublishAllowed({ workspaceRoot: dir, projectName: 'pkg-b', env: {} });
    assert.equal(result.allowed, false);
    assert.match(result.reason, /is not listed in the release manifest/);
  });
});

test('checkPublishAllowed: REFUSES when the manifest is stale (older than maxAgeMs)', () => {
  withTmpDir((dir) => {
    const now = 2_000_000_000_000;
    writeReleaseManifest(dir, ['pkg-b'], { now: now - MANIFEST_MAX_AGE_MS - 1000 });
    const result = checkPublishAllowed({ workspaceRoot: dir, projectName: 'pkg-b', env: {}, now });
    assert.equal(result.allowed, false);
    assert.match(result.reason, /is stale/);
  });
});

test('checkPublishAllowed: PROCEEDS when the project IS listed in a fresh manifest', () => {
  withTmpDir((dir) => {
    const now = 2_000_000_000_000;
    writeReleaseManifest(dir, ['pkg-a', 'pkg-b'], { now: now - 60_000 }); // 1 minute old, well within the window
    const result = checkPublishAllowed({ workspaceRoot: dir, projectName: 'pkg-b', env: {}, now });
    assert.equal(result.allowed, true);
    assert.equal(result.forced, false);
  });
});

test('checkPublishAllowed: RELEASE_FORCE_FULL_PUBLISH without RELEASE_FORCE_REASON is REFUSED (reason is mandatory, mirrors backlog requiresReason)', () => {
  withTmpDir((dir) => {
    const result = checkPublishAllowed({
      workspaceRoot: dir,
      projectName: 'pkg-b',
      env: { RELEASE_FORCE_FULL_PUBLISH: '1', RELEASE_FORCE_REASON: '   ' },
    });
    assert.equal(result.allowed, false);
    assert.match(result.reason, /RELEASE_FORCE_REASON is empty/);
    assert.equal(existsSync(join(dir, OVERRIDE_LOG_RELATIVE_PATH)), false, 'a refused override attempt must not be logged as a real override');
  });
});

test('checkPublishAllowed: RELEASE_FORCE_FULL_PUBLISH + a non-empty RELEASE_FORCE_REASON bypasses every other check and is LOGGED (auditable, never silent)', () => {
  withTmpDir((dir) => {
    // Deliberately no manifest at all AND the project isn't listed anywhere —
    // proves the override genuinely bypasses both the "missing" and
    // "not listed" refusal paths, not just one of them.
    const result = checkPublishAllowed({
      workspaceRoot: dir,
      projectName: 'pkg-never-scoped',
      env: { RELEASE_FORCE_FULL_PUBLISH: '1', RELEASE_FORCE_REASON: 'emergency hotfix, registry incident', USER: 'test-operator' },
    });
    assert.equal(result.allowed, true);
    assert.equal(result.forced, true);
    assert.match(result.reason, /emergency hotfix, registry incident/);

    const logPath = join(dir, OVERRIDE_LOG_RELATIVE_PATH);
    assert.ok(existsSync(logPath), 'the override must be appended to the audit log file, not silent');
    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.projectName, 'pkg-never-scoped');
    assert.equal(entry.reason, 'emergency hotfix, registry incident');
    assert.equal(entry.actor, 'test-operator');
    assert.ok(entry.at, 'must record a timestamp');
  });
});

test('checkPublishAllowed: RELEASE_FORCE_FULL_PUBLISH=0/false is treated as NOT forced (falsy-string guard)', () => {
  withTmpDir((dir) => {
    const result = checkPublishAllowed({
      workspaceRoot: dir,
      projectName: 'pkg-b',
      env: { RELEASE_FORCE_FULL_PUBLISH: '0', RELEASE_FORCE_REASON: 'ignored' },
    });
    assert.equal(result.allowed, false, 'a "0" value must not count as forcing — otherwise an accidentally-set env var forces every publish');
    assert.match(result.reason, /no release manifest found/);
  });
});

test('multiple overrides append multiple lines to the same log file (never overwritten)', () => {
  withTmpDir((dir) => {
    checkPublishAllowed({ workspaceRoot: dir, projectName: 'pkg-a', env: { RELEASE_FORCE_FULL_PUBLISH: '1', RELEASE_FORCE_REASON: 'first' } });
    checkPublishAllowed({ workspaceRoot: dir, projectName: 'pkg-b', env: { RELEASE_FORCE_FULL_PUBLISH: '1', RELEASE_FORCE_REASON: 'second' } });
    const lines = readFileSync(join(dir, OVERRIDE_LOG_RELATIVE_PATH), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2, 'each override use must be a new appended line, not a clobbered single entry');
  });
});
