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
  classifyBinHelpExit,
  buildNpmInstallArgs,
  compareSemver,
  isInstallStale,
  looksLikeTransientRegistryError,
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

// --- classifyBinHelpExit: BUG-012 fail-safe verdict (the confirmed false-negative fix) ---
//
// BUG-012: a real `@adhd/backlog@0.1.0` install from the registry crashes on
// `backlog --help` (exit 1, stderr = a thrown `Error: ... cannot mount ...`
// + stack trace, matching NONE of `CRASH_ON_LOAD_SIGNATURES`). The OLD
// verdict ("non-zero exit + no crash-on-load signature -> PASS") let this
// through as a false PASS. The tests below assert the NEW fail-safe verdict
// treats this exact stderr as FAIL, while still passing every empirically
// observed benign arg-parse rejection (see the task's live bin-enumeration:
// agent-mcp-tail's `util.parseArgs`, agent-engine-compiler's own usage
// rejection, apigen/decompile exiting 0, agent-mcp staying alive).

test('classifyBinHelpExit: exit 0 -> ok:true', () => {
  const result = classifyBinHelpExit({ code: 0, timedOut: false, stderr: '' });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'exited-0');
});

test('classifyBinHelpExit: still running at timeout -> ok:true (server-style entrypoint)', () => {
  const result = classifyBinHelpExit({ code: null, timedOut: true, stderr: '' });
  assert.equal(result.ok, true);
  assert.match(result.mode, /still-running-at-timeout/);
});

test('classifyBinHelpExit: node:util parseArgs unknown-option rejection -> ok:true (benign, empirically observed on @adhd/agent-mcp\'s agent-mcp-tail bin)', () => {
  const stderr = [
    "node:internal/util/parse_args/parse_args:107",
    "TypeError [ERR_PARSE_ARGS_UNKNOWN_OPTION]: Unknown option '--help'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"--help\"'",
    '    at checkOptionUsage (node:internal/util/parse_args/parse_args:107:13)',
    '    at parseArgs (node:internal/util/parse_args/parse_args:379:3) {',
    "  code: 'ERR_PARSE_ARGS_UNKNOWN_OPTION'",
    '}',
  ].join('\n');
  const result = classifyBinHelpExit({ code: 1, timedOut: false, stderr });
  assert.equal(result.ok, true, result.reason);
  assert.match(result.mode, /ERR_PARSE_ARGS_UNKNOWN_OPTION/);
});

test('classifyBinHelpExit: own usage-rejection message ("Expected sub-command") -> ok:true (benign, empirically observed on @adhd/agent-engine-compiler\'s agent-compiler bin)', () => {
  const result = classifyBinHelpExit({ code: 1, timedOut: false, stderr: "agent-compiler: Expected sub-command 'compile', got: --help\n" });
  assert.equal(result.ok, true, result.reason);
  assert.match(result.mode, /Expected sub-command/);
});

test('classifyBinHelpExit: REGRESSION for BUG-012 — a real backlog-style startup crash -> ok:false (was a false PASS under the old verdict)', () => {
  const stderr = [
    'Error: @adhd/backlog: cannot mount — /x/node_modules/@adhd/dist/client.d.ts does not exist. Run "nx build backlog" first (extract() needs the built .d.ts for type information).',
    '    at qN (/x/node_modules/@adhd/backlog/index.js:190:7364)',
    '    at Wi (/x/node_modules/@adhd/backlog/index.js:190:7644)',
  ].join('\n');
  const result = classifyBinHelpExit({ code: 1, timedOut: false, stderr });
  assert.equal(result.ok, false, 'a real startup crash must FAIL under the fail-safe verdict — this is the exact BUG-012 stderr shape');
  assert.match(result.reason, /fail-safe default/);
  // Prove the OLD (pre-fix) permissive verdict would have wrongly passed this exact case: it
  // matches none of the old CRASH_ON_LOAD_SIGNATURES denylist, so "no crash-on-load signature
  // found -> PASS" (the old logic) evaluates true here, even though the NEW verdict is FAIL.
  const OLD_CRASH_ON_LOAD_SIGNATURES = [
    'Cannot find module',
    'ERR_MODULE_NOT_FOUND',
    'MODULE_NOT_FOUND',
    'ERR_REQUIRE_ESM',
    'is not a constructor',
    'is not a function',
    'Cannot read propert',
    'SyntaxError',
    'ReferenceError',
  ];
  const oldVerdictWouldHavePassed = !OLD_CRASH_ON_LOAD_SIGNATURES.some((sig) => stderr.includes(sig));
  assert.equal(oldVerdictWouldHavePassed, true, 'sanity check: this stderr must indeed have slipped past the old denylist (that IS BUG-012)');
});

test('classifyBinHelpExit: a generic thrown Error with a stack trace -> ok:false', () => {
  const stderr = 'Error: something went wrong\n    at foo (file.js:1:1)\n    at bar (file.js:2:2)\n';
  const result = classifyBinHelpExit({ code: 1, timedOut: false, stderr });
  assert.equal(result.ok, false);
  assert.match(result.reason, /fail-safe default/);
});

test('classifyBinHelpExit: a known crash-on-load signature (Cannot find module) -> ok:false and annotated as such', () => {
  const stderr = "Error: Cannot find module '/x/node_modules/@adhd/foo/dist/index.js'\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1421:15)\n";
  const result = classifyBinHelpExit({ code: 1, timedOut: false, stderr });
  assert.equal(result.ok, false);
  assert.match(result.reason, /matches a known crash-on-load signature/);
});

// --- buildNpmInstallArgs / compareSemver / isInstallStale / looksLikeTransientRegistryError ---
//
// GATE 2 hardening: a live release run proved `npm install <name>@latest`
// (no `--prefer-online`) can resolve a STALE packument straight from npm's
// local cache immediately after `npm publish` — `@adhd/backlog@0.1.1` was
// published, but GATE 2's install pulled the cached `0.1.0` and red-failed
// on an already-fixed package. `npm view` (which GATE 2 does not use for
// its actual install step) already showed `0.1.1` as `dist-tags.latest`;
// only `npm install` trusted stale local metadata. These are the pure,
// spawn-free seams that fix now covers.

test('buildNpmInstallArgs: always includes --prefer-online (mandatory for a POST-publish gate)', () => {
  const args = buildNpmInstallArgs('@adhd/backlog', '/tmp/install-dir');
  assert.ok(args.includes('--prefer-online'), `expected --prefer-online in ${JSON.stringify(args)}`);
  assert.deepEqual(args, [
    'install',
    '--prefix',
    '/tmp/install-dir',
    '@adhd/backlog@latest',
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
    '--prefer-online',
  ]);
});

test('buildNpmInstallArgs: appends --registry when a custom registryUrl is supplied', () => {
  const args = buildNpmInstallArgs('@adhd/backlog', '/tmp/install-dir', { registryUrl: 'https://registry.example.com' });
  assert.ok(args.includes('--prefer-online'));
  assert.deepEqual(args.slice(-2), ['--registry', 'https://registry.example.com']);
});

test('compareSemver: orders major/minor/patch numerically, not lexicographically', () => {
  assert.equal(compareSemver('0.1.0', '0.1.1') < 0, true);
  assert.equal(compareSemver('0.1.1', '0.1.0') > 0, true);
  assert.equal(compareSemver('0.1.1', '0.1.1'), 0);
  assert.equal(compareSemver('0.2.0', '0.10.0') < 0, true, 'numeric compare: 2 < 10, never lexicographic "0.2.0" > "0.10.0"');
  assert.equal(compareSemver('1.0.0', '0.9.9') > 0, true);
});

test('isInstallStale: resolved OLDER than on-disk -> true (the live @adhd/backlog 0.1.0-vs-0.1.1 incident shape)', () => {
  assert.equal(isInstallStale('0.1.0', '0.1.1'), true);
});

test('isInstallStale: resolved EQUAL to on-disk -> false', () => {
  assert.equal(isInstallStale('0.1.1', '0.1.1'), false);
});

test('isInstallStale: resolved NEWER than on-disk -> false (never a reason to retry)', () => {
  assert.equal(isInstallStale('0.1.2', '0.1.1'), false);
});

test('isInstallStale: missing resolved or on-disk version -> false (never a hard error, never retried)', () => {
  assert.equal(isInstallStale(null, '0.1.1'), false);
  assert.equal(isInstallStale('0.1.1', undefined), false);
  assert.equal(isInstallStale(null, null), false);
});

test('looksLikeTransientRegistryError: detects ETARGET/E404-shaped npm install failures', () => {
  assert.equal(looksLikeTransientRegistryError('npm ERR! code ETARGET\nnpm ERR! notarget No matching version found'), true);
  assert.equal(looksLikeTransientRegistryError('npm ERR! code E404\nnpm ERR! 404 Not Found'), true);
  assert.equal(looksLikeTransientRegistryError('npm ERR! code EACCES\npermission denied'), false);
  assert.equal(looksLikeTransientRegistryError(''), false);
  assert.equal(looksLikeTransientRegistryError(undefined), false);
});
