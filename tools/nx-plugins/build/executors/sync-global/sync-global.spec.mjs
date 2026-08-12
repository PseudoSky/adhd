/**
 * tools/nx-plugins/build/executors/sync-global/sync-global.spec.mjs
 *
 * Teeth tests for the publish -> global-CLI sync script (release step 3.5).
 * `node --test` compatible — plain node scripts OUTSIDE the nx graph (do NOT
 * run `nx build` for these; see AGENTS.md BL-235). Wired into
 * `pnpm test:build-tools`.
 *
 * Every test runs against TEMP FIXTURES: a fake workspace root (with an
 * `entrypoint/<name>/package.json`), a fake pnpm global bin dir with a
 * PLANTED stale link shim (content referencing the workspace root — the
 * exact shape of a `pnpm link -g` shim), and a fake global store. The real
 * registry, the real `~/Library/pnpm`, and the real global store are NEVER
 * touched: the registry gate (`npmView`) and the sync (`pnpmAdd`) are
 * injected fakes, and `globalDir` is always passed explicitly.
 *
 * Required coverage (per the task spec):
 *   1. detects a stale link shim;
 *   2. dry-run does not modify;
 *   3. registry-missing version -> SKIP;
 *   4. verifyShim returns false when the shim still references workspaceRoot.
 * Plus the positive twins (verifyShim true, real-sync path with a fake
 * pnpmAdd, restore-on-verify-failure) and the global-dir scan fallback.
 *
 * Run: node --test tools/nx-plugins/build/executors/sync-global/sync-global.spec.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectStaleShims, resolvePnpmGlobalDir, syncGlobalShims, verifyShim } from './sync-global.mjs';

/**
 * Build an isolated fixture: fake workspace root with one bin-shipping
 * entrypoint (`entrypoint/backlog` -> @adhd/backlog@0.1.4), a fake pnpm
 * global bin dir with a PLANTED stale link shim whose content references the
 * workspace root, and a fake (empty) global store dir.
 *
 * @returns {{ root: string, workspaceRoot: string, pnpmGlobalBinDir: string, pnpmGlobalDir: string, shimPath: string, shimContent: string }}
 */
function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'sync-global-fixture-'));
  const workspaceRoot = join(root, 'ws');
  const pnpmGlobalBinDir = join(root, 'bin');
  const pnpmGlobalDir = join(root, 'global', '5');
  mkdirSync(join(workspaceRoot, 'entrypoint', 'backlog'), { recursive: true });
  writeFileSync(
    join(workspaceRoot, 'entrypoint', 'backlog', 'package.json'),
    JSON.stringify({ name: '@adhd/backlog', version: '0.1.4', bin: { backlog: './dist/index.js' } }, null, 2)
  );
  mkdirSync(pnpmGlobalBinDir, { recursive: true });
  // The planted shim mirrors a real `pnpm link -g` shim: NODE_PATH walking up
  // the worktree chain + `exec node <workspace>/entrypoint/.../dist/index.js`.
  const shimContent =
    `#!/bin/sh\nNODE_PATH="${workspaceRoot}/entrypoint/backlog/node_modules"\n` +
    `exec node "${workspaceRoot}/entrypoint/backlog/dist/index.js" "$@"\n`;
  const shimPath = join(pnpmGlobalBinDir, 'backlog');
  writeFileSync(shimPath, shimContent, { mode: 0o755 });
  return { root, workspaceRoot, pnpmGlobalBinDir, pnpmGlobalDir, shimPath, shimContent };
}

/** Write the "published-artifact" global-store shape a real `pnpm add -g` would leave. */
function writeGlobalStoreVersion(f, name, version) {
  mkdirSync(join(f.pnpmGlobalDir, 'node_modules', name), { recursive: true });
  writeFileSync(
    join(f.pnpmGlobalDir, 'node_modules', name, 'package.json'),
    JSON.stringify({ name, version }, null, 2)
  );
}

// --- 1. detection ---

test('detectStaleShims: detects a planted stale link shim (content references workspaceRoot)', () => {
  const f = makeFixture();
  try {
    const stale = detectStaleShims({ workspaceRoot: f.workspaceRoot, pnpmGlobalBinDir: f.pnpmGlobalBinDir });
    assert.equal(stale.length, 1, 'expected exactly one stale shim (backlog)');
    assert.equal(stale[0].binName, 'backlog');
    assert.equal(stale[0].shimPath, f.shimPath);
    assert.equal(stale[0].pkg.name, '@adhd/backlog');
    assert.equal(stale[0].pkg.version, '0.1.4');
    assert.equal(stale[0].shimContent, f.shimContent);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('detectStaleShims: a shim that does not reference the workspace is NOT reported stale', () => {
  const f = makeFixture();
  try {
    // Published-artifact shape: execs the global store, no workspace path.
    writeFileSync(
      f.shimPath,
      `#!/bin/sh\nexec node "${f.pnpmGlobalDir}/node_modules/@adhd/backlog/index.js" "$@"\n`
    );
    assert.deepEqual(detectStaleShims({ workspaceRoot: f.workspaceRoot, pnpmGlobalBinDir: f.pnpmGlobalBinDir }), []);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('detectStaleShims: --projects filter narrows to the named entrypoint (nx project name = dir name)', () => {
  const f = makeFixture();
  try {
    assert.equal(
      detectStaleShims({ workspaceRoot: f.workspaceRoot, pnpmGlobalBinDir: f.pnpmGlobalBinDir, projects: ['backlog'] }).length,
      1
    );
    assert.deepEqual(
      detectStaleShims({ workspaceRoot: f.workspaceRoot, pnpmGlobalBinDir: f.pnpmGlobalBinDir, projects: ['other-cli'] }),
      [],
      'a --projects name with no matching entrypoint dir must select nothing'
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('detectStaleShims: a package without a bin field is never reported stale', () => {
  const f = makeFixture();
  try {
    // Drop the bin-shipping fixture entrypoint so only the bin-less one remains.
    rmSync(join(f.workspaceRoot, 'entrypoint', 'backlog'), { recursive: true, force: true });
    mkdirSync(join(f.workspaceRoot, 'entrypoint', 'library-only'), { recursive: true });
    writeFileSync(
      join(f.workspaceRoot, 'entrypoint', 'library-only', 'package.json'),
      JSON.stringify({ name: '@adhd/library-only', version: '0.1.0' })
    );
    assert.deepEqual(detectStaleShims({ workspaceRoot: f.workspaceRoot, pnpmGlobalBinDir: f.pnpmGlobalBinDir }), []);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// --- 2. dry-run does not modify ---

test('syncGlobalShims: dry-run prints WOULD and does NOT modify the shim (content + mtime) or create backups', async () => {
  const f = makeFixture();
  try {
    const mtimeBefore = statSync(f.shimPath).mtimeMs;
    const summary = await syncGlobalShims({
      workspaceRoot: f.workspaceRoot,
      pnpmGlobalBinDir: f.pnpmGlobalBinDir,
      dryRun: true,
      npmView: async () => '0.1.4', // registry has it — dry-run must STILL not touch anything
      pnpmAdd: async () => {
        throw new Error('pnpm add must never run in dry-run');
      },
      globalDir: f.pnpmGlobalDir,
    });
    assert.equal(readFileSync(f.shimPath, 'utf8'), f.shimContent, 'shim content must be byte-identical after dry-run');
    assert.equal(statSync(f.shimPath).mtimeMs, mtimeBefore, 'shim mtime must be untouched by dry-run');
    assert.deepEqual(
      readdirSync(f.pnpmGlobalBinDir).filter((n) => n.includes('.pre-sync-')),
      [],
      'dry-run must not leave backup files behind'
    );
    assert.equal(summary.length, 1);
    assert.equal(summary[0].pkg, '@adhd/backlog');
    assert.equal(summary[0].action, 'skipped', 'dry-run WOULD rows report action skipped (nothing synced)');
    assert.equal(summary[0].dryRun, true);
    assert.equal(summary[0].verified, false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// --- 3. registry-missing version -> SKIP ---

test('syncGlobalShims: version not on registry -> SKIP (pnpm add never called, shim untouched)', async () => {
  const f = makeFixture();
  try {
    let addCalls = 0;
    const summary = await syncGlobalShims({
      workspaceRoot: f.workspaceRoot,
      pnpmGlobalBinDir: f.pnpmGlobalBinDir,
      npmView: async () => '', // `npm view <name>@<version> version` found nothing (partial publish)
      pnpmAdd: async () => {
        addCalls++;
        return { ok: true };
      },
      globalDir: f.pnpmGlobalDir,
    });
    assert.equal(addCalls, 0, 'SKIP must never reach pnpm add');
    assert.equal(readFileSync(f.shimPath, 'utf8'), f.shimContent, 'shim must be untouched on SKIP');
    assert.equal(summary.length, 1);
    assert.equal(summary[0].action, 'skipped');
    assert.equal(summary[0].verified, false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// --- 4. verifyShim negative (the required case) ---

test('verifyShim: false when the shim still references workspaceRoot, even if the global store version matches', () => {
  const f = makeFixture();
  try {
    writeGlobalStoreVersion(f, '@adhd/backlog', '0.1.4'); // (b) would pass…
    const ok = verifyShim({
      pkg: { name: '@adhd/backlog', version: '0.1.4' },
      binName: 'backlog',
      shimPath: f.shimPath,
      workspaceRoot: f.workspaceRoot,
      pnpmGlobalDir: f.pnpmGlobalDir,
    });
    assert.equal(ok, false, 'a shim still referencing the workspace must never verify true');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('verifyShim: true when the shim no longer references workspaceRoot AND the global store version matches', () => {
  const f = makeFixture();
  try {
    // Simulate what `pnpm add -g` leaves behind: shim execs the global store…
    writeFileSync(
      f.shimPath,
      `#!/bin/sh\nexec node "${f.pnpmGlobalDir}/node_modules/@adhd/backlog/index.js" "$@"\n`
    );
    // …and the global store has the exact published version.
    writeGlobalStoreVersion(f, '@adhd/backlog', '0.1.4');
    const ok = verifyShim({
      pkg: { name: '@adhd/backlog', version: '0.1.4' },
      binName: 'backlog',
      shimPath: f.shimPath,
      workspaceRoot: f.workspaceRoot,
      pnpmGlobalDir: f.pnpmGlobalDir,
    });
    assert.equal(ok, true);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('verifyShim: false when the shim is clean but the global store version does not match the source version', () => {
  const f = makeFixture();
  try {
    writeFileSync(f.shimPath, `#!/bin/sh\nexec node "${f.pnpmGlobalDir}/node_modules/@adhd/backlog/index.js" "$@"\n`);
    writeGlobalStoreVersion(f, '@adhd/backlog', '0.1.3'); // stale store copy
    const ok = verifyShim({
      pkg: { name: '@adhd/backlog', version: '0.1.4' },
      binName: 'backlog',
      shimPath: f.shimPath,
      workspaceRoot: f.workspaceRoot,
      pnpmGlobalDir: f.pnpmGlobalDir,
    });
    assert.equal(ok, false, 'a store version that does not match the published version must fail verification');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// --- full sync path (fake pnpmAdd simulating pnpm's real effects) ---

test('syncGlobalShims: real sync path — fake pnpmAdd rewrites the shim and lands the global store version -> synced + verified, backup retained', async () => {
  const f = makeFixture();
  try {
    const summary = await syncGlobalShims({
      workspaceRoot: f.workspaceRoot,
      pnpmGlobalBinDir: f.pnpmGlobalBinDir,
      npmView: async () => '0.1.4',
      pnpmAdd: async (name, version) => {
        // What a real `pnpm add -g` does (verified against pnpm 8.15.9):
        // rewrite the shim away from the workspace, land the registry
        // tarball in the global store.
        writeFileSync(f.shimPath, `#!/bin/sh\nexec node "${f.pnpmGlobalDir}/node_modules/@adhd/backlog/index.js" "$@"\n`);
        writeGlobalStoreVersion(f, name, version);
        return { ok: true };
      },
      globalDir: f.pnpmGlobalDir,
    });
    assert.equal(summary.length, 1);
    assert.equal(summary[0].action, 'synced');
    assert.equal(summary[0].verified, true);
    assert.deepEqual(summary[0].bins, ['backlog']);
    // The rollback point existed: a .pre-sync-<ts> backup of the ORIGINAL
    // shim was written before the add.
    const backups = readdirSync(f.pnpmGlobalBinDir).filter((n) => n.startsWith('backlog.pre-sync-'));
    assert.equal(backups.length, 1, 'expected exactly one pre-sync backup of the stale shim');
    assert.equal(readFileSync(join(f.pnpmGlobalBinDir, backups[0]), 'utf8'), f.shimContent);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('syncGlobalShims: verify failure -> shims restored from backup and reported verified:false (advisory ERROR path)', async () => {
  const f = makeFixture();
  try {
    const summary = await syncGlobalShims({
      workspaceRoot: f.workspaceRoot,
      pnpmGlobalBinDir: f.pnpmGlobalBinDir,
      npmView: async () => '0.1.4',
      pnpmAdd: async () => ({ ok: true }), // "succeeds" but fixes nothing — verification must catch it
      globalDir: f.pnpmGlobalDir,
    });
    assert.equal(summary.length, 1);
    assert.equal(summary[0].action, 'synced');
    assert.equal(summary[0].verified, false, 'a sync that leaves the shim stale must report verified:false');
    // Fail-safe: the shim was restored to its pre-sync state (the backup).
    assert.equal(
      readFileSync(f.shimPath, 'utf8'),
      f.shimContent,
      'after a failed verification the shim must be restored to its pre-sync content'
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// --- global-dir derivation ---

test('resolvePnpmGlobalDir: scans versioned global dirs under the bin dir when config is unset, picking the highest with a node_modules', () => {
  const root = mkdtempSync(join(tmpdir(), 'sync-global-gd-'));
  try {
    const binDir = join(root, 'bin');
    mkdirSync(join(binDir, 'global', '5', 'node_modules'), { recursive: true });
    mkdirSync(join(binDir, 'global', '10', 'node_modules'), { recursive: true });
    mkdirSync(join(binDir, 'global', '8')); // no node_modules — must be skipped
    const resolved = resolvePnpmGlobalDir(binDir, () => ''); // injectable configGet: never spawns pnpm
    assert.equal(resolved, join(binDir, 'global', '10'), 'expected the highest versioned dir that has a node_modules');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolvePnpmGlobalDir: falls back to the unversioned base when no versioned node_modules dir exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'sync-global-gd2-'));
  try {
    const binDir = join(root, 'bin');
    mkdirSync(binDir, { recursive: true });
    assert.equal(resolvePnpmGlobalDir(binDir, () => ''), join(binDir, 'global'));
    assert.ok(!existsSync(join(binDir, 'global')), 'the fallback path is returned without creating it');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolvePnpmGlobalDir: pnpm 8 prints the literal string "undefined" for unset config keys — must be treated as unset, not as a path', () => {
  // Verified against pnpm 8.15.9: `pnpm config get global-dir` for an unset
  // key exits 0 and prints "undefined" (a truthy string). The versioned-dir
  // scan must still run. Caught live by the first real dry-run — this pins
  // the regression.
  const root = mkdtempSync(join(tmpdir(), 'sync-global-gd3-'));
  try {
    const binDir = join(root, 'bin');
    mkdirSync(join(binDir, 'global', '5', 'node_modules'), { recursive: true });
    assert.equal(
      resolvePnpmGlobalDir(binDir, () => 'undefined'),
      join(binDir, 'global', '5'),
      '"undefined" from pnpm config get must fall through to the versioned-dir scan'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
