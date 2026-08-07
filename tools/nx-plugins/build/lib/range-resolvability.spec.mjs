/**
 * range-resolvability.spec.mjs — proves GATE 1's pure core, including a
 * literal reproduction of the live BUG-RELEASE-UNINSTALLABLE-AGENTMCP-001
 * shape: `agent-engine-compiler`/`agent-mcp` declaring
 * `"@adhd/agent-store-tools": "^2.1.7"` while the registry's max published
 * `agent-store-tools` is `2.1.6` and `agent-store-tools` is NOT itself part
 * of the release. This MUST go red (teeth requirement) — and MUST go green
 * the instant either the range is fixed, or `agent-store-tools` joins the
 * release at a version the range accepts.
 *
 * Run: `node --test tools/nx-plugins/build/lib/range-resolvability.spec.mjs`
 * (also wired into `pnpm test:build-tools`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const {
  parseVersion,
  compareVersions,
  satisfiesRange,
  maxSatisfying,
  discoverReleaseSet,
  collectDependencyNames,
  checkRangeResolvability,
  formatViolation,
  fetchRegistryVersions,
} = require('./range-resolvability.js');

// ---------------------------------------------------------------------------
// semver primitives
// ---------------------------------------------------------------------------

test('parseVersion: parses plain MAJOR.MINOR.PATCH', () => {
  assert.deepEqual(parseVersion('2.1.7'), [2, 1, 7]);
  assert.deepEqual(parseVersion('0.0.5'), [0, 0, 5]);
  assert.equal(parseVersion('not-a-version'), null);
});

test('compareVersions: standard ordering', () => {
  assert.ok(compareVersions([2, 1, 7], [2, 1, 6]) > 0);
  assert.ok(compareVersions([2, 1, 6], [2, 1, 7]) < 0);
  assert.equal(compareVersions([2, 1, 6], [2, 1, 6]), 0);
  assert.ok(compareVersions([3, 0, 0], [2, 9, 9]) > 0);
});

test('satisfiesRange: caret range — same major, >= base', () => {
  assert.equal(satisfiesRange('2.1.7', '^2.1.0'), true);
  assert.equal(satisfiesRange('2.1.0', '^2.1.0'), true);
  assert.equal(satisfiesRange('2.0.9', '^2.1.0'), false); // below base
  assert.equal(satisfiesRange('3.0.0', '^2.1.0'), false); // major bump
});

test('satisfiesRange: caret range — the exact live bug shape (^2.1.7 vs registry max 2.1.6)', () => {
  assert.equal(satisfiesRange('2.1.6', '^2.1.7'), false);
  assert.equal(satisfiesRange('2.1.7', '^2.1.7'), true);
});

test('satisfiesRange: tilde range — same major.minor, >= base', () => {
  assert.equal(satisfiesRange('2.1.9', '~2.1.0'), true);
  assert.equal(satisfiesRange('2.2.0', '~2.1.0'), false);
});

test('satisfiesRange: exact pin', () => {
  assert.equal(satisfiesRange('2.1.0', '2.1.0'), true);
  assert.equal(satisfiesRange('2.1.1', '2.1.0'), false);
});

test('satisfiesRange: wildcard matches anything valid', () => {
  assert.equal(satisfiesRange('9.9.9', '*'), true);
  assert.equal(satisfiesRange('0.0.1', ''), true);
});

test('maxSatisfying: picks the highest matching version, null if none match', () => {
  assert.equal(maxSatisfying(['2.1.0', '2.1.5', '2.1.6'], '^2.1.0'), '2.1.6');
  assert.equal(maxSatisfying(['2.1.0', '2.1.5', '2.1.6'], '^2.1.7'), null);
  assert.equal(maxSatisfying([], '^2.1.0'), null);
});

// ---------------------------------------------------------------------------
// checkRangeResolvability — the pure gate
// ---------------------------------------------------------------------------

/** Build a minimal ReleaseProject fixture. */
function project(name, version, deps) {
  return {
    projectRoot: `packages/agent/${name.replace('@adhd/', '')}`,
    name,
    version,
    deps: deps.map(([depName, range]) => ({ field: 'dependencies', depName, range })),
  };
}

test('RED — reproduces BUG-RELEASE-UNINSTALLABLE-AGENTMCP-001 exactly: dangling ^2.1.7 range, store-tools not in release, registry maxes at 2.1.6', () => {
  const releaseSet = [
    project('@adhd/agent-engine-compiler', '2.1.6', [['@adhd/agent-store-tools', '^2.1.7']]),
    project('@adhd/agent-mcp', '2.1.4', [['@adhd/agent-store-tools', '^2.1.7']]),
  ];
  // agent-store-tools is NOT part of this release (it published nothing new
  // this run) — its only "availability" is whatever the registry already has.
  const registryVersions = new Map([
    ['@adhd/agent-store-tools', ['2.1.0', '2.1.1', '2.1.2', '2.1.3', '2.1.4', '2.1.5', '2.1.6']],
  ]);

  const { ok, violations } = checkRangeResolvability(releaseSet, registryVersions);

  assert.equal(ok, false, 'must go RED on the known-broken input — a gate that stays green here is worthless');
  assert.equal(violations.length, 2, 'both agent-engine-compiler and agent-mcp declare the dangling edge');
  const names = violations.map((v) => v.project).sort();
  assert.deepEqual(names, ['@adhd/agent-engine-compiler', '@adhd/agent-mcp']);
  for (const v of violations) {
    assert.equal(v.dependency, '@adhd/agent-store-tools');
    assert.equal(v.range, '^2.1.7');
    assert.equal(v.pendingVersion, null);
    assert.deepEqual(v.registryVersions, ['2.1.0', '2.1.1', '2.1.2', '2.1.3', '2.1.4', '2.1.5', '2.1.6']);
    const msg = formatViolation(v);
    assert.match(msg, /agent-store-tools/);
    assert.match(msg, /\^2\.1\.7/);
    assert.match(msg, /UNRESOLVABLE/);
    assert.match(msg, /2\.1\.6/); // names the highest actually-available version, for a human to act on
  }
});

test('GREEN — same dangling range, but agent-store-tools DOES join this release at 2.1.7 (the correct fix: order the release so the dependency actually ships first)', () => {
  const releaseSet = [
    project('@adhd/agent-store-tools', '2.1.7', []),
    project('@adhd/agent-engine-compiler', '2.1.6', [['@adhd/agent-store-tools', '^2.1.7']]),
    project('@adhd/agent-mcp', '2.1.4', [['@adhd/agent-store-tools', '^2.1.7']]),
  ];
  const registryVersions = new Map([
    ['@adhd/agent-store-tools', ['2.1.0', '2.1.1', '2.1.2', '2.1.3', '2.1.4', '2.1.5', '2.1.6']],
  ]);

  const { ok, violations } = checkRangeResolvability(releaseSet, registryVersions);
  assert.equal(ok, true, `expected GREEN, got violations: ${JSON.stringify(violations)}`);
});

test('GREEN — same dangling range, alternative fix: range corrected down to an already-published version', () => {
  const releaseSet = [
    project('@adhd/agent-engine-compiler', '2.1.6', [['@adhd/agent-store-tools', '^2.1.6']]),
    project('@adhd/agent-mcp', '2.1.4', [['@adhd/agent-store-tools', '^2.1.6']]),
  ];
  const registryVersions = new Map([
    ['@adhd/agent-store-tools', ['2.1.0', '2.1.1', '2.1.2', '2.1.3', '2.1.4', '2.1.5', '2.1.6']],
  ]);

  const { ok } = checkRangeResolvability(releaseSet, registryVersions);
  assert.equal(ok, true);
});

test('a package never published anywhere resolves only via being in THIS release', () => {
  const releaseSet = [
    project('@adhd/brand-new-consumer', '0.1.0', [['@adhd/brand-new-dep', '^0.1.0']]),
    project('@adhd/brand-new-dep', '0.1.0', []),
  ];
  const registryVersions = new Map([['@adhd/brand-new-dep', []]]);
  const { ok } = checkRangeResolvability(releaseSet, registryVersions);
  assert.equal(ok, true);
});

test('a package never published anywhere AND not in this release is a violation with an empty registryVersions list', () => {
  const releaseSet = [project('@adhd/consumer', '0.1.0', [['@adhd/ghost-dep', '^0.1.0']])];
  const registryVersions = new Map([['@adhd/ghost-dep', []]]);
  const { ok, violations } = checkRangeResolvability(releaseSet, registryVersions);
  assert.equal(ok, false);
  assert.equal(violations[0].registryVersions.length, 0);
  assert.match(formatViolation(violations[0]), /NOTHING/);
});

test('external (non-@adhd) dependencies are never collected as internal edges', () => {
  const releaseSet = discoverReleaseSetFromFixture({
    '@adhd/consumer': { version: '1.0.0', dependencies: { react: '^18.0.0', '@adhd/dep': '^1.0.0' } },
    '@adhd/dep': { version: '1.0.0', dependencies: {} },
  });
  const names = collectDependencyNames(releaseSet);
  assert.deepEqual(names, ['@adhd/dep']);
});

// ---------------------------------------------------------------------------
// discoverReleaseSet — filesystem discovery against a real (fixture) tree
// ---------------------------------------------------------------------------

/** Build a throwaway workspace fixture on disk matching this repo's layout conventions. */
function discoverReleaseSetFromFixture(pkgsByName) {
  const root = mkdtempSync(join(tmpdir(), 'range-resolvability-fixture-'));
  try {
    let i = 0;
    for (const [name, extra] of Object.entries(pkgsByName)) {
      const projectRoot = `packages/fixture/${name.replace('@adhd/', '')}-${i++}`;
      const abs = join(root, projectRoot);
      mkdirSync(abs, { recursive: true });
      writeFileSync(join(abs, 'project.json'), JSON.stringify({ name, targets: { build: {} } }));
      writeFileSync(join(abs, 'package.json'), JSON.stringify({ name, ...extra }));
    }
    return discoverReleaseSet(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('discoverReleaseSet: finds publishable projects under packages/ with a build target and non-private manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'range-resolvability-discover-'));
  try {
    const pubRoot = join(root, 'packages', 'agent', 'agent-fixture-pub');
    mkdirSync(pubRoot, { recursive: true });
    writeFileSync(join(pubRoot, 'project.json'), JSON.stringify({ name: 'agent-fixture-pub', targets: { build: {} } }));
    writeFileSync(
      join(pubRoot, 'package.json'),
      JSON.stringify({ name: '@adhd/agent-fixture-pub', version: '1.0.0', dependencies: { '@adhd/agent-fixture-dep': '^1.0.0' } })
    );

    const privRoot = join(root, 'packages', 'agent', 'agent-fixture-private');
    mkdirSync(privRoot, { recursive: true });
    writeFileSync(join(privRoot, 'project.json'), JSON.stringify({ name: 'agent-fixture-private', targets: { build: {} } }));
    writeFileSync(join(privRoot, 'package.json'), JSON.stringify({ name: '@adhd/agent-fixture-private', version: '1.0.0', private: true }));

    const noBuildRoot = join(root, 'packages', 'agent', 'agent-fixture-nobuild');
    mkdirSync(noBuildRoot, { recursive: true });
    writeFileSync(join(noBuildRoot, 'project.json'), JSON.stringify({ name: 'agent-fixture-nobuild', targets: {} }));
    writeFileSync(join(noBuildRoot, 'package.json'), JSON.stringify({ name: '@adhd/agent-fixture-nobuild', version: '1.0.0' }));

    const releaseSet = discoverReleaseSet(root);
    const names = releaseSet.map((p) => p.name).sort();
    assert.deepEqual(names, ['@adhd/agent-fixture-pub']);
    assert.equal(releaseSet[0].deps.length, 1);
    assert.equal(releaseSet[0].deps[0].depName, '@adhd/agent-fixture-dep');
    assert.equal(releaseSet[0].deps[0].range, '^1.0.0');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// fetchRegistryVersions — batching, one call per UNIQUE name, never per-edge
// ---------------------------------------------------------------------------

test('fetchRegistryVersions: fetches each UNIQUE name exactly once, in parallel, never per-edge', async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    const name = decodeURIComponent(url.split('/').pop());
    const versionsByName = {
      '@adhd/agent-store-tools': ['2.1.0', '2.1.6'],
      '@adhd/agent-core-provider': ['2.1.0'],
    };
    return {
      ok: true,
      json: async () => ({
        versions: Object.fromEntries((versionsByName[name] || []).map((v) => [v, {}])),
      }),
    };
  };

  // Two projects each declaring the SAME two dependency names twice over —
  // four edges total, but only two UNIQUE names.
  const names = [
    '@adhd/agent-store-tools',
    '@adhd/agent-core-provider',
    '@adhd/agent-store-tools',
    '@adhd/agent-core-provider',
  ];
  const result = await fetchRegistryVersions(names, { fetchImpl: fakeFetch, registryUrl: 'https://fake-registry.test' });

  assert.equal(calls.length, 2, 'exactly one network call per UNIQUE dependency name, never per edge');
  assert.deepEqual(result.get('@adhd/agent-store-tools'), ['2.1.0', '2.1.6']);
  assert.deepEqual(result.get('@adhd/agent-core-provider'), ['2.1.0']);
});

test('fetchRegistryVersions: a 404/never-published package resolves to an empty list, never throws', async () => {
  const fakeFetch = async () => ({ ok: false, status: 404 });
  const result = await fetchRegistryVersions(['@adhd/never-published'], { fetchImpl: fakeFetch });
  assert.deepEqual(result.get('@adhd/never-published'), []);
});

test('fetchRegistryVersions: a network error resolves to an empty list, never throws (fail-safe, not fail-open — checkRangeResolvability then correctly treats it as unresolvable unless the release itself supplies the version)', async () => {
  const fakeFetch = async () => {
    throw new Error('ECONNRESET');
  };
  const result = await fetchRegistryVersions(['@adhd/flaky'], { fetchImpl: fakeFetch });
  assert.deepEqual(result.get('@adhd/flaky'), []);
});
