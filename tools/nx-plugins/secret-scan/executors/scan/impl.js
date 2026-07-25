'use strict';
/**
 * secret-scan (whole-repo, not per-project) — runs the exact same scanner as
 * the pre-commit hook and the CI `secret-scan` job
 * (`.githooks/check-no-credentials.js`), in-process, via `withMetrics`.
 *
 * This target is declared once on the ROOT project (`@adhd/source`), not
 * inferred per-project via `createNodes` — a leaked credential can live in
 * ANY tracked file (`nx.json`, `.github/*`, a script, a lockfile), not just
 * inside a project's own root, so this must scan the whole tree exactly as
 * `check-no-credentials.js` already does. Wiring it per-project would narrow
 * that surface to "affected projects" and stop scanning where real leaks
 * live (see `check-no-credentials.js`'s own header for the FontAwesome/
 * Nx-Cloud-token incidents that a per-project/affected scope would have
 * missed entirely).
 *
 * `check-no-credentials.js` is `require()`d directly (it's already CJS with
 * zero dependencies) rather than spawned as a subprocess — same
 * in-process-over-subprocess rationale as `../../../deps/executors/check/impl.js`.
 */
const { join } = require('node:path');
const { withMetrics } = require('../../../lib/metrics');

const SCANNER_PATH = join(__dirname, '..', '..', '..', '..', '..', '.githooks', 'check-no-credentials.js');

function loadScanner() {
  // Not memoized: unlike eslint-check.mjs's dynamic `import()`, `require()`
  // is already cached by Node's own module system.
  return require(SCANNER_PATH);
}

/**
 * @param {{mode?: 'staged'|'range'|'all', base?: string, head?: string}} options
 * @param {*} context nx executor context (unused beyond withMetrics' own needs)
 */
async function run(options, context) {
  return withMetrics('secret-scan', context, async (rec) => {
    const mode = options.mode || 'staged';
    let argv;
    if (mode === 'staged') argv = ['--staged'];
    else if (mode === 'all') argv = ['--all'];
    else if (mode === 'range') {
      if (!options.base || !options.head) {
        throw new Error('secret-scan: mode "range" requires both --base and --head.');
      }
      argv = ['--range', options.base, options.head];
    } else {
      throw new Error(`secret-scan: unknown mode "${mode}" (expected staged | range | all).`);
    }

    const code = rec.time(`check-no-credentials.js ${argv.join(' ')} (in-process)`, () =>
      module.exports.__internals.loadScanner().main(argv)
    );
    return { success: code === 0 };
  });
}
module.exports = run; module.exports.default = run;
module.exports.__internals = { loadScanner };
