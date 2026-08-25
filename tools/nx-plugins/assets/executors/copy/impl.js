'use strict';
/**
 * copy — makes {projectRoot}/dist publish-ready: copies README.md +
 * CHANGELOG.md (if present) + package.json "assets" globs, flattened to the
 * dist root (basename only) so a nested source path (e.g. "src/schema.json")
 * still lands beside index.js, matching every asset consumer's expected
 * lookup path.
 *
 * The `bin` chmod that used to live here moved to its own uncacheable
 * `chmod-bin` target (`../chmod-bin/impl.js`) — BUG-NXASSETS-001: this
 * target is `cache: true`, so its executor body (this file) never runs at
 * all on a cache hit, which meant the chmod silently stopped happening once
 * an `assets` cache entry existed. `chmod-bin` runs on every invocation
 * instead, with no such gap.
 *
 * In-tree ({projectRoot}/dist), never the old workspace-root dist/{projectRoot} — per
 * the pnpm/in-source-dist migration.
 */
const { existsSync, mkdirSync, copyFileSync, cpSync, readFileSync, statSync } = require('node:fs');
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
    return { success: true };
  });
}
module.exports = run; module.exports.default = run;
