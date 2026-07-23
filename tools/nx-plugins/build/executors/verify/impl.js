'use strict';
/** verify-dist-load — thin nx executor wrapping the proven script (unchanged). */
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const { withMetrics } = require('../../../lib/metrics');
async function run(options, context) {
  return withMetrics('verify-dist-load', context, async (rec) => {
    const script = join(context.root, 'tools/nx-plugins/build/executors/verify/verify-dist-load.mjs');
    // The script wants the workspace-relative project root; `.root` already IS that.
    const projectRoot = context.projectsConfigurations.projects[context.projectName].root;
    const res = rec.time(`node ${script} ${projectRoot}`, () =>
      spawnSync('node', [script, projectRoot], { stdio: 'inherit', cwd: context.root })
    );
    return { success: res.status === 0 };
  });
}
module.exports = run;
module.exports.default = run;
