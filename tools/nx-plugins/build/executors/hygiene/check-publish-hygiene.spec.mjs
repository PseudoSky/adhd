/**
 * Teeth tests for check-publish-hygiene.mjs's FORBIDDEN_PATTERNS —
 * DEBT-002 #3: the original pattern set caught `__tests__/` (Jest-style,
 * double underscore) and filename-shaped markers (`*.test.*`/`*.spec.*`/
 * `*.e2e.*`), but NOT a generic `test/`, `tests/`, `__mocks__/`, or
 * `fixtures/` directory — a real incident shipped `test/*.d.ts` inside a
 * published tarball this way, because none of the existing patterns matched
 * that shape.
 *
 * Mocking boundary: NONE. This drives `checkPackage` against a real,
 * isolated `dist/` fixture (real `npm pack --dry-run --json`, no
 * `child_process` mocking) — the exact same code path `publish-hygiene`
 * calls in production.
 *
 * Run: node --test tools/nx-plugins/build/executors/hygiene/check-publish-hygiene.spec.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const implAbs = require.resolve('./check-publish-hygiene.mjs');

async function loadCheckPackage() {
  const mod = await import(implAbs + `?t=${Date.now()}`);
  return mod;
}

function makeDist(rootDir, projectRoot, pkgJson, files) {
  const distDir = join(rootDir, projectRoot, 'dist');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, 'package.json'), JSON.stringify(pkgJson, null, 2));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(distDir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return distDir;
}

test('DEBT-002 #3: a generic top-level "test/" directory is now forbidden (the exact BUG-shaped incident: test/*.d.ts shipped)', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hygiene-patterns-'));
  try {
    const projectRoot = 'packages/pkg-b';
    makeDist(rootDir, projectRoot, { name: '@adhd/pkg-b', version: '1.0.0', main: './index.js' }, {
      'index.js': 'module.exports = {};\n',
      'test/fixture.d.ts': 'export {};\n',
    });
    // Import a fresh copy so main()'s module-level `isMain` guard state
    // doesn't matter — we call checkPackage-equivalent behavior via main({repoRoot}).
    const { main } = await loadCheckPackage();
    const result = JSON.parse(
      await captureStdout(() => main([projectRoot, '--json'], { repoRoot: rootDir }))
    );
    const pkgResult = result.results[0];
    assert.equal(pkgResult.ok, false, 'a shipped test/ directory must fail the gate');
    assert.ok(
      pkgResult.errors.some((e) => /test\/ directory/.test(e)),
      `expected a "test/ directory" violation, got: ${JSON.stringify(pkgResult.errors)}`
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('DEBT-002 #3: "tests/", "__mocks__/", and "fixtures/" directories are all forbidden', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hygiene-patterns-'));
  try {
    const projectRoot = 'packages/pkg-b';
    makeDist(rootDir, projectRoot, { name: '@adhd/pkg-b', version: '1.0.0', main: './index.js' }, {
      'index.js': 'module.exports = {};\n',
      'tests/a.js': 'x\n',
      '__mocks__/b.js': 'x\n',
      'fixtures/c.json': '{}\n',
    });
    const { main } = await loadCheckPackage();
    const result = JSON.parse(
      await captureStdout(() => main([projectRoot, '--json'], { repoRoot: rootDir }))
    );
    const pkgResult = result.results[0];
    assert.equal(pkgResult.ok, false);
    const labels = pkgResult.errors.join(' | ');
    assert.match(labels, /tests\/ directory/);
    assert.match(labels, /__mocks__ directory/);
    assert.match(labels, /fixtures\/ directory/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('DEBT-002 #3: source map (.map) files are NOT forbidden — they are an intentional part of the shipped artifact', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hygiene-patterns-'));
  try {
    const projectRoot = 'packages/pkg-b';
    makeDist(rootDir, projectRoot, { name: '@adhd/pkg-b', version: '1.0.0', main: './index.js' }, {
      'index.js': 'module.exports = {};\n',
      'index.js.map': '{"version":3}\n',
    });
    const { main } = await loadCheckPackage();
    const result = JSON.parse(
      await captureStdout(() => main([projectRoot, '--json'], { repoRoot: rootDir }))
    );
    const pkgResult = result.results[0];
    assert.equal(pkgResult.ok, true, `a clean package with a .map file must pass: ${JSON.stringify(pkgResult.errors)}`);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('generator-template false-positive fix: a "test/" path INSIDE a __files__/ scaffold-template directory is ALLOWED (legitimate nx generator template content, not shipped bloat)', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hygiene-patterns-'));
  try {
    const projectRoot = 'packages/apigen-generator-nx';
    // Exact live shape: an nx generator ships scaffold TEMPLATES for the
    // projects it generates under __files__/, including a template test file
    // (e.g. "plugin.spec.ts__tmpl__") that must ship as-is — it's DATA the
    // generator writes into a NEW project, never this package's own bloat.
    makeDist(rootDir, projectRoot, { name: '@adhd/apigen-generator-nx', version: '1.0.0', main: './index.js' }, {
      'index.js': 'module.exports = {};\n',
      'src/generators/plugin/__files__/src/test/plugin.spec.ts__tmpl__': 'export {};\n',
      'src/generators/plugin/__files__/src/lib/plugin.ts__tmpl__': 'export {};\n',
    });
    const { main } = await loadCheckPackage();
    const result = JSON.parse(
      await captureStdout(() => main([projectRoot, '--json'], { repoRoot: rootDir }))
    );
    const pkgResult = result.results[0];
    assert.equal(pkgResult.ok, true, `a __files__/ scaffold template must never be flagged as shipped test bloat: ${JSON.stringify(pkgResult.errors)}`);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('generator-template false-positive fix: a TOP-LEVEL (non-__files__/) "test/" path is STILL forbidden — the exemption is scoped to __files__/ only, never a blanket allow', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hygiene-patterns-'));
  try {
    const projectRoot = 'packages/apigen-generator-nx';
    makeDist(rootDir, projectRoot, { name: '@adhd/apigen-generator-nx', version: '1.0.0', main: './index.js' }, {
      'index.js': 'module.exports = {};\n',
      // A real, top-level (never templated, never inside __files__/) test/
      // directory — this is the package's OWN dev-time bloat, not a
      // generator's scaffold data, and must still be forbidden.
      'test/x.d.ts': 'export {};\n',
    });
    const { main } = await loadCheckPackage();
    const result = JSON.parse(
      await captureStdout(() => main([projectRoot, '--json'], { repoRoot: rootDir }))
    );
    const pkgResult = result.results[0];
    assert.equal(pkgResult.ok, false, 'a genuine top-level test/ directory outside any __files__/ scaffold must still fail');
    assert.ok(pkgResult.errors.some((e) => /test\/ directory/.test(e)));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('DEBT-002 #3: a clean package with no test-shaped paths still passes (no false positives from the new patterns)', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hygiene-patterns-'));
  try {
    const projectRoot = 'packages/pkg-b';
    makeDist(rootDir, projectRoot, { name: '@adhd/pkg-b', version: '1.0.0', main: './index.js' }, {
      'index.js': 'module.exports = {};\n',
      'src/lib/helper.js': 'module.exports = {};\n',
    });
    const { main } = await loadCheckPackage();
    const result = JSON.parse(
      await captureStdout(() => main([projectRoot, '--json'], { repoRoot: rootDir }))
    );
    assert.equal(result.results[0].ok, true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

/** Capture everything main() writes to stdout during `fn()` and return it as a string. */
async function captureStdout(fn) {
  const chunks = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    chunks.push(chunk);
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
  }
  return chunks.join('');
}
