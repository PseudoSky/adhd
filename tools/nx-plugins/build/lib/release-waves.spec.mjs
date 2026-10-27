/**
 * guards: a pending dependent is versioned or published before its pending dependency, or an unchanged dependency is pulled into the waves
 * tier: S
 * cites: release-perf handoff P2
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { computeWaves } = createRequire(import.meta.url)('./release-waves.js');

const pkg = (name, ...deps) => ({ name, deps: deps.map((depName) => ({ depName })) });

test('a dependency lands in an earlier wave than its pending dependent', () => {
  const set = [pkg('c', 'b'), pkg('b', 'a'), pkg('a')];
  assert.deepEqual(computeWaves(set, ['a', 'b', 'c']), [['a'], ['b'], ['c']]);
});

test('independent pending projects share a wave and are sorted', () => {
  const set = [pkg('z'), pkg('y'), pkg('x', 'z')];
  assert.deepEqual(computeWaves(set, ['x', 'y', 'z']), [['y', 'z'], ['x']]);
});

test('a non-pending dependency is ignored: it neither appears nor delays its dependent', () => {
  const set = [pkg('b', 'a'), pkg('a')];
  assert.deepEqual(computeWaves(set, ['b']), [['b']]);
});

test('a transitive chain through a non-pending middle package keeps no edge to the far end', () => {
  const set = [pkg('c', 'b'), pkg('b', 'a'), pkg('a')];
  assert.deepEqual(computeWaves(set, ['a', 'c']), [['a', 'c']]);
});

test('an empty pending set yields no waves', () => {
  assert.deepEqual(computeWaves([pkg('a')], []), []);
});

test('a cycle among pending projects throws and names the members', () => {
  const set = [pkg('a', 'b'), pkg('b', 'a')];
  assert.throws(() => computeWaves(set, ['a', 'b']), /cycle.*a, b/);
});

test('a pending name outside the release set throws', () => {
  assert.throws(() => computeWaves([pkg('a')], ['ghost']), /ghost.*not in the release set/);
});
