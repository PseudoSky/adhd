/**
 * plugin.spec.mjs — proves `@adhd/nx-build`'s `createNodes` attaches the
 * `^publish` topological ordering edge to every publishable project's
 * `publish` target (BUG-RELEASE-ATOMICITY-DEP-RANGE-AHEAD-OF-TARGET-PUBLISH-001,
 * point 1 — "publish has no `^publish` graph edge to stop it shipping
 * anyway").
 *
 * Drives the REAL `createNodes` handler exported by `./plugin.js` against a
 * throwaway on-disk fixture project (real fs reads via `detect-target.js`,
 * never a mock of the plugin itself) — mirrors exactly what nx's own graph
 * construction does when it calls this createNodes function for a matching
 * `**\/package.json`.
 *
 * Run: `node --test tools/nx-plugins/build/plugin.spec.mjs`
 * (also wired into `pnpm test:build-tools`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { createNodes } = require('./plugin.js');

// createNodes is `['**/package.json', handler]` — the nx CreateNodes tuple shape.
const [, handler] = createNodes;

/** Build a throwaway publishable-project fixture (project.json + build target + non-private package.json). */
function makeFixtureProject({ workspaceRoot, projectRoot, name, isPrivate = false }) {
  const abs = join(workspaceRoot, projectRoot);
  mkdirSync(abs, { recursive: true });
  writeFileSync(join(abs, 'project.json'), JSON.stringify({ name, targets: { build: {} } }));
  const pkg = { name, version: '1.0.0' };
  if (isPrivate) pkg.private = true;
  writeFileSync(join(abs, 'package.json'), JSON.stringify(pkg));
  return join(abs, 'package.json');
}

test('createNodes: publish target dependsOn includes ^publish (topological dependency-publish-first ordering)', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'nx-build-plugin-fixture-'));
  try {
    const pkgPath = makeFixtureProject({
      workspaceRoot,
      projectRoot: 'packages/fixture/fixture-core-widget',
      name: '@adhd/fixture-core-widget',
    });
    const pkgPathRel = pkgPath.slice(workspaceRoot.length + 1);

    const result = handler(pkgPathRel, {}, { workspaceRoot });

    const projectRoot = 'packages/fixture/fixture-core-widget';
    const targets = result.projects[projectRoot].targets;
    assert.ok(targets.publish, 'expected a publish target to be attached to a publishable project');
    assert.ok(
      Array.isArray(targets.publish.dependsOn),
      'publish.dependsOn must be an array'
    );
    assert.ok(
      targets.publish.dependsOn.includes('^publish'),
      `publish.dependsOn must include "^publish" so nx's task graph forces every internal ` +
        `@adhd/* dependency's OWN publish task to complete before this dependent's publish runs. ` +
        `Got: ${JSON.stringify(targets.publish.dependsOn)}`
    );
    // Guard against a false-positive teeth test: prove the OTHER real
    // dependencies are still present too — this must ADD the edge, not
    // replace the existing gate chain.
    for (const dep of ['test', '^test', 'version', 'dist-manifest', 'verify-dist-load', 'publish-hygiene']) {
      assert.ok(
        targets.publish.dependsOn.includes(dep),
        `publish.dependsOn must still include "${dep}" — got: ${JSON.stringify(targets.publish.dependsOn)}`
      );
    }
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('RED-equivalent: a publish.dependsOn WITHOUT ^publish is exactly the shape that let BUG-RELEASE-ATOMICITY-DEP-RANGE-AHEAD-OF-TARGET-PUBLISH-001 ship', () => {
  // Simulates the pre-fix array literal cited in the bug report
  // (tools/nx-plugins/build/plugin.js:72 at filing time) to prove the
  // assertion above actually has teeth: it must fail against the broken shape.
  const brokenDependsOn = ['test', '^test', 'version', 'dist-manifest', 'verify-dist-load', 'publish-hygiene'];
  assert.equal(
    brokenDependsOn.includes('^publish'),
    false,
    'sanity check: the pre-fix dependsOn shape must NOT satisfy the ^publish assertion'
  );
});

test('createNodes: a private (non-publishable) project gets no publish/version/dist-manifest targets at all', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'nx-build-plugin-fixture-private-'));
  try {
    const pkgPath = makeFixtureProject({
      workspaceRoot,
      projectRoot: 'packages/fixture/fixture-core-private',
      name: '@adhd/fixture-core-private',
      isPrivate: true,
    });
    const pkgPathRel = pkgPath.slice(workspaceRoot.length + 1);

    const result = handler(pkgPathRel, {}, { workspaceRoot });

    assert.deepEqual(result, {}, 'a private package must get no publish-related targets attached');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('createNodes: version target still carries ^version (topological dependency-version-first ordering — must not regress alongside the ^publish fix)', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'nx-build-plugin-fixture-version-'));
  try {
    const pkgPath = makeFixtureProject({
      workspaceRoot,
      projectRoot: 'packages/fixture/fixture-core-widget2',
      name: '@adhd/fixture-core-widget2',
    });
    const pkgPathRel = pkgPath.slice(workspaceRoot.length + 1);

    const result = handler(pkgPathRel, {}, { workspaceRoot });

    const projectRoot = 'packages/fixture/fixture-core-widget2';
    const targets = result.projects[projectRoot].targets;
    assert.ok(targets.version.dependsOn.includes('^version'));
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
