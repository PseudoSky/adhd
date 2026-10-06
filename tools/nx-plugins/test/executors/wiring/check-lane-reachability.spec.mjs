#!/usr/bin/env node
/**
 * Negative controls for check-lane-reachability.
 *
 * AGENTS.md §7: an assertion with no negative control proves nothing. Each test
 * below builds a fixture workspace, drives the REAL `runChecks` over it, asserts
 * the specific rule FIRES when the invariant is violated, and — in the base
 * case — that a correctly-wired fixture is silent. Rule 4's control injects a
 * deliberately-broken `createNodesFn` (the production path uses the real build
 * plugin, so a fixture cannot break it without a plugin edit; the injected stub
 * proves the machine check reads the plugin's RESOLVED output, not a
 * re-implementation).
 *
 * Run: node --test tools/nx-plugins/test/executors/wiring/check-lane-reachability.spec.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runChecks } from './check-lane-reachability.mjs';
// Rule 8's own negative controls ride this (already `test:build-tools`-wired) spec file.
import './check-agent-lane-spawn.spec.mjs';

const GATE_TARGETS = ['test', 'e2e'];
// A stub createNodes that attaches NO publish target (so rule 4 is silent
// unless a test deliberately injects a broken one).
const NO_PUBLISH = () => [];

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'lane-reach-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}

/** A correctly-wired project `foo` (has e2e files + a cached e2e target). */
function baseFiles(overrides = {}) {
  const fooProject = {
    name: 'foo',
    targets: {
      test: { executor: 'nx:run-commands' },
      e2e: { executor: 'nx:run-commands', cache: true, inputs: ['default'] },
    },
  };
  const files = {
    'packages/foo/project.json': JSON.stringify(fooProject, null, 2),
    'packages/foo/package.json': JSON.stringify({ name: '@adhd/foo', version: '0.0.0' }),
    'packages/foo/src/a.e2e.ts': '',
    // A valid single-array config so rule 7 (the repo-wide sweep) is silent on the base fixture.
    'packages/foo/vite.config.ts': 'export default {\n  plugins: [nxViteTsPaths()],\n};\n',
    '.githooks/pre-push': 'flags=$(node "$repo_root/tools/gate/lane-gate.mjs")\n',
    '.github/workflows/pull-request.yml':
      'npx nx affected -t test --parallel=5\nnpx nx affected -t e2e --parallel=1\n',
    '.github/workflows/ci.yml':
      'npx nx affected -t test build\nnpx nx affected -t e2e --parallel=1\n',
  };
  return { files, fooProject, ...overrides };
}

async function check(root, extra = {}) {
  return runChecks({ workspaceRoot: root, gateTargets: GATE_TARGETS, createNodesFn: NO_PUBLISH, baseline: { tsconfigSpecWithoutCompileTarget: [] }, agentLaneBaseline: { pendingMove: [] }, ...extra });
}

const hasRule = (res, rule) => res.violations.some((v) => v.rule === rule);
const close = (root) => rmSync(root, { recursive: true, force: true });

test('base fixture (correctly wired) is silent', async () => {
  const root = fixture(baseFiles().files);
  try {
    const res = await check(root);
    assert.deepEqual(res.violations, []);
  } finally {
    close(root);
  }
});

test('rule 1 RED: e2e files with no e2e target', async () => {
  const { files } = baseFiles();
  files['packages/baz/project.json'] = JSON.stringify({ name: 'baz', targets: {} });
  files['packages/baz/package.json'] = JSON.stringify({ name: '@adhd/baz' });
  files['packages/baz/src/b.e2e.ts'] = '';
  const root = fixture(files);
  try {
    const res = await check(root);
    assert.ok(hasRule(res, '1-e2e-files-without-target'), JSON.stringify(res.violations));
  } finally {
    close(root);
  }
});

test('rule 2 RED: test.dependsOn contains e2e', async () => {
  const { files, fooProject } = baseFiles();
  fooProject.targets.test.dependsOn = ['build', 'e2e'];
  files['packages/foo/project.json'] = JSON.stringify(fooProject, null, 2);
  const root = fixture(files);
  try {
    const res = await check(root);
    assert.ok(hasRule(res, '2-test-depends-on-e2e'), JSON.stringify(res.violations));
  } finally {
    close(root);
  }
});

test('rule 3 RED: e2e not cached / no inputs', async () => {
  const { files, fooProject } = baseFiles();
  fooProject.targets.e2e = { executor: 'nx:run-commands', cache: false };
  files['packages/foo/project.json'] = JSON.stringify(fooProject, null, 2);
  const root = fixture(files);
  try {
    const res = await check(root);
    assert.ok(hasRule(res, '3-e2e-not-cached'), JSON.stringify(res.violations));
  } finally {
    close(root);
  }
});

test('rule 4 RED: publish does not reach a declared e2e (broken plugin conditional)', async () => {
  const { files } = baseFiles();
  const root = fixture(files);
  // Inject a plugin that attaches a publish target WITHOUT e2e for foo, which
  // DOES declare e2e -> disagreement.
  const brokenPlugin = (configFiles) =>
    configFiles.map((p) => [p, { projects: { [dirname(p)]: { targets: { publish: { dependsOn: ['test'] } } } } }]);
  try {
    const res = await check(root, { createNodesFn: brokenPlugin });
    assert.ok(hasRule(res, '4-publish-e2e-disagreement'), JSON.stringify(res.violations));
  } finally {
    close(root);
  }
});

test('rule 5 RED: a gate file stops invoking a GATE_TARGET', async () => {
  const { files } = baseFiles();
  files['.github/workflows/ci.yml'] = 'npx nx affected -t test build\n'; // e2e dropped
  const root = fixture(files);
  try {
    const res = await check(root);
    assert.ok(hasRule(res, '5-gate-file-missing-target'), JSON.stringify(res.violations));
    assert.ok(res.violations.some((v) => v.detail.includes('ci.yml') && v.detail.includes('e2e')));
  } finally {
    close(root);
  }
});

test('rule 5 RED: pre-push hard-codes flags instead of sourcing lane-gate.mjs', async () => {
  const { files } = baseFiles();
  files['.githooks/pre-push'] = 'npx nx affected --target=test --target=e2e\n';
  const root = fixture(files);
  try {
    const res = await check(root);
    assert.ok(hasRule(res, '5-gate-not-canonical'), JSON.stringify(res.violations));
  } finally {
    close(root);
  }
});

test('rule 6 RED: tsconfig.spec.json with no compiling target (not baselined)', async () => {
  const { files } = baseFiles();
  files['packages/qux/project.json'] = JSON.stringify({ name: 'qux', targets: {} });
  files['packages/qux/package.json'] = JSON.stringify({ name: '@adhd/qux' });
  files['packages/qux/tsconfig.spec.json'] = '{}';
  const root = fixture(files);
  try {
    const res = await check(root);
    assert.ok(hasRule(res, '6-tsconfig-spec-without-compile-target'), JSON.stringify(res.violations));
  } finally {
    close(root);
  }
});

test('rule 7 RED: a duplicate `plugins:` key in ANY package config', async () => {
  const { files } = baseFiles();
  // A config OUTSIDE packages/foo (the sweep is repo-wide, not per-project).
  files['packages/bar/project.json'] = JSON.stringify({ name: 'bar', targets: {} });
  files['packages/bar/vite.config.ts'] =
    'export default {\n  plugins: [nxViteTsPaths()],\n  plugins: [importMetaUrlCjs()],\n};\n';
  const root = fixture(files);
  try {
    const res = await check(root);
    assert.ok(hasRule(res, 'vite-duplicate-plugins-key'), JSON.stringify(res.violations));
    assert.ok(res.violations.some((v) => v.detail.includes('packages/bar')));
  } finally {
    close(root);
  }
});

test('rule 7 RED: an imported vite-plugin factory missing from the plugins array', async () => {
  const { files } = baseFiles();
  files['packages/bar/project.json'] = JSON.stringify({ name: 'bar', targets: {} });
  files['packages/bar/vite.config.ts'] =
    "import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';\nexport default {\n  plugins: [],\n};\n";
  const root = fixture(files);
  try {
    const res = await check(root);
    assert.ok(hasRule(res, 'vite-imported-factory-missing'), JSON.stringify(res.violations));
  } finally {
    close(root);
  }
});

test('rule 7 RED: a workspace with projects but no scanned configs fails loudly (dead walker)', async () => {
  const { files } = baseFiles();
  delete files['packages/foo/vite.config.ts'];
  const root = fixture(files);
  try {
    const res = await check(root);
    assert.ok(hasRule(res, '7-vite-sweep-found-nothing'), JSON.stringify(res.violations));
  } finally {
    close(root);
  }
});

test('rule 6 ratchet: a baselined gap is suppressed; a wired one is not flagged', async () => {
  const { files, fooProject } = baseFiles();
  files['packages/qux/project.json'] = JSON.stringify({ name: 'qux', targets: {} });
  files['packages/qux/package.json'] = JSON.stringify({ name: '@adhd/qux' });
  files['packages/qux/tsconfig.spec.json'] = '{}';
  // foo gets a compiling target over its tsconfig.spec.json.
  fooProject.targets['typecheck-spec'] = { executor: 'nx:run-commands', options: { command: 'tsc -p packages/foo/tsconfig.spec.json --noEmit' } };
  files['packages/foo/project.json'] = JSON.stringify(fooProject, null, 2);
  files['packages/foo/tsconfig.spec.json'] = '{}';
  const root = fixture(files);
  try {
    const res = await check(root, { baseline: { tsconfigSpecWithoutCompileTarget: ['packages/qux'] } });
    assert.ok(!hasRule(res, '6-tsconfig-spec-without-compile-target'), JSON.stringify(res.violations));
    const res2 = await check(root, { baseline: { tsconfigSpecWithoutCompileTarget: [] } });
    assert.ok(!res2.violations.some((v) => v.detail.startsWith('packages/foo')), 'wired project must not be flagged');
  } finally {
    close(root);
  }
});

test('rule 8 fires: an agent-family unit test spawning a subprocess [5b839b90 AC2]', async () => {
  const root = fixture({
    ...baseFiles().files,
    'packages/agent/agent-foo/project.json': JSON.stringify({ name: 'agent-foo', targets: {} }),
    'packages/agent/agent-foo/package.json': JSON.stringify({ name: '@adhd/agent-foo', version: '0.0.0' }),
    'packages/agent/agent-foo/vite.config.ts': 'export default { plugins: [] };\n',
    'packages/agent/agent-foo/src/spawn.test.ts': "import { spawnSync } from 'node:child_process';\nspawnSync('npx', []);\n",
  });
  try {
    const res = await check(root);
    assert.ok(hasRule(res, '8-A-spawn-in-unit-lane'), JSON.stringify(res.violations));
  } finally { close(root); }
});

test('the five agent projects have an e2e target and their unit test excludes the e2e globs [5b839b90 AC1]', () => {
  const repo = join(dirname(fileURLToPath(import.meta.url)), '../../../../..');
  const projects = [
    'packages/agent/agent-core-env',
    'packages/agent/agent-engine-compiler',
    'packages/agent/agent-engine-orchestrator',
    'entrypoint/agent-mcp',
    'entrypoint/dispatch-cli',
  ];
  for (const p of projects) {
    const proj = JSON.parse(readFileSync(join(repo, p, 'project.json'), 'utf8'));
    assert.ok(proj.targets.e2e, `${p} has no e2e target`);
    assert.equal(proj.targets.e2e.cache, true, `${p} e2e not cached`);
    assert.ok(proj.targets['nx-release-publish'].dependsOn.includes('e2e'), `${p} release does not reach e2e`);
    assert.ok(existsSync(join(repo, p, 'vitest.e2e.config.ts')), `${p} lacks vitest.e2e.config.ts`);
    assert.match(readFileSync(join(repo, p, 'vite.config.ts'), 'utf8'), /exclude:\s*\[[^\]]*E2E_FILE_EXCLUDES/, `${p} unit lane does not exclude e2e globs`);
  }
});
