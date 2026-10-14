/**
 * g1-tests.spec.mjs — 595965cc T30: the G1 command selects the lane targets of tools/gate/lane-gate.mjs,
 * the affected set by default and every project under GATE_FULL=1.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { GATE_TARGETS } from '../../../gate/lane-gate.mjs';
import { g1Argv } from './g1-tests.mjs';

test('G1 default: nx affected over every gate target against origin/main', () => {
  const a = g1Argv({});
  assert.deepEqual(a.slice(0, 2), ['nx', 'affected']);
  for (const t of GATE_TARGETS) assert.ok(a.includes(`--target=${t}`), t);
  assert.ok(a.includes('--base=origin/main'));
});

test('G1 honours GATE_BASE', () => {
  assert.ok(g1Argv({ GATE_BASE: 'abc123' }).includes('--base=abc123'));
});

test('G1 under GATE_FULL=1 runs every project, with no base', () => {
  const a = g1Argv({ GATE_FULL: '1' });
  assert.deepEqual(a.slice(0, 2), ['nx', 'run-many']);
  assert.equal(a.some((x) => x.startsWith('--base')), false);
  for (const t of GATE_TARGETS) assert.ok(a.includes(`--target=${t}`), t);
});
