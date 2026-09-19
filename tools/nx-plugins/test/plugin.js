'use strict';
/** createNodes: attach @adhd/nx-test executor-backed targets to every buildable project. No project.json edits. */
const { existsSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { hasBuildTarget } = require('../build/detect-target');
const { isScratchPath } = require('../lib/scratch-root');
function skip(p) { return p === '.' || p.startsWith('node_modules/') || p.includes('/node_modules/') || p.startsWith('dist/') || p.includes('/dist/') || isScratchPath(p); }
// Nx 23 unified on the v2 plugin API: createNodes[1] receives the ARRAY of
// matched config files and returns [configFile, result] tuples.
exports.createNodes = ['**/package.json', (configFiles, _o, ctx) =>
  configFiles.map((pkgPath) => {
  const projectRoot = dirname(pkgPath);
  if (skip(projectRoot)) return [pkgPath, {}];
  if (!existsSync(join(ctx.workspaceRoot, projectRoot, 'project.json'))) return [pkgPath, {}];
  if (!hasBuildTarget(ctx.workspaceRoot, projectRoot)) return [pkgPath, {}];
  return [pkgPath, { projects: { [projectRoot]: { targets: {"test-wiring":{"executor":"@adhd/nx-test:wiring","cache":true}} } } }];
  })];
