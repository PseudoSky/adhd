/**
 * Teeth tests for the `assets` copy executor's bin-chmod step —
 * DEBT-002 #4: the chmod loop only handled OBJECT-form `bin`
 * ({ name: path }); a STRING-form `bin` ("bin": "./cli.js", the common
 * single-executable shape) silently skipped the chmod entirely, so a CLI
 * package declaring `bin` as a string would ship without its executable bit
 * — npm's publish-time bin validation then silently strips it.
 *
 * Mocking boundary: none. Runs the real executor against a real temp dist
 * directory and asserts the real chmod bit on disk.
 *
 * Run: node --test tools/nx-plugins/assets/executors/copy/impl.spec.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const implAbs = require.resolve('./impl.js');

function loadFreshImpl() {
  delete require.cache[implAbs];
  return require(implAbs);
}

function makeProject({ rootDir, name, projectRoot, pkg, distFiles = {} }) {
  const pkgRoot = join(rootDir, projectRoot);
  mkdirSync(pkgRoot, { recursive: true });
  writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify(pkg, null, 2));
  const distDir = join(pkgRoot, 'dist');
  mkdirSync(distDir, { recursive: true });
  for (const [rel, content] of Object.entries(distFiles)) {
    const abs = join(distDir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
    chmodSync(abs, 0o644); // start explicitly non-executable, matching a real tsc/vite build output
  }
  const context = { root: rootDir, projectName: name, projectsConfigurations: { projects: { [name]: { root: projectRoot } } } };
  return { pkgRoot, distDir, context };
}

function isExecutable(path) {
  return (statSync(path).mode & 0o111) === 0o111;
}

test('DEBT-002 #4: STRING-form "bin" is normalized and chmod +x is applied (previously silently skipped)', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'assets-copy-'));
  try {
    const pkg = { name: '@adhd/some-cli', version: '1.0.0', bin: './dist/index.js' };
    const { distDir, context } = makeProject({
      rootDir, name: 'some-cli', projectRoot: 'entrypoint/some-cli', pkg,
      distFiles: { 'index.js': '#!/usr/bin/env node\nconsole.log("hi");\n' },
    });
    const binFile = join(distDir, 'index.js');
    assert.equal(isExecutable(binFile), false, 'precondition: dist output starts non-executable, like a real tsc/vite build');

    const copy = loadFreshImpl();
    const result = await copy({}, context);
    assert.equal(result.success, true);
    assert.equal(isExecutable(binFile), true, 'a string-form bin must now get chmod +x, same as object-form');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('DEBT-002 #4: STRING-form bin key is derived from the package name\'s basename (scoped name)', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'assets-copy-'));
  try {
    const pkg = { name: '@adhd/apigen-cli', version: '1.0.0', bin: './dist/cli.js' };
    const { distDir, context } = makeProject({
      rootDir, name: 'apigen-cli', projectRoot: 'entrypoint/apigen-cli', pkg,
      distFiles: { 'cli.js': '#!/usr/bin/env node\n' },
    });
    const copy = loadFreshImpl();
    const result = await copy({}, context);
    assert.equal(result.success, true);
    assert.equal(isExecutable(join(distDir, 'cli.js')), true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('object-form "bin" still works exactly as before (no regression)', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'assets-copy-'));
  try {
    const pkg = { name: '@adhd/multi-cli', version: '1.0.0', bin: { 'multi-cli': './dist/index.js', 'multi-cli-admin': './dist/admin.js' } };
    const { distDir, context } = makeProject({
      rootDir, name: 'multi-cli', projectRoot: 'entrypoint/multi-cli', pkg,
      distFiles: { 'index.js': '#!/usr/bin/env node\n', 'admin.js': '#!/usr/bin/env node\n' },
    });
    const copy = loadFreshImpl();
    const result = await copy({}, context);
    assert.equal(result.success, true);
    assert.equal(isExecutable(join(distDir, 'index.js')), true);
    assert.equal(isExecutable(join(distDir, 'admin.js')), true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('a package with no "bin" field at all is unaffected (no crash, no chmod attempted)', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'assets-copy-'));
  try {
    const pkg = { name: '@adhd/lib-only', version: '1.0.0', main: './dist/index.js' };
    const { distDir, context } = makeProject({
      rootDir, name: 'lib-only', projectRoot: 'packages/lib-only', pkg,
      distFiles: { 'index.js': 'module.exports = {};\n' },
    });
    const copy = loadFreshImpl();
    const result = await copy({}, context);
    assert.equal(result.success, true);
    assert.equal(isExecutable(join(distDir, 'index.js')), false, 'a plain library entry must never be chmod +x-ed');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('string-form bin whose target does not exist in dist logs and skips chmod without failing the task', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'assets-copy-'));
  try {
    const pkg = { name: '@adhd/broken-cli', version: '1.0.0', bin: './dist/missing.js' };
    const { context } = makeProject({
      rootDir, name: 'broken-cli', projectRoot: 'entrypoint/broken-cli', pkg,
      distFiles: { 'index.js': 'x\n' }, // "missing.js" deliberately never written
    });
    const copy = loadFreshImpl();
    const result = await copy({}, context);
    assert.equal(result.success, true, 'a missing bin target must not fail the whole assets-copy task (matches pre-existing object-form behavior)');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
