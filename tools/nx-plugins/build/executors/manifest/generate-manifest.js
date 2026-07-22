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
 * @param {unknown} bin
 * @returns {unknown}
 */
function rebaseBin(bin) {
  if (typeof bin === 'string') return rebaseDistPath(bin);
  if (bin && typeof bin === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(bin)) out[k] = rebaseDistPath(v);
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

module.exports = {
  generateDistManifest,
  rebaseDistPath,
  rebaseExports,
  rebaseBin,
  resolveInternalDeps,
};
