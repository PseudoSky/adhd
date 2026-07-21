'use strict';
/** deps check — wraps eslint-check.mjs against this project's package.json. */
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
async function run(options, context) {
  const projRoot = context.projectsConfigurations.projects[context.projectName].root;
  const args = [join(context.root, 'tools/nx-plugins/deps/eslint-check.mjs'), join(projRoot, 'package.json')];
  const res = spawnSync('node', args, { stdio: 'inherit', cwd: context.root });
  return { success: res.status === 0 };
}
module.exports = run; module.exports.default = run;
