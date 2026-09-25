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
 * BUG-004 coverage (the content gate — a shim may only flip when the
 * worktree's dist content PROVABLY matches the published artifact at the
 * same version string; see sync-global.mjs's step-2.5 comment for the
 * incident):
 *   (a) content MISMATCH -> REFUSED: pnpm add never called, shim untouched;
 *   (b) content MATCH -> the real sync path proceeds exactly as before;
 *   (c) missing local dist -> REFUSED (cannot verify, never flip blind);
 *   (d) published-state cache MISS -> backfill seam: backfilled mismatch
 *       REFUSED, backfilled match PROCEEDS, backfill-unavailable PROCEEDS
 *       on the version gate alone.
 *
 * The fixture's published-state entry is the STAMPED hash of the local dist
 * (what publish's write-through records) — computed here with the REAL
 * generateDistManifest/normalizedHash primitives so the spec never depends
 * on sync-global's own implementation of the stamp (RED→GREEN per BL-225:
 * these tests run against the PRE-fix code first, where the version-only
 * gate flips on a content-mismatched worktree — the (a) test fails RED).
 *
 * Run: node --test tools/nx-plugins/build/executors/sync-global/sync-global.spec.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { computeExitCode, detectStaleShims, discoverPackageBins, isSourceLink, resolveInstallCommand, resolvePnpmGlobalDir, syncGlobalShims, verifyShim } from './sync-global.mjs';

// The REAL primitives (not sync-global's copies) — used to build the fixture's
// published-state entry the way publish's write-through would, and to build the
// deliberately-stale published hash for the mismatch case.
const require = createRequire(import.meta.url);
const { normalizedHash } = require('../version/compare-published.js');
const { generateDistManifest } = require('../manifest/generate-manifest.js');

/**
 * The STAMPED normalized hash of a dist dir — what publish's write-through
 * records into published-state.json. Copies the dist, re-stamps its
 * package.json via the REAL generateDistManifest (rebase bin/exports, drop
 * files/devDeps/scripts — the exact shape that ships), then hashes. Mirrors
 * sync-global's own gate implementation, but built from the shared
 * primitives so the spec independently proves the gate's comparison.
 *
 * @param {string} distDir
 * @param {Record<string, any>} srcPkg the entrypoint's SOURCE package.json
 * @returns {string} `sha256:<hex>`
 */
function stampedDistHashOf(distDir, srcPkg) {
  const tmp = mkdtempSync(join(tmpdir(), 'sync-global-stamped-'));
  try {
    // Recurse-copy the dist, then replace package.json with the stamped manifest.
    const copyTree = (from, to) => {
      for (const e of readdirSync(from, { withFileTypes: true })) {
        const src = join(from, e.name);
        const dst = join(to, e.name);
        if (e.isDirectory()) {
          mkdirSync(dst, { recursive: true });
          copyTree(src, dst);
        } else {
          copyFileSync(src, dst);
        }
      }
    };
    copyTree(distDir, tmp);
    writeFileSync(join(tmp, 'package.json'), JSON.stringify(generateDistManifest(srcPkg, {}), null, 2) + '\n');
    return normalizedHash(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Build an isolated fixture: fake workspace root with one bin-shipping
 * entrypoint (`entrypoint/backlog` -> @adhd/backlog@0.1.4), a fake pnpm
 * global bin dir with a PLANTED stale link shim whose content references the
 * workspace root, a fake (empty) global store dir, a REAL local dist dir,
 * and a published-state.json whose entry is the STAMPED hash of that dist
 * (what a real write-through would have recorded after publishing it).
 *
 * @returns {{ root: string, workspaceRoot: string, pnpmGlobalBinDir: string, pnpmGlobalDir: string, shimPath: string, shimContent: string, distDir: string, publishedStatePath: string }}
 */
function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'sync-global-fixture-'));
  const workspaceRoot = join(root, 'ws');
  const pnpmGlobalBinDir = join(root, 'bin');
  const pnpmGlobalDir = join(root, 'global', '5');
  const pkgDir = join(workspaceRoot, 'entrypoint', 'backlog');
  const distDir = join(pkgDir, 'dist');
  mkdirSync(distDir, { recursive: true });
  const srcPkg = { name: '@adhd/backlog', version: '0.1.4', bin: { backlog: './dist/index.js' } };
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(srcPkg, null, 2));
  // The RAW built dist (what `nx build` leaves: un-stamped bin path, files
  // allowlist, devDeps — i.e. NOT yet dist-manifest'd). The gate must hash
  // the STAMPED form, not this raw one — the raw hash differs from the
  // published-state hash even when content matches (clobbered-manifest case).
  writeFileSync(
    join(distDir, 'package.json'),
    JSON.stringify({ ...srcPkg, main: './dist/index.js', files: ['dist', 'CHANGELOG.md', 'skill'], devDependencies: { typescript: '^5.0.0' } }, null, 2)
  );
  writeFileSync(join(distDir, 'index.js'), 'export const x = 1;\n');
  const publishedStatePath = join(workspaceRoot, 'published-state.json');
  writeFileSync(
    publishedStatePath,
    JSON.stringify({ '@adhd/backlog': { version: '0.1.4', normalizedHash: stampedDistHashOf(distDir, srcPkg) } }, null, 2) + '\n'
  );
  mkdirSync(pnpmGlobalBinDir, { recursive: true });
  // The planted shim mirrors a real `pnpm link -g` shim: NODE_PATH walking up
  // the worktree chain + `exec node <workspace>/entrypoint/.../dist/index.js`.
  const shimContent =
    `#!/bin/sh\nNODE_PATH="${workspaceRoot}/entrypoint/backlog/node_modules"\n` +
    `exec node "${workspaceRoot}/entrypoint/backlog/dist/index.js" "$@"\n`;
  const shimPath = join(pnpmGlobalBinDir, 'backlog');
  writeFileSync(shimPath, shimContent, { mode: 0o755 });
  return { root, workspaceRoot, pnpmGlobalBinDir, pnpmGlobalDir, shimPath, shimContent, distDir, publishedStatePath };
}

/** Write a published-state.json whose entry for @adhd/backlog carries the given hash. */
function writePublishedHash(f, normalizedHashValue) {
  writeFileSync(
    f.publishedStatePath,
    JSON.stringify({ '@adhd/backlog': { version: '0.1.4', normalizedHash: normalizedHashValue } }, null, 2) + '\n'
  );
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

// --- BUG-004: the content gate (version-string-only gate had a blind spot) ---

/**
 * The stamped hash of a dist whose index.js holds the GIVEN code — the
 * "published at an OLDER/DIFFERENT code state" baseline for mismatch tests.
 */
function stampedHashWithCode(code) {
  const tmp = mkdtempSync(join(tmpdir(), 'sync-global-old-'));
  try {
    mkdirSync(join(tmp, 'dist'), { recursive: true });
    writeFileSync(join(tmp, 'dist', 'index.js'), code);
    const srcPkg = { name: '@adhd/backlog', version: '0.1.4', bin: { backlog: './dist/index.js' } };
    writeFileSync(join(tmp, 'dist', 'package.json'), JSON.stringify(srcPkg, null, 2));
    return stampedDistHashOf(join(tmp, 'dist'), srcPkg);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test('BUG-004 (a): content MISMATCH — worktree dist differs from published-state hash under the SAME version -> REFUSED, pnpm add never called, shim untouched', async () => {
  const f = makeFixture();
  try {
    // Simulate the incident: published @adhd/backlog@0.1.4 content (recorded
    // in published-state.json) is OLDER code than this worktree's dist —
    // e.g. pre-turso vs turso under the same 0.1.4 string. The version gate
    // (npmView -> '0.1.4') passes; the content gate must refuse the flip.
    const publishedOld = stampedHashWithCode('export const x = 99; /* pre-turso */\n');
    assert.notEqual(publishedOld, stampedHashOfFixture(f), 'sanity: the stale baseline must differ from the worktree dist');
    writePublishedHash(f, publishedOld);
    let addCalls = 0;
    const summary = await syncGlobalShims({
      workspaceRoot: f.workspaceRoot,
      pnpmGlobalBinDir: f.pnpmGlobalBinDir,
      npmView: async () => '0.1.4', // version string IS on the registry — the old gate would have flipped
      pnpmAdd: async () => {
        addCalls++;
        return { ok: true };
      },
      globalDir: f.pnpmGlobalDir,
    });
    assert.equal(addCalls, 0, 'a content-mismatched worktree must NEVER reach pnpm add');
    assert.equal(readFileSync(f.shimPath, 'utf8'), f.shimContent, 'the shim must be untouched — never flipped to the stale artifact');
    assert.equal(summary.length, 1);
    assert.equal(summary[0].action, 'refused');
    assert.equal(summary[0].verified, false);
    assert.deepEqual(
      readdirSync(f.pnpmGlobalBinDir).filter((n) => n.includes('.pre-sync-')),
      [],
      'a refused sync must not even create backups'
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('BUG-004 (b): content MATCH — worktree dist matches published-state hash -> sync proceeds exactly as before', async () => {
  const f = makeFixture(); // fixture default: published-state holds the STAMPED hash of this dist
  try {
    const summary = await syncGlobalShims({
      workspaceRoot: f.workspaceRoot,
      pnpmGlobalBinDir: f.pnpmGlobalBinDir,
      npmView: async () => '0.1.4',
      pnpmAdd: async (name, version) => {
        writeFileSync(f.shimPath, `#!/bin/sh\nexec node "${f.pnpmGlobalDir}/node_modules/@adhd/backlog/index.js" "$@"\n`);
        writeGlobalStoreVersion(f, name, version);
        return { ok: true };
      },
      globalDir: f.pnpmGlobalDir,
    });
    assert.equal(summary.length, 1);
    assert.equal(summary[0].action, 'synced', 'a content-matching worktree must flip exactly as before BUG-004');
    assert.equal(summary[0].verified, true);
    assert.equal(readFileSync(f.shimPath, 'utf8').includes(f.workspaceRoot), false, 'shim must be flipped away from the workspace');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('BUG-004 (c): no local dist at all -> REFUSED (cannot verify content; never flip blind)', async () => {
  const f = makeFixture();
  try {
    rmSync(f.distDir, { recursive: true, force: true });
    let addCalls = 0;
    const summary = await syncGlobalShims({
      workspaceRoot: f.workspaceRoot,
      pnpmGlobalBinDir: f.pnpmGlobalBinDir,
      npmView: async () => '0.1.4',
      pnpmAdd: async () => {
        addCalls++;
        return { ok: true };
      },
      globalDir: f.pnpmGlobalDir,
    });
    assert.equal(addCalls, 0, 'a worktree with no local dist must never flip');
    assert.equal(summary.length, 1);
    assert.equal(summary[0].action, 'refused');
    assert.equal(summary[0].verified, false);
    assert.match(summary[0].pkg + '', /@adhd\/backlog/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('BUG-004 (d): published-state cache MISS (no entry) -> backfill seam consulted; backfilled MISMATCH refused, backfilled MATCH proceeds', async () => {
  const f = makeFixture();
  try {
    rmSync(f.publishedStatePath, { force: true }); // no committed entry -> must backfill
    // (i) backfilled entry records OLDER published content than the worktree -> REFUSED
    const publishedOld = stampedHashWithCode('export const x = 99; /* pre-turso */\n');
    let reconcileCalls = 0;
    let addCalls = 0;
    const summaryRefused = await syncGlobalShims({
      workspaceRoot: f.workspaceRoot,
      pnpmGlobalBinDir: f.pnpmGlobalBinDir,
      npmView: async () => '0.1.4',
      reconcilePkg: async ({ name, version }) => {
        reconcileCalls++;
        assert.equal(name, '@adhd/backlog');
        assert.equal(version, '0.1.4');
        return { entry: { version: '0.1.4', normalizedHash: publishedOld } };
      },
      pnpmAdd: async () => {
        addCalls++;
        return { ok: true };
      },
      globalDir: f.pnpmGlobalDir,
    });
    assert.equal(reconcileCalls, 1, 'a cache miss must consult the backfill seam exactly once');
    assert.equal(addCalls, 0, 'a backfilled MISMATCH must never reach pnpm add');
    assert.equal(summaryRefused[0].action, 'refused');
    assert.equal(summaryRefused[0].verified, false);
    assert.equal(readFileSync(f.shimPath, 'utf8'), f.shimContent, 'shim must be untouched after the backfilled-mismatch refusal');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }

  const f2 = makeFixture();
  try {
    rmSync(f2.publishedStatePath, { force: true });
    // (ii) backfilled entry records the SAME content as the worktree -> proceeds
    const matchHash = stampedHashOfFixture(f2);
    const summaryProceed = await syncGlobalShims({
      workspaceRoot: f2.workspaceRoot,
      pnpmGlobalBinDir: f2.pnpmGlobalBinDir,
      npmView: async () => '0.1.4',
      reconcilePkg: async () => ({ entry: { version: '0.1.4', normalizedHash: matchHash } }),
      pnpmAdd: async (name, version) => {
        writeFileSync(f2.shimPath, `#!/bin/sh\nexec node "${f2.pnpmGlobalDir}/node_modules/@adhd/backlog/index.js" "$@"\n`);
        writeGlobalStoreVersion(f2, name, version);
        return { ok: true };
      },
      globalDir: f2.pnpmGlobalDir,
    });
    assert.equal(summaryProceed.length, 1);
    assert.equal(summaryProceed[0].action, 'synced', 'a backfilled MATCH must proceed exactly as a committed match');
    assert.equal(summaryProceed[0].verified, true);
  } finally {
    rmSync(f2.root, { recursive: true, force: true });
  }

  const f3 = makeFixture();
  try {
    rmSync(f3.publishedStatePath, { force: true });
    // (iii) backfill unavailable (reconcile error) -> degrade to the version gate alone (proceed as today)
    const summaryDegraded = await syncGlobalShims({
      workspaceRoot: f3.workspaceRoot,
      pnpmGlobalBinDir: f3.pnpmGlobalBinDir,
      npmView: async () => '0.1.4',
      reconcilePkg: async () => ({ error: 'registry unreachable' }),
      pnpmAdd: async (name, version) => {
        writeFileSync(f3.shimPath, `#!/bin/sh\nexec node "${f3.pnpmGlobalDir}/node_modules/@adhd/backlog/index.js" "$@"\n`);
        writeGlobalStoreVersion(f3, name, version);
        return { ok: true };
      },
      globalDir: f3.pnpmGlobalDir,
    });
    assert.equal(summaryDegraded.length, 1);
    assert.equal(summaryDegraded[0].action, 'synced', 'when the published baseline cannot be established, the version gate alone decides (as today)');
    assert.equal(summaryDegraded[0].verified, true);
  } finally {
    rmSync(f3.root, { recursive: true, force: true });
  }
});

test('BUG-004 (e): the content gate hashes the STAMPED dist, not the raw one — a build-clobbered manifest must not cause a false refusal', async () => {
  // Regression pin for the layout subtlety: publish's write-through records
  // normalizedHash AFTER writeDistManifest re-stamped dist/package.json
  // (rebase bin, drop files/devDeps). The raw on-disk dist has the UN-stamped
  // manifest (bin "./dist/index.js", files allowlist, devDeps present), so a
  // gate that hashed the raw dir would see "changed" even for byte-identical
  // content and falsely refuse every worktree whose dist was rebuilt by a
  // plain `nx build` after the release. The gate must hash the stamped form.
  const f = makeFixture();
  try {
    // The fixture's dist IS deliberately raw/un-stamped (see makeFixture) —
    // and its published-state entry is the STAMPED hash of the same content.
    // If the gate compared raw hashes, this would REFUSE. It must PROCEED.
    assert.match(readFileSync(join(f.distDir, 'package.json'), 'utf8'), /"files"/, 'sanity: fixture dist manifest is the raw build-clobbered shape');
    const summary = await syncGlobalShims({
      workspaceRoot: f.workspaceRoot,
      pnpmGlobalBinDir: f.pnpmGlobalBinDir,
      npmView: async () => '0.1.4',
      pnpmAdd: async (name, version) => {
        writeFileSync(f.shimPath, `#!/bin/sh\nexec node "${f.pnpmGlobalDir}/node_modules/@adhd/backlog/index.js" "$@"\n`);
        writeGlobalStoreVersion(f, name, version);
        return { ok: true };
      },
      globalDir: f.pnpmGlobalDir,
    });
    assert.equal(summary.length, 1);
    assert.equal(summary[0].action, 'synced', 'byte-identical content with a clobbered manifest must NOT be refused (stamped-hash gate)');
    assert.equal(summary[0].verified, true);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

/** The STAMPED hash of the fixture's own local dist — what a real write-through would have recorded. */
function stampedHashOfFixture(f) {
  const srcPkg = JSON.parse(readFileSync(join(f.workspaceRoot, 'entrypoint', 'backlog', 'package.json'), 'utf8'));
  return stampedDistHashOf(f.distDir, srcPkg);
}

// --- BUG-027: version-drift currency check for a NORMAL (non-link) global install ---

/**
 * Plant a NORMAL (non-link) global install shim — content execs the global
 * store, never references workspaceRoot — at the given installed version,
 * distinct from the fixture's published/source version (0.1.4). This is the
 * BUG-027 incident shape: `pnpm add -g @adhd/backlog@0.1.7` while the source
 * has already moved to 0.1.4-equivalent-but-newer (fixture keeps the SAME
 * version string across source/registry for simplicity — see each test for
 * the exact version numbers used).
 */
function plantNormalInstall(f, installedVersion) {
  writeFileSync(f.shimPath, `#!/bin/sh\nexec node "${f.pnpmGlobalDir}/node_modules/@adhd/backlog/index.js" "$@"\n`);
  writeGlobalStoreVersion(f, '@adhd/backlog', installedVersion);
}

test('BUG-027 (RED without the fix): a normal (non-link) global install on an OLDER version is reported "no stale global link" — never checked for currency', () => {
  // This test pins the OLD, buggy behavior of the version-only link-shim
  // check in isolation (detectStaleShims), proving why the bug existed: link
  // detection alone is blind to version drift on an ordinary install.
  const f = makeFixture();
  try {
    plantNormalInstall(f, '0.1.7'); // installed OLDER than the fixture's published 0.1.4... this line
    // intentionally uses a version that ISN'T the fixture's — the point is
    // only that detectStaleShims (link-only) reports nothing regardless.
    const stale = detectStaleShims({ workspaceRoot: f.workspaceRoot, pnpmGlobalBinDir: f.pnpmGlobalBinDir });
    assert.deepEqual(stale, [], 'link-only detection correctly finds nothing — this IS the blind spot BUG-027 closes at the syncGlobalShims level');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('BUG-027: a normal (non-link) global install behind the published version is synced to current, not reported "unchanged"', async () => {
  const f = makeFixture();
  try {
    plantNormalInstall(f, '0.1.3'); // installed OLDER than the fixture's published/source 0.1.4
    let addCalls = 0;
    const summary = await syncGlobalShims({
      workspaceRoot: f.workspaceRoot,
      pnpmGlobalBinDir: f.pnpmGlobalBinDir,
      npmView: async () => '0.1.4',
      pnpmAdd: async (name, version) => {
        addCalls++;
        writeFileSync(f.shimPath, `#!/bin/sh\nexec node "${f.pnpmGlobalDir}/node_modules/@adhd/backlog/index.js" "$@"\n`);
        writeGlobalStoreVersion(f, name, version);
        return { ok: true };
      },
      globalDir: f.pnpmGlobalDir,
    });
    assert.equal(addCalls, 1, 'BUG-027: an outdated normal global install must trigger pnpm add -g, exactly like a stale link shim');
    assert.equal(summary.length, 1);
    assert.notEqual(summary[0].action, 'unchanged', 'BUG-027 incident: this must never be silently reported unchanged');
    assert.equal(summary[0].action, 'synced');
    assert.equal(summary[0].verified, true);
    const globalPkg = JSON.parse(
      readFileSync(join(f.pnpmGlobalDir, 'node_modules', '@adhd/backlog', 'package.json'), 'utf8')
    );
    assert.equal(globalPkg.version, '0.1.4', 'the global store must now hold the published version');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('BUG-027: an installed-but-not-upgradable (content-refused) global install is reported refused, not unchanged/verified:true', async () => {
  const f = makeFixture();
  try {
    plantNormalInstall(f, '0.1.3');
    // Force the BUG-004 content gate to refuse (published-state hash mismatch).
    writePublishedHash(f, stampedHashWithCode('export const x = 99; /* pre-turso */\n'));
    let addCalls = 0;
    const summary = await syncGlobalShims({
      workspaceRoot: f.workspaceRoot,
      pnpmGlobalBinDir: f.pnpmGlobalBinDir,
      npmView: async () => '0.1.4',
      pnpmAdd: async () => {
        addCalls++;
        return { ok: true };
      },
      globalDir: f.pnpmGlobalDir,
    });
    assert.equal(addCalls, 0, 'a content-mismatched worktree must never flip the global install, even under BUG-027 version drift');
    assert.equal(summary[0].action, 'refused');
    assert.equal(summary[0].verified, false);
    const globalPkg = JSON.parse(
      readFileSync(join(f.pnpmGlobalDir, 'node_modules', '@adhd/backlog', 'package.json'), 'utf8')
    );
    assert.equal(globalPkg.version, '0.1.3', 'the stale global install must be left exactly as it was — never flipped to unverifiable content');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('BUG-027: a global install whose upgrade attempt FAILS is reported synced/verified:false — never silently "unchanged"', async () => {
  const f = makeFixture();
  try {
    plantNormalInstall(f, '0.1.3');
    const summary = await syncGlobalShims({
      workspaceRoot: f.workspaceRoot,
      pnpmGlobalBinDir: f.pnpmGlobalBinDir,
      npmView: async () => '0.1.4',
      pnpmAdd: async () => ({ ok: false, error: new Error('ETARGET simulated') }),
      globalDir: f.pnpmGlobalDir,
    });
    assert.equal(summary[0].action, 'synced');
    assert.equal(summary[0].verified, false);
    assert.equal(
      computeExitCode(summary),
      1,
      'BUG-027: a release must not report success while the operator global CLI stays stale — this must drive a non-zero exit'
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('BUG-027: a global install already matching the published version is reported "current" with verified:true (no pnpm add called)', async () => {
  const f = makeFixture();
  try {
    plantNormalInstall(f, '0.1.4'); // already current
    let addCalls = 0;
    const summary = await syncGlobalShims({
      workspaceRoot: f.workspaceRoot,
      pnpmGlobalBinDir: f.pnpmGlobalBinDir,
      npmView: async () => '0.1.4',
      pnpmAdd: async () => {
        addCalls++;
        return { ok: true };
      },
      globalDir: f.pnpmGlobalDir,
    });
    assert.equal(addCalls, 0, 'an already-current global install must never trigger pnpm add -g');
    assert.equal(summary.length, 1);
    assert.equal(summary[0].action, 'current');
    assert.equal(summary[0].verified, true);
    assert.equal(computeExitCode(summary), 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('BUG-027: a package with NO global install at all is reported "not-installed" with verified:null (never a currency claim)', async () => {
  const f = makeFixture();
  try {
    rmSync(f.shimPath, { force: true }); // no bin shim in the global bin dir at all
    let addCalls = 0;
    const summary = await syncGlobalShims({
      workspaceRoot: f.workspaceRoot,
      pnpmGlobalBinDir: f.pnpmGlobalBinDir,
      npmView: async () => '0.1.4',
      pnpmAdd: async () => {
        addCalls++;
        return { ok: true };
      },
      globalDir: f.pnpmGlobalDir,
    });
    assert.equal(addCalls, 0);
    assert.equal(summary.length, 1);
    assert.equal(summary[0].action, 'not-installed');
    assert.equal(summary[0].verified, null, 'BUG-027: a package that was never installed must never report verified:true — that would be a false currency claim');
    assert.equal(computeExitCode(summary), 0, 'nothing to enforce is not a failure');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// --- computeExitCode (BUG-027: the pipeline must be able to detect an unresolved currency failure) ---

test('computeExitCode: 0 when every row is current/not-installed/skipped; 1 when any row is refused or synced+unverified', () => {
  assert.equal(computeExitCode([]), 0);
  assert.equal(computeExitCode([{ action: 'current', verified: true }]), 0);
  assert.equal(computeExitCode([{ action: 'not-installed', verified: null }]), 0);
  assert.equal(computeExitCode([{ action: 'skipped', verified: false }]), 0);
  assert.equal(computeExitCode([{ action: 'skipped', verified: false, dryRun: true }]), 0);
  assert.equal(computeExitCode([{ action: 'synced', verified: true }]), 0);
  assert.equal(computeExitCode([{ action: 'refused', verified: false }]), 1);
  assert.equal(computeExitCode([{ action: 'synced', verified: false }]), 1);
  assert.equal(
    computeExitCode([
      { action: 'current', verified: true },
      { action: 'synced', verified: false },
    ]),
    1,
    'one unresolved row among many must still fail the whole run'
  );
});

// =====================================================================
// BUG f1dece41 (bin-keying) / BUG bea4bfe1 (currency) / DEBT ab4d0864
// (multi-root) — the 2026-09-25 bundle.
//
// RED-on-HEAD map (each test names the pre-fix behavior it kills):
//   - bin-keying: HEAD keys off `Object.keys(pkg.bin)` only, so a `backlog`
//     shim for a package declaring `adhd-backlog` is reported NOT-INSTALLED.
//   - currency: HEAD's `installedVersion ?? pkg.version` reports `current`
//     with `verified:true` when the installed manifest is MISSING.
//   - manager/multi-root: HEAD has no `roots`/`install` seam at all (the
//     `roots` argument is ignored and only pnpm is ever used).
//   - verifyShim(modulesDir): HEAD only accepts `pnpmGlobalDir`.
//
// Review fixes (2026-09-25 v2) — RED map:
//   - HIGH-1: detection required the shim content to contain the RUNNING
//     workspaceRoot, so a shim execing a SIBLING worktree was invisible
//     (not-installed, exit 0). RED until the entrypoint-path predicate lands.
//   - HIGH-2: a surviving legacy shim was reported synced/verified:true, exit
//     0. RED until `legacy-pending` + its computeExitCode entry land.
//   - MEDIUM-3: a store path symlinked into a source worktree was accepted as
//     `current`. RED until `isSourceLink` rejects it.
//   - LOW-7: an unreadable shim was folded into not-installed. RED until it is
//     `unverifiable`.
//   - LOW-8: a not-installed row carried installedVersion. RED until null.
//   - MEDIUM-4: defaultInstall had no coverage. The pure `resolveInstallCommand`
//     is asserted directly (pnpm argv/env, npm+NVM argv/execEnv, own-npm pick).
// =====================================================================

/**
 * Fixture whose package DELIBERATELY declares a bin name different from the
 * planted shim: package @adhd/backlog@1.0.0 declares `adhd-backlog`, but the
 * shim is the LEGACY `backlog` (exactly the production state — the live
 * ~/Library/pnpm/backlog shim for a package that now declares adhd-backlog).
 * published-state.json holds the STAMPED hash of the local dist.
 */
function makeBinKeyingFixture() {
  const root = mkdtempSync(join(tmpdir(), 'sync-global-binkey-'));
  const workspaceRoot = join(root, 'ws');
  const pnpmGlobalBinDir = join(root, 'bin');
  const pnpmGlobalDir = join(root, 'global', '5');
  const modulesDir = join(pnpmGlobalDir, 'node_modules');
  const pkgDir = join(workspaceRoot, 'entrypoint', 'backlog');
  const distDir = join(pkgDir, 'dist');
  mkdirSync(distDir, { recursive: true });
  const srcPkg = { name: '@adhd/backlog', version: '1.0.0', bin: { 'adhd-backlog': './dist/index.js' } };
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(srcPkg, null, 2));
  writeFileSync(
    join(distDir, 'package.json'),
    JSON.stringify({ ...srcPkg, main: './dist/index.js', files: ['dist'], devDependencies: { typescript: '^5.0.0' } }, null, 2)
  );
  writeFileSync(join(distDir, 'index.js'), 'export const x = 1;\n');
  writeFileSync(
    join(workspaceRoot, 'published-state.json'),
    JSON.stringify({ '@adhd/backlog': { version: '1.0.0', normalizedHash: stampedDistHashOf(distDir, srcPkg) } }, null, 2) + '\n'
  );
  mkdirSync(pnpmGlobalBinDir, { recursive: true });
  const shimContent =
    `#!/bin/sh\nNODE_PATH="${workspaceRoot}/entrypoint/backlog/node_modules"\n` +
    `exec node "${workspaceRoot}/entrypoint/backlog/dist/index.js" "$@"\n`;
  const shimPath = join(pnpmGlobalBinDir, 'backlog');
  writeFileSync(shimPath, shimContent, { mode: 0o755 });
  return { root, workspaceRoot, pnpmGlobalBinDir, pnpmGlobalDir, modulesDir, shimPath, shimContent, distDir, publishedStatePath: join(workspaceRoot, 'published-state.json') };
}

// --- BUG f1dece41: bin-keying ---

test('BUG f1dece41 + HIGH-2: a LEGACY-named stale shim is detected, drives the install of the declared shim, and is reported UNRESOLVED (legacy-pending, fails the exit) — never a false "synced/verified"', async () => {
  const f = makeBinKeyingFixture();
  try {
    // detectStaleShims must see the `backlog` shim (declared name: adhd-backlog).
    const stale = detectStaleShims({ workspaceRoot: f.workspaceRoot, pnpmGlobalBinDir: f.pnpmGlobalBinDir, modulesDir: f.modulesDir });
    assert.equal(stale.length, 1, 'the legacy shim must be detected (HEAD: not-installed)');
    assert.equal(stale[0].binName, 'backlog');
    assert.equal(stale[0].pkg.name, '@adhd/backlog');

    let installCalls = 0;
    const summary = await syncGlobalShims({
      workspaceRoot: f.workspaceRoot,
      pnpmGlobalBinDir: f.pnpmGlobalBinDir,
      globalDir: f.pnpmGlobalDir,
      npmView: async () => '1.0.0',
      install: async ({ manager, name, version, root }) => {
        installCalls++;
        assert.equal(manager, 'pnpm');
        // A real `pnpm add -g` writes the DECLARED bin name (adhd-backlog), not the legacy one.
        writeFileSync(join(root.binDir, 'adhd-backlog'), `#!/bin/sh\nexec node "${join(root.modulesDir, name, 'index.js')}" "$@"\n`);
        mkdirSync(join(root.modulesDir, name), { recursive: true });
        writeFileSync(join(root.modulesDir, name, 'package.json'), JSON.stringify({ name, version }));
        return { ok: true };
      },
    });
    assert.equal(installCalls, 1, 'the legacy shim must trigger the install (HEAD: the shim was invisible)');
    assert.equal(summary.length, 1);
    // HIGH-2: the declared shim the install wrote IS verified, but the legacy
    // shim survives and no manager install can rewrite it — the honest verdict
    // is UNRESOLVED, and the release must FAIL. (The PRE-fix test asserted
    // `action:synced`/`verified:true` here while the legacy shim sat stale —
    // that assertion enshrined the bug.)
    assert.equal(summary[0].action, 'legacy-pending', 'a surviving legacy shim must NOT be reported synced');
    assert.equal(summary[0].verified, false, 'legacy-pending is never verified:true');
    assert.equal(computeExitCode(summary), 1, 'HIGH-2: a release must not report success while a legacy shim remains stale');
    assert.equal(summary[0].targetVersion, '1.0.0');
    assert.deepEqual(summary[0].bins, ['backlog'], 'the row names the DETECTED (legacy) bin');
    // Reachability: the legacy shim survives (pnpm add -g cannot rewrite it) —
    // it must NOT be silently claimed fixed, it needs quarantine.
    assert.equal(readFileSync(f.shimPath, 'utf8'), f.shimContent, 'legacy shim left untouched — quarantine needed');
    assert.equal(existsSync(join(f.pnpmGlobalBinDir, 'adhd-backlog')), true, 'the declared shim now exists');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('discoverPackageBins: unions declared + installed-declared + content-referencing names', () => {
  const f = makeBinKeyingFixture();
  try {
    mkdirSync(join(f.modulesDir, '@adhd/backlog'), { recursive: true });
    writeFileSync(
      join(f.modulesDir, '@adhd/backlog', 'package.json'),
      JSON.stringify({ name: '@adhd/backlog', version: '1.0.0', bin: { 'adhd-backlog-legacy': './dist/index.js' } })
    );
    const names = discoverPackageBins({
      pkg: { name: '@adhd/backlog', bin: { 'adhd-backlog': './dist/index.js' } },
      binDir: f.pnpmGlobalBinDir,
      modulesDir: f.modulesDir,
      workspaceRoot: f.workspaceRoot,
    });
    assert.ok(names.includes('adhd-backlog'), 'source-declared name');
    assert.ok(names.includes('adhd-backlog-legacy'), 'installed-declared name');
    assert.ok(names.includes('backlog'), 'content-referencing legacy shim');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('discoverPackageBins: does NOT claim an unrelated workspace-referencing shim (no cross-package contamination)', () => {
  const f = makeFixture();
  try {
    writeFileSync(
      join(f.pnpmGlobalBinDir, 'other-cli'),
      `#!/bin/sh\nexec node "${f.workspaceRoot}/entrypoint/other-cli/dist/index.js" "$@"\n`,
      { mode: 0o755 }
    );
    const names = discoverPackageBins({
      pkg: { name: '@adhd/backlog', bin: { 'adhd-backlog': './dist/index.js' } },
      binDir: f.pnpmGlobalBinDir,
      modulesDir: join(f.pnpmGlobalDir, 'node_modules'),
      workspaceRoot: f.workspaceRoot,
    });
    assert.equal(names.includes('other-cli'), false, 'another package shim must never be claimed by @adhd/backlog');
    assert.equal(names.includes('backlog'), true, 'the package own content-referencing shim IS claimed');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// --- BUG bea4bfe1: currency is a claim about the INSTALLED tree only ---

test('BUG bea4bfe1 (currency): a present shim with a MISSING installed manifest is `unverifiable` (HEAD: current/verified:true) and fails the exit code', async () => {
  const f = makeFixture();
  try {
    // NORMAL (non-link) shim present; the store manifest is deliberately ABSENT.
    writeFileSync(f.shimPath, `#!/bin/sh\nexec node "${f.pnpmGlobalDir}/node_modules/@adhd/backlog/index.js" "$@"\n`);
    let installCalls = 0;
    const summary = await syncGlobalShims({
      workspaceRoot: f.workspaceRoot,
      pnpmGlobalBinDir: f.pnpmGlobalBinDir,
      globalDir: f.pnpmGlobalDir,
      npmView: async () => '0.1.4',
      pnpmAdd: async () => {
        installCalls++;
        return { ok: true };
      },
    });
    assert.equal(installCalls, 0, 'unverifiable must not blindly run the installer');
    assert.equal(summary.length, 1);
    assert.equal(summary[0].action, 'unverifiable');
    assert.equal(summary[0].verified, false, 'never a false verified:true (HEAD printed current/verified:true)');
    assert.equal(summary[0].installedVersion, null);
    assert.equal(summary[0].targetVersion, '0.1.4');
    assert.equal(computeExitCode(summary), 1, 'unverifiable must fail the release currency gate');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('BUG bea4bfe1: a stale install carries installedVersion AND targetVersion on the row (never conflated)', async () => {
  const f = makeFixture();
  try {
    plantNormalInstall(f, '0.1.3'); // readable store manifest at 0.1.3; source target is 0.1.4
    const summary = await syncGlobalShims({
      workspaceRoot: f.workspaceRoot,
      pnpmGlobalBinDir: f.pnpmGlobalBinDir,
      globalDir: f.pnpmGlobalDir,
      npmView: async () => '0.1.4',
      pnpmAdd: async (name, version) => {
        writeFileSync(f.shimPath, `#!/bin/sh\nexec node "${f.pnpmGlobalDir}/node_modules/@adhd/backlog/index.js" "$@"\n`);
        writeGlobalStoreVersion(f, name, version);
        return { ok: true };
      },
    });
    assert.equal(summary[0].installedVersion, '0.1.3', 'the INSTALLED version is reported');
    assert.equal(summary[0].targetVersion, '0.1.4', 'the TARGET version is reported separately');
    assert.equal(summary[0].action, 'synced');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('computeExitCode: 1 on `unverifiable` (BUG bea4bfe1)', () => {
  assert.equal(computeExitCode([{ action: 'unverifiable', verified: false }]), 1);
  assert.equal(computeExitCode([{ action: 'current', verified: true }, { action: 'unverifiable', verified: false }]), 1);
});

// --- DEBT ab4d0864: multi-root + manager dispatch ---

test('multi-root + manager dispatch: one row per (pkg, root); a pnpm root installs via pnpm, an npm root via npm', async () => {
  const f = makeFixture(); // pnpm-root fixture (declared bin `backlog`, v0.1.4)
  try {
    const npmBin = join(f.root, 'npmprefix', 'bin');
    const npmModules = join(f.root, 'npmprefix', 'lib', 'node_modules');
    mkdirSync(npmBin, { recursive: true });
    mkdirSync(npmModules, { recursive: true });
    const npmShim = join(npmBin, 'backlog');
    writeFileSync(npmShim, `#!/bin/sh\nexec node "${f.workspaceRoot}/entrypoint/backlog/dist/index.js" "$@"\n`, { mode: 0o755 });

    const roots = [
      { manager: 'pnpm', label: 'pnpm:fixture', binDir: f.pnpmGlobalBinDir, modulesDir: join(f.pnpmGlobalDir, 'node_modules') },
      { manager: 'npm', label: 'npm:fixture', binDir: npmBin, modulesDir: npmModules },
    ];
    const calls = [];
    const summary = await syncGlobalShims({
      workspaceRoot: f.workspaceRoot,
      roots,
      npmView: async () => '0.1.4',
      install: async ({ manager, name, version, root }) => {
        calls.push({ manager, label: root.label });
        writeFileSync(join(root.binDir, 'backlog'), `#!/bin/sh\nexec node "${join(root.modulesDir, name, 'index.js')}" "$@"\n`);
        mkdirSync(join(root.modulesDir, name), { recursive: true });
        writeFileSync(join(root.modulesDir, name, 'package.json'), JSON.stringify({ name, version }));
        return { ok: true };
      },
    });
    assert.equal(summary.length, 2, 'one row per (pkg, root)');
    assert.deepEqual(calls.map((c) => c.manager).sort(), ['npm', 'pnpm'], 'each root repaired by its own manager');
    assert.ok(calls.some((c) => c.manager === 'pnpm' && c.label === 'pnpm:fixture'));
    assert.ok(calls.some((c) => c.manager === 'npm' && c.label === 'npm:fixture'));
    for (const row of summary) {
      assert.equal(row.action, 'synced');
      assert.equal(row.verified, true);
    }
    assert.equal(readFileSync(npmShim, 'utf8').includes(f.workspaceRoot), false, 'the npm-root shim was flipped too');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('multi-root: a root with no installation of the package reports not-installed (verified:null) without touching the other root', async () => {
  const f = makeFixture();
  try {
    const emptyBin = join(f.root, 'emptybin');
    const emptyModules = join(f.root, 'emptyglobal', 'node_modules');
    mkdirSync(emptyBin, { recursive: true });
    mkdirSync(emptyModules, { recursive: true });
    const summary = await syncGlobalShims({
      workspaceRoot: f.workspaceRoot,
      roots: [
        { manager: 'pnpm', label: 'pnpm:fixture', binDir: f.pnpmGlobalBinDir, modulesDir: join(f.pnpmGlobalDir, 'node_modules') },
        { manager: 'npm', label: 'npm:empty', binDir: emptyBin, modulesDir: emptyModules },
      ],
      npmView: async () => '0.1.4',
      pnpmAdd: async (name, version) => {
        writeFileSync(f.shimPath, `#!/bin/sh\nexec node "${f.pnpmGlobalDir}/node_modules/@adhd/backlog/index.js" "$@"\n`);
        writeGlobalStoreVersion(f, name, version);
        return { ok: true };
      },
    });
    assert.equal(summary.length, 2);
    const byRoot = Object.fromEntries(summary.map((r) => [r.root, r]));
    assert.equal(byRoot['pnpm:fixture'].action, 'synced');
    assert.equal(byRoot['npm:empty'].action, 'not-installed');
    assert.equal(byRoot['npm:empty'].verified, null);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// --- verifyShim with modulesDir (the uniform packages dir across roots) ---

test('verifyShim: accepts `modulesDir` directly (no pnpmGlobalDir) — true on match, false on version mismatch', () => {
  const f = makeFixture();
  try {
    writeFileSync(f.shimPath, `#!/bin/sh\nexec node "${f.pnpmGlobalDir}/node_modules/@adhd/backlog/index.js" "$@"\n`);
    writeGlobalStoreVersion(f, '@adhd/backlog', '0.1.4');
    const modulesDir = join(f.pnpmGlobalDir, 'node_modules');
    assert.equal(
      verifyShim({ pkg: { name: '@adhd/backlog', version: '0.1.4' }, binName: 'backlog', shimPath: f.shimPath, workspaceRoot: f.workspaceRoot, modulesDir }),
      true
    );
    writeGlobalStoreVersion(f, '@adhd/backlog', '0.1.3');
    assert.equal(
      verifyShim({ pkg: { name: '@adhd/backlog', version: '0.1.4' }, binName: 'backlog', shimPath: f.shimPath, workspaceRoot: f.workspaceRoot, modulesDir }),
      false
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// =====================================================================
// Review-fix coverage (2026-09-25 v2): HIGH-1, HIGH-2, MEDIUM-3, LOW-7,
// LOW-8, MEDIUM-4. See the RED map above.
// =====================================================================

// --- HIGH-1: a shim execing a DIFFERENT checkout must be detected ---

test('HIGH-1: a legacy shim execing a SIBLING worktree is detected (not not-installed) and reported unresolved', async () => {
  const f = makeBinKeyingFixture(); // declares adhd-backlog; shim named backlog
  try {
    // Replace the fixture shim with one that execs a DIFFERENT root's source
    // — a sibling worktree / the main checkout. Pre-fix, `content.includes(
    // workspaceRoot)` is false here, so the shim is invisible -> not-installed.
    const sibling = join(f.root, 'sibling-checkout');
    const siblingShim =
      `#!/bin/sh\nNODE_PATH="${sibling}/entrypoint/backlog/node_modules"\n` +
      `exec node "${sibling}/entrypoint/backlog/dist/index.js" "$@"\n`;
    writeFileSync(f.shimPath, siblingShim, { mode: 0o755 });
    assert.equal(siblingShim.includes(f.workspaceRoot), false, 'sanity: the shim points at a DIFFERENT root');

    // Discovery must come from the entrypoint PATH in the content (the bin
    // name `backlog` is neither declared nor in the installed manifest).
    const names = discoverPackageBins({
      pkg: { name: '@adhd/backlog', bin: { 'adhd-backlog': './dist/index.js' } },
      binDir: f.pnpmGlobalBinDir,
      modulesDir: f.modulesDir,
      workspaceRoot: f.workspaceRoot,
      entrypointDirName: 'backlog',
    });
    assert.ok(names.includes('backlog'), 'HIGH-1: the sibling-worktree shim must be claimed by its entrypoint path');

    const stale = detectStaleShims({ workspaceRoot: f.workspaceRoot, pnpmGlobalBinDir: f.pnpmGlobalBinDir, modulesDir: f.modulesDir });
    assert.equal(stale.length, 1, 'HIGH-1: a shim execing a sibling worktree must be detected (HEAD: not-installed)');
    assert.equal(stale[0].binName, 'backlog');

    const summary = await syncGlobalShims({
      workspaceRoot: f.workspaceRoot,
      pnpmGlobalBinDir: f.pnpmGlobalBinDir,
      globalDir: f.pnpmGlobalDir,
      npmView: async () => '1.0.0',
      install: async ({ name, version, root }) => {
        writeFileSync(join(root.binDir, 'adhd-backlog'), `#!/bin/sh\nexec node "${join(root.modulesDir, name, 'index.js')}" "$@"\n`);
        mkdirSync(join(root.modulesDir, name), { recursive: true });
        writeFileSync(join(root.modulesDir, name, 'package.json'), JSON.stringify({ name, version }));
        return { ok: true };
      },
    });
    assert.notEqual(summary[0].action, 'not-installed', 'HIGH-1: the live sibling shim must never be reported not-installed');
    assert.equal(summary[0].action, 'legacy-pending', 'the sibling shim is a legacy shim the install cannot rewrite — unresolved');
    assert.equal(summary[0].verified, false);
    assert.equal(computeExitCode(summary), 1, 'HIGH-1 + HIGH-2: the run must fail while the sibling shim is left stale');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// --- MEDIUM-3: a source-link store path is not an installed artifact ---

test('isSourceLink: realpath-based source-tree discriminator (real dir/link/absent)', () => {
  const root = mkdtempSync(join(tmpdir(), 'sync-global-srclink-'));
  try {
    const src = join(root, 'wt', 'entrypoint', 'backlog');
    mkdirSync(src, { recursive: true });
    const realStore = join(root, 'global', 'node_modules', '@adhd', 'backlog');
    mkdirSync(realStore, { recursive: true });
    const link = join(root, 'global', 'node_modules', '@adhd', 'linked');
    symlinkSync(src, link);

    assert.equal(isSourceLink(src), true, 'a path inside entrypoint/<name> is a source tree');
    assert.equal(isSourceLink(link), true, 'a symlink resolving into a source tree is a source link');
    assert.equal(isSourceLink(realStore), false, 'a plain store dir is not a source link');
    assert.equal(isSourceLink(join(root, 'does-not-exist')), false, 'absent/dangling → false, never throws');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('MEDIUM-3: verifyShim rejects a store path that resolves into a source worktree (version would match the SOURCE manifest)', () => {
  const f = makeFixture();
  try {
    const srcTree = join(f.root, 'src-wt', 'entrypoint', 'backlog');
    mkdirSync(srcTree, { recursive: true });
    writeFileSync(join(srcTree, 'package.json'), JSON.stringify({ name: '@adhd/backlog', version: '0.1.4' })); // source manifest at the TARGET version
    const storeParent = join(f.pnpmGlobalDir, 'node_modules', '@adhd');
    mkdirSync(storeParent, { recursive: true });
    const storePkg = join(storeParent, 'backlog');
    symlinkSync(srcTree, storePkg);
    writeFileSync(f.shimPath, `#!/bin/sh\nexec node "${storePkg}/index.js" "$@"\n`);
    const ok = verifyShim({
      pkg: { name: '@adhd/backlog', version: '0.1.4' },
      binName: 'backlog',
      shimPath: f.shimPath,
      workspaceRoot: f.workspaceRoot,
      modulesDir: join(f.pnpmGlobalDir, 'node_modules'),
    });
    assert.equal(ok, false, 'MEDIUM-3: a source-linked store must never verify true (it would be reading the SOURCE manifest)');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('MEDIUM-3: a source-linked store reported `current` before the fix is now repaired, not claimed current', async () => {
  const f = makeFixture();
  try {
    // The store path is a symlink INTO a source worktree (this machine's live
    // ~/Library/pnpm/global/5/node_modules/@adhd/backlog -> .worktrees/... shape).
    const srcTree = join(f.root, 'src-wt', 'entrypoint', 'backlog');
    mkdirSync(srcTree, { recursive: true });
    writeFileSync(join(srcTree, 'package.json'), JSON.stringify({ name: '@adhd/backlog', version: '0.1.4' }));
    const storeParent = join(f.pnpmGlobalDir, 'node_modules', '@adhd');
    mkdirSync(storeParent, { recursive: true });
    const storePkg = join(storeParent, 'backlog');
    symlinkSync(srcTree, storePkg);
    // A CLEAN shim (no workspace reference) whose version "matches" only via
    // the source symlink — so pre-fix this row is `current`/verified:true.
    writeFileSync(f.shimPath, `#!/bin/sh\nexec node "${storePkg}/index.js" "$@"\n`);
    assert.equal(isSourceLink(storePkg), true, 'sanity: the store path IS a source link');

    const summary = await syncGlobalShims({
      workspaceRoot: f.workspaceRoot,
      pnpmGlobalBinDir: f.pnpmGlobalBinDir,
      globalDir: f.pnpmGlobalDir,
      npmView: async () => '0.1.4',
      pnpmAdd: async (name, version) => {
        // What a real install does: replace the symlink with a real store dir.
        rmSync(storePkg, { recursive: true, force: true });
        mkdirSync(storePkg, { recursive: true });
        writeFileSync(join(storePkg, 'package.json'), JSON.stringify({ name, version }));
        return { ok: true };
      },
    });
    assert.equal(summary[0].action, 'synced', 'MEDIUM-3: a source-linked store must be repaired, never reported current');
    assert.equal(summary[0].verified, true);
    assert.equal(isSourceLink(storePkg), false, 'the repaired store is a real install');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// --- LOW-7: present-but-unreadable shim is unverifiable ---

test('LOW-7: a shim present but UNREADABLE is `unverifiable` (exit 1), never silently not-installed', async () => {
  const f = makeFixture();
  try {
    chmodSync(f.shimPath, 0o000); // present, but readFileSync will throw EACCES
    let addCalls = 0;
    const summary = await syncGlobalShims({
      workspaceRoot: f.workspaceRoot,
      pnpmGlobalBinDir: f.pnpmGlobalBinDir,
      globalDir: f.pnpmGlobalDir,
      npmView: async () => '0.1.4',
      pnpmAdd: async () => {
        addCalls++;
        return { ok: true };
      },
    });
    assert.equal(addCalls, 0, 'an unreadable shim must not blindly trigger the installer');
    assert.equal(summary[0].action, 'unverifiable', 'LOW-7: present-but-unreadable must not fold into not-installed');
    assert.equal(summary[0].verified, false);
    assert.equal(computeExitCode(summary), 1);
  } finally {
    chmodSync(f.shimPath, 0o644); // so rmSync can always clean up
    rmSync(f.root, { recursive: true, force: true });
  }
});

// --- LOW-8: not-installed row must not carry installedVersion ---

test('LOW-8: a not-installed row carries installedVersion:null even when the store manifest is readable', async () => {
  const f = makeFixture();
  try {
    writeGlobalStoreVersion(f, '@adhd/backlog', '0.1.4'); // readable store manifest…
    rmSync(f.shimPath, { force: true }); // …but NO bin shim at all
    const summary = await syncGlobalShims({
      workspaceRoot: f.workspaceRoot,
      pnpmGlobalBinDir: f.pnpmGlobalBinDir,
      globalDir: f.pnpmGlobalDir,
      npmView: async () => '0.1.4',
      pnpmAdd: async () => ({ ok: true }),
    });
    assert.equal(summary[0].action, 'not-installed');
    assert.equal(summary[0].installedVersion, null, 'LOW-8: not-installed must not carry a version (self-contradictory summary)');
    assert.equal(summary[0].verified, null);
    assert.equal(computeExitCode(summary), 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// --- MEDIUM-4: the real install command/env construction ---

test('MEDIUM-4: resolveInstallCommand builds the EXACT argv+env for a pnpm root and an npm/NVM root', () => {
  // pnpm root: `pnpm add -g <name>@<ver>`, no npm_config_prefix injected.
  const pnpm = resolveInstallCommand({
    manager: 'pnpm',
    name: '@adhd/backlog',
    version: '1.0.0',
    root: { manager: 'pnpm', binDir: '/tmp/pnpmbin', modulesDir: '/tmp/pnpmmods' },
    env: { PATH: '/usr/bin' },
  });
  assert.equal(pnpm.cmd, 'pnpm');
  assert.deepEqual(pnpm.argv, ['add', '-g', '@adhd/backlog@1.0.0']);
  assert.equal(pnpm.env.npm_config_prefix, undefined, 'a pnpm root must not get npm_config_prefix');
  assert.equal(pnpm.env.PATH, '/usr/bin');

  // npm/NVM root: `npm i -g <name>@<ver>` with the root's execEnv merged over
  // the inherited env (so it targets THAT prefix, not the caller's).
  const prefix = '/nvm/versions/node/v20.0.0';
  const npm = resolveInstallCommand({
    manager: 'npm',
    name: '@adhd/backlog',
    version: '1.0.0',
    root: {
      manager: 'npm',
      binDir: join(prefix, 'bin'),
      modulesDir: join(prefix, 'lib', 'node_modules'),
      execEnv: { npm_config_prefix: prefix, PATH: `${join(prefix, 'bin')}:/usr/bin` },
    },
    env: { PATH: '/usr/bin', npm_config_prefix: '/wrong-prefix' },
  });
  assert.equal(npm.cmd, 'npm', 'no <binDir>/npm exists in this fixture → PATH npm');
  assert.deepEqual(npm.argv, ['i', '-g', '@adhd/backlog@1.0.0']);
  assert.equal(npm.env.npm_config_prefix, prefix, 'execEnv must override the inherited npm_config_prefix');
  assert.equal(npm.env.PATH, `${join(prefix, 'bin')}:/usr/bin`, 'execEnv PATH puts the root bin dir first');
});

test('MEDIUM-4: resolveInstallCommand prefers an npm/NVM root OWN npm binary when present', () => {
  const root = mkdtempSync(join(tmpdir(), 'sync-global-ownnpm-'));
  try {
    const binDir = join(root, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'npm'), '#!/bin/sh\nexit 0\n');
    const r = resolveInstallCommand({
      manager: 'npm',
      name: '@adhd/backlog',
      version: '1.0.0',
      root: { manager: 'npm', binDir },
      env: {},
    });
    assert.equal(r.cmd, join(binDir, 'npm'), "a version-managed node's own npm must win");
    assert.deepEqual(r.argv, ['i', '-g', '@adhd/backlog@1.0.0']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- computeExitCode: legacy-pending + dry-run exemption ---

test('computeExitCode: legacy-pending fails (1); a dry-run row of any action does not (0)', () => {
  assert.equal(computeExitCode([{ action: 'legacy-pending', verified: false }]), 1);
  assert.equal(computeExitCode([{ action: 'current', verified: true }, { action: 'legacy-pending', verified: false }]), 1);
  assert.equal(computeExitCode([{ action: 'legacy-pending', verified: false, dryRun: true }]), 0, 'dry-run never fails');
  assert.equal(computeExitCode([{ action: 'refused', verified: false, dryRun: true }]), 0, 'dry-run never fails');
});

test('discoverPackageBins: a timestamped BACKUP file (.bak-<ts>) is not claimed as a shim', () => {
  const f = makeBinKeyingFixture();
  try {
    // The operator's backup convention is `<file>.bak-<ISO>` (the live
    // ~/Library/pnpm/backlog.bak-20260922T214041Z): a backup is NOT an
    // installed CLI shim and must never be detected / asked to be quarantined.
    writeFileSync(
      join(f.pnpmGlobalBinDir, 'backlog.bak-20260922T214041Z'),
      `#!/bin/sh\nexec node "${f.workspaceRoot}/entrypoint/backlog/dist/index.js" "$@"\n`,
      { mode: 0o755 }
    );
    const names = discoverPackageBins({
      pkg: { name: '@adhd/backlog', bin: { 'adhd-backlog': './dist/index.js' } },
      binDir: f.pnpmGlobalBinDir,
      modulesDir: f.modulesDir,
      workspaceRoot: f.workspaceRoot,
      entrypointDirName: 'backlog',
    });
    assert.equal(names.includes('backlog.bak-20260922T214041Z'), false, 'a .bak-<ts> backup must not be claimed as a shim');
    assert.ok(names.includes('backlog'), 'the real legacy shim is still claimed');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
