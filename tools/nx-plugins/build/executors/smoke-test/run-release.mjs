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
 *   3.5. `sync-global.mjs` (BUG-027 REVISED — a real currency gate, no longer
 *      purely advisory) — after publish, flip any stale global CLI link shims
 *      (shims execing local workspace source) to the published artifacts,
 *      AND (BUG-027) verify/upgrade any ordinary, non-link global install
 *      that's simply on an older version than what was just published. Its
 *      exit code is CAPTURED, not thrown (a non-zero here does not stop step
 *      4, mirroring the BUG-003 pattern for publish) — but, UNLIKE publish's
 *      capture, it now DOES feed the compound verdict below: a non-zero
 *      `syncExit` means the operator's global CLI could not be verified
 *      current, and the release must not report success. Incident this
 *      closes: @adhd/backlog@0.1.8 published clean, GATE 2 passed, and this
 *      step logged "no stale global link" while the operator's CLI silently
 *      stayed on 0.1.7 for hours — `pnpm run release` still printed RESULT
 *      (a). See PUBLISHING.md §Workflow "Step 3.5".
 *   3. `clean-room-smoke.mjs` (GATE 2) ALWAYS runs after step 2, regardless
 *      of step 2's outcome.
 *   4. A COMPOUND verdict is printed distinguishing the FOUR outcomes:
 *        (a) publish fully succeeded, smoke passed, AND the operator global
 *            CLI is verified current                            -> exit 0
 *        (b) publish partially/fully FAILED but smoke passed    -> exit 1
 *            (still a failed release — nothing about a successful smoke
 *            excuses a broken publish — but it tells you unambiguously that
 *            what DID get published is installable, which changes the
 *            remediation: fix/retry the failed packages, not panic about a
 *            corrupted registry state).
 *        (c) smoke FAILED (regardless of publish outcome)      -> exit 1
 *        (d) publish + smoke both OK but sync-global could NOT verify the
 *            operator's global CLI is current (BUG-027)        -> exit 1
 *      The overall exit code is non-zero if ANY of step 2 (publish), step
 *      3.5 (sync-global currency), or step 3 (smoke) failed; it is only 0
 *      when all three succeeded (or had nothing to do).
 *
 * RECEIPT. After GATE 2, and BEFORE the compound verdict, a release receipt
 * (task-report.mjs) is printed on EVERY outcome — success or failure — so a
 * failed release still reports every task it got through. It is sourced from
 * metrics.json (withMetrics executors only; the report states its own
 * coverage) and, for each published package, partitions PUBLISHED vs SKIPPED
 * from the publish executor's own `outcome` field (the `✔ :publish` line is
 * identical for both, and a registry re-read lags). It is diagnostic: its exit
 * code does NOT change the verdict (a corrupt metrics log must not fail an
 * otherwise-good release) and is surfaced as a warning if nonzero.
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
 * PENDING-SCOPED, WAVE-ORDERED RELEASE (DEBT-RELEASE-UNSCOPED-PUBLISH-001; tmp/release-perf/HANDOFF.md P2).
 * Nothing here calls `nx run-many` without a `--projects=` list, and the list is never the whole workspace:
 *
 *   0. `planRelease` (`../../lib/release-plan.js`) takes the pending set from `release:pending`
 *      (`../../lib/release-pending.js`: filesystem + git only, no nx graph) and orders it into topological waves
 *      over the pending projects (`../../lib/release-waves.js`). A dependency that is not pending is already on
 *      the registry, so it is neither scoped in nor ordered against. There is NO fallback to "everyone": a failure
 *      computing the scope exits non-zero before anything runs. `planRelease` also writes the release manifest the
 *      publish executor's backstop requires. The very first statement of `main()` mints a per-run
 *      `RELEASE_RUN_TOKEN` into the process env; the manifest stamps it and every spawned phase inherits it, so the
 *      backstop's age gate is skipped for THIS run's manifest however long the batch takes
 *      (`../../lib/release-manifest.js`, "RUN-SCOPED FRESHNESS").
 *   0.25. GATE 0, lane-reachability wiring.
 *   0.5. Test gate: `nx run-many -t test --projects=<pending>` once, before anything is built, versioned or
 *      written, so a failing test cannot leave source `package.json` files mutated.
 *   1. Build: `nx run-many -t build --projects=<pending>` explicitly, so no release path reaches version/publish
 *      against a cold cache (DEBT-BUILD-COMPOSITE-TSC-PARALLEL-001).
 *   2. Version waves: `version` per wave, in dependency order, ALL of them before GATE 1 and before any publish
 *      (DEBT-RELEASE-GATE1-STALE-DISK-VERSION-001: GATE 1 must read every post-bump disk version). `version` needs
 *      its dependencies' versions settled on disk, not published. It compares the built dist hash with the
 *      registry baseline and no-ops a package whose content is unchanged, so a `release:pending` false positive
 *      costs a build, never a bump.
 *   3. GATE 1 (`check-release-ranges.mjs`) once: a hard pre-gate; an unresolvable internal range never attempts a
 *      publish.
 *   4. Publish waves: `publish` per wave, dependency-first; a failed wave stops the later waves, whose members
 *      may depend on it. The exit code is CAPTURED, not thrown (BUG-003): GATE 2 below runs regardless.
 *   4.5. `sync-global.mjs` (BUG-027): flip stale global CLI link shims and verify the operator's global install is
 *      current. Exit code captured; it feeds the compound verdict.
 *   5. `clean-room-smoke.mjs` (GATE 2) ALWAYS runs after publish, regardless of its outcome. It runs unscoped
 *      (audit §6.3 scoping is a separate fix).
 *   6. A COMPOUND verdict distinguishes four outcomes:
 *        (a) publish OK, smoke OK, sync-global currency verified -> exit 0
 *        (b) publish partially/fully FAILED but smoke passed     -> exit 1
 *        (c) smoke FAILED (regardless of publish outcome)        -> exit 1
 *        (d) publish+smoke OK but sync-global currency unresolved -> exit 1
 *
 * `--dry-run` runs the same flow with `version` and `publish` in their dry-run modes
 * (`ADHD_NX_VERSION_DRY_RUN=1`, `--dryRun`) and skips sync-global and the smoke; `pnpm release:dry` is this
 * flag, so the dry run and the real run share one code path.
 *
 * `--publish-only` skips GATE 0, the test gate and the build (for CI, whose earlier lanes already ran them) and exits
 * with the publish result; `--configuration=<name>` is forwarded to every publish wave.
 *
 * An EMPTY pending set prints that and exits 0 without running anything: nothing to release, and Nx's own
 * `--projects=` rejects an empty list rather than meaning "everyone".
 *
 * Usage:
 *   node tools/nx-plugins/build/executors/smoke-test/run-release.mjs [--dry-run]
 *
 * Exit code: 0 only if publish succeeded fully AND clean-room-smoke passed
 * (or there was nothing to publish). Non-zero otherwise. A failure computing
 * the release scope, the test gate, the build phase, the version
 * waves, or GATE 1 (check-release-ranges) all exit non-zero before
 * either publish or smoke runs.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const { planRelease } = require('../../lib/release-plan.js');

// `--dry-run`: the same flow, with version/publish in their dry-run modes and no sync-global / smoke. One code path
// for `pnpm release` and `pnpm release:dry`, so the dry run cannot drift from the real one.
const DRY_RUN = process.argv.includes('--dry-run');
if (DRY_RUN) process.env.ADHD_NX_VERSION_DRY_RUN = '1';
// `--publish-only`: version waves, GATE 1 and publish waves only. For a caller that already ran the lane, test and build
// gates earlier (CI's Publish step). Skips GATE 0, the test gate and the build, and exits with the publish result
// without sync-global or the clean-room smoke.
const PUBLISH_ONLY = process.argv.includes('--publish-only');
// `--configuration=<name>` is forwarded to every publish wave (CI passes `production`).
const CONFIGURATION = (process.argv.find((a) => a.startsWith('--configuration=')) || '').trim();

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

/**
 * Run `target` over each wave in order, one `nx run-many` per wave (projects inside a wave run in parallel). Stops at
 * the first failing wave and returns its exit code: a failed dependency must not let its dependents proceed. This is
 * the ordering the removed `^version` / `^publish` closure edges used to give, applied to the pending set only.
 */
function runWaves(label, target, waves, extra = []) {
  for (let i = 0; i < waves.length; i += 1) {
    const exit = run(`${label} wave ${i + 1}/${waves.length}`, 'pnpm', [
      'nx', 'run-many', '-t', target, `--projects=${waves[i].join(',')}`, ...extra,
    ]);
    if (exit !== 0) return exit;
  }
  return 0;
}

function main() {
  // Run-scoped freshness token (F1 root fix) — MUST be the very first thing
  // this run does. `planRelease` (step 0, below) writes the
  // release manifest, and `release-manifest.js` stamps this value into it;
  // every later phase (build, version, GATE 1, publish) is spawned with this
  // process's env inherited, so every publish task sees the SAME token and the
  // manifest's age gate is skipped for the duration of THIS run — a large
  // batch that pushes publish past the 10-minute window no longer refuses its
  // own in-scope projects. Minting it before the scope computation is what
  // guarantees the step-0 manifest carries it. Setting it here is safe even if
  // a caller already provided one (we still re-mint per run; the manifest and
  // the children always agree because both read this same process env).
  process.env.RELEASE_RUN_TOKEN = randomUUID();
  // Deliberately NOT echoed: the token is a nonce (see release-manifest.js's
  // "RUN-SCOPED FRESHNESS" header), not a secret and not operationally useful
  // to a human reading the log — its only job is to be identical in the
  // step-0 manifest and every spawned publish task.

  // Step 0 — compute the changed/affected project scope. NO catch-and-
  // fall-back-to-unscoped here: a failure computing the scope is a hard,
  // immediate stop. This is the one deliberate anti-pattern-prevention
  // requirement from the audit — there must be no code path in this file
  // that reaches `nx run-many -t publish` (or `-t version`) without a
  // `--projects=<computed-list>` filter.
  let plan;
  try {
    plan = planRelease({ workspaceRoot });
  } catch (err) {
    console.error(
      `\nrun-release: FAILED to compute the release scope — refusing to fall back to an ` +
        `unscoped publish across the entire workspace. Fix the underlying error and retry.\n${err.stack || err.message}`
    );
    process.exit(1);
    return;
  }

  const { projectNames, waves, projects } = plan;
  console.error(
    `\nrun-release: pending set (release:pending): ${projectNames.length} publishable project(s) in ${waves.length} wave(s)` +
      (projectNames.length ? `:\n${projects.map((p) => `  ${p.nxName}\t${p.reasons.join(',')}`).join('\n')}` : '.')
  );

  if (projectNames.length === 0) {
    console.error(
      '\nrun-release: every publishable project matches published-state.json and has no changes since its ' +
        'publishedFromRef — nothing to release. Exiting 0 without running version/GATE 1/publish/smoke.'
    );
    process.exit(0);
    return;
  }

  if (!PUBLISH_ONLY) {
    // GATE 0 (NEW) — lane-reachability wiring gate. This is the SAME check the
    // pre-push hook runs (.githooks/pre-push): it refuses when any project has a
    // tsconfig.spec.json that no target compiles (backlog 98142eab rule 6), so a
    // spec corpus can carry type errors no gate can see. The release path
    // previously did NOT run it, so a release could publish around a broken gate
    // (incident: @adhd/apigen-plugin-tracing shipped with exactly that gap). A
    // hard pre-flight gate: if the wiring is broken, nothing downstream (build,
    // version, GATE 1, publish) is allowed to run.
    const laneExit = run('GATE 0: check-lane-reachability', 'node', [
      join(workspaceRoot, 'tools/nx-plugins/test/executors/wiring/check-lane-reachability.mjs'),
    ]);
    if (laneExit !== 0) {
      console.error(
        '\nrun-release: GATE 0 (lane-reachability) FAILED — the gate wiring is broken ' +
          '(e.g. a project has a tsconfig.spec.json that no target compiles). Refusing to ' +
          'build/version/publish around a broken gate. Fix the wiring and retry.'
      );
      process.exit(laneExit);
      return;
    }

    const projectsArg = `--projects=${projectNames.join(',')}`;

    // Test gate — once over the whole pending set, BEFORE anything is built, versioned or written, so a failing test
    // can never leave source package.json files mutated. `test` depends on lint, typecheck-spec and ^build, so the
    // gates every publish used to re-run per project run exactly once here; `publish` keeps its own `test` dependency
    // and finds it cached.
    const testExit = run('test gate (once over the pending set)', 'pnpm', ['nx', 'run-many', '-t', 'test', projectsArg]);
    if (testExit !== 0) {
      console.error('\nrun-release: test gate FAILED — nothing was built, versioned or published.');
      process.exit(testExit);
      return;
    }

    // Build phase, scoped to the pending set (DEBT-BUILD-COMPOSITE-TSC-PARALLEL-001: never rely on build firing
    // on-demand inside the publish task graph).
    const buildExit = run('build (structural build-first guarantee)', 'pnpm', ['nx', 'run-many', '-t', 'build', projectsArg]);
    if (buildExit !== 0) {
      console.error(
        '\nrun-release: build phase FAILED — refusing to run version/publish against ' +
          'an unbuilt or partially-built cache. Release skipped entirely.'
      );
      process.exit(buildExit);
      return;
    }

  }

  // Version phase, in dependency waves over the pending set, BEFORE GATE 1 (DEBT-RELEASE-GATE1-STALE-DISK-VERSION-001:
  // GATE 1 must read every POST-bump disk version, so ALL versions settle before it and before any publish).
  // `version` only needs its dependencies' versions settled on disk, not published, so waves order versioning alone.
  const versionExit = runWaves('version (explicit prior phase, GATE 1 timing fix)', 'version', waves, DRY_RUN ? ['--dryRun'] : []);
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
  // Publish waves: a dependency is on the registry before any dependent publishes. A failed wave stops the rest.
  const publishExit = runWaves('publish', 'publish', waves, [...(DRY_RUN ? ['--dryRun'] : []), ...(CONFIGURATION ? [CONFIGURATION] : [])]);
  const publishOk = publishExit === 0;

  if (PUBLISH_ONLY) {
    console.error(`\nrun-release: publish-only run ${publishOk ? 'complete' : 'FAILED'} — sync-global and clean-room-smoke were skipped.`);
    process.exit(publishExit);
    return;
  }

  if (DRY_RUN) {
    console.error(`\nrun-release: dry run ${publishOk ? 'complete' : 'FAILED'} — nothing was published; sync-global and clean-room-smoke were skipped.`);
    process.exit(publishExit);
    return;
  }

  // Step 3.5 (BUG-027 REVISED) — sync-global: flip any stale global CLI link
  // shims (shims whose content references this workspace — the `pnpm link
  // -g` shape) AND verify/upgrade an ordinary non-link global install that's
  // simply behind the just-published version, via `pnpm add -g
  // <name>@<exact-version>`, gated on the exact version being on the
  // registry. Runs AFTER publish (so the registry actually has the version)
  // and BEFORE GATE 2 (so clean-room-smoke still exercises the real registry
  // path). Exit code captured, not thrown (does not stop GATE 2 below) — but
  // UNLIKE the old advisory-only contract, a non-zero `syncExit` now DOES
  // feed the compound verdict: it means sync-global itself could not verify
  // the operator's global CLI is current (BUG-027's `computeExitCode`), and
  // "a release that leaves the operator on a stale binary must not report
  // success." Retry manually with `pnpm release:sync-global` (or run the
  // exact `pnpm add -g <name>@<version>` command sync-global's own ERROR
  // line prints).
  const syncExit = run('sync-global (global CLI shims -> published artifacts)', 'node', [
    join(workspaceRoot, 'tools/nx-plugins/build/executors/sync-global/sync-global.mjs'),
    `--projects=${projectNames.join(',')}`,
  ]);
  const syncOk = syncExit === 0;
  if (!syncOk) {
    console.error(
      'run-release: sync-global could NOT verify the operator global CLI is current (BUG-027) — this WILL fail ' +
        'the release verdict below. Retry with `pnpm release:sync-global`, or run the exact `pnpm add -g ' +
        '<name>@<version>` command printed in the sync-global ERROR line(s) above.'
    );
  }

  // GATE 2 — ALWAYS runs, even after a partial/failed publish. Deliberately
  // NOT scoped to the computed project list (audit §6.3 — a separate, later
  // fix; out of scope here).
  const smokeExit = run(
    'GATE 2: clean-room-smoke',
    'node',
    [join(workspaceRoot, 'tools/nx-plugins/build/executors/smoke-test/clean-room-smoke.mjs')]
  );
  const smokeOk = smokeExit === 0;

  // Final phase — the release RECEIPT: every task this run executed, grouped
  // by task with project + duration, sourced from metrics.json (withMetrics
  // executors only — nx-native build/test are NOT in it; the report states
  // its own coverage), plus the per-package PUBLISHED vs SKIPPED partition
  // from the publish executor's own `outcome` (never a registry re-read, which
  // lags the publish). Placed AFTER GATE 2 and before the compound verdict so
  // it runs on EVERY outcome — a FAILED release still reports what it got
  // through. Its exit code is deliberately NOT folded into the verdict: a
  // corrupt/unreadable metrics log must not fail an otherwise-good release,
  // and the report exits 1 ONLY in that case — surfaced as a warning, never
  // swallowed.
  const reportExit = run('receipt: release task report (metrics.json)', 'node', [
    join(workspaceRoot, 'tools/nx-plugins/build/executors/smoke-test/task-report.mjs'),
  ]);
  if (reportExit !== 0) {
    console.error(
      `run-release: task report could not be produced (metrics.json unreadable/corrupt, exit ${reportExit}) — ` +
        'release verdict unaffected.'
    );
  }

  console.error('\nrun-release: ==================== COMPOUND RESULT ====================');
  console.error(`run-release: publish: ${publishOk ? 'OK' : `FAILED (exit ${publishExit})`}`);
  console.error(`run-release: sync-global (operator CLI currency, BUG-027): ${syncOk ? 'OK — verified current' : `FAILED (exit ${syncExit})`}`);
  console.error(`run-release: clean-room-smoke: ${smokeOk ? 'OK' : `FAILED (exit ${smokeExit})`}`);

  if (publishOk && smokeOk && syncOk) {
    console.error('run-release: RESULT (a) — full publish + smoke pass + operator global CLI verified current. Release complete.');
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
  } else if (!syncOk) {
    console.error(
      'run-release: RESULT (d) — publish and clean-room-smoke both succeeded, but the operator global CLI ' +
        'could NOT be verified current (BUG-027). The registry is fine; YOUR terminal is not — do not report ' +
        'this release as done until you rerun `pnpm release:sync-global` (or the printed `pnpm add -g` command) ' +
        'and it reports success.'
    );
    process.exit(1);
  }
}

main();
