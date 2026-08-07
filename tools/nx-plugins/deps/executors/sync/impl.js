'use strict';
/**
 * deps sync (--fix) — runs `@nx/dependency-checks` (via the guarded
 * `eslint-check.mjs`) against this project's package.json.
 *
 * BUILD-TOOLING-METRICS-001 profiling of the `version` task (which calls this
 * executor in-process once per project, via `version/impl.js`'s
 * `reconcileOwnInternalRanges`) found `sync-deps`/`sync-deps-check` spawning
 * a FRESH `node eslint-check.mjs <pkg.json> [--fix]` SUBPROCESS on every
 * single project, unconditionally — one full extra Node-process boot
 * (fork+exec, V8 init, module resolution) per project, purely to re-launch a
 * script that itself still shells out to the real `eslint` binary
 * (`eslint-check.mjs`'s own `execFileSync` call, UNCHANGED — see below).
 *
 * This now calls `eslint-check.mjs`'s exported `main()` IN-PROCESS instead
 * (one dynamic `import()`, memoized per Node process) — eliminating that
 * outer subprocess layer entirely. `eslint-check.mjs`'s own guard
 * (`isRealInstall`) and its real dependency-checks invocation
 * (`execFileSync(eslint, ...)`) are COMPLETELY UNTOUCHED: this is a pure
 * invocation-mechanism change (subprocess-of-a-subprocess -> one subprocess),
 * never a behavior change to the actual, historically-fragile
 * dependency-checks logic (BUG-REPO-PRECOMMIT-DEPCHECK-STRIPS-USED-DEPS-001).
 *
 * `module.exports.__internals.runDependencyCheck` is a deliberate,
 * overridable seam (a plain, mutable CJS property looked up at CALL time, not
 * a captured closure) so tests can substitute a fake without ever letting the
 * real ESLint engine run inside a unit test — see impl.spec.mjs and
 * `../../../build/executors/version/impl.spec.mjs`.
 */
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { withMetrics } = require('../../../lib/metrics');

const ESLINT_CHECK_URL = pathToFileURL(require.resolve('../../eslint-check.mjs')).href;
let cachedModulePromise;
/** Dynamically `import()` eslint-check.mjs once per process (Node's own ESM
 * loader caches by specifier — this local promise just avoids re-resolving
 * the URL on every call). An ESM module cannot be `require()`d from CJS. */
function loadEslintCheck() {
  if (!cachedModulePromise) cachedModulePromise = import(ESLINT_CHECK_URL);
  return cachedModulePromise;
}

/**
 * Run the real dependency-check in-process.
 *
 * @param {string} pkgJsonPath absolute path to the target project's package.json
 * @param {string[]} extraArgs e.g. `['--fix']`
 * @returns {Promise<number>} the intended process exit code (0 = ok)
 */
async function runDependencyCheck(pkgJsonPath, extraArgs) {
  const mod = await loadEslintCheck();
  return mod.main([pkgJsonPath, ...extraArgs]);
}

async function run(options, context) {
  return withMetrics('sync-deps', context, async (rec) => {
    const projRoot = context.projectsConfigurations.projects[context.projectName].root;
    const pkgJsonPath = join(context.root, projRoot, 'package.json');
    const code = await rec.timeAsync(`eslint-check.mjs ${pkgJsonPath} --fix (in-process)`, () =>
      module.exports.__internals.runDependencyCheck(pkgJsonPath, ['--fix'])
    );
    return { success: code === 0 };
  });
}
module.exports = run; module.exports.default = run;
module.exports.__internals = { runDependencyCheck, loadEslintCheck };
