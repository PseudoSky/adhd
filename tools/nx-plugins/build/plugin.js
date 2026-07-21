'use strict';
/** createNodes: attach @adhd/nx-build executor-backed targets to every buildable project. No project.json edits. */
const { existsSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { hasBuildTarget, isPublishable } = require('./detect-target');
function skip(p) { return p === '.' || p.startsWith('node_modules/') || p.includes('/node_modules/') || p.startsWith('dist/') || p.includes('/dist/') || p.startsWith('tmp/') || p.includes('/tmp/'); }
exports.createNodes = ['**/package.json', (pkgPath, _o, ctx) => {
  const projectRoot = dirname(pkgPath);
  if (skip(projectRoot)) return {};
  if (!existsSync(join(ctx.workspaceRoot, projectRoot, 'project.json'))) return {};
  if (!hasBuildTarget(ctx.workspaceRoot, projectRoot)) return {};
  // Private packages have no published artifact to verify/ship.
  if (!isPublishable(ctx.workspaceRoot, projectRoot)) return {};
  // In-source dist ({projectRoot}/dist) + publish-from-source-root means pnpm resolves
  // @adhd/* natively via each package's own manifest (main → ./dist/…). The old `link`
  // target (symlink node_modules/@adhd/<name> → repo-root dist) is retired — it created
  // the per-package-source-link shadowing that broke @adhd builds (BUG-WORKSPACE-NO-LINKING-001).
  // The `assets` executor (copied README/CHANGELOG into repo-root dist) is likewise retired:
  // README/CHANGELOG now ship straight from the package root via files:["dist","CHANGELOG.md"]
  // + npm's always-included README, and in-dist *.md copies (where wanted) come from each
  // build target's own `options.assets`.
  return { projects: { [projectRoot]: { targets: {"verify-dist-load":{"executor":"@adhd/nx-build:verify","dependsOn":["build"],"cache":true},"publish-hygiene":{"executor":"@adhd/nx-build:hygiene","dependsOn":["build"],"cache":true},"publish":{"executor":"@adhd/nx-build:publish","dependsOn":["build","verify-dist-load","publish-hygiene"]}} } } };
}];
