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
 * AFFECTED-SCOPED PUBLISH (tmp/release-pipeline-audit.md §6.1,
 * DEBT-RELEASE-UNSCOPED-PUBLISH-001): this script used to call
 * `nx run-many -t publish` with NO `--projects`/`--affected` filter — every
 * publishable project in the workspace (~55), every release, regardless of
 * what changed (486 tasks for a real ~15-package changeset, confirmed as the
 * direct cause of 2 of 3 real failures on 2026-07-31 — see the audit's
 * baseline measurement). That unscoped call no longer exists anywhere in this
 * script. Instead:
 *
 *   0. `computeChangedProjectSet` (`../../lib/changed-set.js`) computes the
 *      changed/affected publishable-project set (git-diff-affected UNION
 *      published-state-cache-stale — see that module's header). This step
 *      has NO fallback to "everyone": if it cannot compute a scope (e.g. the
 *      underlying `nx show projects --affected` call fails), it THROWS, and
 *      this script exits non-zero immediately, before GATE 1, `version`, or
 *      `publish` ever run. There is no unscoped code path left in this file.
 *   1. `version`/`^version` runs EXPLICITLY, scoped to the computed project
 *      list, BEFORE GATE 1 (DEBT-RELEASE-GATE1-STALE-DISK-VERSION-001, audit
 *      §6.2). Previously GATE 1 (`check-release-ranges.mjs`) ran first and
 *      read each project's on-disk version to predict what would be
 *      published — but the real version bump only happens inside `publish`'s
 *      own `version` dependency, so GATE 1 was reading STALE pre-bump
 *      versions and could false-positive-flag an already-correct dependent
 *      range as unresolvable (confirmed root cause of failure #1 on
 *      2026-07-31). Running `version` as its own explicit prior phase means
 *      GATE 1 now reads the REAL, post-bump disk state. `publish`'s own
 *      `dependsOn: [..., "version", ...]` chain is untouched — Nx cache-skips
 *      it on the real publish run since inputs haven't changed since this
 *      explicit run.
 *   2. GATE 1 (`check-release-ranges.mjs`) — hard pre-gate, unchanged in
 *      behavior, just re-ordered to run after step 1.
 *   3. `nx run-many -t publish --projects=<computed-list>` — the actual
 *      publish, now scoped. Exit code CAPTURED, not thrown — a non-zero here
 *      does not stop step 4 (BUG-003, unchanged from before).
 *   4. `clean-room-smoke.mjs` (GATE 2) ALWAYS runs after step 3, regardless
 *      of step 3's outcome. GATE 2's own scoping (audit §6.3, "scope GATE 2
 *      to only the packages actually published this run") is explicitly OUT
 *      OF SCOPE for this change — GATE 2 still runs unscoped, exactly as
 *      before; that is a separate, later fix.
 *   5. A COMPOUND verdict is printed distinguishing the three outcomes the
 *      original BUG-003 fix called out:
 *        (a) publish fully succeeded AND smoke passed        -> exit 0
 *        (b) publish partially/fully FAILED but smoke passed -> exit 1
 *            (still a failed release — nothing about a successful smoke
 *            excuses a broken publish — but it tells you unambiguously that
 *            what DID get published is installable, which changes the
 *            remediation: fix/retry the failed packages, not panic about a
 *            corrupted registry state).
 *        (c) smoke FAILED (regardless of publish outcome)      -> exit 1
 *      The overall exit code is non-zero if EITHER step 3 or step 4 failed;
 *      it is only 0 when both succeeded.
 *
 * If the computed project list is EMPTY (nothing changed since `baseRef` and
 * every publishable project's on-disk version already matches
 * `published-state.json`), this script prints that and exits 0 without
 * running `version`, GATE 1, or `publish` at all — there is nothing to
 * release, and Nx's own `--projects=` flag rejects an empty list rather than
 * meaning "everyone," so an empty computed list must be handled explicitly
 * here rather than passed through.
 *
 * `RELEASE_BASE_REF` env var overrides the git ref the changed-set is diffed
 * against (default: `HEAD~1` — see `changed-set.js`'s `resolveBaseRef` for
 * the full precedence/fallback rules).
 *
 * Usage:
 *   node tools/nx-plugins/build/executors/smoke-test/run-release.mjs
 *
 * Exit code: 0 only if publish succeeded fully AND clean-room-smoke passed
 * (or there was nothing to publish). Non-zero otherwise. A failure computing
 * the changed-set scope, the explicit `version` phase, or GATE 1
 * (check-release-ranges) all exit non-zero before either publish or smoke
 * runs.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { computeChangedProjectSet } = require('../../lib/changed-set.js');

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
  // Step 0 — compute the changed/affected project scope. NO catch-and-
  // fall-back-to-unscoped here: a failure computing the scope is a hard,
  // immediate stop. This is the one deliberate anti-pattern-prevention
  // requirement from the audit — there must be no code path in this file
  // that reaches `nx run-many -t publish` (or `-t version`) without a
  // `--projects=<computed-list>` filter.
  let changedSet;
  try {
    changedSet = computeChangedProjectSet({ workspaceRoot });
  } catch (err) {
    console.error(
      `\nrun-release: FAILED to compute the changed/affected project scope — refusing to fall back to an ` +
        `unscoped publish across the entire workspace. Fix the underlying error and retry.\n${err.stack || err.message}`
    );
    process.exit(1);
    return;
  }

  const { baseRef, projectNames } = changedSet;
  console.error(
    `\nrun-release: computed changed-set (base=${baseRef}): ${projectNames.length} publishable project(s) in scope` +
      (projectNames.length ? `:\n  ${projectNames.join('\n  ')}` : '.')
  );

  if (projectNames.length === 0) {
    console.error(
      '\nrun-release: nothing changed since the computed base ref, and every publishable project already ' +
        'matches published-state.json — nothing to release. Exiting 0 without running version/GATE 1/publish/smoke.'
    );
    process.exit(0);
    return;
  }

  const projectsArg = `--projects=${projectNames.join(',')}`;

  // Step 1 — explicit prior `version` phase, SCOPED to the computed project
  // list, BEFORE GATE 1 (fixes DEBT-RELEASE-GATE1-STALE-DISK-VERSION-001,
  // audit §6.2: GATE 1 must read POST-bump disk versions, not pre-bump ones).
  // This is a hard gate: if version itself can't settle the real on-disk
  // versions, nothing downstream (GATE 1's prediction, the publish itself)
  // can be trusted either.
  const versionExit = run('version (explicit prior phase, GATE 1 timing fix)', 'pnpm', [
    'nx',
    'run-many',
    '-t',
    'version',
    projectsArg,
  ]);
  if (versionExit !== 0) {
    console.error(
      '\nrun-release: explicit version phase FAILED — GATE 1 would read unreliable on-disk versions. ' +
        'Publish skipped entirely.'
    );
    process.exit(versionExit);
    return;
  }

  // GATE 1 — hard pre-gate, now running AFTER the version phase (§6.2 fix).
  // An unresolvable internal range must never even attempt a publish; this
  // is the one step that legitimately short-circuits.
  const rangesExit = run(
    'GATE 1: check-release-ranges',
    'node',
    [join(workspaceRoot, 'tools/nx-plugins/build/executors/range-check/check-release-ranges.mjs')]
  );
  if (rangesExit !== 0) {
    console.error('\nrun-release: GATE 1 (check-release-ranges) FAILED — publish skipped entirely.');
    process.exit(rangesExit);
    return;
  }

  // Publish attempt — SCOPED to the computed project list (§6.1 fix). Exit
  // code captured, never thrown. GATE 2 below must run regardless of what
  // happens here (BUG-003).
  const publishExit = run('publish', 'pnpm', ['nx', 'run-many', '-t', 'publish', projectsArg]);
  const publishOk = publishExit === 0;

  // GATE 2 — ALWAYS runs, even after a partial/failed publish. Deliberately
  // NOT scoped to the computed project list (audit §6.3 — a separate, later
  // fix; out of scope here).
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
