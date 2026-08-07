'use strict';
/**
 * deps check (read-only) — runs `@nx/dependency-checks` (via the guarded
 * `eslint-check.mjs`) against this project's package.json, never `--fix`.
 *
 * See `../sync/impl.js`'s header (BUILD-TOOLING-METRICS-001) for why this
 * calls `eslint-check.mjs`'s exported `main()` IN-PROCESS instead of spawning
 * a fresh `node eslint-check.mjs <pkg.json>` subprocess — the real
 * dependency-checks invocation inside `eslint-check.mjs` (still
 * `execFileSync(eslint, ...)`) is completely unchanged; only the outer
 * wrapper-script subprocess is eliminated.
 */
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { withMetrics } = require('../../../lib/metrics');

const ESLINT_CHECK_URL = pathToFileURL(require.resolve('../../eslint-check.mjs')).href;
let cachedModulePromise;
function loadEslintCheck() {
  if (!cachedModulePromise) cachedModulePromise = import(ESLINT_CHECK_URL);
  return cachedModulePromise;
}

/**
 * @param {string} pkgJsonPath absolute path to the target project's package.json
 * @param {string[]} extraArgs e.g. `[]`
 * @returns {Promise<number>} the intended process exit code (0 = ok)
 */
async function runDependencyCheck(pkgJsonPath, extraArgs) {
  const mod = await loadEslintCheck();
  return mod.main([pkgJsonPath, ...extraArgs]);
}

async function run(options, context) {
  return withMetrics('sync-deps-check', context, async (rec) => {
    const projRoot = context.projectsConfigurations.projects[context.projectName].root;
    const pkgJsonPath = join(context.root, projRoot, 'package.json');
    const code = await rec.timeAsync(`eslint-check.mjs ${pkgJsonPath} (check, in-process)`, () =>
      module.exports.__internals.runDependencyCheck(pkgJsonPath, [])
    );
    return { success: code === 0 };
  });
}
module.exports = run; module.exports.default = run;
module.exports.__internals = { runDependencyCheck, loadEslintCheck };
