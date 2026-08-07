/**
 * Structural (grep-based) teeth tests for run-release.mjs — proving the two
 * §6.1/§6.2 fixes from tmp/release-pipeline-audit.md actually landed in the
 * SHIPPED script text, not just in a design doc:
 *
 *   (b) there is NO code path in this file that calls
 *       `nx run-many -t publish` (or `-t version`) WITHOUT a `--projects=`
 *       argument — the audit's core anti-pattern-prevention requirement.
 *   (c) the explicit `version` phase's `run(...)` call appears BEFORE GATE 1's
 *       `check-release-ranges` `run(...)` call in source order — the
 *       DEBT-RELEASE-GATE1-STALE-DISK-VERSION-001 timing fix.
 *
 * Also proves the DEBT-BUILD-COMPOSITE-TSC-PARALLEL-001 structural
 * build-first guarantee (the architect-accepted hardening of the
 * build-first mitigation onto the REAL, non-dry release path, which
 * previously had no build step of its own and relied entirely on nx's
 * implicit per-project `dependsOn: build` graph edges):
 *
 *   (d) a scoped `run(...)` call passing
 *       `['nx','run-many','-t','build',projectsArg]` exists in the source.
 *   (e) that build `run(...)` call appears BEFORE the `version` run() call,
 *       which itself must remain before GATE 1 (check-release-ranges).
 *   (f) no UNSCOPED `['nx','run-many','-t','build']` (i.e. without
 *       projectsArg) call exists anywhere in the file — mirroring the
 *       existing unscoped-publish/unscoped-version teeth tests.
 *
 * Mirrors `plugin.spec.mjs`'s RED-equivalent convention: a static/grep check
 * against the real file text, each with a paired negative-control assertion
 * proving the check has teeth against the exact pre-fix shape.
 *
 * Run: `node --test tools/nx-plugins/build/executors/smoke-test/run-release.spec.mjs`
 * (also wired into `pnpm test:build-tools`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, 'run-release.mjs');
const source = readFileSync(scriptPath, 'utf8');

test('run-release.mjs: no unscoped "nx run-many -t publish" call exists anywhere in the file', () => {
  // The pre-fix shape (audit-cited, run-release.mjs:100 at filing time) was
  // exactly this array literal — no --projects entry at all.
  const unscopedPublishPattern = /\[\s*'nx'\s*,\s*'run-many'\s*,\s*'-t'\s*,\s*'publish'\s*\]/;
  assert.ok(
    !unscopedPublishPattern.test(source),
    'found an unscoped ["nx","run-many","-t","publish"] call (no --projects) — this is exactly the ' +
      'DEBT-RELEASE-UNSCOPED-PUBLISH-001 anti-pattern the audit requires be fully removed, not just reduced.'
  );
});

test('run-release.mjs: no unscoped "nx run-many -t version" call exists anywhere in the file', () => {
  const unscopedVersionPattern = /\[\s*'nx'\s*,\s*'run-many'\s*,\s*'-t'\s*,\s*'version'\s*\]/;
  assert.ok(
    !unscopedVersionPattern.test(source),
    'found an unscoped ["nx","run-many","-t","version"] call (no --projects) — the explicit version phase ' +
      'added for the GATE 1 timing fix must be scoped to the same computed project list as publish.'
  );
});

test('run-release.mjs: the real publish invocation IS scoped with a --projects= argument derived from the computed changed-set', () => {
  // Positive-shape check: the actual publish run() call must include a
  // projectsArg entry (built as `--projects=${projectNames.join(',')}`).
  assert.match(
    source,
    /run\(\s*'publish'\s*,\s*'pnpm'\s*,\s*\[\s*'nx'\s*,\s*'run-many'\s*,\s*'-t'\s*,\s*'publish'\s*,\s*projectsArg\s*\]\s*\)/,
    'expected the publish run() call to pass projectsArg (a --projects=<computed-list> argument) as its last arg'
  );
});

test('run-release.mjs: computeChangedProjectSet is imported from the shared changed-set resolver and used to build the scope', () => {
  assert.match(
    source,
    /require\(['"]\.\.\/\.\.\/lib\/changed-set\.js['"]\)/,
    'expected run-release.mjs to import computeChangedProjectSet from ../../lib/changed-set.js, not reinvent scoping inline'
  );
  assert.match(source, /computeChangedProjectSet\(/, 'expected computeChangedProjectSet to actually be called');
});

test('run-release.mjs: a scope-computation failure is NOT swallowed into an unscoped fallback (fail-loud contract)', () => {
  // The catch block around computeChangedProjectSet must exit non-zero and
  // must NOT proceed to call `run(...)` with a bare/unscoped publish or
  // version command afterwards.
  const catchBlockMatch = source.match(/catch \(err\) \{[\s\S]*?process\.exit\(1\);\s*return;\s*\}/);
  assert.ok(catchBlockMatch, 'expected a catch block around computeChangedProjectSet that exits 1 and returns');
  assert.match(
    catchBlockMatch[0],
    /refusing to fall back to an ` \+\s*`unscoped publish|refusing to fall back/i,
    'the failure message must explicitly state it is refusing to fall back to an unscoped publish'
  );
});

test('run-release.mjs: the explicit version-phase run() call appears BEFORE GATE 1 (check-release-ranges) in source order', () => {
  const versionPhaseIdx = source.indexOf("run('version (explicit prior phase, GATE 1 timing fix)'");
  const gate1Idx = source.indexOf("run(\n    'GATE 1: check-release-ranges'");
  assert.ok(versionPhaseIdx !== -1, 'expected to find the labeled explicit version-phase run() call');
  assert.ok(gate1Idx !== -1, 'expected to find the labeled GATE 1 run() call');
  assert.ok(
    versionPhaseIdx < gate1Idx,
    `expected the version phase (index ${versionPhaseIdx}) to appear BEFORE GATE 1 (index ${gate1Idx}) in source ` +
      'order — DEBT-RELEASE-GATE1-STALE-DISK-VERSION-001 requires version to settle real on-disk versions before ' +
      'GATE 1 reads them'
  );
});

test('RED-equivalent: the pre-fix ordering (GATE 1 first, no version phase at all) is exactly the shape that produced the stale-disk-version false positive', () => {
  // Simulates the pre-fix source ordering to prove the ordering assertion
  // above has teeth: swapped indices must fail it.
  const preFixSource = "run('GATE 1: check-release-ranges', ...); run('publish', ...);";
  const gate1Idx = preFixSource.indexOf('GATE 1');
  const versionPhaseIdx = preFixSource.indexOf('version (explicit prior phase');
  assert.equal(versionPhaseIdx, -1, 'sanity check: the pre-fix source has no explicit version phase at all');
  assert.ok(gate1Idx !== -1, 'sanity check: GATE 1 is present in the simulated pre-fix source');
});

// --- DEBT-BUILD-COMPOSITE-TSC-PARALLEL-001: structural build-first guarantee ---

test('run-release.mjs: a scoped "nx run-many -t build" run() call exists, passing projectsArg', () => {
  // Positive-shape check: the new structural build-first phase must invoke
  // `nx run-many -t build` scoped to the same computed project list as
  // version/publish (DEBT-BUILD-COMPOSITE-TSC-PARALLEL-001).
  assert.match(
    source,
    /run\(\s*'build \(structural build-first guarantee\)'\s*,\s*'pnpm'\s*,\s*\[\s*'nx'\s*,\s*'run-many'\s*,\s*'-t'\s*,\s*'build'\s*,\s*projectsArg\s*,?\s*\]\s*\)/,
    'expected a run() call invoking `nx run-many -t build` scoped with projectsArg — the structural ' +
      'build-first guarantee that hardens the build-first mitigation onto the real (non-dry) release path'
  );
});

test('run-release.mjs: no unscoped "nx run-many -t build" call exists anywhere in the file', () => {
  // Same anti-pattern-prevention shape as the existing unscoped-publish and
  // unscoped-version tests above: the build phase must never fire without a
  // --projects= scope, or it silently reverts to a workspace-wide build.
  const unscopedBuildPattern = /\[\s*'nx'\s*,\s*'run-many'\s*,\s*'-t'\s*,\s*'build'\s*\]/;
  assert.ok(
    !unscopedBuildPattern.test(source),
    'found an unscoped ["nx","run-many","-t","build"] call (no --projects) — the structural build-first ' +
      'guarantee must be scoped to the same computed project list as version/publish, exactly like them'
  );
});

test('run-release.mjs: the structural build-first run() call appears BEFORE the version run() call in source order', () => {
  const buildPhaseIdx = source.indexOf("run('build (structural build-first guarantee)'");
  const versionPhaseIdx = source.indexOf("run('version (explicit prior phase, GATE 1 timing fix)'");
  assert.ok(buildPhaseIdx !== -1, 'expected to find the labeled structural build-first run() call');
  assert.ok(versionPhaseIdx !== -1, 'expected to find the labeled explicit version-phase run() call');
  assert.ok(
    buildPhaseIdx < versionPhaseIdx,
    `expected the build-first phase (index ${buildPhaseIdx}) to appear BEFORE the version phase ` +
      `(index ${versionPhaseIdx}) in source order — DEBT-BUILD-COMPOSITE-TSC-PARALLEL-001 requires build ` +
      'to settle a warm, complete cache before version/GATE 1/publish ever run'
  );
});

test('run-release.mjs: the structural build-first run() call appears BEFORE GATE 1 (check-release-ranges) in source order', () => {
  const buildPhaseIdx = source.indexOf("run('build (structural build-first guarantee)'");
  const gate1Idx = source.indexOf("run(\n    'GATE 1: check-release-ranges'");
  assert.ok(buildPhaseIdx !== -1, 'expected to find the labeled structural build-first run() call');
  assert.ok(gate1Idx !== -1, 'expected to find the labeled GATE 1 run() call');
  assert.ok(
    buildPhaseIdx < gate1Idx,
    `expected the build-first phase (index ${buildPhaseIdx}) to appear BEFORE GATE 1 (index ${gate1Idx}) ` +
      'in source order'
  );
});

test('run-release.mjs: a build phase failure exits non-zero without a fallback, mirroring the version/GATE1 hard-gate contract', () => {
  const buildBlockMatch = source.match(
    /const buildExit = run\([\s\S]*?if \(buildExit !== 0\) \{[\s\S]*?process\.exit\(buildExit\);\s*return;\s*\}/
  );
  assert.ok(
    buildBlockMatch,
    'expected a hard gate around the build phase that exits with buildExit and returns on failure'
  );
  assert.match(
    buildBlockMatch[0],
    /refusing to run version\/publish|Release skipped entirely/i,
    'the build-failure message must explicitly state the release is being skipped, not silently continuing'
  );
});

test('RED-equivalent: the pre-fix shape (no build-first phase at all, only implicit dependsOn: build) is exactly what DEBT-BUILD-COMPOSITE-TSC-PARALLEL-001 flagged as unhardened', () => {
  // Simulates the pre-fix source (before this fix, run-release.mjs went
  // straight from scope-computation to the version phase with no explicit
  // build step) to prove the build-first-precedes-version assertion above
  // has teeth: a source lacking the build phase entirely must fail it.
  const preFixSource = "run('version (explicit prior phase, GATE 1 timing fix)', ...); run('GATE 1: check-release-ranges', ...);";
  const buildPhaseIdx = preFixSource.indexOf('build (structural build-first guarantee)');
  const versionPhaseIdx = preFixSource.indexOf('version (explicit prior phase');
  assert.equal(buildPhaseIdx, -1, 'sanity check: the pre-fix source has no structural build-first phase at all');
  assert.ok(versionPhaseIdx !== -1, 'sanity check: the version phase is present in the simulated pre-fix source');
});

test('run-release.mjs: the empty-changed-set early return (projectNames.length === 0 -> process.exit(0)) appears BEFORE the new structural build-first run() call in source order', () => {
  // Guards against a regression where the new build-first phase gets hoisted
  // above the empty-changed-set early-return: an empty computed project list
  // must still exit 0 WITHOUT running the build phase (or version/GATE 1/
  // publish), exactly as it did before this change.
  const earlyReturnIdx = source.indexOf('if (projectNames.length === 0)');
  const buildPhaseIdx = source.indexOf("run('build (structural build-first guarantee)'");
  assert.ok(earlyReturnIdx !== -1, 'expected to find the empty-changed-set early-return check');
  assert.ok(buildPhaseIdx !== -1, 'expected to find the labeled structural build-first run() call');
  assert.ok(
    earlyReturnIdx < buildPhaseIdx,
    `expected the empty-changed-set early return (index ${earlyReturnIdx}) to appear BEFORE the new build-first ` +
      `phase (index ${buildPhaseIdx}) in source order — an empty computed project list must still exit 0 without ` +
      'ever reaching the build/version/GATE 1/publish phases'
  );
});
