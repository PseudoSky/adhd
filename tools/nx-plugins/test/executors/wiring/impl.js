'use strict';
/** check-test-wiring — thin nx executor wrapping the proven script (unchanged). */
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
async function run(options, context) {
  const script = join(context.root, 'tools/nx-plugins/test/executors/wiring/check-test-wiring.mjs');
  const args = [];
  const res = spawnSync('node', [script, ...args], { stdio: 'inherit', cwd: context.root });
  return { success: res.status === 0 };
}
module.exports = run;
module.exports.default = run;
