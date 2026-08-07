'use strict';
/**
 * verify-dist-load — thin nx executor wrapping the proven script
 * (verify-dist-load.mjs's own read/resolve logic is unchanged).
 *
 * CLOBBER-RACE FIX: `@nx/js:tsc`'s build output rebases `main`/`module`/
 * `types` but NOT `exports`/`bin` (those are left source-relative,
 * `./dist/...`) — and `dist-manifest`/`build` are SIBLINGS in every gate's
 * `dependsOn` (nx guarantees both complete, never their relative order), so a
 * build cache-restore can leave `dist/package.json` sitting in a transiently
 * PARTIALLY-rebased state (`main` correct, `exports["."].default` still
 * `./dist/dist/src/index.js`) at the exact moment `verify-dist-load` reads
 * it. `publish`/`version`/`publish-hygiene` all already defend against this
 * identical race by re-stamping the dist manifest as their own truly-last
 * write before they trust `dist/`'s content (see generate-manifest.js's
 * `writeDistManifest` doc comment, and `hygiene/impl.js`'s `restampDistManifest`
 * for the exact pattern this mirrors). `verify-dist-load` did not, so it
 * could nondeterministically fail a package whose dist was, at the moment it
 * ran, sitting in that transient clobbered state — even though the manifest
 * the REAL publish ships (freshly re-stamped) is fully correct. Re-stamping
 * here makes verify read the SAME fully-rebased manifest publish will ship:
 * no more nondeterministic false-fail, and a genuinely wrong dist manifest
 * (a real bad rebase) still fails for real — verify-dist-load.mjs's own
 * dist/package.json-missing exit-2 safety net is untouched, and still fires
 * for a project with no dist-manifest step configured at all.
 */
const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { withMetrics } = require('../../../lib/metrics');
const { writeDistManifest } = require('../manifest/generate-manifest');

/**
 * Re-stamp the dist manifest before verify-dist-load reads it — mirrors
 * `hygiene/impl.js`'s `restampDistManifest` exactly, including the same
 * guard: only meaningful if a source package.json AND a built dist/ already
 * exist. A missing/un-built dist is still a hard failure, surfaced by the
 * real verify-dist-load.mjs script below (its own "no built output at..."
 * exit 2), never silently skipped here.
 *
 * @param {import('@nx/devkit').ExecutorContext} context
 * @param {string} pkgRoot absolute source project root
 * @param {string} distDir absolute {projectRoot}/dist
 */
async function restampDistManifest(context, pkgRoot, distDir) {
  if (!existsSync(join(pkgRoot, 'package.json')) || !existsSync(distDir)) return;
  await writeDistManifest(context, pkgRoot, distDir);
}

async function run(options, context) {
  return withMetrics('verify-dist-load', context, async (rec) => {
    const script = join(context.root, 'tools/nx-plugins/build/executors/verify/verify-dist-load.mjs');
    // The script wants the workspace-relative project root; `.root` already IS that.
    const projectRoot = context.projectsConfigurations.projects[context.projectName].root;
    const pkgRoot = join(context.root, projectRoot);
    const distDir = join(pkgRoot, 'dist');

    if (module.exports.__internals.restampDistManifest) {
      await module.exports.__internals.restampDistManifest(context, pkgRoot, distDir);
    }

    const res = rec.time(`node ${script} ${projectRoot}`, () =>
      spawnSync('node', [script, projectRoot], { stdio: 'inherit', cwd: context.root })
    );
    return { success: res.status === 0 };
  });
}
module.exports = run;
module.exports.default = run;
module.exports.__internals = { restampDistManifest };
