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
 *
 * BUG-001 (false-fail on a transient un-rebased dist/package.json): `@nx/js:tsc`
 * (`clean:true`) writes its OWN minimal, un-rebased `dist/package.json`
 * (carrying the source `"files": ["dist", …]` allowlist) as a build output.
 * `dist-manifest` is a SIBLING of `build` in `publish`'s `dependsOn` — nx
 * guarantees both complete, never their relative order — so a cache-restored
 * `build` can re-clobber `dist-manifest`'s rebase after the fact. `publish`
 * and `version` already defend against exactly this by calling
 * `writeDistManifest` as their own truly-last write before they trust
 * `dist/`'s content (see generate-manifest.js's doc comment). `publish-hygiene`
 * did not, so it could intermittently fail a package whose dist was, at the
 * moment hygiene ran, sitting in that transient clobbered state — even though
 * the REAL publish (which re-stamps) would have packed it correctly. Re-
 * stamping here makes hygiene check the SAME state the real publish will
 * pack: no more false-fail, and a package that is genuinely un-packable even
 * after a correct re-stamp (e.g. its dist has no shippable files at all)
 * still fails for real.
 */
const { pathToFileURL } = require('node:url');
const { join } = require('node:path');
const { withMetrics } = require('../../../lib/metrics');
const { writeDistManifest } = require('../manifest/generate-manifest');

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
    const pkgRoot = join(context.root, projectRoot);
    const distDir = join(pkgRoot, 'dist');

    // BUG-001: re-stamp the dist manifest HERE, as the truly-last write
    // before the hygiene pack/check below — mirrors `publish`/`version`'s own
    // re-stamp (see generate-manifest.js's doc comment). Only meaningful if
    // build + dist-manifest already ran at least once (a missing dist dir is
    // still a hard failure, surfaced by the real check below, never silently
    // skipped here).
    if (module.exports.__internals.restampDistManifest) {
      await module.exports.__internals.restampDistManifest(context, pkgRoot, distDir);
    }

    const code = await rec.timeAsync(`check-publish-hygiene.mjs ${projectRoot} (in-process)`, () =>
      module.exports.__internals.runHygieneCheck(projectRoot, context.root)
    );
    return { success: code === 0 };
  });
}

/**
 * Re-stamp the dist manifest before the hygiene check reads it — the seam is
 * mockable (like `runHygieneCheck`) so unit tests that don't care about the
 * re-stamp can no-op it, and a missing/un-built dist dir (no source
 * package.json, no dist dir yet) is tolerated here: the real hygiene check
 * below is what turns "nothing to re-stamp" into a proper failure message.
 *
 * @param {import('@nx/devkit').ExecutorContext} context
 * @param {string} pkgRoot absolute source project root
 * @param {string} distDir absolute {projectRoot}/dist
 */
async function restampDistManifest(context, pkgRoot, distDir) {
  const { existsSync } = require('node:fs');
  if (!existsSync(join(pkgRoot, 'package.json')) || !existsSync(distDir)) return;
  await writeDistManifest(context, pkgRoot, distDir);
}

module.exports = run; module.exports.default = run;
module.exports.__internals = { runHygieneCheck, loadHygieneCheck, restampDistManifest };
