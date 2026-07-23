'use strict';
/** check-publish-hygiene — thin nx executor wrapping the proven script (unchanged). */
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const { withMetrics } = require('../../../lib/metrics');
async function run(options, context) {
  return withMetrics('publish-hygiene', context, async (rec) => {
    const script = join(context.root, 'tools/nx-plugins/build/executors/hygiene/check-publish-hygiene.mjs');
    // Per-project: check THIS package's built+versioned dist ({projectRoot}/dist).
    const projectRoot = context.projectsConfigurations.projects[context.projectName].root;
    const res = rec.time(`node ${script} ${projectRoot}`, () =>
      spawnSync('node', [script, projectRoot], { stdio: 'inherit', cwd: context.root })
    );
    return { success: res.status === 0 };
  });
}
module.exports = run;
module.exports.default = run;
