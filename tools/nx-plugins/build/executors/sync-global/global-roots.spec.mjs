/**
 * tools/nx-plugins/build/executors/sync-global/global-roots.spec.mjs
 *
 * Teeth tests for `discoverGlobalRoots` (DEBT ab4d0864 — sync-global used to
 * scan ONLY the pnpm global bin dir, so a stale/broken global install under
 * NVM's npm prefix was invisible to the release).
 *
 * RED on HEAD: `./global-roots.mjs` does not exist, so this file fails to load
 * (the import throws) — proving the spec is a real new-behaviour test.
 *
 * Every test runs against TEMP FIXTURES via `mkdtempSync` (+ `finally rmSync`).
 * The real `~/Library/pnpm`, the real `npm prefix -g`, the real `~/.nvm`, and
 * the network are NEVER touched: `pnpmGlobalBinDir`, `nvmDir`, and `npmPrefixG`
 * are always injected, and `configGet` is a stub returning '' so no `pnpm`
 * process is spawned.
 *
 * Run: node --test tools/nx-plugins/build/executors/sync-global/global-roots.spec.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { discoverGlobalRoots } from './global-roots.mjs';

/** mkdir -p shim for the fixture builders. */
function mkdirp(...segments) {
  mkdirSync(join(...segments), { recursive: true });
}

test('discoverGlobalRoots: enumerates every existing NVM node version root (bin + lib/node_modules)', () => {
  const root = mkdtempSync(join(tmpdir(), 'global-roots-nvm-'));
  try {
    const nvm = join(root, 'nvm');
    for (const v of ['v20.0.0', 'v22.0.0']) {
      mkdirp(nvm, 'versions', 'node', v, 'bin');
      mkdirp(nvm, 'versions', 'node', v, 'lib', 'node_modules');
    }
    mkdirp(nvm, 'versions', 'node', 'v18.0.0'); // incomplete — no bin, no modules
    const pnpmBin = join(root, 'pnpmbin');
    mkdirp(pnpmBin);

    const roots = discoverGlobalRoots({
      pnpmGlobalBinDir: pnpmBin,
      npmPrefixG: '', // disable the npm-prefix root deterministically
      nvmDir: nvm,
      configGet: () => '', // never spawn real `pnpm`
    });

    const nvmRoots = roots.filter((r) => r.label.startsWith('nvm:'));
    assert.deepEqual(
      nvmRoots.map((r) => r.label).sort(),
      ['nvm:v20.0.0', 'nvm:v22.0.0'],
      'each existing NVM node version is a root; the incomplete v18.0.0 is skipped'
    );
    for (const r of nvmRoots) {
      assert.equal(r.manager, 'npm', 'NVM roots are repaired by npm');
      const v = r.label.slice('nvm:'.length);
      assert.equal(r.binDir, join(nvm, 'versions', 'node', v, 'bin'));
      assert.equal(r.modulesDir, join(nvm, 'versions', 'node', v, 'lib', 'node_modules'));
      assert.equal(r.execEnv && r.execEnv.npm_config_prefix, join(nvm, 'versions', 'node', v), 'execEnv targets that node prefix');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discoverGlobalRoots: discovers the `npm prefix -g` root (prefix/bin + prefix/lib/node_modules)', () => {
  const root = mkdtempSync(join(tmpdir(), 'global-roots-npm-'));
  try {
    const prefix = join(root, 'nodeprefix');
    mkdirp(prefix, 'bin');
    mkdirp(prefix, 'lib', 'node_modules');

    const roots = discoverGlobalRoots({
      pnpmGlobalBinDir: join(root, 'emptybin'), // does not exist — pnpm root omitted
      npmPrefixG: prefix,
      nvmDir: join(root, 'no-nvm'),
      configGet: () => '',
    });

    const npmRoots = roots.filter((r) => r.label === `npm:${prefix}`);
    assert.equal(npmRoots.length, 1, 'the npm global prefix is discovered');
    assert.equal(npmRoots[0].manager, 'npm');
    assert.equal(npmRoots[0].binDir, join(prefix, 'bin'));
    assert.equal(npmRoots[0].modulesDir, join(prefix, 'lib', 'node_modules'));
    assert.equal(npmRoots[0].execEnv.npm_config_prefix, prefix, 'npm installs are pinned to this prefix');
    assert.ok(
      String(npmRoots[0].execEnv.PATH).startsWith(join(prefix, 'bin')),
      'execEnv PATH prefers the prefix own bin dir'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discoverGlobalRoots: discovers the pnpm global root at <binDir>/global/<n>/node_modules', () => {
  const root = mkdtempSync(join(tmpdir(), 'global-roots-pnpm-'));
  try {
    const pnpmBin = join(root, 'pnpmbin');
    mkdirp(pnpmBin, 'global', '5', 'node_modules');

    const roots = discoverGlobalRoots({
      pnpmGlobalBinDir: pnpmBin,
      npmPrefixG: '',
      nvmDir: join(root, 'no-nvm'),
      configGet: () => '',
    });

    const pnpmRoots = roots.filter((r) => r.manager === 'pnpm');
    assert.equal(pnpmRoots.length, 1, 'the pnpm global root is discovered');
    assert.equal(pnpmRoots[0].binDir, pnpmBin);
    assert.equal(
      pnpmRoots[0].modulesDir,
      join(pnpmBin, 'global', '5', 'node_modules'),
      'modulesDir is the node_modules dir that DIRECTLY contains <pkg.name> (uniform layout)'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discoverGlobalRoots: dedupes the npm-prefix root against the identical NVM version root', () => {
  const root = mkdtempSync(join(tmpdir(), 'global-roots-dedupe-'));
  try {
    const nvm = join(root, 'nvm');
    const v20 = join(nvm, 'versions', 'node', 'v20.0.0');
    mkdirp(v20, 'bin');
    mkdirp(v20, 'lib', 'node_modules');

    const roots = discoverGlobalRoots({
      pnpmGlobalBinDir: join(root, 'emptybin'),
      npmPrefixG: v20, // the ACTIVE node IS the nvm v20.0.0
      nvmDir: nvm,
      configGet: () => '',
    });

    const atV20 = roots.filter((r) => r.modulesDir === join(v20, 'lib', 'node_modules'));
    assert.equal(atV20.length, 1, 'the same modulesDir is only returned once');
    assert.equal(atV20[0].label, `npm:${v20}`, 'the npm-prefix root (added first) wins the dedupe');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
