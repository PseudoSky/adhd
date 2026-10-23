'use strict';
/**
 * declared-external-deps.js — the one canonical list of a project's own
 * declared npm dependencies, for Nx cache inputs (fbbb1464).
 *
 * WHY THIS EXISTS
 * A target that declares `{ externalDependencies: [...] }` REPLACES Nx's default
 * hashing of installed external dependency versions for that target, and Nx
 * then only hashes the listed names plus the npm packages the project's source
 * imports. A declared dependency that is neither listed nor imported by source
 * (a runtime-loaded or bundled-only dep, or a range check against a hoisted
 * version) therefore never invalidates the cache. Listing every declared name
 * here restores the invalidation for exactly the declaring project. Only names
 * that are installed are listed, so the list never names a package with no
 * installed version.
 *
 * SCOPE
 * - Reads `<workspaceRoot>/<projectRoot>/package.json`, and checks for
 *   `node_modules/<name>/package.json` on the path from the project up to the
 *   workspace root. It never writes, and it never reads the lockfile (adding the
 *   lockfile as an input would re-run every project's lint on any dependency
 *   bump anywhere in the workspace).
 * - Excludes `@adhd/*` names: workspace siblings are project-graph inputs and
 *   are already covered by the `^production` input.
 * - Excludes `eslint`: callers always list `eslint` themselves, so it is never
 *   duplicated.
 *
 * Plain CommonJS with zero dependencies beyond `node:fs` and `node:path`. It
 * runs inside Nx's `createNodes` graph-construction pass, which runs before any
 * project is built, so it must not depend on a package whose `dist/` must exist
 * first.
 */
const { existsSync, readFileSync } = require('node:fs');
const { dirname, join, relative, resolve, isAbsolute } = require('node:path');

/** The manifest fields whose keys are installed npm dependencies. */
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

/** Workspace-scoped names: already covered by the `^production` input. */
const WORKSPACE_SCOPE_PREFIX = '@adhd/';

/** Names excluded here because each caller always lists them itself. */
const ALWAYS_LISTED_BY_CALLER = new Set(['eslint']);

/**
 * Report whether a package is installed where Node's module resolution would
 * find it from the project directory: `<dir>/node_modules/<name>/package.json`
 * exists for some `dir` on the path from `projectDir` up to `workspaceRoot`,
 * both ends inclusive. This covers pnpm's per-project `node_modules` links and
 * hoisted root installs. Nothing outside the workspace is searched.
 *
 * It checks for the manifest file directly rather than calling
 * `require.resolve`, because a package whose `exports` map omits
 * `./package.json` is installed but would not resolve that way.
 *
 * @param {string} name npm package name (may be scoped, e.g. `@types/node`).
 * @param {string} projectDir Absolute project directory (search starts here).
 * @param {string} workspaceRoot Absolute workspace root (search stops here).
 * @returns {boolean} `true` when the package is installed and resolvable from the project.
 */
function isInstalledFromProject(name, projectDir, workspaceRoot) {
  const ws = resolve(workspaceRoot);
  const start = resolve(projectDir);
  const rel = relative(ws, start);
  // A project directory outside the workspace is searched from the workspace root only.
  const insideWorkspace = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  let dir = insideWorkspace ? start : ws;
  for (;;) {
    if (existsSync(join(dir, 'node_modules', name, 'package.json'))) return true;
    if (dir === ws) return false;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Return the sorted, de-duplicated npm dependency names that a project declares
 * in its own `package.json` and that are installed in the workspace, for use as
 * the `externalDependencies` cache input of that project's targets.
 *
 * RULE: a name is emitted only if `isInstalledFromProject` finds it, i.e.
 * Node can resolve its `package.json` from the project directory up to the
 * workspace root. A declared name that is not installed (a missing optional
 * peer, a manifest ahead of `pnpm install`) is dropped, not emitted, so the
 * list never names a package that has no installed version to hash. Installed
 * names, peers included, are always emitted. (fbbb1464 D3(i): this filter is
 * applied unconditionally rather than after an Nx probe; the probe is not yet
 * run, so the filter is the safe path whether or not Nx tolerates a missing name.)
 *
 * A project with no `package.json` declares nothing and yields `[]`. A
 * `package.json` that exists but is not valid JSON, or whose top level is not
 * a plain object, throws, naming the file: a silently empty list would
 * reintroduce the stale-cache defect this helper exists to prevent.
 *
 * @param {string} projectRoot Workspace-relative project directory (POSIX form, e.g. `packages/x/y`), as Nx's `createNodes` hands it.
 * @param {string} workspaceRoot Absolute workspace root (`ctx.workspaceRoot`).
 * @returns {string[]} Sorted unique installed names from `dependencies`, `devDependencies`,
 *   `peerDependencies` and `optionalDependencies`, excluding `@adhd/*` and `eslint`.
 * @throws {Error} When the project's `package.json` exists but does not parse as
 *   JSON, or parses to something other than a plain object (`null`, an array, a
 *   number or a string). The error message names the file.
 */
function declaredExternalDeps(projectRoot, workspaceRoot) {
  const manifestPath = join(workspaceRoot, projectRoot, 'package.json');
  if (!existsSync(manifestPath)) return [];

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new Error(
      `declaredExternalDeps: cannot parse ${manifestPath}: ${err.message}`,
    );
  }

  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(
      `declaredExternalDeps: ${manifestPath} is not a JSON object`,
    );
  }

  const projectDir = join(workspaceRoot, projectRoot);
  const names = new Set();
  for (const field of DEPENDENCY_FIELDS) {
    const block = manifest[field];
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    for (const name of Object.keys(block)) {
      if (name.startsWith(WORKSPACE_SCOPE_PREFIX)) continue;
      if (ALWAYS_LISTED_BY_CALLER.has(name)) continue;
      if (!isInstalledFromProject(name, projectDir, workspaceRoot)) continue;
      names.add(name);
    }
  }
  return [...names].sort();
}

module.exports = { declaredExternalDeps, isInstalledFromProject, DEPENDENCY_FIELDS };
