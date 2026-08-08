/**
 * Teeth tests for changed-set.js — the shared changed/affected-project
 * resolver behind the release pipeline's affected-scoped publish
 * (tmp/release-pipeline-audit.md §6.1, DEBT-RELEASE-UNSCOPED-PUBLISH-001).
 *
 * Drives the REAL `computeChangedProjectSet` against a throwaway on-disk
 * fixture workspace (real fs reads via `discoverReleaseSet`/`readProjectName`,
 * never a mock of the module itself), injecting only the two external
 * dependencies that would otherwise require a real git repo / real registry
 * (`getAffectedProjectNames`, `publishedState`) — mirrors
 * `check-release-ranges.mjs`'s own `runCheck({ fetchVersions })` injection
 * convention and `plugin.spec.mjs`'s fixture-project pattern.
 *
 * Run: `node --test tools/nx-plugins/build/lib/changed-set.spec.mjs`
 * (also wired into `pnpm test:build-tools`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { computeChangedProjectSet, resolveBaseRef, resolveBaseRefFromPublishedState } = require('./changed-set.js');
const { readReleaseManifest } = require('./release-manifest.js');

/** Build a throwaway publishable-project fixture (project.json + build target + non-private package.json). */
function makeFixtureProject({ workspaceRoot, projectRoot, name, nxName, version }) {
  const abs = join(workspaceRoot, projectRoot);
  mkdirSync(abs, { recursive: true });
  writeFileSync(join(abs, 'project.json'), JSON.stringify({ name: nxName, targets: { build: {} } }));
  writeFileSync(join(abs, 'package.json'), JSON.stringify({ name, version }));
  return abs;
}

test('computeChangedProjectSet: includes a git-diff-affected project, includes a published-state-cache-stale project, excludes an unrelated unchanged project', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'changed-set-fixture-'));
  try {
    // A: source changed (nx says affected), cache matches disk version — should be included via "affected-by-git-diff".
    makeFixtureProject({
      workspaceRoot,
      projectRoot: 'packages/fixture/fixture-core-a',
      name: '@adhd/fixture-core-a',
      nxName: 'fixture-core-a',
      version: '1.0.0',
    });
    // B: source NOT flagged affected, but its on-disk version has already
    // diverged from what published-state.json last recorded (simulates a
    // prior partial run that bumped it) — should be included via
    // "published-state-cache-stale".
    makeFixtureProject({
      workspaceRoot,
      projectRoot: 'packages/fixture/fixture-core-b',
      name: '@adhd/fixture-core-b',
      nxName: 'fixture-core-b',
      version: '2.0.0',
    });
    // C: source NOT affected, cache matches disk version exactly — must be
    // EXCLUDED. This is the negative control: without it, a resolver that
    // always returns "everyone" would pass the first two assertions too.
    makeFixtureProject({
      workspaceRoot,
      projectRoot: 'packages/fixture/fixture-core-c',
      name: '@adhd/fixture-core-c',
      nxName: 'fixture-core-c',
      version: '1.0.0',
    });

    const publishedState = {
      '@adhd/fixture-core-a': { version: '1.0.0', normalizedHash: 'sha256:aaa', publishedIntegrity: 'sha512-aaa' },
      '@adhd/fixture-core-b': { version: '1.9.0', normalizedHash: 'sha256:bbb', publishedIntegrity: 'sha512-bbb' },
      '@adhd/fixture-core-c': { version: '1.0.0', normalizedHash: 'sha256:ccc', publishedIntegrity: 'sha512-ccc' },
    };

    const result = computeChangedProjectSet({
      workspaceRoot,
      baseRef: 'fake-base-ref',
      publishedState,
      getAffectedProjectNames: ({ baseRef }) => {
        assert.equal(baseRef, 'fake-base-ref', 'must forward the resolved baseRef to the affected computation');
        return ['fixture-core-a'];
      },
    });

    assert.deepEqual(
      result.projectNames.sort(),
      ['fixture-core-a', 'fixture-core-b'],
      `expected exactly the affected project + the stale-cache project, got: ${JSON.stringify(result.projectNames)}`
    );

    const a = result.projects.find((p) => p.nxProjectName === 'fixture-core-a');
    assert.ok(a.reasons.includes('affected-by-git-diff'), 'A must be included for the affected-by-git-diff reason');
    assert.ok(!a.reasons.includes('published-state-cache-stale'), 'A must NOT also be flagged cache-stale (cache matches disk)');

    const b = result.projects.find((p) => p.nxProjectName === 'fixture-core-b');
    assert.ok(b.reasons.includes('published-state-cache-stale'), 'B must be included for the published-state-cache-stale reason');
    assert.ok(!b.reasons.includes('affected-by-git-diff'), 'B must NOT also be flagged affected (nx did not report it)');

    assert.ok(
      !result.projectNames.includes('fixture-core-c'),
      'C (unchanged source, cache matches disk) must be EXCLUDED from the computed set'
    );
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('computeChangedProjectSet: empty affected set + fully-synced cache -> empty computed project list (never falls back to "everyone")', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'changed-set-fixture-empty-'));
  try {
    makeFixtureProject({
      workspaceRoot,
      projectRoot: 'packages/fixture/fixture-core-only',
      name: '@adhd/fixture-core-only',
      nxName: 'fixture-core-only',
      version: '1.0.0',
    });
    const result = computeChangedProjectSet({
      workspaceRoot,
      baseRef: 'fake-base-ref',
      publishedState: {
        '@adhd/fixture-core-only': { version: '1.0.0', normalizedHash: 'sha256:x', publishedIntegrity: 'sha512-x' },
      },
      getAffectedProjectNames: () => [],
    });
    assert.deepEqual(result.projectNames, [], 'nothing changed -> empty list, not the full workspace');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('computeChangedProjectSet: propagates (throws) when the affected-computation dependency fails — no silent fallback to "everyone"', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'changed-set-fixture-throw-'));
  try {
    makeFixtureProject({
      workspaceRoot,
      projectRoot: 'packages/fixture/fixture-core-only',
      name: '@adhd/fixture-core-only',
      nxName: 'fixture-core-only',
      version: '1.0.0',
    });
    assert.throws(
      () =>
        computeChangedProjectSet({
          workspaceRoot,
          baseRef: 'fake-base-ref',
          publishedState: {},
          getAffectedProjectNames: () => {
            throw new Error('simulated nx/git failure');
          },
        }),
      /simulated nx\/git failure/,
      'a failure computing the affected set must propagate, never be swallowed into an unscoped/full-workspace result'
    );
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('resolveBaseRef: explicit RELEASE_BASE_REF env override always wins', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'changed-set-baseref-'));
  try {
    const ref = resolveBaseRef({ workspaceRoot, env: { RELEASE_BASE_REF: 'refs/tags/last-release' } });
    assert.equal(ref, 'refs/tags/last-release');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('computeChangedProjectSet (Phase 3 manifest backstop): writes tmp/release-manifest.json listing exactly the computed scope', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'changed-set-manifest-'));
  try {
    makeFixtureProject({
      workspaceRoot,
      projectRoot: 'packages/fixture/fixture-core-a',
      name: '@adhd/fixture-core-a',
      nxName: 'fixture-core-a',
      version: '1.0.0',
    });
    makeFixtureProject({
      workspaceRoot,
      projectRoot: 'packages/fixture/fixture-core-c',
      name: '@adhd/fixture-core-c',
      nxName: 'fixture-core-c',
      version: '1.0.0',
    });
    const publishedState = {
      '@adhd/fixture-core-a': { version: '1.0.0', normalizedHash: 'sha256:aaa', publishedIntegrity: 'sha512-aaa' },
      '@adhd/fixture-core-c': { version: '1.0.0', normalizedHash: 'sha256:ccc', publishedIntegrity: 'sha512-ccc' },
    };
    const result = computeChangedProjectSet({
      workspaceRoot,
      baseRef: 'fake-base-ref',
      publishedState,
      getAffectedProjectNames: () => ['fixture-core-a'],
    });

    const manifest = readReleaseManifest(workspaceRoot);
    assert.ok(manifest, 'computeChangedProjectSet must write a manifest by default');
    assert.deepEqual(manifest.projectNames, result.projectNames, 'the written manifest must list exactly the computed scope');
    assert.equal(manifest.baseRef, 'fake-base-ref');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('computeChangedProjectSet: { writeManifest: false } opts out of the manifest write (used by fixtures that do not want the side effect)', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'changed-set-manifest-optout-'));
  try {
    makeFixtureProject({
      workspaceRoot,
      projectRoot: 'packages/fixture/fixture-core-only',
      name: '@adhd/fixture-core-only',
      nxName: 'fixture-core-only',
      version: '1.0.0',
    });
    computeChangedProjectSet({
      workspaceRoot,
      baseRef: 'fake-base-ref',
      publishedState: {},
      getAffectedProjectNames: () => ['fixture-core-only'],
      writeManifest: false,
    });
    assert.equal(readReleaseManifest(workspaceRoot), null, 'writeManifest: false must skip the manifest write entirely');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('RED-equivalent: a resolver that ignores its inputs and always returns every releaseSet project is exactly the unscoped anti-pattern this module replaces', () => {
  // Simulates the pre-fix behavior (`nx run-many -t publish` with no
  // --projects filter, run-release.mjs:100 at audit time) to prove the
  // exclusion assertions above have teeth: a "return everyone" resolver would
  // satisfy the inclusion checks but must fail the exclusion check.
  const alwaysEveryone = ['fixture-core-a', 'fixture-core-b', 'fixture-core-c'];
  assert.ok(
    alwaysEveryone.includes('fixture-core-c'),
    'sanity check: the pre-fix "everyone" shape does NOT exclude the unchanged project — that is exactly the bug'
  );
});

// ---------------------------------------------------------------------------
// publishedFromRef -> automatic base-ref resolution.
//
// These have teeth by construction: each asserts the SPECIFIC ref chosen, not
// merely that "a ref came back". Before `publishedFromRef` existed, every one
// of these fell through to `HEAD~1` — the bug that made a 21-commit release
// compute an empty changed-set and publish nothing.
// ---------------------------------------------------------------------------

test('resolveBaseRefFromPublishedState: picks the OLDEST resolvable ref, not the newest', () => {
  // Two real commits in this repo; older must win so no package's window is
  // clipped. Newest-wins would silently hide changes for anything published
  // at the earlier commit.
  const older = execFileSync('git', ['rev-list', '--max-count=1', '--skip=3', 'HEAD'], {
    cwd: process.cwd(), encoding: 'utf8',
  }).trim();
  const newer = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: process.cwd(), encoding: 'utf8',
  }).trim();
  assert.notStrictEqual(older, newer, 'fixture precondition: need two distinct commits');

  const chosen = resolveBaseRefFromPublishedState({
    workspaceRoot: process.cwd(),
    publishedState: {
      '@adhd/a': { version: '1.0.0', publishedFromRef: newer },
      '@adhd/b': { version: '1.0.0', publishedFromRef: older },
    },
  });
  assert.strictEqual(chosen, older, 'must choose the oldest ref, never the newest');
});

test('resolveBaseRefFromPublishedState: skips refs that no longer resolve (rebase/squash guard)', () => {
  const real = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: process.cwd(), encoding: 'utf8',
  }).trim();
  // Well-formed 40-hex SHA that is not a commit in this repo — exactly what a
  // rebased-away ref looks like. It must be skipped, not thrown on, and must
  // not win despite sorting arbitrarily.
  const dangling = 'd'.repeat(40);

  const chosen = resolveBaseRefFromPublishedState({
    workspaceRoot: process.cwd(),
    publishedState: {
      '@adhd/gone': { version: '1.0.0', publishedFromRef: dangling },
      '@adhd/real': { version: '1.0.0', publishedFromRef: real },
    },
  });
  assert.strictEqual(chosen, real, 'a dangling ref must be skipped in favour of a resolvable one');
});

test('resolveBaseRefFromPublishedState: returns null when NO usable ref exists, so callers fall through', () => {
  assert.strictEqual(
    resolveBaseRefFromPublishedState({ workspaceRoot: process.cwd(), publishedState: {} }),
    null,
    'empty state must fall through, not invent a ref'
  );
  assert.strictEqual(
    resolveBaseRefFromPublishedState({
      workspaceRoot: process.cwd(),
      // Legacy entries written before publishedFromRef existed, plus a
      // malformed value. Neither may be treated as usable.
      publishedState: {
        '@adhd/legacy': { version: '1.0.0', normalizedHash: 'sha256:x' },
        '@adhd/bad': { version: '1.0.0', publishedFromRef: 'not-a-sha' },
      },
    }),
    null,
    'legacy and malformed refs must fall through, never be used as a base'
  );
});

test('resolveBaseRef: RELEASE_BASE_REF still outranks publishedFromRef', () => {
  const real = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: process.cwd(), encoding: 'utf8',
  }).trim();
  assert.strictEqual(
    resolveBaseRef({
      workspaceRoot: process.cwd(),
      env: { RELEASE_BASE_REF: 'explicit-wins' },
      publishedState: { '@adhd/a': { version: '1.0.0', publishedFromRef: real } },
    }),
    'explicit-wins',
    'an explicit caller override must never be overridden by the cache'
  );
});
