/**
 * guards: release:pending reports a project whose shipped source is unchanged, or misses one that changed
 * tier: S
 * cites: release-perf handoff P2
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { isRelevant } = createRequire(import.meta.url)('./release-pending.js');

test('release-neutral paths are not source changes', () => {
  for (const f of ['p/dist/a.js', 'p/node_modules/x/i.js', 'p/test/unit/a.mjs', 'p/README.md', 'p/CHANGELOG.md', 'p/project.json', 'p/eslint.config.mjs', 'p/src/a.spec.ts'])
    assert.equal(isRelevant(f), false, f);
});

test('shipped source and tsconfig are source changes', () => {
  for (const f of ['p/src/index.ts', 'p/package.json', 'p/tsconfig.lib.json']) assert.equal(isRelevant(f), true, f);
});
