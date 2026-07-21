'use strict';
/** createNodes: attach @adhd/nx-test executor-backed targets to every buildable project. No project.json edits. */
const { existsSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { hasBuildTarget } = require('../build/detect-target');
function skip(p) { return p === '.' || p.startsWith('node_modules/') || p.includes('/node_modules/') || p.startsWith('dist/') || p.includes('/dist/') || p.startsWith('tmp/') || p.includes('/tmp/'); }
exports.createNodes = ['**/package.json', (pkgPath, _o, ctx) => {
  const projectRoot = dirname(pkgPath);
  if (skip(projectRoot)) return {};
  if (!existsSync(join(ctx.workspaceRoot, projectRoot, 'project.json'))) return {};
  if (!hasBuildTarget(ctx.workspaceRoot, projectRoot)) return {};
  return { projects: { [projectRoot]: { targets: {"test-wiring":{"executor":"@adhd/nx-test:wiring","cache":true}} } } };
}];
