'use strict';
/**
 * @adhd/nx-build:manifest — "version the dist at build".
 *
 * Runs after `build` (dependsOn:["build"]) and (over)writes {projectRoot}/dist/
 * package.json with a fully-resolved, dist-root publishable manifest produced by
 * ./generate-manifest.js. Also copies the source CHANGELOG.md into dist so the
 * published-from-dist artifact ships its changelog.
 *
 * The workspace version map is built from EVERY project's source package.json as
 * resolved in the current task graph — so during `nx release` (which writes all
 * source version bumps BEFORE the publish-phase build), each dist manifest is
 * stamped against the FINAL version of every sibling. That makes internal
 * @adhd/* ranges correct independent of nx's non-topological versioning order
 * (BUG-RELEASE-PIPELINE-UNFIT-FOR-FULL-PUBLISH-001, Defect C).
 *
 * Not cached: it is a sub-millisecond JSON write whose correctness depends on
 * every sibling's version (an input that is impractical to express as a cache
 * key), so it always re-runs and is authoritative over any manifest a prior
 * build step (e.g. vite `generatePackageJson`) may have emitted.
 */
const { existsSync } = require('node:fs');
const { join, relative } = require('node:path');
const { writeDistManifest } = require('./generate-manifest');
const { withMetrics } = require('../../../lib/metrics');

async function run(_options, context) {
  return withMetrics('dist-manifest', context, async (rec) => {
    const projectRoot = context.projectsConfigurations.projects[context.projectName].root;
    const pkgRoot = join(context.root, projectRoot);
    const distDir = join(pkgRoot, 'dist');
    const srcPkgPath = join(pkgRoot, 'package.json');

    if (!existsSync(distDir)) {
      console.error(
        `dist-manifest: no built output at ${relative(context.root, distDir)} — did 'build' run? (this target must dependsOn:["build"])`
      );
      return { success: false };
    }
    if (!existsSync(srcPkgPath)) {
      console.error(`dist-manifest: no source package.json at ${relative(context.root, srcPkgPath)}.`);
      return { success: false };
    }

    // Shared with `version` and `publish` (BUG-BUILD-PUBLISH-DISTMANIFEST-
    // CLOBBERED-001) — this is not the only writer of dist/package.json
    // anymore; it's the first of three call sites that all re-stamp it
    // defensively, using the exact same generate-manifest.js logic.
    const manifest = await writeDistManifest(context, pkgRoot, distDir);
    rec.phase('writeDistManifest');

    console.log(
      `dist-manifest: ${manifest.name}@${manifest.version} -> ${relative(context.root, join(distDir, 'package.json'))}`
    );
    return { success: true };
  });
}

module.exports = run;
module.exports.default = run;
