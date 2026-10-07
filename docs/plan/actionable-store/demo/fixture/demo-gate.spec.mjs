/**
 * ddceb069 C-AC9 — the demo acceptance gate has teeth.
 *
 * `run.mjs` is the Actionable Store acceptance runner: it drives every DEMO.md
 * beat and the R1-R7 refusal controls through the BUILT backlog CLI and exits 1
 * on any FAIL beat. CI invokes it as `nx run @adhd/source:demo-acceptance`
 * (which builds backlog first). This spec proves the gate is not vacuous:
 *
 *   1. the unmodified runner exits 0 against the real build;
 *   2. a copy with the R1 positive control deliberately broken exits 1 and names
 *      the R1 beat as the failure.
 *
 * Both run the REAL runner as a real child process (never imported). The broken
 * copy is written beside run.mjs (it resolves REPO_ROOT from its own location)
 * and removed in a `finally`, so a failing run leaves nothing behind.
 *
 * Prerequisite: `entrypoint/backlog/dist` is built. A missing build fails
 * loudly — this suite never skips.
 *
 * Run: nx run @adhd/source:demo-acceptance-teeth   (or node --test <this file>)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// 50e8c966: the runner (a child of this process) shells out to git; hook-exported GIT_* in
// process.env would redirect it at the real repo. Scrub in place before anything spawns.
createRequire(import.meta.url)('../../../../../tools/nx-plugins/lib/git-env.js').scrubProcessGitEnv();
const REPO_ROOT = join(HERE, '..', '..', '..', '..', '..');
const RUNNER = join(HERE, 'run.mjs');
const BROKEN = join(HERE, 'run.negctl.mjs');

function runRunner(path) {
  return spawnSync(process.execPath, [path], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

test('ddceb069 C-AC9: the built backlog dist exists (prerequisite fails loudly, never skips)', () => {
  assert.ok(existsSync(join(REPO_ROOT, 'entrypoint/backlog/dist/index.js')), 'run `nx build backlog` first (the nx target does this via dependsOn)');
});

test('ddceb069 C-AC9: the unmodified runner exits 0; a deliberately broken R-control makes it exit 1 (negative control)', () => {
  const green = runRunner(RUNNER);
  assert.equal(green.status, 0, `unmodified runner must be green:\n${green.stdout.slice(-1500)}\n${green.stderr.slice(-800)}`);

  try {
    const src = readFileSync(RUNNER, 'utf8');
    const needle = "good.rc === 0 && J(good.out)?.ok === true, good.out.trim().slice(0, 120));\n  finish();\n}\n\n{\n  beat('R2'";
    assert.ok(src.includes(needle), 'the R1 control assertion must still be locatable — update this spec with the runner');
    writeFileSync(BROKEN, src.replace(needle, needle.replace('good.rc === 0 &&', 'good.rc === 99 &&')));
    const red = runRunner(BROKEN);
    assert.equal(red.status, 1, `a broken R1 control must turn the runner red (exit 1), got ${red.status}`);
    assert.match(red.stdout, /✗ R1\b/, 'the failing beat must be R1');
  } finally {
    rmSync(BROKEN, { force: true });
  }
  assert.ok(!existsSync(BROKEN), 'the broken copy must not outlive the test');
});
