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

test('the real release:dry script exports the dry-run variable before every nx invocation', () => {
  assert.ok(exportCoversEveryNx(scripts['release:dry']), scripts['release:dry']);
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
