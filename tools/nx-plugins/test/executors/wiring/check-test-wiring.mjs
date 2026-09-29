#!/usr/bin/env node
/**
 * check-test-wiring — every project that ships spec/test files MUST declare a
 * runnable `test` target.
 *
 * Why this exists (BUG-NXTEST-001, 2026-07-16): `nx run-many -t test` reports
 * SUCCESS for projects that don't define the target at all — so a project can
 * carry hundreds of test cases that never execute while every pipeline stays
 * green. 75 cases across dispatch-core-optimizer / agent-plugin-budget /
 * agent-plugin-sanitize sat unrun this way, and two published documents cited
 * them as passing. This gate makes that class of silent green impossible.
 *
 * Exit code is the only signal (0 = wired, 1 = gap found), per the repo's
 * verification standard — never grep stdout for "passed".
 */
import { globSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const projects = globSync('{packages/*/*,entrypoint/*}/project.json', {
  ignore: ['**/node_modules/**', '**/.worktrees/**', '**/.claude/**'],
});

const gaps = [];
for (const projectJson of projects) {
  const root = dirname(projectJson);
  const specs = globSync(join(root, 'src/**/*.{spec,test}.{ts,tsx,js,mjs}'), {
    ignore: ['**/node_modules/**', '**/__files__/**'],
  });
  if (specs.length === 0) continue;
  const targets = JSON.parse(readFileSync(projectJson, 'utf8')).targets ?? {};
  if (!targets.test) gaps.push({ root, specCount: specs.length });
}

if (gaps.length > 0) {
  console.error('✖ projects with test files but NO `test` target (their tests can NEVER run):');
  for (const { root, specCount } of gaps) console.error(`   ${root}  (${specCount} spec file(s))`);
  console.error('  Fix: add a `test` target (see packages/agent/agent-store-runtime/project.json for the shape).');
  process.exit(1);
}

// Delegate the workspace-scoped lane-reachability assertions (rule set in
// check-lane-reachability.mjs). This keeps the two checks inseparable: a project
// can be "wired" (has a `test` target) and still have an unreachable/uncached
// heavy lane. That script is also the canonical entry point invoked by the
// pre-push hook and both CI workflows; we call the SAME file so there is one
// rule set, not two.
const laneCheck = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'check-lane-reachability.mjs')], {
  stdio: 'inherit',
});
if (laneCheck.status !== 0) process.exit(laneCheck.status ?? 1);

console.log(`✓ test wiring OK — every project with spec files (${projects.length} projects scanned) declares a test target.`);
