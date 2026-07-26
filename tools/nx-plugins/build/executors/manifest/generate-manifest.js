'use strict';
/**
 * generate-manifest.js — the pure, side-effect-free core of the
 * `@adhd/nx-build:manifest` executor (the "version the dist at build" step).
 *
 * WHY THIS EXISTS
 * ----------------
 * The workspace publishes each package from its OWN built artifact directory
 * ({projectRoot}/dist), not from the source root. For that dist directory to be
 * a correct, installable npm package, its `package.json` must be a fully
 * RESOLVED, dist-root manifest — not a copy of the source manifest (whose entry
 * paths point at `./dist/…` and whose internal `@adhd/*` dependency ranges are
 * whatever a human last hand-pinned).
 *
 * This function performs that resolution deterministically at BUILD time from a
 * live snapshot of every workspace package's version. Because the build reads
 * the FINAL version of every sibling (not an incremental one), the internal
 * dependency ranges it stamps are correct regardless of the order packages are
 * versioned in — which is exactly the guarantee `nx release`'s own
 * `updateDependents` pass fails to provide (it versions in non-topological
 * order, so a dependency bumped AFTER its dependent leaves the dependent's range
 * stale and unsatisfiable — BUG-RELEASE-PIPELINE-UNFIT-FOR-FULL-PUBLISH-001,
 * Defect C). Resolving from a whole-workspace snapshot at build time sidesteps
 * ordering entirely.
 *
 * WHAT IT DOES (source manifest -> dist-root manifest)
 * ----------------------------------------------------
 *  1. Rebases every entry-point path from source-relative (`./dist/index.js`,
 *     tsc's nested `./dist/src/index.js`) to dist-root-relative (`./index.js`,
 *     `./src/index.js`) by stripping the leading `dist/` segment — dist IS the
 *     package root once published, so `./dist/…` would resolve to `dist/dist/…`.
 *  2. Resolves every internal `@adhd/*` dependency (in dependencies /
 *     peerDependencies / optionalDependencies) to a concrete caret range
 *     `^<version>` read from the workspace version map. This also repairs the
 *     latent publish hazards of `workspace:*` (npm never substitutes it — it
 *     would ship literally) and bare `*` (unpinned) internal ranges.
 *  3. Drops `devDependencies` (consumers never install them, and they are where
 *     workspace-only tooling refs like `@adhd/nx-build: workspace:*` live) and
 *     `scripts` / `nx` (build-time-only, hazardous or meaningless once shipped).
 *  4. Drops `files` — with dist as the package root the source `files:["dist",…]`
 *     allowlist is wrong; the whole (clean) dist directory ships.
 *
 * @module generate-manifest
 */

/**
 * Rebase a single entry-point path from source-relative to dist-root-relative.
 * `./dist/index.js` -> `./index.js`; `./dist/src/index.js` -> `./src/index.js`;
 * `dist/index.js` -> `index.js`. Any path that does not start under `dist/` is
 * returned unchanged (defensive — never mangle an unexpected shape).
 *
 * @param {unknown} p candidate path (non-strings pass through untouched)
 * @returns {unknown}
 */
function rebaseDistPath(p) {
  if (typeof p !== 'string') return p;
  return p.replace(/^(\.\/)?dist\//, '$1');
}

/**
 * Deep-rebase an `exports` map (or string). Recurses through condition objects
 * ({ import, require, types, default, … }) and subpath keys ("./sub"), rebasing
 * every string leaf. Subpath KEYS are left untouched — only target VALUES are
 * paths.
 *
 * @param {unknown} node an exports value (string | object | array)
 * @returns {unknown}
 */
function rebaseExports(node) {
  if (typeof node === 'string') return rebaseDistPath(node);
  if (Array.isArray(node)) return node.map(rebaseExports);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = rebaseExports(v);
    return out;
  }
  return node;
}

/**
 * Rebase a `bin` field (string form or { name: path } map).
 *
 * Unlike `main`/`module`/`typings`/`exports` (rebased via {@link rebaseDistPath}
 * alone, which preserves a leading `./`), `bin` values ALSO get that leading
 * `./` stripped entirely. npm's publish-time bin validation rejects a `./`-
 * prefixed path outright — silently, with no error, just a warning naming the
 * wrong cause ("script name X was invalid and removed") and the bin entry
 * dropped from the published package. Confirmed empirically (npm 11.6.2,
 * isolated repro outside this repo): identical file, identical permissions,
 * only the leading `./` differs — `"./index.js"` stripped, `"index.js"` kept.
 *
 * @param {unknown} bin
 * @returns {unknown}
 */
function rebaseBin(bin) {
  const stripLeadingDotSlash = (v) => (typeof v === 'string' ? rebaseDistPath(v).replace(/^\.\//, '') : v);
  if (typeof bin === 'string') return stripLeadingDotSlash(bin);
  if (bin && typeof bin === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(bin)) out[k] = stripLeadingDotSlash(v);
    return out;
  }
  return bin;
}

/**
 * Resolve one dependency-collection object, rewriting every internal `@adhd/*`
 * entry to `^<version>` from the version map. External deps and internal deps
 * absent from the map (nothing to resolve against) are left exactly as-is.
 *
 * @param {Record<string,string>|undefined} coll
 * @param {Record<string,string>} versionMap  package name -> concrete version
 * @returns {Record<string,string>|undefined}
 */
function resolveInternalDeps(coll, versionMap) {
  if (!coll || typeof coll !== 'object') return coll;
  const out = {};
  for (const [name, range] of Object.entries(coll)) {
    if (name.startsWith('@adhd/') && versionMap[name]) {
      out[name] = `^${versionMap[name]}`;
    } else {
      out[name] = range;
    }
  }
  return out;
}

/**
 * Produce the dist-root publishable manifest from a source `package.json`.
 * Pure: does not read the filesystem, mutate its inputs, or write anything.
 *
 * @param {Record<string, any>} sourcePkg  the parsed source package.json
 * @param {Record<string, string>} versionMap  workspace pkg name -> version
 * @returns {Record<string, any>} the dist/package.json to write
 */
function generateDistManifest(sourcePkg, versionMap) {
  // Shallow clone, then override the specific fields we transform. Preserves
  // every other field (name, description, keywords, license, author,
  // repository, bugs, homepage, type, sideEffects, engines, publishConfig, …)
  // verbatim.
  const out = { ...sourcePkg };

  // (1) Rebase entry-point paths (dist becomes the package root).
  for (const field of ['main', 'module', 'browser', 'types', 'typings', 'unpkg', 'jsdelivr']) {
    if (out[field] != null) out[field] = rebaseDistPath(out[field]);
  }
  if (out.bin != null) out.bin = rebaseBin(out.bin);
  if (out.exports != null) out.exports = rebaseExports(out.exports);

  // (2) Resolve internal @adhd/* ranges to concrete caret versions.
  for (const coll of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    if (out[coll] != null) out[coll] = resolveInternalDeps(out[coll], versionMap);
  }

  // (3)+(4) Strip fields that must not ship / are wrong at dist root.
  delete out.devDependencies; // consumers never install these
  delete out.scripts; // build-time only; hazardous (lifecycle) once published
  delete out.nx; // nx project metadata, meaningless off-workspace
  delete out.files; // source allowlist ("dist", …) is wrong once dist is root

  return out;
}

const { existsSync: _existsSync, readFileSync: _readFileSync, writeFileSync: _writeFileSync, copyFileSync: _copyFileSync } = require('node:fs');
const { join: _join } = require('node:path');

/**
 * Build `{ "@adhd/x": "1.2.3", … }` from every project's CURRENT source
 * package.json — a live workspace version snapshot, independent of nx's
 * project-graph cache (which is computed once up front and can go stale
 * mid-run if a sibling's own `version` task already bumped it — see
 * `reconcileInternalRangesFromDisk`'s doc comment in `../version/impl.js` for
 * the identical staleness concern this addresses for a different consumer).
 *
 * @param {import('@nx/devkit').ExecutorContext} context
 * @returns {Record<string,string>}
 */
function buildVersionMapFromDisk(context) {
  const map = {};
  for (const cfg of Object.values(context.projectsConfigurations?.projects || {})) {
    const pkgPath = _join(context.root, cfg.root, 'package.json');
    if (!_existsSync(pkgPath)) continue;
    try {
      const pkg = JSON.parse(_readFileSync(pkgPath, 'utf8'));
      if (pkg.name && pkg.version) map[pkg.name] = pkg.version;
    } catch {
      // malformed sibling manifest — skip, leave whatever range was authored
    }
  }
  return map;
}

/**
 * Write the resolved dist-root manifest (+ CHANGELOG.md) to `{distDir}/package.json`,
 * from the CURRENT source `package.json` and a live workspace version snapshot.
 * The single, shared side-effecting entry point — `dist-manifest`, `version`,
 * and `publish` all call THIS (never their own copy) so there is exactly one
 * place that materializes a dist manifest to disk.
 *
 * WHY EVERY CALLER NEEDS THIS, NOT JUST `dist-manifest`
 * (BUG-BUILD-PUBLISH-DISTMANIFEST-CLOBBERED-001): `dist-manifest` is a sibling
 * of `build`/`test`/`version` in the `publish` task's `dependsOn` — nx
 * guarantees all of them complete before `publish` runs, but NOT any relative
 * order AMONG them. `@nx/js:tsc`'s `build` (with `clean:true`) unconditionally
 * (re)writes its OWN minimal, un-rebased `dist/package.json` as a build
 * output; if that happens to (re)materialize AFTER `dist-manifest` already
 * ran once in the same or an earlier invocation, it silently clobbers the
 * rebase — producing a `"files": ["dist", …]` manifest inside `dist/` itself
 * (a self-referential allowlist matching nothing) that packs to a 1-file,
 * `package.json`-only tarball (observed live: `agent-engine-compiler@2.1.7`/
 * `2.1.8`). Both `version` (which hashes `distDir` to decide bump/no-bump)
 * and `publish` (which packs `distDir`) read this SAME potentially-clobbered
 * directory, so both must re-stamp it as their own truly-last write before
 * they trust its content — re-stamping only inside `dist-manifest` is
 * necessary but not sufficient, since nothing stops `build` running again
 * afterward within the same overall release pass.
 *
 * ALSO re-runs `@adhd/nx-assets:copy` (README.md/CHANGELOG.md/`drizzle`/
 * package.json-declared assets + bin chmod) as part of the SAME re-stamp
 * (BUG-BUILD-ASSETS-CACHE-STALE-AFTER-CLEAN-001): `assets` is nx-cached
 * (`cache: true`) independently of `build`'s own `clean:true` wipe of the
 * SHARED `dist/` directory it writes into — nx's cache-hit decision for
 * `assets` is keyed on `assets`'s own inputs (unchanged), not on whether
 * `build` physically re-executed and deleted the directory `assets` last
 * wrote into. Reproduced live: a fresh `build` (real recompile) followed by
 * an `assets` "existing outputs match the cache, left as is" skip left
 * `dist/README.md` permanently missing — which, hashed via `normalizedHash`,
 * differs from the published tarball (which DOES have README.md) and
 * produces an unbounded "changed" / re-bump loop with ZERO real code
 * changes (observed live: agent-store-tools re-bumping 2.1.7 -> 2.1.8 ->
 * 2.1.9 -> … on every single `version`/`publish` invocation). Re-running the
 * real `assets` executor here — never a reimplementation — makes both bugs'
 * fix share one call site: dist is guaranteed complete AND correctly
 * manifested immediately before it's hashed or packed, regardless of what
 * nx's own cache decided about `build`/`assets` earlier in the same pass.
 *
 * @param {import('@nx/devkit').ExecutorContext} context
 * @param {string} pkgRoot absolute source project root
 * @param {string} distDir absolute {projectRoot}/dist
 * @returns {Promise<Record<string, any>>} the manifest that was written
 */
async function writeDistManifest(context, pkgRoot, distDir) {
  // eslint-disable-next-line global-require -- lazy require avoids a
  // module-load-order dependency between the assets and build nx plugins.
  const assetsCopy = require('../../../assets/executors/copy/impl');
  const assetsResult = await assetsCopy({}, context);
  if (!assetsResult || assetsResult.success === false) {
    throw new Error(`writeDistManifest: assets re-copy failed for ${context.projectName} — see assets-copy output above.`);
  }
  const sourcePkg = JSON.parse(_readFileSync(_join(pkgRoot, 'package.json'), 'utf8'));
  const versionMap = buildVersionMapFromDisk(context);
  const manifest = generateDistManifest(sourcePkg, versionMap);
  _writeFileSync(_join(distDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  const srcChangelog = _join(pkgRoot, 'CHANGELOG.md');
  if (_existsSync(srcChangelog)) _copyFileSync(srcChangelog, _join(distDir, 'CHANGELOG.md'));
  return manifest;
}

module.exports = {
  generateDistManifest,
  rebaseDistPath,
  rebaseExports,
  rebaseBin,
  resolveInternalDeps,
  buildVersionMapFromDisk,
  writeDistManifest,
};
