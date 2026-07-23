'use strict';
/**
 * reconcile-core.js — the pure(ish) orchestration for backfilling ONE
 * package's `published-state.json` cache entry from npm (PUBLISHED-STATE-
 * CACHE-001, Deliverable 4). Used by:
 *
 *   - `executors/reconcile/impl.js` — the `@adhd/nx-build:reconcile` task,
 *     run across every publishable project (`nx run-many -t reconcile`) to
 *     build/refresh the whole cache.
 *   - `executors/version/impl.js` — a single-package, in-process call on a
 *     CACHE MISS (a package `version` doesn't yet have an entry for), so a
 *     miss costs exactly one package's worth of network, never a graph-wide
 *     re-backfill.
 *
 * THE INTEGRITY GATE (why this is "network-light", not "network-free"):
 * for a package whose local `dist/` is already byte-identical to what's
 * published (the common case — most releases only touch a handful of
 * packages), we must still tell "identical" from "diverged" WITHOUT paying
 * for the tarball every time. The gate:
 *
 *   1. Pack the LOCAL dist OFFLINE (`packLocalDir` — no registry contact at
 *      all) and hash that tarball's bytes (`tarballIntegrity`).
 *   2. Fetch ONLY the packument's `dist.integrity` for `name@version`
 *      (`fetchPublishedIntegrity` — network, but metadata-sized, ~KB, never
 *      the tarball itself).
 *   3. MATCH -> local dist is byte-identical to what's actually published.
 *      Store `normalizedHash(localDist)` (equivalently the published hash,
 *      since they're byte-identical) + the confirmed integrity. No tarball
 *      pull. (`status: 'fast'`)
 *   4. DIFFER (or integrity metadata unavailable) -> we cannot know the
 *      PUBLISHED normalized hash without the published bytes — pull the
 *      real tarball (`fetchPublished`) and compute `normalizedHash` from the
 *      EXTRACTED PUBLISHED content, so the cached signal stays exact even
 *      though local and published currently differ. (`status: 'slow'`)
 *
 * This is sound because `npm pack` is CONTENT-DETERMINISTIC (proven
 * empirically against this workspace's pinned npm version — identical bytes
 * always produce a byte-identical tarball, independent of file mtimes): a
 * local pack's integrity can only equal the registry's `dist.integrity` when
 * the underlying file content is truly identical, never as a false positive
 * from timestamp coincidence.
 *
 * @module reconcile-core
 */
const { existsSync } = require('node:fs');
const { normalizedHash } = require('../version/compare-published');
const {
  publishedVersions,
  fetchPublishedIntegrity,
  fetchPublished,
  packLocalDir,
  tarballIntegrity,
} = require('../../lib/npm-registry');

/**
 * @typedef {object} ReconcileResult
 * @property {'pending'|'fast'|'slow'|'error'} status
 *   `pending`  — `version` isn't on npm yet (today's "release pending" logic); no cache entry to write.
 *   `fast`     — integrity gate matched; no tarball pulled.
 *   `slow`     — integrity diverged (or was unavailable); the published tarball WAS pulled.
 *   `error`    — could not reconcile (network failure, missing dist, etc); caller should fail loudly, not cache garbage.
 * @property {boolean} tarballPulled true iff the FULL published tarball was downloaded.
 * @property {{version:string, normalizedHash:string, publishedIntegrity:string}} [entry] present for 'fast'/'slow'.
 * @property {string} [error] present for 'error'.
 */

/**
 * Reconcile ONE package's published-state entry from npm.
 *
 * @param {{name:string, version:string, distDir:string, workDir:string}} args
 * @returns {ReconcileResult}
 */
function reconcilePackage({ name, version, distDir, workDir }) {
  if (!existsSync(distDir)) {
    return { status: 'error', error: `no built dist at ${distDir}`, tarballPulled: false };
  }

  const versions = publishedVersions(name);
  if (!versions.includes(version)) {
    // Matches the pre-cache `version` executor's "not yet on npm — release
    // pending" branch: nothing published at this version yet, so there is
    // nothing authoritative to cache.
    return { status: 'pending', tarballPulled: false };
  }

  // --- Integrity gate: try to avoid the tarball pull entirely. ---
  const localTgz = packLocalDir(distDir, workDir);
  const localIntegrity = localTgz ? tarballIntegrity(localTgz) : null;
  const publishedIntegrity = fetchPublishedIntegrity(name, version);

  if (localIntegrity && publishedIntegrity && localIntegrity === publishedIntegrity) {
    return {
      status: 'fast',
      tarballPulled: false,
      entry: { version, normalizedHash: normalizedHash(distDir), publishedIntegrity },
    };
  }

  // --- Slow path: content diverges (or integrity metadata was unavailable)
  // -- pull the real tarball and hash the ACTUAL published content.
  const publishedDir = fetchPublished(name, version, workDir);
  if (!publishedDir) {
    return {
      status: 'error',
      error: `could not fetch published tarball for ${name}@${version}`,
      tarballPulled: true,
    };
  }
  return {
    status: 'slow',
    tarballPulled: true,
    entry: {
      version,
      normalizedHash: normalizedHash(publishedDir),
      publishedIntegrity: publishedIntegrity || localIntegrity || null,
    },
  };
}

module.exports = { reconcilePackage };
