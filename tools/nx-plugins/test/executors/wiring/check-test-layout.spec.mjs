#!/usr/bin/env node
/**
 * Contract of the test-layout checker (docs/standards/testing.md, "Test file layout").
 *
 * guards: a package keeps a spec under src/, a `.test.ts` or `.e2e.test.ts` suffix, an unknown directory under
 *   test/, a mis-cased name, a vitest include that bypasses UNIT_FILE_INCLUDES, or a tsconfig.spec.json that
 *   never reaches test/ — each of which leaves a test undiscovered or unchecked while every lane stays green.
 * failure mode: the checker passes a non-conforming project (rule L1-L6 silent), or flags a conforming one, or
 *   reports clean because its walker scanned nothing.
 * tier: S (pure collector over throwaway fixture workspaces under the tooling scratch root; no process spawned,
 *   nothing sleeps). Fidelity gap: none at tier S; the run against the real repository is recorded in the commit.
 * cites: docs/standards/testing.md "Test file layout"; tools/vite-plugins/e2e-globs.mjs.
 * red: the pre-conformance repository fails the real checker with 557 violations (L1 dominant); every violation
 *   case below fails on a collector that omits its rule, and the conforming control passes on both.
 * risk map (standard): a layout rule that never fires (high, silent undiscovered tests); an over-strict rule
 *   (medium, blocks a legitimate layout).
 *
 * Run: node --test tools/nx-plugins/test/executors/wiring/check-test-layout.spec.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { collectLayoutViolations, TEST_DIR_CHILDREN } from './check-test-layout.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../..');
const { scratchRootPath } = createRequire(import.meta.url)('../../../lib/scratch-root.js');
const SCRATCH_PARENT = scratchRootPath(REPO_ROOT, 'test-layout-spec');

const P = 'packages/demo/demo-core-thing';
const PKG = JSON.stringify({ name: '@adhd/demo-core-thing', version: '0.0.0' });
const VITE = "import { UNIT_FILE_INCLUDES } from '../../../tools/vite-plugins/e2e-globs.mjs';\nexport default { test: { include: UNIT_FILE_INCLUDES } };\n";
const TSSPEC = JSON.stringify({ include: ['vite.config.ts', 'test/**/*.ts'] });
const CONFORMING = {
  [`${P}/package.json`]: PKG,
  [`${P}/project.json`]: '{}',
  [`${P}/vite.config.ts`]: VITE,
  [`${P}/tsconfig.spec.json`]: TSSPEC,
  [`${P}/src/index.ts`]: 'export {};\n',
  [`${P}/test/unit/index.spec.ts`]: '',
  [`${P}/test/e2e/serve.e2e.ts`]: '',
  [`${P}/test/helpers/tmp-dir.ts`]: '',
  [`${P}/test/fixtures/Sample.TS`]: '',
};

function withFixture(files, fn) {
  mkdirSync(SCRATCH_PARENT, { recursive: true });
  const root = mkdtempSync(join(SCRATCH_PARENT, 'ws-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const p = join(root, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
    }
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const rulesOf = (files) => withFixture(files, (root) => collectLayoutViolations(root).violations.map((v) => v.rule));
const without = (key) => Object.fromEntries(Object.entries(CONFORMING).filter(([k]) => k !== key));

test('control: a conforming project reports no violation and counts its test files', () => {
  withFixture(CONFORMING, (root) => {
    const res = collectLayoutViolations(root);
    assert.deepEqual(res.violations, []);
    assert.equal(res.projects, 1);
    assert.equal(res.testFiles, 2);
  });
});

test('L1: a spec, a __tests__ directory, a test-support directory or a src/test-setup file under src/ is flagged', () => {
  assert.deepEqual(rulesOf({ ...CONFORMING, [`${P}/src/lib/thing.spec.ts`]: '' }), ['L1']);
  assert.deepEqual(rulesOf({ ...CONFORMING, [`${P}/src/__tests__/helper.ts`]: '' }), ['L1']);
  assert.deepEqual(rulesOf({ ...CONFORMING, [`${P}/src/test-support/harness.ts`]: '' }), ['L1']);
  assert.deepEqual(rulesOf({ ...CONFORMING, [`${P}/src/test-setup.ts`]: '' }), ['L1']);
});

test('L1: a generator template under __files__ is not a test file of the project', () => {
  assert.deepEqual(rulesOf({ ...CONFORMING, [`${P}/src/generators/x/__files__/src/a.spec.ts__tmpl__`]: '' }), []);
  assert.deepEqual(rulesOf({ ...CONFORMING, [`${P}/src/generators/x/__files__/src/a.spec.ts`]: '' }), []);
});

test('empty directories carry no test and are not flagged; the same names holding a file are', () => {
  withFixture(CONFORMING, (root) => {
    mkdirSync(join(root, P, 'src/__tests__'), { recursive: true });
    mkdirSync(join(root, P, 'test/integration'), { recursive: true });
    assert.deepEqual(collectLayoutViolations(root).violations, []);
    writeFileSync(join(root, P, 'src/__tests__/helper.ts'), '');
    writeFileSync(join(root, P, 'test/integration/helper.ts'), '');
    assert.deepEqual(collectLayoutViolations(root).violations.map((v) => v.rule).sort(), ['L1', 'L2']);
  });
});

test('L2: an entry under test/ outside the closed set is flagged; every allowed child is accepted', () => {
  assert.deepEqual(rulesOf({ ...CONFORMING, [`${P}/test/integration/a.spec.ts`]: '' }), ['L2']);
  assert.deepEqual(rulesOf({ ...CONFORMING, [`${P}/test/rpc-harness.ts`]: '' }), ['L2']);
  assert.deepEqual(rulesOf({ ...CONFORMING, [`${P}/test/golden/x.snapshot.json`]: '', [`${P}/test/setup.ts`]: '' }), []);
  assert.deepEqual([...TEST_DIR_CHILDREN].sort(), ['e2e', 'fixtures', 'golden', 'helpers', 'setup.ts', 'unit']);
});

test('L3: a .test suffix, a non-spec file in unit/ and a non-e2e file in e2e/ are flagged', () => {
  assert.deepEqual(rulesOf({ ...CONFORMING, [`${P}/test/unit/a.test.ts`]: '' }), ['L3']);
  assert.deepEqual(rulesOf({ ...CONFORMING, [`${P}/test/unit/a-helper.ts`]: '' }), ['L3']);
  assert.deepEqual(rulesOf({ ...CONFORMING, [`${P}/test/e2e/a.e2e.test.ts`]: '' }), ['L3']);
  assert.deepEqual(rulesOf({ ...CONFORMING, [`${P}/test/e2e/a.spec.ts`]: '' }), ['L3']);
});

test('L4: upper-case, underscore and camelCase names in unit/, e2e/ and helpers/ are flagged; dotted qualifiers pass', () => {
  assert.deepEqual(rulesOf({ ...CONFORMING, [`${P}/test/unit/MyThing.spec.ts`]: '' }), ['L4']);
  assert.deepEqual(rulesOf({ ...CONFORMING, [`${P}/test/unit/my_thing.spec.ts`]: '' }), ['L4']);
  assert.deepEqual(rulesOf({ ...CONFORMING, [`${P}/test/helpers/tmpDir.ts`]: '' }), ['L4']);
  assert.deepEqual(rulesOf({ ...CONFORMING, [`${P}/test/unit/Query/a.spec.ts`]: '' }), ['L4']);
  assert.deepEqual(rulesOf({ ...CONFORMING, [`${P}/test/unit/cli.store-check.spec.ts`]: '' }), []);
});

test('L5: a vitest include that is not UNIT_FILE_INCLUDES is flagged', () => {
  assert.deepEqual(rulesOf({ ...CONFORMING, [`${P}/vite.config.ts`]: "export default { test: { include: ['src/**/*.spec.ts'] } };\n" }), ['L5']);
  assert.deepEqual(rulesOf(without(`${P}/vite.config.ts`)), ['L5']);
});

test('L6: a tsconfig.spec.json that never reaches test/ is flagged; a project with none is left to lane-reachability rule 6', () => {
  assert.deepEqual(rulesOf(without(`${P}/tsconfig.spec.json`)), []);
  assert.deepEqual(rulesOf({ ...CONFORMING, [`${P}/tsconfig.spec.json`]: JSON.stringify({ include: ['src/**/*.spec.ts'] }) }), ['L6']);
});

test('L7: a src file importing from test/ is flagged (import, re-export and require); a src-internal import is not', () => {
  for (const body of ["export { X } from '../test/helpers/tmp-dir.js';\n", "import { X } from '../../test/helpers/tmp-dir';\n", "const X = require('../test/helpers/tmp-dir');\n"]) {
    assert.deepEqual(rulesOf({ ...CONFORMING, [`${P}/src/lib/uses-test.ts`]: body }), ['L7']);
  }
  assert.deepEqual(rulesOf({ ...CONFORMING, [`${P}/src/lib/ok.ts`]: "export { X } from './latest/thing.js';\n" }), []);
});

test('scope: the native-layout Maven module is not governed, and a workspace with no project scans zero', () => {
  const native = { 'packages/apigen/java/package.json': PKG, 'packages/apigen/java/project.json': '{}', 'packages/apigen/java/src/test/java/A.spec.ts': '' };
  assert.deepEqual(rulesOf(native), []);
  withFixture({ 'README.md': '' }, (root) => {
    const res = collectLayoutViolations(root);
    assert.equal(res.projects, 0);
    assert.equal(res.testFiles, 0);
  });
});
