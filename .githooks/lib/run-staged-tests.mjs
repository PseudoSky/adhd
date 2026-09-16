#!/usr/bin/env node
// run-staged-tests.mjs — Gate 3 driver (DEBT-PROCESS-AFFECTED-TEST-001 Option 3).
//
// Reads staged file paths on stdin (newline-separated, repo-root-relative),
// computes the staged-spec plan via select-staged-specs.mjs, and runs ONE
// `vitest run` invocation per implicated project — vitest parallelizes the
// files within that single invocation across its own worker pool, so this is
// not "one process per file" (which is what would have blown the time
// budget). Prints a summary and exits non-zero if any project's tests fail.
//
// See .githooks/pre-commit's Gate 3 header comment for the full incident
// this replaces (338s / cross-author-failure) and why co-located matching
// (not whole-directory) is the scoping rule.

import { spawnSync } from 'node:child_process';
import { readSync } from 'node:fs';
import { computePlan } from './select-staged-specs.mjs';

function readStdin() {
  const chunks = [];
  const buf = Buffer.alloc(65536);
  let bytes;
  while (true) {
    try {
      bytes = readSync(0, buf, 0, buf.length, null);
    } catch (e) {
      if (e.code === 'EAGAIN') continue;
      if (e.code === 'EOF') break;
      throw e;
    }
    if (bytes === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, bytes)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function main() {
  const staged = readStdin()
    .trim()
    .split('\n')
    .filter(Boolean);

  const plan = computePlan(staged);

  let failed = false;
  const start = Date.now();

  for (const proj of plan.projects) {
    const args = ['vitest', 'run', '--config', proj.configFile, ...proj.specs];
    console.log(`→ pre-commit: vitest run (project '${proj.name}', ${proj.specs.length} spec file(s))`);
    const result = spawnSync('npx', args, {
      stdio: 'inherit',
      env: { ...process.env, CI: 'true' },
    });
    if (result.status !== 0) {
      failed = true;
      console.error('');
      console.error(`✖ pre-commit: staged-spec test failed in project '${proj.name}'.`);
      console.error(`  Reproduce: npx vitest run --config ${proj.configFile} ${proj.specs.join(' ')}`);
    }
  }

  const skipped = plan.unsupported.length + plan.unmatched.length;
  if (skipped > 0) {
    console.log(
      `ℹ pre-commit: ${skipped} staged file(s) have no directly-runnable spec in this ` +
        `fast gate (no co-located spec, or the project's test target isn't @nx/vite:test). ` +
        `Full coverage for these runs at 'git push' (pre-push hook) and in CI — expected, not an error.`,
    );
    for (const f of plan.unsupported) console.log(`    · unsupported project: ${f}`);
    for (const f of plan.unmatched) console.log(`    · no co-located spec: ${f}`);
  }

  const elapsedS = ((Date.now() - start) / 1000).toFixed(1);
  if (plan.projects.length === 0) {
    console.log(`✓ pre-commit: no directly-runnable staged specs (${elapsedS}s).`);
  } else if (!failed) {
    console.log(`✓ pre-commit: staged-spec test clean (${elapsedS}s).`);
  }

  process.exit(failed ? 1 : 0);
}

main();
