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

const require = createRequire(import.meta.url);
const { generateDistManifest, rebaseDistPath, rebaseExports } = require('./generate-manifest.js');

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

test('rebases string bin and object bin', () => {
  assert.deepEqual(
    generateDistManifest({ name: '@adhd/cli', version: '1.0.0', bin: { adhd: './dist/index.js' } }, MAP).bin,
    { adhd: './index.js' }
  );
  assert.equal(
    generateDistManifest({ name: '@adhd/cli', version: '1.0.0', bin: './dist/cli.js' }, MAP).bin,
    './cli.js'
  );
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

test('does not mutate the input source manifest', () => {
  const src = { name: '@adhd/x', version: '1.0.0', main: './dist/index.js', dependencies: { '@adhd/apigen-core-client': '^0.1.0' }, files: ['dist'] };
  const snapshot = JSON.parse(JSON.stringify(src));
  generateDistManifest(src, MAP);
  assert.deepEqual(src, snapshot);
});
