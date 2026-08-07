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

async function run(options, context) {
  return withMetrics('release-reset', context, async (rec) => {
    const projectRoot = context.projectsConfigurations.projects[context.projectName].root;
    const live = Boolean(options && options.live);

    const state = rec.time('detectProjectReleaseState', () =>
      detectProjectReleaseState({ repoRoot: context.root, projectRoot, projectName: context.projectName })
    );

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

    if (!live) {
      console.log('  (dry-run — pass --live to apply the SAFE actions above. Nothing was changed.)');
      return { success: true };
    }

    const { applied, skipped } = rec.time('applyRevert', () => applyRevert(context.root, state));
    for (const a of applied) console.log(`  APPLIED: ${a}`);
    for (const s of skipped) console.log(`  SKIPPED (manual review required): ${s}`);
    return { success: true };
  });
}

module.exports = run;
module.exports.default = run;
module.exports.__internals = { detectProjectReleaseState, applyRevert };
