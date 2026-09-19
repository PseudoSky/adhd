'use strict';
/** createNodes: attach @adhd/nx-assets executor-backed targets to every buildable project. No project.json edits. */
const { existsSync, readFileSync } = require('node:fs');
const { dirname, join, basename } = require('node:path');
const { hasBuildTarget } = require('../build/detect-target');
const { isScratchPath } = require('../lib/scratch-root');
function skip(p) { return p === '.' || p.startsWith('node_modules/') || p.includes('/node_modules/') || p.startsWith('dist/') || p.includes('/dist/') || isScratchPath(p); }

/**
 * The `assets` target's declared `outputs`, mirroring exactly what
 * `executors/copy/impl.js` writes: each of README.md / CHANGELOG.md /
 * llms.txt / drizzle / `package.json` "assets" entries that actually EXISTS
 * in the project root, copied FLATTENED (basename only) into `dist/`.
 *
 * This must be declared or the target is broken by its own `cache: true`.
 * A cached nx target restores its DECLARED outputs on a cache hit; a target
 * with no declared outputs restores NOTHING, while still reporting success
 * ("read the output from the cache"). So once an `assets` cache entry exists,
 * any later state where `dist/` lacks the asset files — a fresh checkout, a
 * CI machine warmed from a shared cache, or a `build` that re-ran with vite's
 * `emptyOutDir: true` and wiped them — is never repaired: `assets` hits the
 * cache, copies nothing, and `nx release publish` ships a `dist/` with no
 * README and no CHANGELOG. Reproduced directly: delete `dist/README.md`, re-run
 * `nx run <p>:assets`, observe "read the output from the cache instead of
 * running the command" and a still-missing README.
 *
 * Deliberately NOT included: the files `pkg.bin` points at. The executor
 * chmods those, but they are `build`'s outputs, not this target's — claiming
 * them here would let a stale `assets` cache entry restore an outdated
 * `dist/index.js` over a fresh build. The lost-chmod-on-cache-hit case is a
 * separate defect and is tracked separately rather than papered over here.
 *
 * `inputs` are deliberately left at the nx default: narrowing them risks
 * under-invalidation, which is a worse failure than an occasional extra copy.
 */
function assetOutputs(workspaceRoot, projectRoot) {
  const src = join(workspaceRoot, projectRoot);
  let pkg = {};
  try { pkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')); } catch { pkg = {}; }
  const candidates = ['README.md', 'CHANGELOG.md', 'llms.txt', 'drizzle', ...(Array.isArray(pkg.assets) ? pkg.assets : [])];
  const outs = [];
  for (const f of candidates) {
    if (typeof f !== 'string' || !existsSync(join(src, f))) continue;
    const out = '{projectRoot}/dist/' + basename(f);
    if (!outs.includes(out)) outs.push(out);
  }
  return outs;
}

// Nx 23 unified on the v2 plugin API: createNodes[1] receives the ARRAY of
// matched config files and returns [configFile, result] tuples.
exports.createNodes = ['**/package.json', (configFiles, _o, ctx) =>
  configFiles.map((pkgPath) => {
  const projectRoot = dirname(pkgPath);
  if (skip(projectRoot)) return [pkgPath, {}];
  if (!existsSync(join(ctx.workspaceRoot, projectRoot, 'project.json'))) return [pkgPath, {}];
  if (!hasBuildTarget(ctx.workspaceRoot, projectRoot)) return [pkgPath, {}];
  return [pkgPath, { projects: { [projectRoot]: { targets: {
    assets: {
      executor: '@adhd/nx-assets:copy',
      // BUG-NXASSETS-001: `chmod-bin` in the dependsOn list (not merely
      // `build`) is what pulls the always-runs chmod into every EXISTING
      // consumer of `assets` (e.g. `test`'s own `dependsOn: ["^build",
      // "build", "assets"]`) via nx's transitive task graph — no per-project
      // `project.json` needs to know chmod-bin exists.
      dependsOn: ['build', 'chmod-bin'],
      cache: true,
      outputs: assetOutputs(ctx.workspaceRoot, projectRoot),
    },
    'chmod-bin': {
      executor: '@adhd/nx-assets:chmod-bin',
      dependsOn: ['build'],
      // Deliberately UNCACHEABLE — see executors/chmod-bin/impl.js's doc
      // comment. The whole point is that this must run on every invocation;
      // caching it reintroduces the exact defect it fixes.
      cache: false,
    },
  } } } }];
  })];
