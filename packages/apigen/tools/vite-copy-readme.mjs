import fs from 'node:fs';
import path from 'node:path';

/**
 * Vite plugin: copy `<root>/README.md` into the build `outDir` so the published
 * package (published from `dist/{projectRoot}`) ships its README on npm.
 *
 * @nx/vite:build ignores the project.json `assets` option, so this runs as part
 * of the build itself — surviving `emptyOutDir` and nx cache restore, and making
 * the gated `nx release publish` (clean build + test) produce a README-bearing
 * artifact without any post-build hand-editing of dist.
 *
 * @param {string} root absolute package root (pass `__dirname` from vite.config)
 */
export function copyReadme(root) {
  let outDir = '';
  return {
    name: 'apigen-copy-readme',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const src = path.resolve(root, 'README.md');
      if (!fs.existsSync(src)) return;
      const dest = path.resolve(root, outDir);
      fs.mkdirSync(dest, { recursive: true });
      fs.copyFileSync(src, path.join(dest, 'README.md'));
    },
  };
}
