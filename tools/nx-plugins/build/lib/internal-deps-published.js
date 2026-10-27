'use strict';
/**
 * internal-deps-published.js — the per-package form of the ordering guarantee the `publish → <dep>:publish` graph
 * edge used to give (BUG-RELEASE-ATOMICITY-DEP-RANGE-AHEAD-OF-TARGET-PUBLISH-001).
 *
 * Before a package is published, every internal `@adhd/*` dependency range in its dist manifest must be satisfied
 * by a version `published-state.json` records as on the registry. A dependent whose range points at a version that
 * is not yet published is refused, whatever order the caller ran things in, instead of shipping an uninstallable
 * package. Zero network: `publish` writes the state through after each confirmed publish, so a dependency
 * published earlier in the same run is already visible here.
 */
const semver = require('semver');

const FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'];
const SCOPE = '@adhd/';

/**
 * @param {{ dependencies?: object, peerDependencies?: object, optionalDependencies?: object }} manifest dist manifest
 * @param {Record<string, {version?: string}>} state published-state.json contents
 * @returns {Array<{ field: string, dep: string, range: string, published: string|null }>} unsatisfied internal ranges
 */
function unpublishedInternalDeps(manifest, state) {
  const out = [];
  for (const field of FIELDS) {
    for (const [dep, range] of Object.entries((manifest && manifest[field]) || {})) {
      if (!dep.startsWith(SCOPE)) continue;
      const published = state && state[dep] && state[dep].version ? state[dep].version : null;
      // `workspace:` and wildcard ranges carry no ordering requirement; anything else must be satisfied.
      if (typeof range !== 'string' || range === '*' || range === '' || range.startsWith('workspace:')) continue;
      if (!published || !semver.satisfies(published, range, { includePrerelease: true })) {
        out.push({ field, dep, range, published });
      }
    }
  }
  return out;
}

/** One-line operator message naming each unsatisfied range and the fix. */
function formatUnpublished(name, version, missing) {
  const lines = missing.map(
    (m) => `  ${m.field}.${m.dep} ${m.range} — registry has ${m.published ? m.published : 'no recorded version'}`
  );
  return (
    `publish: refusing ${name}@${version}: ${missing.length} internal range(s) are ahead of what is published ` +
    `(BUG-RELEASE-ATOMICITY-DEP-RANGE-AHEAD-OF-TARGET-PUBLISH-001):\n${lines.join('\n')}\n` +
    `Publish the dependency first (dependency-first order is what \`pnpm release\` runs), then re-run this publish.`
  );
}

module.exports = { unpublishedInternalDeps, formatUnpublished };
