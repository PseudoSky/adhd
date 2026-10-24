#!/usr/bin/env node
/**
 * Contract of check-test-wiring's gap finder: a project with spec files needs a `test` target, whether it is
 * written in project.json or inferred by an Nx plugin and visible only in the resolved project graph.
 *
 * guards: check-test-wiring flags a project whose `test` target is plugin-inferred (a false positive that blocks every release gate), or stops flagging a project with specs and no test target at all (tests that can never run stay green)
 * tier: S (throwaway fixture workspaces on disk and an in-memory stand-in for the project graph; no process spawned, no Nx daemon)
 * cites: ticket 8468f7b1 [release-gate-fixes.1] [release-gate-fixes.2]; docs/standards/testing.md; commit c6d6e055f (rely on plugin inference)
 * teeth: red: the pre-fix literal-only read of project.json flags the inferred-target project below; the negative control fails on a finder that ignores specs.
 *
 * Run: node --test tools/nx-plugins/test/executors/wiring/check-test-wiring.spec.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { findWiringGaps } from './check-test-wiring.mjs';

const roots = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function workspace(files) {
  const root = mkdtempSync(join(tmpdir(), 'test-wiring-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}

const SPEC = 'export {};\n';
const bare = JSON.stringify({ name: 'x' });

test('a plugin-inferred test target (absent from project.json, present in the graph) is not flagged', () => {
  const cwd = workspace({
    'packages/demo/inferred/project.json': bare,
    'packages/demo/inferred/test/unit/a.spec.ts': SPEC,
  });
  const graph = new Map([['packages/demo/inferred', new Set(['build', 'test'])]]);
  assert.deepEqual(findWiringGaps(cwd, graph).gaps, []);
});

test('a literal test target in project.json is not flagged even if the graph has no entry', () => {
  const cwd = workspace({
    'entrypoint/lit/project.json': JSON.stringify({ targets: { test: { executor: 'nx:run-commands' } } }),
    'entrypoint/lit/test/unit/a.spec.ts': SPEC,
  });
  assert.deepEqual(findWiringGaps(cwd, new Map()).gaps, []);
});

test('negative control: specs and no test target, literal or inferred, is still flagged (the gate exits 1 on this)', () => {
  const cwd = workspace({
    'packages/demo/orphan/project.json': bare,
    'packages/demo/orphan/test/unit/a.spec.ts': SPEC,
    'packages/demo/orphan/test/unit/b.spec.tsx': SPEC,
  });
  const graph = new Map([['packages/demo/orphan', new Set(['build', 'lint'])]]);
  const { gaps } = findWiringGaps(cwd, graph);
  assert.deepEqual(gaps, [{ root: 'packages/demo/orphan', specCount: 2 }]);
});

test('a project with no spec files needs no test target', () => {
  const cwd = workspace({ 'packages/demo/empty/project.json': bare });
  const { gaps, scanned } = findWiringGaps(cwd, new Map());
  assert.deepEqual(gaps, []);
  assert.equal(scanned, 1);
});
