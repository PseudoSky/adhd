/**
 * Teeth tests for generate-manifest.js — the "version the dist at build" core.
 *
 * Run: node --test tools/nx-plugins/build/executors/manifest/
 *
 * These assert the exact resolved output. Each is a negative control for a real
 * publish hazard: if the transform regresses to passing a source range through
 * untouched, or fails to rebase a path, or ships devDeps/files, the matching
 * test goes red. (Repo verification standard §7: a test must FAIL if the bug is
 * reintroduced.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { generateDistManifest, rebaseDistPath, rebaseExports, assertResolvedInternalDeps } = require('./generate-manifest.js');

const MAP = {
  '@adhd/apigen-plugin-py-flask': '0.2.0',
  '@adhd/apigen-core-client': '0.2.0',
  '@adhd/agent-base-types': '2.1.0',
  '@adhd/apigen-base-errors': '0.2.0',
};

test('rebases vite-flat entry paths (dist becomes package root)', () => {
  assert.equal(rebaseDistPath('./dist/index.js'), './index.js');
  assert.equal(rebaseDistPath('./dist/index.mjs'), './index.mjs');
  assert.equal(rebaseDistPath('./dist/index.d.ts'), './index.d.ts');
});

test('rebases tsc-nested entry paths', () => {
  assert.equal(rebaseDistPath('./dist/src/index.js'), './src/index.js');
  assert.equal(rebaseDistPath('dist/src/index.d.ts'), 'src/index.d.ts');
});

test('leaves non-dist paths untouched (defensive)', () => {
  assert.equal(rebaseDistPath('./lib/foo.js'), './lib/foo.js');
  assert.equal(rebaseDistPath('./index.js'), './index.js');
});

test('deep-rebases nested exports conditions', () => {
  const out = rebaseExports({
    '.': { types: './dist/src/index.d.ts', default: './dist/src/index.js' },
    './sub': { import: './dist/sub.mjs', require: './dist/sub.js' },
  });
  assert.deepEqual(out, {
    '.': { types: './src/index.d.ts', default: './src/index.js' },
    './sub': { import: './sub.mjs', require: './sub.js' },
  });
});

test('DEFECT C: resolves a stale/foreign internal range to the LIVE version', () => {
  // The dependent's source pins ^0.1.0, but the dependency is now 0.2.0. nx's
  // own updateDependents leaves this stale when the dep is versioned after the
  // dependent (BUG-RELEASE-PIPELINE-UNFIT-FOR-FULL-PUBLISH-001, Defect C). The
  // build-time snapshot must correct it to ^0.2.0 regardless of source pin.
  const out = generateDistManifest(
    { name: '@adhd/apigen-cli', version: '0.1.1', dependencies: { '@adhd/apigen-plugin-py-flask': '^0.1.0' } },
    MAP
  );
  assert.equal(out.dependencies['@adhd/apigen-plugin-py-flask'], '^0.2.0');
});

test('resolves workspace:* to a concrete caret range (npm never substitutes workspace:)', () => {
  const out = generateDistManifest(
    { name: '@adhd/x', version: '1.0.0', dependencies: { '@adhd/apigen-core-client': 'workspace:*' } },
    MAP
  );
  assert.equal(out.dependencies['@adhd/apigen-core-client'], '^0.2.0');
});

test('resolves bare * (unpinned) internal peerDependency to a concrete caret', () => {
  const out = generateDistManifest(
    { name: '@adhd/agent-plugin-x', version: '0.1.0', peerDependencies: { '@adhd/agent-base-types': '*' } },
    MAP
  );
  assert.equal(out.peerDependencies['@adhd/agent-base-types'], '^2.1.0');
});

test('leaves EXTERNAL deps untouched, and internal deps absent from the map untouched', () => {
  const out = generateDistManifest(
    { name: '@adhd/x', version: '1.0.0', dependencies: { 'better-sqlite3': '12.10.0', zod: '4.4.3', '@adhd/not-in-workspace': '^9.9.9' } },
    MAP
  );
  assert.equal(out.dependencies['better-sqlite3'], '12.10.0');
  assert.equal(out.dependencies['zod'], '4.4.3');
  assert.equal(out.dependencies['@adhd/not-in-workspace'], '^9.9.9');
});

test('drops devDependencies, scripts, nx, and the source files allowlist', () => {
  const out = generateDistManifest(
    {
      name: '@adhd/x', version: '1.0.0',
      devDependencies: { '@adhd/nx-build': 'workspace:*', vitest: '1.0.0' },
      scripts: { build: 'vite build' },
      nx: { tags: ['x'] },
      files: ['dist', 'CHANGELOG.md'],
    },
    MAP
  );
  assert.equal(out.devDependencies, undefined);
  assert.equal(out.scripts, undefined);
  assert.equal(out.nx, undefined);
  assert.equal(out.files, undefined);
});

test('rebases string bin and object bin, stripping the leading "./" that main/module/typings keep', () => {
  // Unlike main/module/typings (which keep a leading "./"), bin values must NOT
  // have one — npm's publish-time bin validation silently strips any bin entry
  // whose path starts with "./" (confirmed empirically, npm 11.6.2: identical
  // file + permissions, only the leading "./" differs between accepted and
  // rejected). A dropped bin entry means `npm install -g` installs with no
  // command registered at all — no error, just a warning naming the wrong cause.
  assert.deepEqual(
    generateDistManifest({ name: '@adhd/cli', version: '1.0.0', bin: { adhd: './dist/index.js' } }, MAP).bin,
    { adhd: 'index.js' }
  );
  assert.equal(
    generateDistManifest({ name: '@adhd/cli', version: '1.0.0', bin: './dist/cli.js' }, MAP).bin,
    'cli.js'
  );
});

test('bin rebasing does not affect main/module/typings, which keep their leading "./"', () => {
  const out = generateDistManifest(
    { name: '@adhd/cli', version: '1.0.0', main: './dist/index.js', module: './dist/index.mjs', typings: './dist/index.d.ts', bin: './dist/cli.js' },
    MAP
  );
  assert.equal(out.main, './index.js');
  assert.equal(out.module, './index.mjs');
  assert.equal(out.typings, './index.d.ts');
  assert.equal(out.bin, 'cli.js');
});

test('preserves identity metadata (name, version, license, publishConfig, type)', () => {
  const out = generateDistManifest(
    { name: '@adhd/x', version: '3.2.1', license: 'MIT', type: 'module', publishConfig: { access: 'public' }, main: './dist/index.js' },
    MAP
  );
  assert.equal(out.name, '@adhd/x');
  assert.equal(out.version, '3.2.1');
  assert.equal(out.license, 'MIT');
  assert.equal(out.type, 'module');
  assert.deepEqual(out.publishConfig, { access: 'public' });
  assert.equal(out.main, './index.js');
});

// ---------------------------------------------------------------------------
// DEBT-002 #1 — assertResolvedInternalDeps: the post-resolution hazard gate
// `writeDistManifest` runs before ever writing a manifest to disk.
// ---------------------------------------------------------------------------

test('assertResolvedInternalDeps: passes silently when every @adhd/* range resolved to a concrete caret version', () => {
  const manifest = generateDistManifest(
    { name: '@adhd/x', version: '1.0.0', dependencies: { '@adhd/apigen-core-client': 'workspace:*' } },
    MAP
  );
  assert.doesNotThrow(() => assertResolvedInternalDeps(manifest, MAP));
});

// CONTRACT REFINEMENT (post-audit false positive): map ABSENCE alone is no
// longer a hazard signal. `@adhd/*` is not an exclusively-internal scope —
// `@adhd/sox-graph-store` is a real, independently-published external npm
// package (0.3.0/0.5.0 on the registry) that happens to share the scope. A
// concrete range on a name absent from the workspace map is exactly what a
// legitimate external @adhd-scoped dependency looks like, and must pass
// through untouched — see the dedicated test below.
test('assertResolvedInternalDeps: a CONCRETE range on an @adhd/* name absent from the version map is ALLOWED (legitimate external @adhd-scoped package)', () => {
  const manifest = { name: '@adhd/x', version: '1.0.0', dependencies: { '@adhd/sox-graph-store': '^0.3.0' } };
  assert.doesNotThrow(
    () => assertResolvedInternalDeps(manifest, MAP),
    'a concrete range must never be flagged just because the name is not a workspace sibling'
  );
});

test('assertResolvedInternalDeps: throws, naming the dep, on a literal "workspace:*" that survived resolution', () => {
  const manifest = { name: '@adhd/x', version: '1.0.0', dependencies: { '@adhd/ghost': 'workspace:*' } };
  assert.throws(() => assertResolvedInternalDeps(manifest, MAP), /@adhd\/ghost/);
});

test('assertResolvedInternalDeps: throws on any "workspace:" protocol range, not just the literal "workspace:*" spelling', () => {
  const manifest = { name: '@adhd/x', version: '1.0.0', dependencies: { '@adhd/ghost': 'workspace:^' } };
  assert.throws(() => assertResolvedInternalDeps(manifest, MAP), /@adhd\/ghost/);
});

test('assertResolvedInternalDeps: throws on a bare "*" that survived resolution', () => {
  const manifest = { name: '@adhd/x', version: '1.0.0', peerDependencies: { '@adhd/ghost': '*' } };
  assert.throws(() => assertResolvedInternalDeps(manifest, MAP), /@adhd\/ghost/);
});

test('assertResolvedInternalDeps: never flags external (non-@adhd/*) deps, however unresolved-looking their range', () => {
  const manifest = { name: '@adhd/x', version: '1.0.0', dependencies: { 'left-pad': '*', react: 'workspace:*' } };
  assert.doesNotThrow(() => assertResolvedInternalDeps(manifest, MAP));
});

test('assertResolvedInternalDeps: checks optionalDependencies too', () => {
  const manifest = { name: '@adhd/x', version: '1.0.0', optionalDependencies: { '@adhd/ghost': '*' } };
  assert.throws(() => assertResolvedInternalDeps(manifest, MAP), /@adhd\/ghost/);
});

test('writeDistManifest integration: refuses to write a manifest with a surviving "workspace:*" internal range (real fs, real generateDistManifest)', async () => {
  const { writeDistManifest } = require('./generate-manifest.js');
  const rootDir = mkdtempSync(join(tmpdir(), 'generate-manifest-writeDist-'));
  try {
    const projectRoot = 'packages/pkg-b';
    const pkgRoot = join(rootDir, projectRoot);
    const distDir = join(pkgRoot, 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(
      join(pkgRoot, 'package.json'),
      // "@adhd/ghost-dep" is not a workspace sibling (buildVersionMapFromDisk
      // will never learn its version), so resolveInternalDeps leaves this
      // "workspace:*" literal untouched — exactly the surviving-hazard shape.
      JSON.stringify({ name: '@adhd/pkg-b', version: '1.0.0', main: './dist/index.js', dependencies: { '@adhd/ghost-dep': 'workspace:*' } })
    );
    writeFileSync(join(distDir, 'index.js'), 'module.exports = {};\n');
    const context = { root: rootDir, projectName: '@adhd/pkg-b', projectsConfigurations: { projects: { '@adhd/pkg-b': { root: projectRoot } } } };

    await assert.rejects(
      () => writeDistManifest(context, pkgRoot, distDir),
      /@adhd\/ghost-dep/,
      'writeDistManifest must refuse to materialize a dist manifest with a surviving workspace:* range'
    );
    assert.equal(existsSync(join(distDir, 'package.json')), false, 'must never have written the bad manifest to disk');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('writeDistManifest integration: a CONCRETE external @adhd/* dependency (not a workspace sibling) writes through unchanged, real fs (BACKLOG false-positive regression: @adhd/sox-graph-store)', async () => {
  const { writeDistManifest } = require('./generate-manifest.js');
  const rootDir = mkdtempSync(join(tmpdir(), 'generate-manifest-writeDist-'));
  try {
    const projectRoot = 'entrypoint/backlog';
    const pkgRoot = join(rootDir, projectRoot);
    const distDir = join(pkgRoot, 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(
      join(pkgRoot, 'package.json'),
      JSON.stringify({ name: '@adhd/backlog', version: '1.0.0', main: './dist/index.js', dependencies: { '@adhd/sox-graph-store': '^0.3.0' } })
    );
    writeFileSync(join(distDir, 'index.js'), 'module.exports = {};\n');
    const context = { root: rootDir, projectName: '@adhd/backlog', projectsConfigurations: { projects: { '@adhd/backlog': { root: projectRoot } } } };

    const manifest = await writeDistManifest(context, pkgRoot, distDir);
    assert.equal(manifest.dependencies['@adhd/sox-graph-store'], '^0.3.0', 'a legitimate external @adhd-scoped package\'s concrete range must ship unchanged');
    assert.equal(
      JSON.parse(readFileSync(join(distDir, 'package.json'), 'utf8')).dependencies['@adhd/sox-graph-store'],
      '^0.3.0'
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('writeDistManifest integration: succeeds and writes normally when every internal dep resolves (real fs)', async () => {
  const { writeDistManifest } = require('./generate-manifest.js');
  const rootDir = mkdtempSync(join(tmpdir(), 'generate-manifest-writeDist-'));
  try {
    const projectRoot = 'packages/pkg-b';
    const depRoot = 'packages/pkg-dep';
    const pkgRoot = join(rootDir, projectRoot);
    const distDir = join(pkgRoot, 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(
      join(pkgRoot, 'package.json'),
      JSON.stringify({ name: '@adhd/pkg-b', version: '1.0.0', main: './dist/index.js', dependencies: { '@adhd/pkg-dep': '^1.0.0' } })
    );
    writeFileSync(join(distDir, 'index.js'), 'module.exports = {};\n');
    mkdirSync(join(rootDir, depRoot), { recursive: true });
    writeFileSync(join(rootDir, depRoot, 'package.json'), JSON.stringify({ name: '@adhd/pkg-dep', version: '1.2.0' }));
    const context = {
      root: rootDir,
      projectName: '@adhd/pkg-b',
      projectsConfigurations: { projects: { '@adhd/pkg-b': { root: projectRoot }, '@adhd/pkg-dep': { root: depRoot } } },
    };

    const manifest = await writeDistManifest(context, pkgRoot, distDir);
    assert.equal(manifest.dependencies['@adhd/pkg-dep'], '^1.2.0');
    assert.equal(JSON.parse(readFileSync(join(distDir, 'package.json'), 'utf8')).dependencies['@adhd/pkg-dep'], '^1.2.0');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('does not mutate the input source manifest', () => {
  const src = { name: '@adhd/x', version: '1.0.0', main: './dist/index.js', dependencies: { '@adhd/apigen-core-client': '^0.1.0' }, files: ['dist'] };
  const snapshot = JSON.parse(JSON.stringify(src));
  generateDistManifest(src, MAP);
  assert.deepEqual(src, snapshot);
});
