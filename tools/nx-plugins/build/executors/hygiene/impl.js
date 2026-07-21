'use strict';
/** check-publish-hygiene — thin nx executor wrapping the proven script (unchanged). */
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
async function run(options, context) {
  const script = join(context.root, 'tools/nx-plugins/build/executors/hygiene/check-publish-hygiene.mjs');
  const args = [];
  const res = spawnSync('node', [script, ...args], { stdio: 'inherit', cwd: context.root });
  return { success: res.status === 0 };
}
module.exports = run;
module.exports.default = run;
