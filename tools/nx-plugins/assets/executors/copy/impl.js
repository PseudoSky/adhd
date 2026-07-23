'use strict';
/** copy — README.md + CHANGELOG.md (if present) + package.json "assets" globs into {projectRoot}/dist (in-tree, per the pnpm/in-source-dist migration — never the old workspace-root dist/{projectRoot}). Every destination is flattened to the dist root (basename only) so a nested source path (e.g. "src/schema.json") still lands beside index.js, matching every asset consumer's expected lookup path. */
const { existsSync, mkdirSync, copyFileSync, readFileSync } = require('node:fs');
const { join, dirname, basename } = require('node:path');
async function run(options, context) {
  const projRoot = context.projectsConfigurations.projects[context.projectName].root;
  const src = join(context.root, projRoot);
  const out = join(src, 'dist');
  if (!existsSync(out)) { console.error('assets: no dist for ' + context.projectName + ' (build first)'); return { success: false }; }
  const pkg = existsSync(join(src, 'package.json')) ? JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')) : {};
  const files = ['README.md', 'CHANGELOG.md', ...(Array.isArray(pkg.assets) ? pkg.assets : [])];
  for (const f of files) {
    const from = join(src, f);
    if (!existsSync(from)) continue;
    const to = join(out, basename(f));
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    console.log('asset ' + f + ' -> ' + projRoot + '/dist/' + basename(f));
  }
  return { success: true };
}
module.exports = run; module.exports.default = run;
