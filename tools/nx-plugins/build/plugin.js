'use strict';
/** createNodes: attach @adhd/nx-build executor-backed targets to every buildable project. No project.json edits. */
const { existsSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { hasBuildTarget } = require('./detect-target');
function skip(p) { return p === '.' || p.startsWith('node_modules/') || p.includes('/node_modules/') || p.startsWith('dist/') || p.includes('/dist/') || p.startsWith('tmp/') || p.includes('/tmp/'); }
exports.createNodes = ['**/package.json', (pkgPath, _o, ctx) => {
  const projectRoot = dirname(pkgPath);
  if (skip(projectRoot)) return {};
  if (!existsSync(join(ctx.workspaceRoot, projectRoot, 'project.json'))) return {};
  if (!hasBuildTarget(ctx.workspaceRoot, projectRoot)) return {};
  return { projects: { [projectRoot]: { targets: {"link":{"executor":"@adhd/nx-build:link","dependsOn":["build"],"cache":false},"verify-dist-load":{"executor":"@adhd/nx-build:verify","dependsOn":["build","assets","link"],"cache":true},"publish-hygiene":{"executor":"@adhd/nx-build:hygiene","dependsOn":["build","assets"],"cache":true},"publish":{"executor":"@adhd/nx-build:publish","dependsOn":["build","assets","link","verify-dist-load","publish-hygiene"]}} } } };
}];
