'use strict';
/**
 * range-resolvability.js — GATE 1 core: pre-publish range-resolvability check
 * (BUG-RELEASE-UNINSTALLABLE-AGENTMCP-001).
 *
 * THE FAILURE THIS PREVENTS
 * --------------------------
 * A coordinated multi-package publish shipped intra-`@adhd/*` dependency
 * RANGES pointing at versions that were never actually published. Live,
 * confirmed example (2026-07-22): `@adhd/agent-engine-compiler@2.1.6` and
 * `@adhd/agent-mcp@2.1.4` both declare `"@adhd/agent-store-tools": "^2.1.7"`,
 * but at the time they were published the max published `agent-store-tools`
 * was `2.1.6` — `npm install @adhd/agent-mcp@2.1.4` dies with `ETARGET`
 * (no version of `agent-store-tools` in the `^2.1.7` range exists on the
 * registry). The package is permanently uninstallable at that version (npm
 * does not allow silently rewriting a published version's manifest).
 *
 * WHY EVERY EXISTING GATE MISSED IT
 * -----------------------------------
 * `dist-manifest` (`executors/manifest/generate-manifest.js`) resolves every
 * internal `@adhd/*` range to `^<version>` from a LIVE ON-DISK SNAPSHOT of
 * every workspace package's SOURCE `package.json` version — deliberately, so
 * ordering doesn't matter (see that file's header). But "on disk" and
 * "published" are two different facts: a sibling's `version` task can bump
 * its source `package.json` to `2.1.7` (intending to publish it this run)
 * while that sibling's OWN `publish` task never actually succeeds (a
 * transient npm failure, a hygiene-gate failure, a network blip, or simply
 * `nx run-many -t publish --projects=<subset>` excluding it). Nx's `publish`
 * target `dependsOn` chain (`plugin.js`) ties a project's publish to its own
 * `test`/`version`/`dist-manifest`/`verify-dist-load`/`publish-hygiene` —
 * NEVER to its internal dependencies' `publish` tasks having succeeded. So
 * package B can publish successfully referencing package A's about-to-be
 * on-disk version, even though A's publish independently failed or never ran.
 * `verify-dist-load` then loads B's dist via the LOCAL pnpm-linked
 * `node_modules/@adhd/A` symlink (real content, whatever's on disk) — it can
 * never observe that the REGISTRY doesn't have that version of A.
 * `@nx/dependency-checks`/`sync-deps` compare a declared range against Nx's
 * own project graph (i.e. the same on-disk siblings) — again never the
 * registry. Every one of these gates is a LOCAL-workspace-consistency check;
 * none of them ever perform a clean-room `npm install` of the ranges that
 * are about to leave the workspace. This module is that missing check, run
 * BEFORE any package in the release actually hits the registry.
 *
 * THE ALGORITHM (offline, O(unique @adhd/* dependency names) network calls)
 * ---------------------------------------------------------------------------
 * 1. Discover the release set: every publishable project's CURRENT on-disk
 *    `{name, version, internal-@adhd/*-dependency-ranges}` — mirrors
 *    `plugin.js`'s own `hasBuildTarget && isPublishable` detection, so this
 *    checks exactly the set `nx run-many -t publish` would attempt.
 * 2. Collect the distinct `@adhd/*` dependency NAMES referenced anywhere in
 *    that release set (not every edge — one fetch per unique NAME).
 * 3. Fetch each name's published version list from the registry ONCE, in
 *    parallel (see `fetchRegistryVersions`) — the only network in this gate.
 * 4. For every `<project> -> <dependency>@"<range>"` edge, compute the
 *    resolvable set = {registry-published versions of <dependency>} UNION
 *    {<dependency>'s own about-to-publish version, IF <dependency> is also
 *    in this release set}. If NO version in that union satisfies `<range>`,
 *    it's a violation — this is EXACTLY the dangling-edge shape that shipped
 *    live: `agent-store-tools` was never re-published in that release with a
 *    high-enough version, so the union stayed capped at `2.1.6`, `^2.1.7`
 *    matched nothing, and the check would have failed loudly, before
 *    anything touched the registry.
 *
 * All of this is pure, dependency-free (no external `semver` package — this
 * workspace only ever uses plain `MAJOR.MINOR.PATCH` exact/`^`/`~`/`*` ranges;
 * see `compare-published.js`'s `bumpVersion` for the same plain-semver
 * assumption already made elsewhere in this plugin) and injectable for tests
 * (`fetchVersions`/`registryVersions` are always passed in, never resolved
 * internally by the pure `checkRangeResolvability`).
 *
 * @module range-resolvability
 */
const { existsSync, readFileSync, readdirSync, statSync } = require('node:fs');
const { join, dirname } = require('node:path');
const { hasBuildTarget, isPublishable } = require('../detect-target');

const INTERNAL_SCOPE = '@adhd/';
const DEP_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'];
const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', 'tmp']);

// ---------------------------------------------------------------------------
// Minimal, dependency-free semver (plain MAJOR.MINOR.PATCH only — matches
// every range shape actually used in this workspace: exact pin, "^x.y.z",
// "~x.y.z", or the bare wildcard "*"/"").
// ---------------------------------------------------------------------------

/** @param {string} v @returns {[number,number,number]|null} */
function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** @param {[number,number,number]} a @param {[number,number,number]} b @returns {number} */
function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Does `version` satisfy `range`? Supports exactly the range shapes this
 * workspace declares (verified empirically against every internal `@adhd/*`
 * dependency range in the repo): bare exact pin (`"2.1.0"`), caret (`"^2.1.0"`),
 * tilde (`"~2.1.0"`), and the wildcard (`"*"` or `""`). Anything else is
 * treated as UNSUPPORTED and never silently matches (fail loud, not open).
 *
 * @param {string} version
 * @param {string} range
 * @returns {boolean}
 */
function satisfiesRange(version, range) {
  const v = parseVersion(version);
  if (!v) return false;
  const r = String(range ?? '').trim();
  if (r === '*' || r === '') return true;
  if (r.startsWith('^')) {
    const base = parseVersion(r.slice(1));
    if (!base) return false;
    return v[0] === base[0] && compareVersions(v, base) >= 0;
  }
  if (r.startsWith('~')) {
    const base = parseVersion(r.slice(1));
    if (!base) return false;
    return v[0] === base[0] && v[1] === base[1] && compareVersions(v, base) >= 0;
  }
  const base = parseVersion(r);
  if (!base) return false;
  return compareVersions(v, base) === 0;
}

/**
 * The highest version in `versions` that satisfies `range`, or `null` if none does.
 * @param {string[]} versions
 * @param {string} range
 * @returns {string|null}
 */
function maxSatisfying(versions, range) {
  let best = null;
  let bestParsed = null;
  for (const v of versions) {
    if (!satisfiesRange(v, range)) continue;
    const parsed = parseVersion(v);
    if (!parsed) continue;
    if (best === null || compareVersions(parsed, bestParsed) > 0) {
      best = v;
      bestParsed = parsed;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Release-set discovery (filesystem only — no nx project-graph load needed;
// mirrors plugin.js's own publishable-project detection exactly).
// ---------------------------------------------------------------------------

/**
 * Recursively find every `package.json` under `packages/` and `entrypoint/`,
 * skipping `node_modules`/`dist`/`tmp` at any depth (mirrors `plugin.js`'s
 * `skip()`).
 *
 * @param {string} workspaceRoot
 * @returns {string[]} workspace-root-relative posix paths to package.json files
 */
function findCandidatePackageJsons(workspaceRoot) {
  const results = [];
  const walk = (absDir) => {
    let entries;
    try {
      entries = readdirSync(absDir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (SKIP_DIR_NAMES.has(name)) continue;
      const abs = join(absDir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(abs);
      } else if (name === 'package.json') {
        results.push(abs.slice(workspaceRoot.length + 1).split('\\').join('/'));
      }
    }
  };
  for (const base of ['packages', 'entrypoint']) {
    const baseDir = join(workspaceRoot, base);
    if (existsSync(baseDir)) walk(baseDir);
  }
  return results;
}

/**
 * @typedef {{ field: string, depName: string, range: string }} InternalDepEdge
 * @typedef {{ projectRoot: string, name: string, version: string, deps: InternalDepEdge[] }} ReleaseProject
 */

/**
 * Discover every publishable project's CURRENT on-disk `{name, version,
 * internal-@adhd/*-deps}` — the exact set (and exact source-of-truth ranges)
 * that `nx run-many -t publish` is about to attempt.
 *
 * @param {string} workspaceRoot
 * @returns {ReleaseProject[]}
 */
function discoverReleaseSet(workspaceRoot) {
  const projects = [];
  for (const pkgJsonRel of findCandidatePackageJsons(workspaceRoot)) {
    const projectRoot = dirname(pkgJsonRel);
    if (!existsSync(join(workspaceRoot, projectRoot, 'project.json'))) continue;
    if (!hasBuildTarget(workspaceRoot, projectRoot)) continue;
    if (!isPublishable(workspaceRoot, projectRoot)) continue;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(workspaceRoot, pkgJsonRel), 'utf8'));
    } catch {
      continue;
    }
    if (!pkg.name || !pkg.version) continue;
    const deps = [];
    for (const field of DEP_FIELDS) {
      const coll = pkg[field];
      if (!coll || typeof coll !== 'object') continue;
      for (const [depName, range] of Object.entries(coll)) {
        if (depName.startsWith(INTERNAL_SCOPE)) deps.push({ field, depName, range });
      }
    }
    projects.push({ projectRoot, name: pkg.name, version: pkg.version, deps });
  }
  return projects;
}

/**
 * The distinct `@adhd/*` dependency names referenced anywhere in `releaseSet`
 * — the exact, minimal set of packages to fetch registry versions for (one
 * network call per unique name, never per edge).
 *
 * @param {ReleaseProject[]} releaseSet
 * @returns {string[]}
 */
function collectDependencyNames(releaseSet) {
  const names = new Set();
  for (const project of releaseSet) {
    for (const dep of project.deps) names.add(dep.depName);
  }
  return Array.from(names);
}

// ---------------------------------------------------------------------------
// The pure check.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} RangeViolation
 * @property {string} project        the DEPENDENT package's npm name
 * @property {string} projectRoot
 * @property {string} field          which manifest field declared the range
 * @property {string} dependency     the internal @adhd/* package name
 * @property {string} range          the declared range, e.g. "^2.1.7"
 * @property {string[]} registryVersions  what the registry has published for `dependency`
 * @property {string|null} pendingVersion  `dependency`'s own about-to-publish version, if it's also in this release
 * @property {string[]} availableVersions  registryVersions ∪ {pendingVersion}
 */

/**
 * The core, pure gate: for every intra-`@adhd/*` dependency edge in
 * `releaseSet`, assert the declared range resolves against {registry-published
 * versions} ∪ {this release's own about-to-publish versions}.
 *
 * @param {ReleaseProject[]} releaseSet
 * @param {Map<string,string[]>} registryVersions  dependency name -> published versions (pre-fetched)
 * @returns {{ ok: boolean, violations: RangeViolation[] }}
 */
function checkRangeResolvability(releaseSet, registryVersions) {
  const aboutToPublish = new Map(releaseSet.map((p) => [p.name, p.version]));
  const violations = [];
  for (const project of releaseSet) {
    for (const { field, depName, range } of project.deps) {
      const registryList = registryVersions.get(depName) || [];
      const pendingVersion = aboutToPublish.has(depName) ? aboutToPublish.get(depName) : null;
      const availableSet = new Set(registryList);
      if (pendingVersion) availableSet.add(pendingVersion);
      const availableVersions = Array.from(availableSet);
      const resolved = maxSatisfying(availableVersions, range);
      if (!resolved) {
        violations.push({
          project: project.name,
          projectRoot: project.projectRoot,
          field,
          dependency: depName,
          range,
          registryVersions: registryList,
          pendingVersion,
          availableVersions,
        });
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Human-readable, one-line description of a single violation — names the
 * exact bad edge (dependent, dependency, declared range) and exactly why
 * nothing satisfies it, so a failing gate is immediately actionable.
 *
 * @param {RangeViolation} v
 * @returns {string}
 */
function formatViolation(v) {
  const registryPart = v.registryVersions.length
    ? `registry has [${v.registryVersions.join(', ')}]`
    : 'registry has published NOTHING for this package';
  const pendingPart = v.pendingVersion
    ? `this release will also publish ${v.dependency}@${v.pendingVersion}`
    : `this release does NOT publish ${v.dependency}`;
  return (
    `${v.project} declares "${v.dependency}": "${v.range}" (${v.field}) — UNRESOLVABLE: ` +
    `${registryPart}; ${pendingPart}; no available version satisfies "${v.range}".`
  );
}

// ---------------------------------------------------------------------------
// Registry fetch — the ONLY network in this gate. One HTTP GET per UNIQUE
// dependency name, run with bounded parallelism (never per-edge, never
// serial). Deliberately independent of `lib/npm-registry.js`'s
// `publishedVersions` (which shells out to `npm view` — fine for the
// low-frequency version/publish tasks, but here we may need dozens of names
// in one gate run and a raw registry GET is both faster and trivially
// parallelizable without spawning a process per name).
// ---------------------------------------------------------------------------

/**
 * Fetch the published version list for `name` from the npm registry.
 * `[]` on any failure (404 — never published, network error, malformed
 * response) — a package genuinely never published is a valid, expected input
 * to {@link checkRangeResolvability} (it just means the ONLY way its range
 * can resolve is via `pendingVersion`, i.e. this same release publishing it).
 *
 * @param {string} name
 * @param {{ registryUrl: string, fetchImpl: typeof fetch }} opts
 * @returns {Promise<string[]>}
 */
async function fetchOneRegistryVersionList(name, { registryUrl, fetchImpl }) {
  try {
    const res = await fetchImpl(`${registryUrl}/${encodeURIComponent(name)}`, {
      headers: { Accept: 'application/vnd.npm.install-v1+json' },
    });
    if (!res.ok) return [];
    const json = await res.json();
    return json && json.versions && typeof json.versions === 'object' ? Object.keys(json.versions) : [];
  } catch {
    return [];
  }
}

/**
 * Batch-fetch published version lists for `names` — ONE network call per
 * unique name (deduped), bounded parallelism, never serial and never per-edge.
 *
 * @param {string[]} names
 * @param {{ registryUrl?: string, fetchImpl?: typeof fetch, concurrency?: number }} [opts]
 * @returns {Promise<Map<string,string[]>>}
 */
async function fetchRegistryVersions(names, opts = {}) {
  const registryUrl = opts.registryUrl || process.env.ADHD_NPM_REGISTRY || 'https://registry.npmjs.org';
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const concurrency = Math.max(1, opts.concurrency || 8);
  const uniqueNames = Array.from(new Set(names));
  const out = new Map();
  let cursor = 0;
  async function worker() {
    for (;;) {
      const idx = cursor++;
      if (idx >= uniqueNames.length) return;
      const name = uniqueNames[idx];
      out.set(name, await fetchOneRegistryVersionList(name, { registryUrl, fetchImpl }));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, uniqueNames.length) }, worker));
  return out;
}

module.exports = {
  // semver
  parseVersion,
  compareVersions,
  satisfiesRange,
  maxSatisfying,
  // discovery
  findCandidatePackageJsons,
  discoverReleaseSet,
  collectDependencyNames,
  // the gate
  checkRangeResolvability,
  formatViolation,
  // network
  fetchOneRegistryVersionList,
  fetchRegistryVersions,
};
