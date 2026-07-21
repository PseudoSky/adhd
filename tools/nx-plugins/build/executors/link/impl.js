'use strict';
/** link — symlink this project's built dist into node_modules/@adhd/<name>. Idempotent. */
const { existsSync, mkdirSync, lstatSync, rmSync, symlinkSync, readFileSync } = require('node:fs');
const { join, relative, dirname } = require('node:path');
async function run(options, context) {
  const projRoot = context.projectsConfigurations.projects[context.projectName].root;
  const pkgPath = join(context.root, projRoot, 'package.json');
  if (!existsSync(pkgPath)) return { success: true };
  const name = JSON.parse(readFileSync(pkgPath, 'utf8')).name; // e.g. @adhd/data-base-transforms
  if (!name || !name.startsWith('@adhd/')) return { success: true };
  const distDir = join(context.root, 'dist', projRoot);
  if (!existsSync(distDir)) { console.error('link: no dist for ' + name + ' (build first)'); return { success: false }; }
  const linkPath = join(context.root, 'node_modules', name);
  mkdirSync(dirname(linkPath), { recursive: true });
  try { if (lstatSync(linkPath)) rmSync(linkPath, { recursive: true, force: true }); } catch {}
  symlinkSync(relative(dirname(linkPath), distDir), linkPath, 'dir');
  console.log('linked ' + name + ' -> ' + relative(context.root, distDir));
  return { success: true };
}
module.exports = run; module.exports.default = run;
