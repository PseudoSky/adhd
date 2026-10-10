/**
 * Wiring spec (unit lane — reads files only) for the lockfile freshness gate:
 * the gate must be reachable from every place the repo's gates live, or it can
 * silently drop out (the failure mode lane-gate.mjs documents).
 *
 *   4f26493e AC2  nx target + pre-push + ci.yml + pull-request.yml all run it
 *
 * Run: node --test tools/nx-plugins/build/executors/lockfile/lockfile-gate.spec.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const read = (p) => readFileSync(join(REPO, p), 'utf8');
const NX_RUN = /nx run @adhd\/source:check-lockfile-fresh/;

test('4f26493e AC2: @adhd/source has check-lockfile-fresh + lockfile-gate-teeth targets pointing at real files', () => {
  const t = JSON.parse(read('project.json')).targets;
  assert.match(t['check-lockfile-fresh'].options.command, /executors\/lockfile\/check-lockfile-fresh\.mjs/);
  assert.match(t['lockfile-gate-teeth'].options.command, /lockfile-gate\.e2e\.spec\.mjs/);
  assert.equal(t['check-lockfile-fresh'].cache, false, 'reads live package.json/lock state: must not be cached');
  assert.ok(existsSync(join(REPO, 'tools/nx-plugins/build/executors/lockfile/check-lockfile-fresh.mjs')));
});

test('4f26493e AC2: both CI workflows and the pre-push hook invoke the gate', () => {
  assert.match(read('.github/workflows/ci.yml'), NX_RUN);
  assert.match(read('.github/workflows/pull-request.yml'), NX_RUN);
  assert.match(read('.githooks/pre-push'), /check-lockfile-fresh\.mjs/);
  assert.match(read('.github/workflows/ci.yml'), /nx run @adhd\/source:lockfile-gate-teeth/);
});

test('4f26493e AC2 NEGATIVE CONTROL: the wiring regexes reject a gate file that never mentions the gate', () => {
  for (const unwired of ['      - run: node tools/nx-plugins/test/executors/wiring/check-lane-reachability.mjs\n', '#!/bin/sh\nexit 0\n']) {
    assert.doesNotMatch(unwired, NX_RUN);
    assert.doesNotMatch(unwired, /check-lockfile-fresh\.mjs/);
  }
});
