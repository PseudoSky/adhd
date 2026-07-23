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
 * NORMALIZED-CONTENT HASH (`normalizedHash`, PUBLISHED-STATE-CACHE-001):
 * `comparePublishedToLocal` above needs BOTH directories materialized on disk
 * (it was built for the tarball-fetch world). The committed `published-state.json`
 * cache instead stores a single `sha256` digest per package — `normalizedHash`
 * feeds the EXACT SAME `normalizeManifest`/`listFiles`/`stableStringify`
 * primitives above into one incremental hash, so two directories hash equal
 * if and only if `comparePublishedToLocal` between them reports `changed:
 * false` (proven both directions, including the range-only and real-content
 * cases, in compare-published.spec.mjs's "normalizedHash equivalence" suite).
 * This is what lets `version`/`reconcile` compare a freshly built local
 * `dist/` against a cached PUBLISHED hash with zero network and zero
 * temporary tarball extraction on the happy path.
 *
 * @module compare-published
 */
const { readFileSync, readdirSync, statSync, existsSync } = require('node:fs');
const { createHash } = require('node:crypto');
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
 * Deterministic `sha256:<hex>` digest of a dist (or extracted published
 * package) directory's NORMALIZED content — the single signal the
 * `published-state.json` cache stores per package.
 *
 * Fed into one incremental hash, in this exact order:
 *   1. `stableStringify(normalizeManifest(package.json))`
 *   2. every OTHER file from `listFiles(dir)` (already sorted), each as
 *      `"<relpath>\0<raw bytes>\0"` — the NUL delimiters make a
 *      `path:'ab', content:'c'` pair unable to collide with `path:'a',
 *      content:'bc'` (no real file path in this workspace's dist output
 *      ever contains a NUL byte, so this is a pure safety margin, not a
 *      real ambiguity that has been observed).
 *
 * Equivalence to `comparePublishedToLocal`: two directories feed IDENTICAL
 * byte sequences into this hash if and only if (a) their normalized
 * manifests stringify identically AND (b) they contain the exact same set
 * of non-manifest files with byte-identical content — which is exactly the
 * condition under which `comparePublishedToLocal(A, B).changed === false`
 * above. See compare-published.spec.mjs for the proof (both directions,
 * incl. the range-only-differs and real-code-differs cases).
 *
 * @param {string} dir a dist root, or an extracted published package root
 * @returns {string} `sha256:<hex>`
 */
function normalizedHash(dir) {
  const hash = createHash('sha256');
  const files = listFiles(dir);
  const manifestPath = join(dir, 'package.json');
  const manifestJson = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
  hash.update(stableStringify(normalizeManifest(manifestJson)));
  hash.update('\0');
  for (const f of files) {
    if (f === 'package.json') continue;
    hash.update(f);
    hash.update('\0');
    hash.update(readFileSync(join(dir, f)));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
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

module.exports = { comparePublishedToLocal, normalizeManifest, bumpVersion, listFiles, normalizedHash };
