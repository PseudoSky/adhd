#!/usr/bin/env node
/**
 * Negative controls for check-agent-lane-spawn (backlog 5b839b90 AC2).
 *
 * Each case builds a fixture agent-family workspace, drives the REAL
 * `collectAgentLaneSpawnViolations`, and asserts the rule FIRES on a planted
 * violation and stays silent on the correctly-laned equivalent. The final case
 * drives the real CLI as a child process and keys on its exit status.
 *
 * Run: node --test tools/nx-plugins/test/executors/wiring/check-agent-lane-spawn.spec.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectAgentLaneSpawnViolations, spawnReason, stripComments } from './check-agent-lane-spawn.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'check-agent-lane-spawn.mjs');
const EMPTY_BASELINE = { pendingMove: [] };
const SPAWNING = `import { spawnSync } from 'node:child_process';\nspawnSync('npx', ['x']);\n`;

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'agent-lane-'));
  for (const [rel, content] of Object.entries({
    'packages/agent/agent-foo/project.json': '{"name":"agent-foo"}',
    'packages/agent/agent-foo/src/ok.spec.ts': 'export {};\n',
    'packages/agent/agent-foo/vite.config.ts': 'export default { test: { exclude: [...E2E_FILE_EXCLUDES] } };\n',
    ...files,
  })) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}
const rules = (r) => r.violations.map((v) => v.rule);

test('clean workspace is silent [5b839b90 AC2]', () => {
  const root = fixture({});
  try {
    assert.deepEqual(rules(collectAgentLaneSpawnViolations(root, EMPTY_BASELINE)), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('A fires: unit-lane spec importing child_process (5b839b90 AC2)', () => {
  const root = fixture({ 'packages/agent/agent-foo/src/bad.test.ts': SPAWNING });
  try {
    const r = collectAgentLaneSpawnViolations(root, EMPTY_BASELINE);
    assert.deepEqual(rules(r), ['A-spawn-in-unit-lane']);
    assert.match(r.violations[0].detail, /bad\.test\.ts/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('A is silent once the same file is in the e2e lane [5b839b90 AC2]', () => {
  const root = fixture({ 'packages/agent/agent-foo/src/bad.e2e.test.ts': SPAWNING });
  try {
    assert.deepEqual(rules(collectAgentLaneSpawnViolations(root, EMPTY_BASELINE)), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('A fires on StdioClientTransport and a real-executable stdio registry [5b839b90 AC2]', () => {
  assert.match(spawnReason(`new StdioClientTransport({ command: 'x' })`) ?? '', /StdioClientTransport/);
  assert.ok(spawnReason(`new McpClientRegistry({ a: { transport: 'stdio', command: process.execPath } })`));
});

test('A is silent for mocked child_process, comment mentions, and inert config data [5b839b90 AC2]', () => {
  assert.equal(spawnReason(`vi.mock('child_process', () => ({}));\nconst { spawn } = await import('child_process');`), undefined);
  assert.equal(spawnReason(`// uses child_process and StdioClientTransport\n/* StdioMcpClient */\n`), undefined);
  assert.equal(spawnReason(`const s = { transport: 'stdio', command: 'npx' };`), undefined);
  assert.equal(stripComments('a // x\nb'), 'a \nb');
});

test('C fires: *.e2e.test.ts present but unit lane does not exclude them [5b839b90 AC2]', () => {
  const root = fixture({
    'packages/agent/agent-foo/src/x.e2e.test.ts': SPAWNING,
    'packages/agent/agent-foo/vite.config.ts': 'export default { test: {} };\n',
  });
  try {
    assert.deepEqual(rules(collectAgentLaneSpawnViolations(root, EMPTY_BASELINE)), ['C-e2e-test-not-excluded-from-unit']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('B fires on a stale pendingMove entry and is silent while the file is still unit-lane [5b839b90 AC2]', () => {
  const root = fixture({ 'packages/agent/agent-foo/src/pending.test.ts': 'export {};\n' });
  try {
    const live = { pendingMove: ['packages/agent/agent-foo/src/pending.test.ts'] };
    assert.deepEqual(rules(collectAgentLaneSpawnViolations(root, live)), []);
    const stale = { pendingMove: ['packages/agent/agent-foo/src/gone.test.ts'] };
    assert.deepEqual(rules(collectAgentLaneSpawnViolations(root, stale)), ['B-pending-move-stale']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI exits 1 on a planted violation and 0 once removed [5b839b90 AC2]', () => {
  const root = fixture({ 'packages/agent/agent-foo/src/bad.test.ts': SPAWNING, 'baseline.json': '{"pendingMove":[]}' });
  const args = [CLI, '--workspace-root', root, '--baseline', join(root, 'baseline.json')];
  try {
    const red = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(red.status, 1);
    rmSync(join(root, 'packages/agent/agent-foo/src/bad.test.ts'));
    const green = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(green.status, 0, green.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
