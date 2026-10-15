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
 * here restores the invalidation for exactly the declaring project.
 *
 * SCOPE
 * - Reads only `<workspaceRoot>/<projectRoot>/package.json`. It never writes, and
 *   it never reads the lockfile (adding the lockfile as an input would re-run
 *   every project's lint on any dependency bump anywhere in the workspace).
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
const { join } = require('node:path');

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
 * Return the sorted, de-duplicated npm dependency names that a project declares
 * in its own `package.json`, for use as the `externalDependencies` cache input
 * of that project's targets.
 *
 * A project with no `package.json` declares nothing and yields `[]`. A
 * `package.json` that exists but is not valid JSON, or whose top level is not
 * a plain object, throws, naming the file: a silently empty list would
 * reintroduce the stale-cache defect this helper exists to prevent.
 *
 * @param {string} projectRoot Workspace-relative project directory (POSIX form, e.g. `packages/x/y`), as Nx's `createNodes` hands it.
 * @param {string} workspaceRoot Absolute workspace root (`ctx.workspaceRoot`).
 * @returns {string[]} Sorted unique names from `dependencies`, `devDependencies`,
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

  const names = new Set();
  for (const field of DEPENDENCY_FIELDS) {
    const block = manifest[field];
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    for (const name of Object.keys(block)) {
      if (name.startsWith(WORKSPACE_SCOPE_PREFIX)) continue;
      if (ALWAYS_LISTED_BY_CALLER.has(name)) continue;
      names.add(name);
    }
  }
  return [...names].sort();
}

module.exports = { declaredExternalDeps, DEPENDENCY_FIELDS };
