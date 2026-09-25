#!/usr/bin/env node
/**
 * tools/nx-plugins/build/executors/sync-global/global-roots.mjs
 *
 * Enumerate every GLOBAL install root a workspace CLI can land in, so
 * `sync-global.mjs` (release step 3.5) can see — and repair — all of them,
 * not just the pnpm global bin dir.
 *
 * WHY THIS EXISTS (DEBT ab4d0864): `sync-global` used to resolve its target
 * as `pnpm config get global-bin-dir` || `~/Library/pnpm` and scan shims only
 * there. On this machine the operator's live `adhd-backlog` resolves through
 * NVM's bundled npm (`~/.nvm/versions/node/<v>/bin/adhd-backlog` ->
 * `.../lib/node_modules/@adhd/backlog`), which is OUTSIDE that scan — so a
 * broken nvm-global install survived every release and had to be repaired by
 * hand with `npm i -g`. This module returns the full set of roots:
 *
 *   1. pnpm global — `pnpm config get global-bin-dir` (else `~/Library/pnpm`);
 *      the packages dir is `resolvePnpmGlobalDir(binDir)/node_modules`.
 *   2. npm global prefix — `npm prefix -g`; bin `<prefix>/bin`, packages
 *      `<prefix>/lib/node_modules` (this is the pnpm-less / system-node path).
 *   3. every NVM node version — `{NVM_DIR||~/.nvm}/versions/node/<v>/` that
 *      exists; bin `<v>/bin`, packages `<v>/lib/node_modules` (the path
 *      `which adhd-backlog` resolves to when a version-managed npm owns it).
 *
 * Every read here is a READ (a `pnpm config`/`npm prefix` invocation, fs
 * scans). Nothing is written, installed, or mutated — repairs are the caller's
 * job, via the `install` seam in `sync-global.mjs`.
 *
 * SHAPE — `GlobalRoot`:
 *   {
 *     manager: 'pnpm' | 'npm',          // which installer repairs this root
 *     label: string,                     // human label for the summary row
 *     binDir: string,                    // where bin shims live
 *     modulesDir: string,                // the node_modules dir that DIRECTLY
 *                                        // contains `<pkg.name>` (uniform layout:
 *                                        // pnpm `<globalDir>/node_modules`,
 *                                        // npm `<prefix>/lib/node_modules`)
 *     execEnv?: Record<string,string>,   // extra env for `npm i -g` into this
 *                                        // root (npm_config_prefix + PATH)
 *   }
 *
 * `resolvePnpmGlobalDir` and `pnpmConfigGet` live here (moved out of
 * `sync-global.mjs` to avoid an import cycle); `sync-global.mjs` re-exports
 * `resolvePnpmGlobalDir` for its existing spec importers.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * `pnpm config get <key>` — read-only. Returns '' when the key is unset or
 * pnpm can't be spawned (never throws; a missing pnpm is not fatal at
 * config-read time — the caller's fallback covers it).
 *
 * PNP QUIRK (verified against pnpm 8.15.9): for an unset key, `pnpm config
 * get <key>` prints the literal string `undefined` (exit 0) rather than
 * printing nothing — so both the empty string AND "undefined" are treated as
 * unset. Caught live by the very first dry-run.
 *
 * @param {string} key
 * @param {typeof spawnSync} [spawn] injectable for tests — must never touch real globals
 * @returns {string}
 */
export function pnpmConfigGet(key, spawn = spawnSync) {
  const res = spawn('pnpm', ['config', 'get', key], { encoding: 'utf8', timeout: 30_000 });
  if (res.error || res.status !== 0) return '';
  const value = (res.stdout || '').trim();
  return value === 'undefined' ? '' : value;
}

/**
 * Resolve the pnpm global DIRECTORY (where `pnpm add -g` installs
 * `node_modules/<name>`, e.g. `~/Library/pnpm/global/5` on this machine) —
 * the location `verifyShim` checks for the installed version. Distinct from
 * the global BIN dir (where the shims live). Derivation order:
 *   1. `pnpm config get global-dir` if it returns a non-empty value.
 *   2. else scan `{binDir}/global/*` for existing versioned subdirs (e.g.
 *      `global/5`) that contain a `node_modules` — pick the HIGHEST. This
 *      matches whatever pnpm major actually created the store (verified:
 *      pnpm 8.15.9 on this machine uses `{binDir}/global/5`).
 *   3. else `{binDir}/global` (unversioned) as last resort — the post-sync
 *      verification will then fail and restore, fail-safe.
 *
 * @param {string} pnpmGlobalBinDir
 * @param {(key: string) => string} [configGet] injectable for tests — must not touch real globals
 * @returns {string}
 */
export function resolvePnpmGlobalDir(pnpmGlobalBinDir, configGet = pnpmConfigGet) {
  const configured = (configGet('global-dir') || '').trim();
  // pnpm prints the literal string "undefined" for unset keys (see
  // `pnpmConfigGet`'s header) — never treat that as a configured path.
  if (configured && configured !== 'undefined') return configured;
  const globalBase = join(pnpmGlobalBinDir, 'global');
  let candidates = [];
  try {
    candidates = readdirSync(globalBase, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
      .map((e) => e.name)
      .filter((n) => existsSync(join(globalBase, n, 'node_modules')))
      .sort((a, b) => Number(b) - Number(a));
  } catch {
    // no global dir at all yet — fall through to the unversioned base
  }
  if (candidates.length > 0) return join(globalBase, candidates[0]);
  return globalBase;
}

/** `npm prefix -g` — read-only. '' when npm can't be spawned or fails. */
function defaultNpmPrefixG() {
  const res = spawnSync('npm', ['prefix', '-g'], { encoding: 'utf8', timeout: 30_000 });
  if (res.error || res.status !== 0) return '';
  return (res.stdout || '').trim();
}

/**
 * The extra env `npm i -g` needs to target an npm root EXPLICITLY rather than
 * whatever `npm prefix -g` happens to resolve in the caller's shell:
 *   - `npm_config_prefix` — npm's documented env form of `--prefix`;
 *   - `PATH` prefixed with the root's bin dir, so the root's own `node`/`npm`
 *     win if the caller resolves `npm` by name.
 *
 * @param {string} prefix
 * @returns {Record<string,string>}
 */
function npmExecEnv(prefix) {
  return {
    npm_config_prefix: prefix,
    PATH: `${join(prefix, 'bin')}:${process.env.PATH || ''}`,
  };
}

/** Directory names under `dir` (empty when `dir` is absent/unreadable). */
function existingDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Discover every global install root on this machine.
 *
 * @param {{
 *   pnpmGlobalBinDir?: string,   // override the pnpm global bin dir (test seam)
 *   nvmDir?: string,             // override {NVM_DIR||~/.nvm} (test seam)
 *   npmPrefixG?: string,         // override `npm prefix -g` (test seam; '' disables the npm root)
 *   configGet?: (key: string) => string, // override `pnpm config get` (test seam)
 * }} [opts]
 * @returns {Array<{ manager: 'pnpm'|'npm', label: string, binDir: string, modulesDir: string, execEnv?: Record<string,string> }>}
 */
export function discoverGlobalRoots({ pnpmGlobalBinDir, nvmDir, npmPrefixG, configGet = pnpmConfigGet } = {}) {
  const roots = [];
  const seen = new Set();
  const add = (root) => {
    const key = root.modulesDir || root.binDir;
    if (!key || seen.has(key)) return;
    seen.add(key);
    roots.push(root);
  };

  // 1. pnpm global
  const binDir = pnpmGlobalBinDir ?? (configGet('global-bin-dir') || join(homedir(), 'Library', 'pnpm'));
  if (binDir) {
    const globalDir = resolvePnpmGlobalDir(binDir, configGet);
    const modulesDir = join(globalDir, 'node_modules');
    if (existsSync(binDir) || existsSync(modulesDir)) {
      add({ manager: 'pnpm', label: `pnpm:${binDir}`, binDir, modulesDir });
    }
  }

  // 2. npm global prefix (`npm prefix -g`)
  const prefix = npmPrefixG ?? defaultNpmPrefixG();
  if (prefix) {
    const modulesDir = join(prefix, 'lib', 'node_modules');
    if (existsSync(modulesDir) || existsSync(join(prefix, 'bin'))) {
      add({
        manager: 'npm',
        label: `npm:${prefix}`,
        binDir: join(prefix, 'bin'),
        modulesDir,
        execEnv: npmExecEnv(prefix),
      });
    }
  }

  // 3. every existing NVM node version (`{NVM_DIR||~/.nvm}/versions/node/<v>`)
  const nvmBase = join(nvmDir ?? (process.env.NVM_DIR || join(homedir(), '.nvm')), 'versions', 'node');
  for (const version of existingDirs(nvmBase).sort()) {
    const versionDir = join(nvmBase, version);
    const binDirV = join(versionDir, 'bin');
    const modulesDirV = join(versionDir, 'lib', 'node_modules');
    if (!existsSync(binDirV) && !existsSync(modulesDirV)) continue;
    add({
      manager: 'npm',
      label: `nvm:${version}`,
      binDir: binDirV,
      modulesDir: modulesDirV,
      execEnv: npmExecEnv(versionDir),
    });
  }

  return roots;
}
