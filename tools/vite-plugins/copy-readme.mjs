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
  return copyDocFiles(root, ['README.md']);
}

/**
 * Vite plugin: copy the given root-level doc files (README.md, CHANGELOG.md,
 * etc.) into the build `outDir` so the published package (published from
 * `dist/{projectRoot}`) ships them on npm.
 *
 * Generalizes {@link copyReadme} — `@nx/vite:build` ignores the project.json
 * `assets` option entirely, so any doc file a package wants shipped (beyond
 * npm's always-included package.json/README/LICENSE/main) has to be copied by
 * the build itself, via this plugin, rather than left to a nx `assets` entry
 * that will silently never run. Missing files are skipped, not an error —
 * only ship what the package actually has (e.g. no CHANGELOG.md yet).
 *
 * @param {string} root absolute package root (pass `__dirname` from vite.config)
 * @param {string[]} [filenames] doc filenames to copy, relative to `root`
 */
export function copyDocFiles(root, filenames = ['README.md', 'CHANGELOG.md']) {
  let outDir = '';
  return {
    name: 'adhd-copy-doc-files',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const dest = path.resolve(root, outDir);
      for (const filename of filenames) {
        const src = path.resolve(root, filename);
        if (!fs.existsSync(src)) continue;
        fs.mkdirSync(dest, { recursive: true });
        fs.copyFileSync(src, path.join(dest, filename));
      }
    },
  };
}
