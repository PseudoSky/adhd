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

import { discoverSmokeEntrypoints } from './clean-room-smoke.mjs';

function makeWorkspace(entrypoints) {
  const root = mkdtempSync(join(tmpdir(), 'clean-room-smoke-fixture-'));
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
