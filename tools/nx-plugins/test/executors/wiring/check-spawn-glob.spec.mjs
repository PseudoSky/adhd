#!/usr/bin/env node
/**
 * Walker and parse-error contract for the wiring checkers (plan discovery-sweep-1014 blind-review D AC1, AC2).
 *
 * guards: `fs.globSync` silently drops the `ignore` option, so the node_modules / dist / .worktrees / .claude
 *   excludes the two spawn checkers declared were dead and every installed dependency was walked (AC1); and a
 *   malformed package.json or ratchet baseline surfaced as a bare SyntaxError with no file name (AC2).
 * failure mode: (AC1) a fixture tree with an unrouted spawn or a malformed package.json under node_modules, dist,
 *   .worktrees or .claude is visited and reported, or counted toward the @adhd/environment zero-scan guard;
 *   (AC2) a malformed package.json or baseline makes the checker throw an error that does not name its file.
 * tier: S (pure collectors over throwaway fixture workspaces under the tooling scratch root; no process spawned,
 *   nothing sleeps). Fidelity gap: none at tier S; the end-to-end run of the real checker against the repo is
 *   AC3 and is recorded in the commit, not in this file.
 * cites: plan discovery-sweep-1014 blind-review D AC1 (exclude contract), AC2 (named parse error).
 * red: recorded before the fix at scratchpad red-spawn-glob-before.txt; the AC1 exclude cases and the AC2
 *   named-error cases fail on the unfixed collectors. The control cases pass on both and pin the exact-segment
 *   and in-scope behaviour so the fix cannot over-exclude.
 * risk map (light): walker exclusion (high, silent false green) and parse error text (medium, misdiagnosis).
 *
 * Run: node --test tools/nx-plugins/test/executors/wiring/check-spawn-glob.spec.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { BASELINE_REL, collectSpawnIsolationViolations, owningPackage } from './check-spawn-isolation.mjs';
import { collectAgentLaneSpawnViolations } from './check-agent-lane-spawn.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../..');
const { scratchRootPath } = createRequire(import.meta.url)('../../../lib/scratch-root.js');
const SCRATCH_PARENT = scratchRootPath(REPO_ROOT, 'spawn-glob-spec');

const CP = "import { spawnSync } from 'node:child_process';";
const UNROUTED = `${CP}\nspawnSync(process.execPath, ['bin.js']);\n`;
const ROUTED = `${CP}\nspawnSync(process.execPath, ['bin.js'], { env: { ...process.env, HOME: tmp } });\n`;
const ENV_PKG = JSON.stringify({ name: '@adhd/envuser', version: '0.0.0', dependencies: { '@adhd/environment-core-node': '*' } });
const PLAIN_PKG = JSON.stringify({ name: '@adhd/plain', version: '0.0.0' });
const SPEC = 'packages/envuser/src/a.e2e.test.ts';
const AGENT_SPAWNING = `import { spawnSync } from 'node:child_process';\nspawnSync('npx', ['x']);\n`;

/** Build a fixture workspace under the scratch root; later entries override earlier ones. */
function fixture(files) {
  mkdirSync(SCRATCH_PARENT, { recursive: true });
  const root = mkdtempSync(join(SCRATCH_PARENT, 'ws-'));
  for (const [rel, content] of Object.entries({ 'packages/envuser/package.json': ENV_PKG, ...files })) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}

function withFixture(files, fn) {
  const root = fixture(files);
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const EMPTY = { unrouted: {} };
const rules = (res) => res.violations.map((v) => v.rule);

// ---------------------------------------------------------------------------------------------------------------
// AC1 - the walker never visits node_modules, dist, .worktrees or .claude (spawn-isolation)
// ---------------------------------------------------------------------------------------------------------------

test('plan discovery-sweep-1014 blind-review D AC1 spawn-isolation never visits node_modules, dist, .worktrees or .claude [AC1]', () => {
  withFixture(
    {
      'packages/envuser/node_modules/dep/a.spec.ts': UNROUTED,
      'packages/envuser/dist/a.spec.js': UNROUTED,
      'packages/envuser/.worktrees/x/a.spec.ts': UNROUTED,
      'packages/envuser/.claude/y/a.spec.ts': UNROUTED,
      [SPEC]: ROUTED,
    },
    (root) => {
      const res = collectSpawnIsolationViolations(root, { baseline: EMPTY });
      assert.deepEqual(rules(res), []);
      assert.equal(res.scanned, 1);
    },
  );
});

test('plan discovery-sweep-1014 blind-review D AC1 control: exclusion is by exact path segment, so src/dist-tools is still scanned [AC1]', () => {
  withFixture(
    { 'packages/envuser/src/dist-tools/a.spec.ts': UNROUTED, [SPEC]: ROUTED },
    (root) => {
      const res = collectSpawnIsolationViolations(root, { baseline: EMPTY });
      assert.deepEqual(rules(res), ['spawn-isolation-unrouted']);
      assert.match(res.violations[0].detail, /src\/dist-tools\/a\.spec\.ts/);
      assert.equal(res.scanned, 2);
    },
  );
});

test('plan discovery-sweep-1014 blind-review D AC1 an @adhd/environment package inside node_modules does not satisfy the zero-scan guard [AC1]', () => {
  withFixture(
    {
      'packages/envuser/package.json': PLAIN_PKG,
      'packages/envuser/node_modules/dep/package.json': ENV_PKG,
    },
    (root) => {
      const res = collectSpawnIsolationViolations(root, { baseline: EMPTY });
      assert.deepEqual(rules(res), []);
      assert.equal(res.scanned, 0);
    },
  );
});

test('plan discovery-sweep-1014 blind-review D AC1 agent-lane never visits node_modules, dist, .worktrees or .claude [AC1]', () => {
  withFixture(
    {
      'packages/agent/agent-foo/project.json': '{"name":"agent-foo"}',
      'packages/agent/agent-foo/src/ok.spec.ts': 'export {};\n',
      'packages/agent/agent-foo/src/node_modules/x/bad.test.ts': AGENT_SPAWNING,
      'packages/agent/agent-foo/src/dist/bad.test.ts': AGENT_SPAWNING,
      'packages/agent/agent-foo/src/.worktrees/bad.test.ts': AGENT_SPAWNING,
      'packages/agent/agent-foo/src/.claude/bad.test.ts': AGENT_SPAWNING,
    },
    (root) => {
      const res = collectAgentLaneSpawnViolations(root, { pendingMove: [] });
      assert.deepEqual(rules(res), []);
      assert.equal(res.scanned, 1);
    },
  );
});

test('plan discovery-sweep-1014 blind-review D AC1 control: agent-lane still flags a spawn in src/dist-tools [AC1]', () => {
  withFixture(
    {
      'packages/agent/agent-foo/project.json': '{"name":"agent-foo"}',
      'packages/agent/agent-foo/src/ok.spec.ts': 'export {};\n',
      'packages/agent/agent-foo/src/dist-tools/bad.test.ts': AGENT_SPAWNING,
    },
    (root) => {
      const res = collectAgentLaneSpawnViolations(root, { pendingMove: [] });
      assert.deepEqual(rules(res), ['A-spawn-in-unit-lane']);
    },
  );
});

// ---------------------------------------------------------------------------------------------------------------
// AC2 - a malformed package.json or baseline names its file, never a bare SyntaxError
// ---------------------------------------------------------------------------------------------------------------

test('plan discovery-sweep-1014 blind-review D AC2 a malformed package.json under a scanned root throws an error naming that file [AC2]', () => {
  withFixture(
    { 'packages/envuser/package.json': '{ "name": ', [SPEC]: ROUTED },
    (root) => {
      assert.throws(
        () => collectSpawnIsolationViolations(root, { baseline: EMPTY }),
        (err) => {
          assert.match(err.message, /packages\/envuser\/package\.json/);
          assert.notEqual(err.name, 'SyntaxError');
          return true;
        },
      );
    },
  );
});

test('plan discovery-sweep-1014 blind-review D AC2 owningPackage names the malformed nearest package.json it parses [AC2]', () => {
  withFixture(
    {
      'packages/bad/package.json': '{ nope',
      'packages/bad/src/a.spec.ts': 'export {};\n',
    },
    (root) => {
      assert.throws(
        () => owningPackage(root, 'packages/bad/src/a.spec.ts'),
        (err) => {
          assert.match(err.message, /packages\/bad\/package\.json/);
          assert.notEqual(err.name, 'SyntaxError');
          return true;
        },
      );
    },
  );
});

test('plan discovery-sweep-1014 blind-review D AC2 a malformed spawn-isolation baseline names the baseline file [AC2]', () => {
  withFixture(
    { [BASELINE_REL]: '{ "unrouted": ', [SPEC]: ROUTED },
    (root) => {
      assert.throws(
        () => collectSpawnIsolationViolations(root),
        (err) => {
          assert.match(err.message, /spawn-isolation\.baseline\.json/);
          assert.notEqual(err.name, 'SyntaxError');
          return true;
        },
      );
    },
  );
});

test('plan discovery-sweep-1014 blind-review D AC2 control: a malformed package.json inside node_modules is never parsed, so it raises nothing [AC2]', () => {
  withFixture(
    {
      'packages/envuser/node_modules/dep/package.json': '{ not json',
      [SPEC]: ROUTED,
    },
    (root) => {
      const res = collectSpawnIsolationViolations(root, { baseline: EMPTY });
      assert.deepEqual(rules(res), []);
      assert.equal(res.scanned, 1);
    },
  );
});
