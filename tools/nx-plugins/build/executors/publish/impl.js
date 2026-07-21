'use strict';
/** release-publish — thin nx executor wrapping the proven script (unchanged). */
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
async function run(options, context) {
  const script = join(context.root, 'tools/nx-plugins/build/executors/publish/release-publish.mjs');
  const args = (options.args || []);
  const res = spawnSync('node', [script, ...args], { stdio: 'inherit', cwd: context.root });
  return { success: res.status === 0 };
}
module.exports = run;
module.exports.default = run;
