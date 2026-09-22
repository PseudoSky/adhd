'use strict';

/**
 * startup-probe-driver.js — the exercise plan `heavy-dep-probe.js` runs for
 * `extraction-session.ts` (S-20 / BUG-APIGEN-CORE-CLIENT-STARTUP-001).
 *
 * Kept as a separate CJS file so the probe stays generic. This module is
 * loaded by the probe AFTER the guard is armed, so it must never itself
 * `require` a guarded specifier (it does not require anything).
 *
 *   nonLazy(mod, fixture) — drives the public surface that must work WITHOUT
 *     ever resolving ts-morph: `fileVersion` (fs-only), session creation via
 *     `createExtractionSession`/`internalSession`, and `dispose`. Returns a
 *     small value the parent asserts on, so a no-op driver cannot pass.
 *
 *   lazy(mod, fixture)    — first real use of the ts-morph-backed path:
 *     `collectLocalImportPaths` builds a syntactic ts-morph `Project`. The
 *     probe only calls this after disarming, so ts-morph is allowed to load.
 */

/** @param {Record<string, unknown>} mod @param {string} fixture */
function nonLazy(mod, fixture) {
  const version = mod.fileVersion(fixture);
  if (typeof version !== 'string') {
    throw new Error(`fileVersion returned ${typeof version}, expected string`);
  }
  if (version === 'nostat') {
    throw new Error(
      `fileVersion(fixture) hit the missing-file sentinel; fixture must exist: ${fixture}`
    );
  }

  const session = mod.createExtractionSession();
  const internal = mod.internalSession(session);
  if (
    !internal ||
    !internal.stats ||
    typeof internal.stats.projectsBuilt !== 'number'
  ) {
    throw new Error(
      'createExtractionSession()/internalSession() did not yield a usable session'
    );
  }
  if (internal.stats.projectsBuilt !== 0) {
    throw new Error('a fresh session reported projectsBuilt > 0 before any use');
  }
  session.dispose();

  return { version, projectsBuiltAtCreation: 0 };
}

/** @param {Record<string, unknown>} mod @param {string} fixture */
function lazy(mod, fixture) {
  const paths = mod.collectLocalImportPaths(fixture);
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('collectLocalImportPaths returned no paths');
  }
  return { paths };
}

module.exports = { nonLazy, lazy };
