'use strict';
/**
 * compare-published.js — the pure change-detection core of `@adhd/nx-build:version`.
 *
 * Decides whether a package's freshly-built `dist/` differs, in a way that
 * warrants a new release, from the tarball currently published at its version.
 * This is how the version task answers "did this package actually change?"
 * WITHOUT git tags or a diff base — the registry artifact IS the baseline,
 * consistent with the repo's "npm registry is the source of truth" model.
 *
 * NORMALIZATION (what does NOT count as a change):
 *   - `package.json` `version` — always equal at compare time; never a signal.
 *   - internal `@adhd/*` dependency RANGES — `dist-manifest` resolves these to
 *     the concrete current version of each sibling, so a *dependency's* version
 *     moving would otherwise make every dependent's manifest differ and cascade
 *     a bump through the whole graph. Caret ranges already absorb a dependency's
 *     patch/minor bump at install time, so a dependent does NOT need to
 *     republish for that. We therefore strip `@adhd/*` entries from both sides
 *     before comparing — a package bumps only when ITS OWN code (or external
 *     deps / other metadata) changed. (A major dependency bump that breaks a
 *     published range is a deliberate, human-driven concern, not auto-cascade.)
 *
 * Everything else — emitted JS/`.d.ts`/maps, external dependencies, name,
 * bin/exports/main, description, license, added/removed files — counts.
 *
 * @module compare-published
 */
const { readFileSync, readdirSync, statSync, existsSync } = require('node:fs');
const { join, relative } = require('node:path');

/** Recursively list files under `dir`, relative to it (sorted, posix-ish). */
function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      const abs = join(d, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else out.push(relative(dir, abs).split('\\').join('/'));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

/** Strip release-noise (own version, internal @adhd/* dep ranges) from a manifest. */
function normalizeManifest(json) {
  const p = { ...json };
  delete p.version;
  for (const coll of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies']) {
    if (!p[coll]) continue;
    const filtered = {};
    for (const [k, v] of Object.entries(p[coll])) {
      if (!k.startsWith('@adhd/')) filtered[k] = v;
    }
    p[coll] = filtered;
  }
  return p;
}

/** Stable stringify (sorted keys) for order-insensitive manifest comparison. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

/**
 * Compare a locally-built dist directory against an extracted published package
 * directory (npm tarballs extract to `<root>/package/…`).
 *
 * @param {string} localDistDir  the freshly built {projectRoot}/dist
 * @param {string} publishedDir  the extracted published package dir (its own root — the one holding package.json)
 * @returns {{changed: boolean, reasons: string[]}}
 */
function comparePublishedToLocal(localDistDir, publishedDir) {
  const reasons = [];
  const localFiles = listFiles(localDistDir);
  const pubFiles = listFiles(publishedDir);

  const localSet = new Set(localFiles);
  const pubSet = new Set(pubFiles);
  for (const f of localFiles) if (!pubSet.has(f)) reasons.push(`added: ${f}`);
  for (const f of pubFiles) if (!localSet.has(f)) reasons.push(`removed: ${f}`);

  for (const f of localFiles) {
    if (!pubSet.has(f)) continue; // already flagged as added
    const localAbs = join(localDistDir, f);
    const pubAbs = join(publishedDir, f);
    if (f === 'package.json') {
      const a = stableStringify(normalizeManifest(JSON.parse(readFileSync(localAbs, 'utf8'))));
      const b = stableStringify(normalizeManifest(JSON.parse(readFileSync(pubAbs, 'utf8'))));
      if (a !== b) reasons.push('package.json (excluding version + internal @adhd/* ranges) differs');
    } else {
      if (!readFileSync(localAbs).equals(readFileSync(pubAbs))) reasons.push(`content differs: ${f}`);
    }
  }

  return { changed: reasons.length > 0, reasons };
}

/**
 * Bump a plain `MAJOR.MINOR.PATCH` version. Prerelease/build metadata is not
 * supported (this workspace uses plain semver); throws on anything else so a
 * malformed version fails loudly rather than silently mis-bumping.
 *
 * @param {string} version
 * @param {'patch'|'minor'|'major'} level
 * @returns {string}
 */
function bumpVersion(version, level) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new Error(`bumpVersion: unsupported version '${version}' (expected MAJOR.MINOR.PATCH)`);
  let [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (level === 'major') { major += 1; minor = 0; patch = 0; }
  else if (level === 'minor') { minor += 1; patch = 0; }
  else patch += 1;
  return `${major}.${minor}.${patch}`;
}

module.exports = { comparePublishedToLocal, normalizeManifest, bumpVersion, listFiles };
