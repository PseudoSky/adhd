'use strict';
/**
 * npm-registry.js — the ONLY place in `@adhd/nx-build` that talks to the npm
 * registry (network reads) or packs a tarball. Everything else in the
 * version/publish/sync path (see `tools/nx-plugins/build/README.md`'s
 * "published-state cache" section) reads the committed `published-state.json`
 * cache instead. Consolidated here (PUBLISHED-STATE-CACHE-001) so the
 * network/tarball surface is auditable in one file:
 *
 *   - `publishedVersions`         network, metadata (~KB)   — "is this version out yet?"
 *   - `fetchPublishedIntegrity`   network, metadata (~KB)   — the packument's `dist.integrity`
 *   - `fetchPublished`            network, FULL TARBALL     — only for integrity-diverging packages
 *   - `packLocalDir`              OFFLINE, no registry hit  — pack an on-disk directory
 *   - `tarballIntegrity`          pure, local               — sha512 of a tarball's bytes
 *
 * `packLocalDir` packs a filesystem PATH (`npm pack <dir>`), not a
 * `name@version` spec — npm never contacts the registry to pack a local
 * directory, so it stays entirely offline (verified empirically: `npm pack`
 * is also CONTENT-DETERMINISTIC — identical file bytes produce a
 * byte-identical tarball regardless of mtimes — which is exactly what makes
 * the `reconcile` integrity gate in `reconcile-core.js` sound).
 *
 * @module npm-registry
 */
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { mkdirSync, existsSync, readdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts });
}

/** Published versions of `name` (network, metadata only), or `[]` if never published. */
function publishedVersions(name) {
  const res = sh('npm', ['view', name, 'versions', '--json'], { stdio: ['ignore', 'pipe', 'ignore'] });
  if (res.status !== 0) return []; // E404 — never published
  try {
    const parsed = JSON.parse(res.stdout);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

/**
 * The packument's `dist.integrity` for `name@version` — metadata ONLY
 * (~KB), never the tarball itself. This is the "integrity gate" read
 * `reconcile-core.js` uses to decide whether a tarball pull is even needed.
 *
 * @param {string} name
 * @param {string} version
 * @returns {string | null} e.g. `sha512-…`, or null if unavailable
 */
function fetchPublishedIntegrity(name, version) {
  const res = sh('npm', ['view', `${name}@${version}`, 'dist.integrity'], { stdio: ['ignore', 'pipe', 'ignore'] });
  if (res.status !== 0) return null;
  const out = String(res.stdout || '').trim();
  return out || null;
}

/**
 * Download + extract the published tarball for `name@version` (network, the
 * FULL tarball) — the expensive path, used only when the integrity gate
 * above finds a real divergence (or is unavailable).
 *
 * @returns {string | null} the extracted package dir (its own root, holding
 *   `package.json`), or null on failure.
 */
function fetchPublished(name, version, workDir) {
  mkdirSync(workDir, { recursive: true });
  const packed = sh('npm', ['pack', `${name}@${version}`, '--pack-destination', workDir, '--json', '--silent'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (packed.status !== 0) return null;
  let filename;
  try {
    filename = JSON.parse(packed.stdout)[0].filename;
  } catch {
    return null;
  }
  // npm may report the filename with the scope dir stripped; resolve what actually landed.
  let tgz = join(workDir, filename);
  if (!existsSync(tgz)) {
    const found = readdirSync(workDir).find((f) => f.endsWith('.tgz'));
    if (!found) return null;
    tgz = join(workDir, found);
  }
  const untar = sh('tar', ['-xzf', tgz, '-C', workDir]);
  if (untar.status !== 0) return null;
  return join(workDir, 'package'); // npm tarballs extract under package/
}

/**
 * Pack a LOCAL directory into a `.tgz` — OFFLINE, no registry contact at all
 * (npm only reads the local filesystem to build the tarball for a directory
 * path spec). Content-deterministic: identical file bytes always produce a
 * byte-identical tarball, independent of mtimes — verified empirically
 * against the exact npm version pinned in this workspace.
 *
 * @param {string} dirPath a directory containing a `package.json` (e.g. a built dist)
 * @param {string} workDir scratch dir to write the tarball into
 * @returns {string | null} the produced tarball's path, or null on failure
 */
function packLocalDir(dirPath, workDir) {
  mkdirSync(workDir, { recursive: true });
  const packed = sh('npm', ['pack', dirPath, '--pack-destination', workDir, '--json', '--silent'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (packed.status !== 0) return null;
  let filename;
  try {
    filename = JSON.parse(packed.stdout)[0].filename;
  } catch {
    return null;
  }
  let tgz = join(workDir, filename);
  if (!existsSync(tgz)) {
    const found = readdirSync(workDir).find((f) => f.endsWith('.tgz'));
    if (!found) return null;
    tgz = join(workDir, found);
  }
  return tgz;
}

/**
 * `sha512-<base64>` of a tarball's raw bytes — the exact format npm's own
 * packument `dist.integrity` field uses, so it's directly comparable against
 * {@link fetchPublishedIntegrity}'s return value.
 *
 * @param {string} tgzPath
 * @returns {string}
 */
function tarballIntegrity(tgzPath) {
  const buf = readFileSync(tgzPath);
  return `sha512-${createHash('sha512').update(buf).digest('base64')}`;
}

module.exports = {
  sh,
  publishedVersions,
  fetchPublishedIntegrity,
  fetchPublished,
  packLocalDir,
  tarballIntegrity,
};
