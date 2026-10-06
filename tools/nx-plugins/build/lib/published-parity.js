'use strict';
/**
 * published-parity.js — the published-vs-source version parity check
 * (backlog 420a7051: `apigen-generator-nx` source and `published-state.json`
 * said 0.1.3 while the registry already carried 0.1.4, so the next release
 * would have tried to republish a taken version / diffed against a stale base).
 *
 * Rule: a publishable project's SOURCE `package.json` version must never be
 * BEHIND the highest version known to be published. Equal is the settled
 * state; AHEAD is a legitimate in-progress bump. Behind is the defect — someone
 * (or CI) published from a tree the repo never recorded.
 *
 * Pure: takes the release set (see `range-resolvability.discoverReleaseSet`) and
 * a map `name -> published versions[]`, so it is unit-testable with no network.
 * Two sources of published versions are supported by the CLI wrapper:
 *   - offline (default, CI-safe): the committed `published-state.json` cache;
 *   - `--registry`: the live registry (`fetchRegistryVersions`), which is the
 *     only mode that can see a publish the cache never recorded.
 */
const { parseVersion, compareVersions } = require('./range-resolvability');

/**
 * @param {{ projectRoot: string, name: string, version: string }[]} releaseSet
 * @param {Map<string, string[]>} publishedByName
 * @returns {{ ok: boolean, violations: { name: string, projectRoot: string, source: string, published: string }[] }}
 */
function checkParity(releaseSet, publishedByName) {
  const violations = [];
  for (const p of releaseSet) {
    const published = (publishedByName.get(p.name) || [])
      .map((v) => ({ v, parsed: parseVersion(v) }))
      .filter((x) => x.parsed)
      .sort((a, b) => compareVersions(a.parsed, b.parsed));
    if (published.length === 0) continue; // never published: nothing to be behind
    const top = published[published.length - 1];
    const src = parseVersion(p.version);
    if (!src || compareVersions(src, top.parsed) < 0) {
      violations.push({ name: p.name, projectRoot: p.projectRoot, source: p.version, published: top.v });
    }
  }
  return { ok: violations.length === 0, violations };
}

/** Build the `name -> versions[]` map from a `published-state.json` object. */
function publishedFromState(state) {
  const m = new Map();
  for (const [name, entry] of Object.entries(state || {})) {
    if (entry && typeof entry.version === 'string') m.set(name, [entry.version]);
  }
  return m;
}

/** @param {{ name: string, projectRoot: string, source: string, published: string }} v */
function formatViolation(v) {
  return `${v.name} (${v.projectRoot}): source ${v.source} is BEHIND published ${v.published} — reconcile the source version (and published-state.json) to ${v.published} or above`;
}

module.exports = { checkParity, publishedFromState, formatViolation };
