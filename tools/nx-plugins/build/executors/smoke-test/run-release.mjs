#!/usr/bin/env node
/**
 * tools/nx-plugins/build/executors/smoke-test/run-release.mjs
 *
 * Fixes BUG-003 (CRITICAL): the previous `release` script was a single `&&`
 * chain —
 *
 *   check-release-ranges && nx run-many -t publish && clean-room-smoke
 *
 * — so ANY non-zero exit from `nx run-many -t publish` (including a PARTIAL
 * publish, e.g. 40 of 52 packages landed before one failed) short-circuited
 * the chain and clean-room-smoke (GATE 2) never ran. That is exactly the
 * moment GATE 2 is most needed: a partial publish is precisely the situation
 * that can leave a package on the registry declaring a dependency range that
 * isn't satisfiable yet (the ETARGET failure mode GATE 2 exists to catch —
 * see clean-room-smoke.mjs's header). Silently skipping the post-publish
 * smoke on a publish failure meant a partially-broken release could go
 * uninvestigated by this pipeline's own tooling.
 *
 * THIS SCRIPT replaces that `&&` chain for the real (non-dry) `release`
 * target only:
 *
 *   1. GATE 1 (`check-release-ranges`) stays a HARD pre-gate — if the range
 *      check itself fails, publish is skipped entirely (an unresolvable
 *      range should never even attempt to hit the registry). This step still
 *      uses a normal early-return; it is correct for it to gate, not race.
 *   2. `nx run-many -t publish` is attempted. Its exit code is CAPTURED, not
 *      thrown — a non-zero here does not stop step 3.
 *   3. `clean-room-smoke.mjs` (GATE 2) ALWAYS runs after step 2, regardless
 *      of step 2's outcome.
 *   4. A COMPOUND verdict is printed distinguishing the three outcomes the
 *      audit called out:
 *        (a) publish fully succeeded AND smoke passed        -> exit 0
 *        (b) publish partially/fully FAILED but smoke passed -> exit 1
 *            (still a failed release — nothing about a successful smoke
 *            excuses a broken publish — but it tells you unambiguously that
 *            what DID get published is installable, which changes the
 *            remediation: fix/retry the failed packages, not panic about a
 *            corrupted registry state).
 *        (c) smoke FAILED (regardless of publish outcome)      -> exit 1
 *      The overall exit code is non-zero if EITHER step 2 or step 3 failed;
 *      it is only 0 when both succeeded.
 *
 * `release:dry` is DELIBERATELY NOT routed through this runner. A `--dryRun`
 * publish never actually touches the registry (it can't ETARGET, and it
 * can't partially land packages — nx either prints the full "would publish"
 * plan or fails validating it up front), so the failure mode this script
 * exists to survive cannot occur there; keeping `release:dry` as a plain
 * `&&` chain in package.json is correct and simpler to read. (`clean-room-
 * smoke` itself talks to the REAL registry via `npm install`, so dry-run
 * doesn't invoke it at all today — see release:dry's own script — and that
 * is unrelated to this fix.)
 *
 * Usage:
 *   node tools/nx-plugins/build/executors/smoke-test/run-release.mjs
 *
 * Exit code: 0 only if publish succeeded fully AND clean-room-smoke passed.
 * Non-zero otherwise. GATE 1 (check-release-ranges) failing exits non-zero
 * before either publish or smoke runs.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const findRoot = (d) => {
  while (d !== dirname(d)) {
    if (existsSync(join(d, 'nx.json'))) return d;
    d = dirname(d);
  }
  return d;
};
const workspaceRoot = findRoot(dirname(fileURLToPath(import.meta.url)));

function run(label, command, args) {
  console.error(`\nrun-release: [${label}] running: ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: workspaceRoot, shell: false });
  if (result.error) {
    console.error(`run-release: [${label}] failed to spawn ${command}: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

function main() {
  // GATE 1 — hard pre-gate. An unresolvable internal range must never even
  // attempt a publish; this is the one step that legitimately short-circuits.
  const rangesExit = run(
    'GATE 1: check-release-ranges',
    'node',
    [join(workspaceRoot, 'tools/nx-plugins/build/executors/range-check/check-release-ranges.mjs')]
  );
  if (rangesExit !== 0) {
    console.error('\nrun-release: GATE 1 (check-release-ranges) FAILED — publish skipped entirely.');
    process.exit(rangesExit);
  }

  // Publish attempt — exit code captured, never thrown. GATE 2 below must
  // run regardless of what happens here (BUG-003).
  const publishExit = run('publish', 'pnpm', ['nx', 'run-many', '-t', 'publish']);
  const publishOk = publishExit === 0;

  // GATE 2 — ALWAYS runs, even after a partial/failed publish.
  const smokeExit = run(
    'GATE 2: clean-room-smoke',
    'node',
    [join(workspaceRoot, 'tools/nx-plugins/build/executors/smoke-test/clean-room-smoke.mjs')]
  );
  const smokeOk = smokeExit === 0;

  console.error('\nrun-release: ==================== COMPOUND RESULT ====================');
  console.error(`run-release: publish: ${publishOk ? 'OK' : `FAILED (exit ${publishExit})`}`);
  console.error(`run-release: clean-room-smoke: ${smokeOk ? 'OK' : `FAILED (exit ${smokeExit})`}`);

  if (publishOk && smokeOk) {
    console.error('run-release: RESULT (a) — full publish + smoke pass. Release complete.');
    process.exit(0);
  } else if (!publishOk && smokeOk) {
    console.error(
      'run-release: RESULT (b) — publish FAILED (partial or total) but everything that DID land ' +
        'installs cleanly. This is still a FAILED release: investigate/retry the failed package(s) ' +
        '(see the publish output above for which). Do not re-run the full release blind — target the ' +
        'failures directly.'
    );
    process.exit(1);
  } else if (!smokeOk) {
    console.error(
      `run-release: RESULT (c) — clean-room-smoke FAILED${publishOk ? ' (publish itself succeeded)' : ' (publish also failed)'}. ` +
        'See the smoke output above for which entrypoint(s) failed to install/start cleanly.'
    );
    process.exit(1);
  }
}

main();
