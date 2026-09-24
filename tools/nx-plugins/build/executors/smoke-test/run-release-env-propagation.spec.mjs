/**
 * run-release-env-propagation.spec.mjs — proves the F1 run-scoped freshness
 * token actually REACHES a spawned nx task through the REAL boundary:
 *
 *   parent process env ──spawnSync('pnpm', ['nx','run-many', ...])──▶ pnpm
 *     ──▶ nx task runner ──▶ the task's own `process.env`
 *
 * WHY this file exists. Every other F1 test calls `checkPublishAllowed` /
 * the publish `impl.js` DIRECTLY, so none of them exercise the propagation hop
 * the whole fix depends on: `run-release.mjs`'s `main()` mints
 * `RELEASE_RUN_TOKEN` into its OWN process env, then `run()` spawns
 * `pnpm nx run-many ...` with NO explicit `env` (so the child inherits it),
 * and nx spawns the task with no explicit `env` either. If either hop dropped
 * the env, the minted token would never reach `checkPublishAllowed` and F1
 * would silently not work — a green unit suite over a broken feature. This
 * spec closes that gap by driving the real `pnpm -> nx -> task` path.
 *
 * HARMLESSNESS. The target driven is a throwaway `nx:run-commands` probe in a
 * hermetic temp nx workspace — a `node -e` that writes the inherited
 * `RELEASE_RUN_TOKEN` to a file and does nothing else. It is NOT the real
 * publish target and nothing is ever published.
 *
 * TEETH.
 *   - positive: with the token in the parent env, the probe task OBSERVES it.
 *   - negative control: with the token withheld from the parent env (all else
 *     inherited), the probe observes NOTHING — so a pass is not vacuous.
 *   - structural guard: `run-release.spec.mjs` asserts `run()`'s `spawnSync`
 *     passes NO explicit `env` (an explicit `env: {}` is exactly how the minted
 *     token gets dropped; demonstrated red in this branch's review).
 *
 * Run: `node --test tools/nx-plugins/build/executors/smoke-test/run-release-env-propagation.spec.mjs`
 * (also wired into `pnpm test:build-tools`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Walk up to the workspace root (the dir holding nx.json) — same shape as run-release.mjs's findRoot. */
function findWorkspaceRoot(start) {
  let d = start;
  while (d !== dirname(d)) {
    if (existsSync(join(d, 'nx.json'))) return d;
    d = dirname(d);
  }
  return start;
}

const workspaceRoot = findWorkspaceRoot(here);
// Reuse THIS workspace's installed nx so the task-runner under test is the
// real one, not a mock — only the WORKSPACE it runs against is throwaway.
const repoNxDir = join(workspaceRoot, 'node_modules', 'nx');
const repoNxBin = join(repoNxDir, 'bin', 'nx.js');

const PROBE_PROJECT = 'probe';
const PROBE_TARGET = 'echo-release-run-token';

/**
 * Build a hermetic, throwaway nx workspace whose only target records the
 * inherited `RELEASE_RUN_TOKEN` to a file. nx itself is symlinked in from this
 * repo, so no install is needed and nothing touches the real workspace.
 */
function makeProbeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'run-release-env-prop-'));
  const outFile = join(dir, 'observed-token.txt');

  writeFileSync(
    join(dir, 'nx.json'),
    JSON.stringify({ $schema: './node_modules/nx/schemas/nx-schema.json', defaultBase: 'main' }, null, 2) + '\n'
  );
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'run-release-env-prop-probe', private: true, version: '0.0.0' }, null, 2) + '\n'
  );

  // The harmless probe: write the inherited token to a file, nothing else.
  const command =
    `node -e 'require("node:fs").writeFileSync(${JSON.stringify(outFile)}, ` +
    `String(process.env.RELEASE_RUN_TOKEN ?? ""))'`;
  writeFileSync(
    join(dir, 'project.json'),
    JSON.stringify(
      {
        name: PROBE_PROJECT,
        targets: { [PROBE_TARGET]: { executor: 'nx:run-commands', options: { command } } },
      },
      null,
      2
    ) + '\n'
  );

  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
  symlinkSync(repoNxDir, join(dir, 'node_modules', 'nx'), 'dir');
  symlinkSync(repoNxBin, join(dir, 'node_modules', '.bin', 'nx'));

  return { dir, outFile };
}

/**
 * The EXACT spawn shape `run-release.mjs`'s `run()` uses for every phase —
 * `spawnSync('pnpm', ['nx','run-many', ...], { cwd, shell:false })` with NO
 * explicit `env`. `env` is a parameter only so the negative control can
 * withhold the token; the positive case passes `undefined`, i.e. inherit this
 * process's env verbatim (exactly what `run()` does).
 */
function spawnLikeRunRelease(cwd, env) {
  const opts = { cwd, encoding: 'utf8', shell: false };
  if (env) opts.env = env;
  return spawnSync('pnpm', ['nx', 'run-many', '-t', PROBE_TARGET, `--projects=${PROBE_PROJECT}`], opts);
}

test('F1 propagation: a RELEASE_RUN_TOKEN minted in the parent env reaches a spawned nx task through the real pnpm -> nx -> task boundary', () => {
  assert.ok(
    existsSync(repoNxBin),
    `this spec reuses the workspace nx at ${repoNxBin}; install deps (pnpm install) in the workspace root first`
  );
  const { dir, outFile } = makeProbeWorkspace();
  const saved = process.env.RELEASE_RUN_TOKEN;
  try {
    // Exactly what run-release.mjs's main() does: mint into OUR OWN env before spawning.
    const token = 'run-propagation-probe-0f9a4c1e';
    process.env.RELEASE_RUN_TOKEN = token;

    const res = spawnLikeRunRelease(dir); // no explicit env -> inherit, exactly like run()
    assert.equal(res.status, 0, `real pnpm -> nx -> task run must succeed; stderr:\n${res.stderr}`);
    assert.ok(existsSync(outFile), 'the probe target must have run and written its observation file');
    assert.equal(
      readFileSync(outFile, 'utf8'),
      token,
      'the spawned nx task must observe the SAME RELEASE_RUN_TOKEN the parent minted — this is the hop F1 depends on'
    );
  } finally {
    if (saved === undefined) delete process.env.RELEASE_RUN_TOKEN;
    else process.env.RELEASE_RUN_TOKEN = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F1 propagation NEGATIVE CONTROL: with the token withheld from the parent env (all else inherited) the spawned nx task observes NOTHING', () => {
  // Proves the positive assertion above is not vacuous: the value can only
  // have come from the inherited env, so removing it from the env must make it
  // disappear from the task. Nothing else about the spawn shape changes.
  const { dir, outFile } = makeProbeWorkspace();
  const saved = process.env.RELEASE_RUN_TOKEN;
  try {
    delete process.env.RELEASE_RUN_TOKEN;

    const res = spawnLikeRunRelease(dir); // inherit — token genuinely absent
    assert.equal(res.status, 0, `real pnpm -> nx -> task run must still succeed; stderr:\n${res.stderr}`);
    assert.ok(existsSync(outFile), 'the probe target must still run with the token absent');
    assert.equal(
      readFileSync(outFile, 'utf8'),
      '',
      'without the token in the parent env the task must observe an empty value — proving the token travels by env, ' +
        'not by any other channel'
    );
  } finally {
    if (saved === undefined) delete process.env.RELEASE_RUN_TOKEN;
    else process.env.RELEASE_RUN_TOKEN = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});
