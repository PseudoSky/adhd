/**
 * clean-room-smoke.spec.mjs — GATE 2 unit coverage for the injectable/pure
 * seams (`discoverSmokeEntrypoints`, and — via a fake `discover` + a fake
 * `spawn`-free bin-classification path — the crash-vs-controlled-exit
 * distinction). The END-TO-END proof (a REAL `npm install` against the real
 * registry, catching the live `@adhd/apigen-cli`/`@adhd/backlog` ETARGET
 * breakage) is run manually/in the release flow itself — see PUBLISHING.md's
 * "GATE 2" section for the captured RED output; hitting the real npm
 * registry from a unit-test suite would be slow, flaky under CI network
 * policy, and is not what this file is for.
 *
 * Run: `node --test tools/nx-plugins/build/executors/smoke-test/clean-room-smoke.spec.mjs`
 * (also wired into `pnpm test:build-tools`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  discoverSmokeEntrypoints,
  discoverAllPackageManifests,
  computeEntrypointClosureGap,
  classifyPublishableTargets,
  computeCoverageGap,
  resolveInstalledEntry,
  smokeInstalledLibraryLoad,
} from './clean-room-smoke.mjs';

function makeWorkspace(entrypoints) {
  const root = mkdtempSync(join(tmpdir(), 'clean-room-smoke-fixture-'));
  for (const [dirName, pkg] of Object.entries(entrypoints)) {
    const dir = join(root, 'entrypoint', dirName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  }
  return root;
}

/** A synthetic workspace with `packages/<domain>/<name>/package.json` entries, for closure-gap tests. */
function makeFullWorkspace({ packages = {}, entrypoints = {} }) {
  const root = mkdtempSync(join(tmpdir(), 'clean-room-smoke-closure-'));
  for (const [relDir, pkg] of Object.entries(packages)) {
    const dir = join(root, 'packages', relDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  }
  for (const [dirName, pkg] of Object.entries(entrypoints)) {
    const dir = join(root, 'entrypoint', dirName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  }
  return root;
}

test('discoverSmokeEntrypoints: finds publishable, bin-shipping entrypoints only', () => {
  const root = makeWorkspace({
    'agent-mcp': { name: '@adhd/agent-mcp', bin: { 'agent-mcp': './dist/index.js' } },
    'dispatch-cli': { name: '@adhd/dispatch-cli' }, // no bin — a library, not smoked
    'environment-cli': { name: '@adhd/environment-cli', private: true, bin: { 'env-cli': './dist/index.js' } }, // private — never smoked
    'no-name': { bin: { x: './dist/index.js' } }, // malformed — skipped defensively
  });
  try {
    const found = discoverSmokeEntrypoints(root);
    assert.deepEqual(
      found.map((e) => e.name),
      ['@adhd/agent-mcp']
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discoverSmokeEntrypoints: string-form bin is also detected', () => {
  const root = makeWorkspace({
    decompile: { name: '@adhd/decompile-cli', bin: './dist/bin/decompile.js' },
  });
  try {
    const found = discoverSmokeEntrypoints(root);
    assert.deepEqual(
      found.map((e) => e.name),
      ['@adhd/decompile-cli']
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discoverSmokeEntrypoints: empty/missing entrypoint dir -> empty list, never throws', () => {
  const root = mkdtempSync(join(tmpdir(), 'clean-room-smoke-empty-'));
  try {
    assert.deepEqual(discoverSmokeEntrypoints(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- DEBT-002 #6: entrypoint-closure coverage assertion -------------------

test('discoverAllPackageManifests: finds packages/<domain>/<name> and entrypoint/<name> manifests, keyed by name', () => {
  const root = makeFullWorkspace({
    packages: {
      'foo/foo-base-a': { name: '@adhd/foo-base-a', dependencies: {} },
      'foo/foo-core-b': { name: '@adhd/foo-core-b', dependencies: { '@adhd/foo-base-a': '0.0.1' } },
    },
    entrypoints: {
      'cli-a': { name: '@adhd/cli-a', bin: { 'cli-a': './dist/index.js' }, dependencies: { '@adhd/foo-core-b': '0.0.1' } },
    },
  });
  try {
    const manifests = discoverAllPackageManifests(root);
    assert.deepEqual(
      [...manifests.keys()].sort(),
      ['@adhd/cli-a', '@adhd/foo-base-a', '@adhd/foo-core-b']
    );
    assert.equal(manifests.get('@adhd/foo-core-b').projectRoot, 'packages/foo/foo-core-b');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('computeEntrypointClosureGap: fully covered workspace reports zero uncovered', () => {
  const root = makeFullWorkspace({
    packages: {
      'foo/foo-base-a': { name: '@adhd/foo-base-a' },
      'foo/foo-core-b': { name: '@adhd/foo-core-b', dependencies: { '@adhd/foo-base-a': '0.0.1' } },
    },
    entrypoints: {
      'cli-a': { name: '@adhd/cli-a', bin: { 'cli-a': './dist/index.js' }, dependencies: { '@adhd/foo-core-b': '0.0.1' } },
    },
  });
  try {
    const entrypoints = discoverSmokeEntrypoints(root);
    const gap = computeEntrypointClosureGap(root, entrypoints);
    assert.deepEqual(gap.uncovered, []);
    assert.equal(gap.publishableCount, 3);
    assert.equal(gap.closureCount, 3); // cli-a + foo-core-b + foo-base-a (transitive)
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('computeEntrypointClosureGap: an island package (unreachable from any smoked entrypoint) is reported uncovered', () => {
  const root = makeFullWorkspace({
    packages: {
      'foo/foo-base-a': { name: '@adhd/foo-base-a' },
      'foo/foo-core-b': { name: '@adhd/foo-core-b', dependencies: { '@adhd/foo-base-a': '0.0.1' } },
      // Published, but nothing in the entrypoint closure ever depends on it.
      'foo/foo-plugin-island': { name: '@adhd/foo-plugin-island' },
    },
    entrypoints: {
      'cli-a': { name: '@adhd/cli-a', bin: { 'cli-a': './dist/index.js' }, dependencies: { '@adhd/foo-core-b': '0.0.1' } },
    },
  });
  try {
    const entrypoints = discoverSmokeEntrypoints(root);
    const gap = computeEntrypointClosureGap(root, entrypoints);
    assert.deepEqual(gap.uncovered, ['@adhd/foo-plugin-island']);
    assert.equal(gap.publishableCount, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('computeEntrypointClosureGap: private packages are excluded from the publishable set entirely', () => {
  const root = makeFullWorkspace({
    packages: {
      'foo/foo-base-a': { name: '@adhd/foo-base-a', private: true },
    },
    entrypoints: {
      'cli-a': { name: '@adhd/cli-a', bin: { 'cli-a': './dist/index.js' } }, // does NOT depend on foo-base-a
    },
  });
  try {
    const entrypoints = discoverSmokeEntrypoints(root);
    const gap = computeEntrypointClosureGap(root, entrypoints);
    assert.deepEqual(gap.uncovered, [], 'a private package must never be counted as an uncovered publishable island');
    assert.equal(gap.publishableCount, 1); // only cli-a itself
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- DEBT-002 #6 follow-up: 100% coverage via bin + library smoke lanes ---

test('classifyPublishableTargets: splits into bin vs library lanes by `bin` presence alone, regardless of directory', () => {
  const root = makeFullWorkspace({
    packages: {
      'foo/foo-base-a': { name: '@adhd/foo-base-a' }, // library — no bin
      // A bin-shipping package that lives under packages/, NOT entrypoint/ — must still land in binTargets
      // (this is exactly the @adhd/agent-engine-compiler shape in the real repo).
      'foo/foo-engine-tool': { name: '@adhd/foo-engine-tool', bin: { 'foo-tool': './dist/cli.js' } },
      'foo/foo-private-b': { name: '@adhd/foo-private-b', private: true }, // excluded entirely
    },
    entrypoints: {
      'cli-a': { name: '@adhd/cli-a', bin: { 'cli-a': './dist/index.js' } },
      'lib-entrypoint': { name: '@adhd/lib-entrypoint' }, // an entrypoint/ project with NO bin -> library lane
    },
  });
  try {
    const { binTargets, libraryTargets } = classifyPublishableTargets(root);
    assert.deepEqual(binTargets.map((t) => t.name).sort(), ['@adhd/cli-a', '@adhd/foo-engine-tool']);
    assert.deepEqual(libraryTargets.map((t) => t.name).sort(), ['@adhd/foo-base-a', '@adhd/lib-entrypoint']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('computeCoverageGap: bin + library lanes together cover 100% of the publishable set by construction', () => {
  const root = makeFullWorkspace({
    packages: {
      'foo/foo-base-a': { name: '@adhd/foo-base-a' },
      'foo/foo-plugin-island': { name: '@adhd/foo-plugin-island' }, // NOT depended on by any entrypoint — was the old "uncovered" case
    },
    entrypoints: {
      'cli-a': { name: '@adhd/cli-a', bin: { 'cli-a': './dist/index.js' } }, // does not depend on either library package
    },
  });
  try {
    const { binTargets, libraryTargets } = classifyPublishableTargets(root);
    const gap = computeCoverageGap(root, binTargets, libraryTargets);
    assert.deepEqual(gap.uncovered, [], 'every publishable package must be covered once library packages are directly smoked');
    assert.equal(gap.publishableCount, 3);
    assert.equal(gap.directlySmokedCount, 3);
    assert.equal(gap.coveredCount, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('computeCoverageGap: still fails loud if a publishable package is somehow in neither lane (discovery inconsistency)', () => {
  const root = makeFullWorkspace({
    packages: {
      'foo/foo-base-a': { name: '@adhd/foo-base-a' },
      'foo/foo-orphan': { name: '@adhd/foo-orphan' },
    },
    entrypoints: {},
  });
  try {
    // Simulate a classify implementation that (incorrectly) dropped foo-orphan from both lanes.
    const binTargets = [];
    const libraryTargets = [{ projectRoot: 'packages/foo/foo-base-a', name: '@adhd/foo-base-a' }];
    const gap = computeCoverageGap(root, binTargets, libraryTargets);
    assert.deepEqual(gap.uncovered, ['@adhd/foo-orphan']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- resolveInstalledEntry: real Node-consumer-shaped exports/main resolution ---

test('resolveInstalledEntry: prefers exports["."] over main', () => {
  assert.equal(resolveInstalledEntry({ exports: './esm/index.js', main: './cjs/index.js' }), './esm/index.js');
  assert.equal(resolveInstalledEntry({ exports: { '.': './esm/index.js' }, main: './cjs/index.js' }), './esm/index.js');
});

test('resolveInstalledEntry: resolves nested exports conditions (import/node/default/require)', () => {
  assert.equal(resolveInstalledEntry({ exports: { '.': { import: './esm.mjs', require: './cjs.cjs' } } }), './esm.mjs');
  assert.equal(resolveInstalledEntry({ exports: { '.': { require: './cjs.cjs', default: './default.js' } } }), './default.js');
  assert.equal(resolveInstalledEntry({ exports: { '.': { require: './only-require.cjs' } } }), './only-require.cjs');
});

test('resolveInstalledEntry: falls back to main, then to ./index.js, when exports is absent/unresolvable', () => {
  assert.equal(resolveInstalledEntry({ main: './dist/index.js' }), './dist/index.js');
  assert.equal(resolveInstalledEntry({}), './index.js');
  assert.equal(resolveInstalledEntry({ exports: {} }), './index.js');
});

// --- smokeInstalledLibraryLoad: REAL fs + REAL child-process import(), no network/npm ---

/** Writes a fake "already npm-installed" package at `<installDir>/node_modules/<name>/`. Real files on disk — no npm, no network — this is exactly the shape `cleanRoomInstall` would have produced. */
function makeFakeInstall({ name, pkg, entryRelPath, entryContents }) {
  const installDir = mkdtempSync(join(tmpdir(), 'clean-room-smoke-install-'));
  const pkgDir = join(installDir, 'node_modules', name);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(pkg));
  if (entryRelPath) {
    writeFileSync(join(pkgDir, entryRelPath), entryContents);
  }
  return installDir;
}

test('smokeInstalledLibraryLoad: a real, valid module loads cleanly -> ok:true', async () => {
  const installDir = makeFakeInstall({
    name: '@adhd/fake-lib-ok',
    pkg: { name: '@adhd/fake-lib-ok', main: './index.js' },
    entryRelPath: 'index.js',
    entryContents: 'module.exports = { hello: () => "world" };\n',
  });
  try {
    const result = await smokeInstalledLibraryLoad(installDir, '@adhd/fake-lib-ok');
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.entryRel, './index.js');
  } finally {
    rmSync(installDir, { recursive: true, force: true });
  }
});

test('smokeInstalledLibraryLoad: a module that throws at import time -> ok:false with the real stack in the reason (never mocked)', async () => {
  const installDir = makeFakeInstall({
    name: '@adhd/fake-lib-throws',
    pkg: { name: '@adhd/fake-lib-throws', main: './index.js' },
    entryRelPath: 'index.js',
    entryContents: "throw new ReferenceError('boom — a real, unmocked throw at module-evaluation time');\n",
  });
  try {
    const result = await smokeInstalledLibraryLoad(installDir, '@adhd/fake-lib-throws');
    assert.equal(result.ok, false);
    assert.match(result.reason, /import\(\) threw/);
    assert.match(result.reason, /boom — a real, unmocked throw/);
  } finally {
    rmSync(installDir, { recursive: true, force: true });
  }
});

test('smokeInstalledLibraryLoad: exports["."] ESM entry is resolved and actually loaded (not just main)', async () => {
  const installDir = makeFakeInstall({
    name: '@adhd/fake-lib-esm',
    pkg: { name: '@adhd/fake-lib-esm', type: 'module', main: './should-not-load.js', exports: { '.': './esm-entry.mjs' } },
    entryRelPath: 'esm-entry.mjs',
    entryContents: 'export const value = 42;\n',
  });
  try {
    const result = await smokeInstalledLibraryLoad(installDir, '@adhd/fake-lib-esm');
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.entryRel, './esm-entry.mjs');
  } finally {
    rmSync(installDir, { recursive: true, force: true });
  }
});

test('smokeInstalledLibraryLoad: resolved entry file missing from the install -> ok:false, never crashes the gate', async () => {
  const installDir = makeFakeInstall({
    name: '@adhd/fake-lib-missing-entry',
    pkg: { name: '@adhd/fake-lib-missing-entry', main: './does-not-exist.js' },
    entryRelPath: null,
    entryContents: null,
  });
  try {
    const result = await smokeInstalledLibraryLoad(installDir, '@adhd/fake-lib-missing-entry');
    assert.equal(result.ok, false);
    assert.match(result.reason, /resolved entry file missing on disk/);
  } finally {
    rmSync(installDir, { recursive: true, force: true });
  }
});

test('smokeInstalledLibraryLoad: installed package.json not found at all -> ok:false, never crashes the gate', async () => {
  const installDir = mkdtempSync(join(tmpdir(), 'clean-room-smoke-install-empty-'));
  try {
    const result = await smokeInstalledLibraryLoad(installDir, '@adhd/never-installed');
    assert.equal(result.ok, false);
    assert.match(result.reason, /installed package\.json not found/);
  } finally {
    rmSync(installDir, { recursive: true, force: true });
  }
});
