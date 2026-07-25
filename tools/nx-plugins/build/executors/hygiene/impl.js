'use strict';
/**
 * check-publish-hygiene — nx executor for the `publish-hygiene` target.
 *
 * BUILD-TOOLING-METRICS-001: this used to `spawnSync('node', [script,
 * projectRoot], ...)` a FRESH subprocess per project purely to re-launch a
 * script that itself still shells out to real `npm pack --dry-run`
 * (`check-publish-hygiene.mjs`'s own `spawnSync`, UNCHANGED — see that
 * file). This now calls the script's exported `main()` IN-PROCESS instead
 * (one dynamic `import()`, memoized per Node process) — eliminating that
 * outer subprocess layer entirely, mirroring `deps/executors/sync|check`'s
 * own elimination of the same pattern. `check-publish-hygiene.mjs`'s real
 * hygiene logic (file-list assertions, the `npm pack --dry-run` call) is
 * COMPLETELY UNTOUCHED: this is a pure invocation-mechanism change
 * (subprocess-of-a-subprocess -> one subprocess), never a behavior change.
 *
 * `--json` is deliberately NOT passed here: the executor path always wants
 * the human-readable report on stdout (nx surfaces it in the task log),
 * matching the pre-conversion subprocess's `stdio: 'inherit'` behavior.
 *
 * `module.exports.__internals.runHygieneCheck` is a deliberate, overridable
 * seam (a plain, mutable CJS property looked up at CALL time, not a
 * captured closure) so tests can substitute a fake without needing a real
 * built `dist/` + a real `npm pack` — see impl.spec.mjs.
 */
const { pathToFileURL } = require('node:url');
const { withMetrics } = require('../../../lib/metrics');

const HYGIENE_SCRIPT_URL = pathToFileURL(require.resolve('./check-publish-hygiene.mjs')).href;
let cachedModulePromise;
/** Dynamically `import()` check-publish-hygiene.mjs once per process (Node's
 * own ESM loader caches by specifier — this local promise just avoids
 * re-resolving the URL on every call). An ESM module cannot be `require()`d
 * from CJS. */
function loadHygieneCheck() {
  if (!cachedModulePromise) cachedModulePromise = import(HYGIENE_SCRIPT_URL);
  return cachedModulePromise;
}

/**
 * Run the real publish-hygiene check in-process.
 *
 * @param {string} projectRoot workspace-relative project root
 * @param {string} repoRoot absolute workspace root (`context.root`) — passed
 *   through explicitly rather than letting the script re-discover its own
 *   (identical, in production) root, so tests can point this at an isolated
 *   sandbox instead of the real repo.
 * @returns {Promise<number>} the intended process exit code (0 = clean)
 */
async function runHygieneCheck(projectRoot, repoRoot) {
  const mod = await loadHygieneCheck();
  return mod.main([projectRoot], { repoRoot });
}

async function run(options, context) {
  return withMetrics('publish-hygiene', context, async (rec) => {
    // Per-project: check THIS package's built+versioned dist ({projectRoot}/dist).
    const projectRoot = context.projectsConfigurations.projects[context.projectName].root;
    const code = await rec.timeAsync(`check-publish-hygiene.mjs ${projectRoot} (in-process)`, () =>
      module.exports.__internals.runHygieneCheck(projectRoot, context.root)
    );
    return { success: code === 0 };
  });
}
module.exports = run; module.exports.default = run;
module.exports.__internals = { runHygieneCheck, loadHygieneCheck };
