#!/usr/bin/env node
/**
 * Contract of the `release:dry` script: ADHD_NX_VERSION_DRY_RUN=1 must cover every nx invocation of the chain.
 *
 * guards: `pnpm release:dry` exports the dry-run variable only on the version run-many, so the `publish` target (which dependsOn `version`) re-runs the version executor for real and rewrites tracked package.json and CHANGELOG.md files
 * tier: S (pure string analysis of the package.json script text; nothing is executed)
 * cites: ticket 8468f7b1 [release-gate-fixes.3]; docs/standards/testing.md; tools/nx-plugins/build/plugin.js (publish dependsOn version); tools/nx-plugins/build/executors/version/impl.js (reads the env)
 * teeth: red: the pre-fix script (variable set inline before the version run-many only) fails the real-script case and matches the negative control.
 *
 * Run: node --test tools/nx-plugins/test/executors/wiring/release-dry-clean.spec.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

/** True when an exported ADHD_NX_VERSION_DRY_RUN=1 precedes every nx invocation (and the first command) of the script. */
export function exportCoversEveryNx(script) {
  const exp = /(^|&&|;)\s*export\s+ADHD_NX_VERSION_DRY_RUN=1\s*(&&|;)/.exec(script);
  if (!exp) return false;
  const exportEnd = exp.index + exp[0].length;
  if (script.slice(0, exp.index).replace(/^\s+/, '') !== '') return false; // must be the first command
  const nxCalls = [...script.matchAll(/\bnx\b|\bpnpm\b/g)];
  return nxCalls.every((m) => m.index >= exportEnd);
}

const scripts = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')).scripts;

const RUN_RELEASE = resolve(REPO_ROOT, 'tools/nx-plugins/build/executors/smoke-test/run-release.mjs');

/**
 * `release:dry` is `run-release.mjs --dry-run`: one code path with the real release. The dry-run variable must then be
 * set by that script at module level, before any child process is spawned (every `run(`/`runWaves(` call is inside
 * `main()`, which runs after the module body), and the flag must be what turns it on.
 */
export function delegatesToDryRun(script, runReleaseSource) {
  if (!/^node\s+tools\/nx-plugins\/build\/executors\/smoke-test\/run-release\.mjs\s+--dry-run\s*$/.test(script)) return false;
  const set = runReleaseSource.search(/if \(DRY_RUN\) process\.env\.ADHD_NX_VERSION_DRY_RUN = '1';/);
  const flag = runReleaseSource.search(/const DRY_RUN = process\.argv\.includes\('--dry-run'\);/);
  const main = runReleaseSource.search(/^function main\(\) \{/m);
  return flag !== -1 && set !== -1 && flag < set && set < main;
}

test('the real release:dry script covers every nx invocation with the dry-run variable (inline export, or run-release.mjs --dry-run setting it before main())', () => {
  const script = scripts['release:dry'];
  const src = readFileSync(RUN_RELEASE, 'utf8');
  assert.ok(exportCoversEveryNx(script) || delegatesToDryRun(script, src), script);
});

test('negative control: a delegating script whose run-release.mjs sets the variable only inside main() is rejected', () => {
  const script = 'node tools/nx-plugins/build/executors/smoke-test/run-release.mjs --dry-run';
  const late = "const DRY_RUN = process.argv.includes('--dry-run');\nfunction main() {\n  if (DRY_RUN) process.env.ADHD_NX_VERSION_DRY_RUN = '1';\n}";
  assert.equal(delegatesToDryRun(script, late), false);
});

test('negative control: a delegating script that omits --dry-run is rejected', () => {
  const src = readFileSync(RUN_RELEASE, 'utf8');
  assert.equal(delegatesToDryRun('node tools/nx-plugins/build/executors/smoke-test/run-release.mjs', src), false);
});

test('negative control: a script that sets the variable only on the version run-many is rejected', () => {
  const pre = 'pnpm run build && ADHD_NX_VERSION_DRY_RUN=1 npx nx run-many -t version --dryRun && npx nx run-many -t publish --dryRun';
  assert.equal(exportCoversEveryNx(pre), false);
});

test('negative control: an export placed after the build is rejected', () => {
  assert.equal(exportCoversEveryNx('pnpm run build && export ADHD_NX_VERSION_DRY_RUN=1 && npx nx run-many -t publish'), false);
});

test('a script that begins with the export is accepted', () => {
  assert.ok(exportCoversEveryNx('export ADHD_NX_VERSION_DRY_RUN=1 && pnpm run build && npx nx run-many -t publish'));
});
