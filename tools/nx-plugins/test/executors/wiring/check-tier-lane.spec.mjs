/**
 * check-tier-lane.spec.mjs — the pre-push hook runs tier S tests only: a tier P, H or X test lives in the e2e lane.
 *
 * guards: a test whose header declares tier P, H or X is named `*.spec.*` / `*.test.*`, so the `test` lane the local
 *   pre-push hook runs executes it on every push (H5), or a build-tools e2e spec is listed in the pre-push
 *   `test:build-tools` script, in no script at all, or behind an `e2e` target that is missing or hashes other inputs
 *   (lane-reachability rule 9).
 * tier: S (pure functions over strings and parsed JSON; the one repository case reads files, spawns nothing)
 * cites: owner order 2026-10-15 "directly stop pre push from running e2e or P tier" (backlog f3683008
 *   AC1-AC3); STRATEGY G2 (every test runs in at least one stage), G9 (header tier judged against the code).
 * teeth: red 2026-10-15: node --test tools/nx-plugins/test/executors/wiring/check-tier-lane.spec.mjs with the H5 push
 *   in judge() disabled (`&& false`) -> exit 1, AssertionError in the H5 "fails" cases (8 failing lines); with
 *   buildToolsLaneViolations returning [] first -> exit 1, every rule 9 negative control red (10 failing lines).
 *   Green after restoring both: exit 0.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, inE2eLane, judge, tierOf } from './check-test-headers.mjs';
import {
  BUILD_TOOLS_E2E_GLOBS,
  BUILD_TOOLS_E2E_SCRIPT,
  BUILD_TOOLS_PROJECT,
  BUILD_TOOLS_UNIT_SCRIPT,
  buildToolsLaneViolations,
  scriptFiles,
} from './check-lane-reachability.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const hdr = (lines) => `/**\n${lines.map((l) => ` * ${l}`).join('\n')}\n */\n`;
const GAP = 'gap: This cannot be observed at tier S because the exit code exists only in a process.';
const S = hdr(['guards: g', 'tier: S', 'cites: c']);
const P = hdr(['guards: g', 'tier: P', 'cites: c', GAP]);
const H = hdr(['guards: g', 'tier: H', 'cites: c', GAP.replace('tier S', 'tier P')]);
const X = hdr(['guards: g', 'tier: X', 'cites: c', GAP.replace('tier S', 'tier P')]);

describe('H5 — a tier P, H or X test is named into the e2e lane', () => {
  test('fails: a tier P header in a *.spec.ts file, and the unbaselined violation fails the run', () => {
    assert.deepEqual(judge(P, 'pkg/src/a.spec.ts'), ['H5']);
    const v = evaluate({ 'pkg/src/a.spec.ts': judge(P, 'pkg/src/a.spec.ts') }, { files: {} });
    assert.equal(v.length, 1, 'main() exits 1 exactly when evaluate() returns a violation');
    assert.match(v[0].detail, /pkg\/src\/a\.spec\.ts violates H5/);
  });

  test('fails: tier P in *.test.ts and *.spec.mjs, tier H and tier X in *.test.ts', () => {
    assert.deepEqual(judge(P, 'pkg/src/a.test.ts'), ['H5']);
    assert.deepEqual(judge(P, 'tools/x/a.spec.mjs'), ['H5']);
    assert.deepEqual(judge(H, 'pkg/src/a.test.ts'), ['H5']);
    assert.deepEqual(judge(X, 'pkg/src/a.test.ts'), ['H5']);
  });

  test('fails: an `e2e` in the directory or stem is not the lane marker', () => {
    assert.deepEqual(judge(P, 'pkg/src/e2e/a.spec.ts'), ['H5']);
    assert.deepEqual(judge(P, 'pkg/src/pre-push-e2e.spec.mjs'), ['H5']);
  });

  test('passes: tier P in *.e2e.ts, *.e2e.test.ts and *.e2e.mjs', () => {
    assert.deepEqual(judge(P, 'pkg/src/a.e2e.ts'), []);
    assert.deepEqual(judge(P, 'pkg/src/a.e2e.test.ts'), []);
    assert.deepEqual(judge(P, 'tools/x/a.e2e.mjs'), []);
    assert.equal(evaluate({}, { files: {} }).length, 0, 'no violation: main() exits 0');
  });

  test('passes: tier S in *.spec.ts (the pre-push lane)', () => {
    assert.deepEqual(judge(S, 'pkg/src/a.spec.ts'), []);
  });

  test('judge without a path judges the header only (existing callers keep their result)', () => {
    assert.deepEqual(judge(P), []);
  });

  test('inE2eLane is the file-name rule', () => {
    assert.equal(inE2eLane('a/b.e2e.ts'), true);
    assert.equal(inE2eLane('a/b.e2e.test.ts'), true);
    assert.equal(inE2eLane('a/b.e2e.mjs'), true);
    assert.equal(inE2eLane('a/b.spec.ts'), false);
    assert.equal(inE2eLane('a.e2e.d/b.spec.ts'), false);
  });
});

describe('rule 9 — the build-tools e2e lane is wired and reachable', () => {
  const RUN = 'node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=./r.mjs --test-reporter-destination=stdout';
  const INPUTS = ['default', '{workspaceRoot}/tools/**/*'];
  const good = () => ({
    scripts: { [BUILD_TOOLS_UNIT_SCRIPT]: `${RUN} tools/a.spec.mjs`, [BUILD_TOOLS_E2E_SCRIPT]: `${RUN} tools/b.e2e.mjs .githooks/c.e2e.mjs` },
    e2eFiles: ['tools/b.e2e.mjs', '.githooks/c.e2e.mjs'],
    project: {
      targets: {
        test: { cache: true, options: { command: `pnpm run ${BUILD_TOOLS_UNIT_SCRIPT}` }, inputs: INPUTS },
        e2e: { cache: true, options: { command: `pnpm run ${BUILD_TOOLS_E2E_SCRIPT}` }, inputs: [...INPUTS] },
      },
    },
  });
  const rules = (input) => buildToolsLaneViolations(input).map((v) => v.rule);

  test('a correctly wired lane is silent', () => {
    assert.deepEqual(rules(good()), []);
  });

  test('scriptFiles lists the spec paths, not the flags or the reporter module', () => {
    assert.deepEqual(scriptFiles(`${RUN} tools/a.spec.mjs .githooks/b.e2e.mjs`), ['tools/a.spec.mjs', '.githooks/b.e2e.mjs']);
  });

  test('fails: an e2e spec listed in the pre-push script', () => {
    const g = good();
    g.scripts[BUILD_TOOLS_UNIT_SCRIPT] += ' tools/b.e2e.mjs';
    assert.deepEqual(rules(g), ['9-e2e-file-in-push-lane']);
  });

  test('fails: an e2e spec on disk that no script lists (G2)', () => {
    const g = good();
    g.e2eFiles.push('tools/d.e2e.mjs');
    assert.deepEqual(rules(g), ['9-e2e-file-unreachable']);
  });

  test('fails: the e2e script lists a non-e2e name or a missing file', () => {
    const g = good();
    g.scripts[BUILD_TOOLS_E2E_SCRIPT] += ' tools/a.spec.mjs tools/gone.e2e.mjs';
    assert.deepEqual(rules(g), ['9-non-e2e-file-in-e2e-lane', '9-e2e-script-stale-entry']);
  });

  test('fails: no e2e target, an uncached one, one hashing other inputs, a test target not running the unit script', () => {
    const noTarget = good();
    delete noTarget.project.targets.e2e;
    assert.deepEqual(rules(noTarget), ['9-build-tools-e2e-target']);
    const uncached = good();
    uncached.project.targets.e2e.cache = false;
    assert.deepEqual(rules(uncached), ['9-build-tools-e2e-not-cached']);
    const drift = good();
    drift.project.targets.e2e.inputs = ['default'];
    assert.deepEqual(rules(drift), ['9-build-tools-e2e-not-cached']);
    const wrongTest = good();
    wrongTest.project.targets.test.options.command = `pnpm run ${BUILD_TOOLS_E2E_SCRIPT}`;
    assert.deepEqual(rules(wrongTest), ['9-build-tools-test-target']);
    assert.deepEqual(rules({ ...good(), project: null }), ['9-build-tools-project-missing']);
  });
});

describe('this repository: the pre-push build-tools lane is tier S only', () => {
  const scripts = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).scripts;

  test('rule 9 holds over the real package.json, tools/nx-plugins/project.json and e2e files', () => {
    const e2eFiles = globSync(BUILD_TOOLS_E2E_GLOBS, { cwd: REPO, exclude: (p) => /node_modules/.test(String(p?.name ?? p)) });
    assert.ok(e2eFiles.length > 0, 'the build-tools e2e lane has files');
    const project = JSON.parse(readFileSync(join(REPO, BUILD_TOOLS_PROJECT), 'utf8'));
    assert.deepEqual(buildToolsLaneViolations({ scripts, e2eFiles, project }), []);
  });

  test('no spec in test:build-tools declares tier P, H or X', () => {
    const files = scriptFiles(scripts[BUILD_TOOLS_UNIT_SCRIPT]);
    assert.ok(files.length > 10, `test:build-tools lists ${files.length} specs`);
    const heavy = files.filter((f) => ['P', 'H', 'X'].includes(tierOf(readFileSync(join(REPO, f), 'utf8')) ?? ''));
    assert.deepEqual(heavy, []);
  });
});
