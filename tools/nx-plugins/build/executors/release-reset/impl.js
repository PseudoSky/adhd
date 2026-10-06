'use strict';
/**
 * @adhd/nx-build:release-reset — per-project TASK that detects and (with
 * `--live`) reverts a PARTIAL/half-generated `nx release version`/changelog
 * step for THIS project (a `CHANGELOG.md` entry asserting a version
 * `package.json` never reached, or an orphaned `package.json` version bump
 * whose changelog step never ran). See `../../lib/release-reset.js` for the
 * full incident writeup and the safety model.
 *
 * DRY-RUN BY DEFAULT: this target only REPORTS what it would revert unless
 * invoked with `--live` (`npx nx run <project>:release-reset --live`).
 * Never touches any file outside this project's own `package.json` /
 * `CHANGELOG.md`, and never reverts anything it cannot prove (via a real
 * line/text diff against HEAD — see `lib/release-reset.js`) is a pure
 * release-generated artifact — a project with unrelated dirty files (the
 * normal state of this repo, with multiple agents' work colocated) is left
 * completely alone.
 *
 * Workspace-wide sweep: `npx nx run-many -t release-reset` (dry-run) /
 * `npx nx run-many -t release-reset --live` (apply). No separate
 * workspace-level script needed — every publishable project gets this
 * target wired in by `plugin.js`, so `run-many` IS the workspace sweep.
 *
 * `dependsOn`: none, `cache: false` — this reads LIVE git/working-tree
 * state (uncached by design; a cache hit would replay a stale verdict).
 */
const { detectProjectReleaseState, applyRevert } = require('../../lib/release-reset');
const { withMetrics } = require('../../../lib/metrics');

/**
 * Pure verdict for one project: decides the executor's exit status from the
 * detected state and the invocation mode. Kept pure so every branch is
 * unit-testable without git or nx.
 *
 * - `check` (the publish/version precondition): NEVER mutates; fails iff the
 *   state is inconsistent, because publishing over a half-generated release
 *   step ships permanently-wrong metadata.
 * - `live`: applies the SAFE actions, then FAILS iff anything was left in
 *   `skipped (manual review)` OR a re-detection of the project still reports
 *   an inconsistent release state (a phantom changelog entry / orphaned
 *   version bump that the revert did not clear). Reporting `success: true`
 *   with a phantom entry still on disk was the defect this closes
 *   (backlog df9de4da).
 * - default (dry-run): report only, never fails.
 *
 * @param {{ inconsistent: boolean }} state detected state
 * @param {{ live?: boolean, check?: boolean }} mode
 * @param {{ skipped: string[], remainingInconsistent: boolean }|null} liveResult
 * @returns {{ success: boolean, reason?: string }}
 */
function verdict(state, mode, liveResult) {
  if (!state.inconsistent) return { success: true };
  if (mode.check) {
    return { success: false, reason: 'inconsistent release state (phantom CHANGELOG entry or orphaned version bump) — run `release-reset --live` or resolve by hand before publishing' };
  }
  if (!mode.live || !liveResult) return { success: true };
  if (liveResult.skipped.length > 0) {
    return { success: false, reason: `${liveResult.skipped.length} action(s) need manual review (skipped)` };
  }
  if (liveResult.remainingInconsistent) {
    return { success: false, reason: 'release state is still inconsistent after the revert (phantom entry / orphaned bump remains)' };
  }
  return { success: true };
}

async function run(options, context) {
  return withMetrics('release-reset', context, async (rec) => {
    const projectRoot = context.projectsConfigurations.projects[context.projectName].root;
    const live = Boolean(options && options.live);
    const check = Boolean(options && options.check);
    const detect = () =>
      detectProjectReleaseState({ repoRoot: context.root, projectRoot, projectName: context.projectName });

    const state = rec.time('detectProjectReleaseState', detect);

    if (!state.inconsistent) {
      const note = state.tagBehindWorking
        ? ` (informational: latest tag ${state.latestTagVersion} is behind working version ${state.pkgWorkingVersion} — normal for an untagged in-progress release)`
        : '';
      console.log(`release-reset: ${context.projectName}: clean${note}`);
      return { success: true };
    }

    console.log(`release-reset: ${context.projectName}: INCONSISTENT release state detected`);
    for (const action of state.actions) {
      console.log(`  - [${action.safe ? 'SAFE' : 'MANUAL REVIEW REQUIRED'}] ${action.path}`);
      console.log(`      ${action.reason}`);
    }

    if (check) {
      const v = verdict(state, { check: true }, null);
      console.error(`release-reset: ${context.projectName}: FAILED precondition — ${v.reason}`);
      return { success: false };
    }

    if (!live) {
      console.log('  (dry-run — pass --live to apply the SAFE actions above. Nothing was changed.)');
      return { success: true };
    }

    const { applied, skipped } = rec.time('applyRevert', () => applyRevert(context.root, state));
    for (const a of applied) console.log(`  APPLIED: ${a}`);
    for (const s of skipped) console.log(`  SKIPPED (manual review required): ${s}`);
    const after = rec.time('redetect', detect);
    const v = verdict(state, { live: true }, { skipped, remainingInconsistent: after.inconsistent });
    if (!v.success) console.error(`release-reset: ${context.projectName}: FAILED — ${v.reason}`);
    return { success: v.success };
  });
}

module.exports = run;
module.exports.default = run;
module.exports.__internals = { detectProjectReleaseState, applyRevert, verdict };
