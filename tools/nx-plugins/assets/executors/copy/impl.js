'use strict';
/** copy — README.md + CHANGELOG.md (if present) + package.json "assets" globs into dist/{projectRoot}. */
const { existsSync, mkdirSync, copyFileSync, readFileSync } = require('node:fs');
const { join, dirname } = require('node:path');
async function run(options, context) {
  const projRoot = context.projectsConfigurations.projects[context.projectName].root;
  const src = join(context.root, projRoot);
  const out = join(context.root, 'dist', projRoot);
  if (!existsSync(out)) { console.error('assets: no dist for ' + context.projectName + ' (build first)'); return { success: false }; }
  const pkg = existsSync(join(src, 'package.json')) ? JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')) : {};
  const files = ['README.md', 'CHANGELOG.md', ...(Array.isArray(pkg.assets) ? pkg.assets : [])];
  for (const f of files) {
    const from = join(src, f);
    if (!existsSync(from)) continue;
    const to = join(out, f);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    console.log('asset ' + f + ' -> dist/' + projRoot);
  }
  return { success: true };
}
module.exports = run; module.exports.default = run;
