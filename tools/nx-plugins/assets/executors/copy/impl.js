'use strict';
/**
 * copy — makes {projectRoot}/dist publish-ready:
 *  1. README.md + CHANGELOG.md (if present) + package.json "assets" globs, flattened
 *     to the dist root (basename only) so a nested source path (e.g. "src/schema.json")
 *     still lands beside index.js, matching every asset consumer's expected lookup path.
 *  2. chmod 0o755 every file the package's own "bin" field points at. `@nx/vite:build`
 *     and `@nx/js:tsc` both emit dist files WITHOUT the executable bit, even when the
 *     built entry has a correct `#!/usr/bin/env node` shebang — npm's publish-time bin
 *     validation silently STRIPS any bin entry pointing at a non-executable file (no
 *     error, no warning that names the real cause — just "script name X was invalid
 *     and removed"). Without this, every CLI package (apigen-cli, decompile-cli,
 *     agent-mcp) would publish with its `bin` entry silently dropped — `npm install -g`
 *     would install fine but register no command at all.
 * In-tree ({projectRoot}/dist), never the old workspace-root dist/{projectRoot} — per
 * the pnpm/in-source-dist migration.
 */
const { existsSync, mkdirSync, copyFileSync, cpSync, readFileSync, chmodSync, statSync } = require('node:fs');
const { join, dirname, basename } = require('node:path');
const { withMetrics } = require('../../../lib/metrics');
async function run(options, context)
{
  return withMetrics('assets-copy', context, async (rec) =>
  {
    const projRoot = context.projectsConfigurations.projects[context.projectName].root;
    const src = join(context.root, projRoot);
    const out = join(src, 'dist');
    if (!existsSync(out)) { console.error('assets: no dist for ' + context.projectName + ' (build first)'); return { success: false }; }
    const pkg = existsSync(join(src, 'package.json')) ? JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')) : {};
    const files = ['README.md', 'CHANGELOG.md', 'llms.txt', 'drizzle', ...(Array.isArray(pkg.assets) ? pkg.assets : [])];
    for (const f of files) {
      const from = join(src, f);
      if (!existsSync(from)) continue;
      const to = join(out, basename(f));
      mkdirSync(dirname(to), { recursive: true });
      if (statSync(from).isDirectory()) {
        // Directory asset (e.g. a top-level "drizzle" migrations folder) — the build's own
        // tsc "assets" glob may already have copied it into dist under the same name, so this
        // is a deliberate, idempotent re-sync rather than a redundant no-op: cpSync recursively
        // overwrites file-for-file instead of copyFileSync's file-only semantics, which throws
        // EISDIR the moment the destination is a directory (BUG: agent-store-tools/agent-mcp
        // publish both have a top-level "drizzle" dir and failed here before this fix).
        cpSync(from, to, { recursive: true });
      } else {
        copyFileSync(from, to);
      }
      console.log('asset ' + f + ' -> ' + projRoot + '/dist/' + basename(f));
    }
    rec.phase('copyAssets');
    if (pkg.bin && typeof pkg.bin === 'object') {
      for (const [name, relPath] of Object.entries(pkg.bin)) {
        const binFile = join(src, relPath);
        if (!existsSync(binFile)) { console.error('assets: bin[' + name + '] -> ' + relPath + ' does not exist, skipping chmod'); continue; }
        const mode = statSync(binFile).mode;
        if ((mode & 0o111) !== 0o111) {
          chmodSync(binFile, mode | 0o755);
          console.log('assets: chmod +x ' + relPath + ' (bin[' + name + '])');
        }
      }
    }
    rec.phase('chmodBin');
    return { success: true };
  });
}
module.exports = run; module.exports.default = run;
