/**
 * tier-timeout.e2e.mjs: T37.AC1, each tier has an enforced per-test timeout. A real vitest runs a temporary project
 * through the setup file the shared plugin hook attaches, with the caps lowered by ADHD_TIER_TIMEOUT_CAPS so a case
 * takes milliseconds, and the declared tier decides whether a 500 ms test times out.
 *
 * guards: a test file keeps a timeout above its declared tier's cap, a cap raises a timeout it should only lower, an
 *   undeclared (legacy) file is capped, or the shared hook stops attaching the setup file.
 * tier: P (spawns vitest as a child process and reads its exit status and report).
 * gap: This cannot be observed at tier S because the timeout is applied by vitest inside a worker from a setup file;
 *   only a real vitest run shows that vi.setConfig in the setup file reaches the test's own timeout.
 * cites: 595965cc T37.AC1; backlog 1ab12bb2 (a 5 s timeout flaked under load), e47ec788 (no load guidance in the standard).
 * teeth: red 2026-10-15: `node --test tier-timeout.e2e.mjs` -> exit 1 with the setup file's vi.setConfig removed (the
 *   declared-S case passes instead of timing out), and 1 with the cap applied to inferred-tier files (the legacy case fails).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sharedTestConfig, tierTimeoutConfig, TIER_TIMEOUT_SETUP } from '../../../vite-plugins/test-metrics.mjs';
import { TIER_TIMEOUT_CAPS_MS, timeoutForTier } from './tiers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const VITEST = join(ROOT, 'node_modules/.bin/vitest');
const SLEEP = "await new Promise((r) => setTimeout(r, 500));";
const spec = (tier) => `/**\n * guards: x\n * tier: ${tier}\n * cites: x\n */\nimport { it } from 'vitest';\nit('sleeps 500 ms', async () => { ${SLEEP} });\n`;

let dir;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'tier-timeout-'));
  writeFileSync(join(dir, 'vitest.config.mjs'), `export default { test: { setupFiles: [${JSON.stringify(TIER_TIMEOUT_SETUP)}], testTimeout: 30000, include: ['*.spec.mjs'] } };\n`);
  writeFileSync(join(dir, 'declared-s.spec.mjs'), spec('S'));
  writeFileSync(join(dir, 'declared-p.spec.mjs'), spec('P'));
  writeFileSync(join(dir, 'legacy.spec.mjs'), `import { it } from 'vitest';\nit('sleeps 500 ms', async () => { ${SLEEP} });\n`);
});
after(() => rmSync(dir, { recursive: true, force: true }));

function runVitest(env = {}) {
  const r = spawnSync(VITEST, ['run', '--reporter=json'], { cwd: dir, encoding: 'utf8', env: { ...process.env, ADHD_TIER_TIMEOUT_CAPS: '{"S":200}', ADHD_TEST_METRICS: '0', ...env } });
  const json = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  const byFile = Object.fromEntries(json.testResults.map((t) => [t.name.split('/').pop(), t.assertionResults[0].status]));
  return { status: r.status, byFile };
}

describe('the enforced timeout of each tier', () => {
  it('the repository states a cap for S, P and H, and none for the metered tier X', () => {
    assert.deepEqual(TIER_TIMEOUT_CAPS_MS, { S: 30_000, P: 60_000, H: 300_000, X: null });
    assert.equal(timeoutForTier('S'), 30_000);
    assert.equal(timeoutForTier('X'), null);
  });

  it('a file declared tier S times out at the S cap while tier P and an undeclared file keep their longer limits', () => {
    const { status, byFile } = runVitest();
    assert.equal(byFile['declared-s.spec.mjs'], 'failed', 'a 500 ms test must time out under a 200 ms S cap');
    assert.equal(byFile['declared-p.spec.mjs'], 'passed');
    assert.equal(byFile['legacy.spec.mjs'], 'passed', 'an undeclared file is not capped');
    assert.equal(status, 1);
  });

  it('ADHD_TIER_TIMEOUT=0 turns the cap off', () => {
    const { status, byFile } = runVitest({ ADHD_TIER_TIMEOUT: '0' });
    assert.equal(byFile['declared-s.spec.mjs'], 'passed');
    assert.equal(status, 0);
  });

  it('a cap never raises a timeout: a project configured below the cap keeps its own', () => {
    writeFileSync(join(dir, 'vitest.config.mjs'), `export default { test: { setupFiles: [${JSON.stringify(TIER_TIMEOUT_SETUP)}], testTimeout: 100, include: ['*.spec.mjs'] } };\n`);
    const { byFile } = runVitest({ ADHD_TIER_TIMEOUT_CAPS: '{"S":5000,"P":5000}' });
    assert.equal(byFile['declared-s.spec.mjs'], 'failed', 'the 100 ms configured timeout stays; a 5000 ms cap does not lift it');
    assert.equal(byFile['declared-p.spec.mjs'], 'failed');
  });
});

describe('the shared plugin hook', () => {
  it('appends the setup file to a config with a test block and touches nothing else', () => {
    assert.deepEqual(tierTimeoutConfig({ test: {} }), { test: { setupFiles: [TIER_TIMEOUT_SETUP] } });
    assert.equal(tierTimeoutConfig({}), undefined);
    assert.equal(tierTimeoutConfig({ test: {} }, { ADHD_TIER_TIMEOUT: '0' }), undefined);
  });

  it('sharedTestConfig carries both the metrics reporter and the timeout setup file, and each switch removes only its own', () => {
    const both = sharedTestConfig({ test: {} });
    assert.ok(both.test.reporters.length >= 1 && both.test.setupFiles.length === 1);
    assert.equal(sharedTestConfig({ test: {} }, { ADHD_TEST_METRICS: '0' }).test.reporters, undefined);
    assert.equal(sharedTestConfig({ test: {} }, { ADHD_TIER_TIMEOUT: '0' }).test.setupFiles, undefined);
    assert.equal(sharedTestConfig({}), undefined);
  });
});
