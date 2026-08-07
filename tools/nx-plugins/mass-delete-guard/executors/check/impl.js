'use strict';
/**
 * mass-delete-guard:check (whole-repo, not per-project) — runs the exact
 * same classifier as `pre-commit`'s Gate 0 and `post-commit`
 * (`.githooks/detect-mass-deletion.js`), in-process, via `withMetrics`.
 * BUG-ADHD-EE8D24C8-REVERT-001.
 *
 * Declared once on the ROOT project (`@adhd/source`), mirroring
 * `secret-scan`'s own root-only wiring — mass-deletion shape is a property
 * of a COMMIT/RANGE, never a single project's own build graph, so this has
 * no reason to be inferred per-project via `createNodes`.
 *
 * Primary consumers: `.githooks/pre-commit` (`--staged`, blocking) and
 * `.githooks/post-commit` (`--range`, warn-only) call
 * `.githooks/detect-mass-deletion.js` DIRECTLY (they must run even without a
 * full `node_modules`/nx install — hooks are the very first gate). This nx
 * target exists for the SAME classifier to be invoked identically from CI
 * (e.g. `nx run @adhd/source:mass-delete-guard --base=<merge-base> --head=<sha>`
 * on a PR), so a server-side check can use the identical logic as the local
 * hook — no local-only blind spot for a `--no-verify` push. See
 * `.githooks/detect-mass-deletion.js`'s own header for the full incident.
 */
const { join } = require('node:path');
const { withMetrics } = require('../../../lib/metrics');

const CHECKER_PATH = join(__dirname, '..', '..', '..', '..', '..', '.githooks', 'detect-mass-deletion.js');

function loadChecker() {
  return require(CHECKER_PATH);
}

/**
 * @param {{base?: string, head?: string}} options
 * @param {*} context nx executor context (unused beyond withMetrics' own needs)
 */
async function run(options, context) {
  return withMetrics('mass-delete-guard', context, async (rec) => {
    let argv;
    if (options && options.base) {
      if (!options.head) {
        throw new Error('mass-delete-guard: `base` was given without `head` (both required for --range).');
      }
      argv = ['--range', options.base, options.head];
    } else {
      argv = ['--staged'];
    }

    const code = rec.time(`detect-mass-deletion.js ${argv.join(' ')} (in-process)`, () =>
      module.exports.__internals.loadChecker().main(argv)
    );
    return { success: code === 0 };
  });
}

module.exports = run;
module.exports.default = run;
module.exports.__internals = { loadChecker };
