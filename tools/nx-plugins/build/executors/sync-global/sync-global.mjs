#!/usr/bin/env node
/**
 * tools/nx-plugins/build/executors/sync-global/sync-global.mjs
 *
 * Release-train step 3.5 — publish -> global-CLI sync.
 *
 * WHY THIS EXISTS: the globally-installed CLIs shipped by this workspace's
 * entrypoints (`backlog`, `apigen`, `agent-mcp`, `decompile`, `dispatch-cli`)
 * can be left as STALE LINK SHIMS. A pnpm link shim (from `pnpm link -g`, or
 * an older install) is a shell script in the pnpm global bin dir (default
 * `~/Library/pnpm`) whose content embeds this workspace's absolute path —
 * e.g. `exec node "$basedir/../../dev/node/adhd/entrypoint/backlog/dist/
 * index.js"` with a NODE_PATH walking up the worktree chain — and the
 * matching `~/Library/pnpm/global/<n>/node_modules/@adhd/<name>` is a
 * symlink INTO the worktree. Every `backlog` invocation (the CLI itself and
 * the `~/.claude.json` MCP server entry) then runs LOCAL worktree source
 * forever, never the published `@adhd/<name>` artifact, silently. After a
 * release publishes new versions, those shims must be flipped to the
 * published artifacts — this script does exactly that, automatically, as
 * step 3.5 of `run-release.mjs`.
 *
 * HOW IT WORKS (per entrypoint/* package that declares a `bin`):
 *   1. DETECT — a shim is "stale" for one of TWO reasons:
 *      (a) LINK — it exists in the pnpm global bin dir AND its content
 *          includes the workspace root path (a `pnpm link -g` shim).
 *      (b) VERSION DRIFT (BUG-027) — it exists, is NOT a link shim, but the
 *          global store's installed `node_modules/<name>/package.json`
 *          version differs from the source version. This is the ordinary
 *          case a plain `pnpm add -g <name>@<oldVersion>` install ends up
 *          in after a release: the shim never referenced the workspace, so
 *          (a) alone reports "no stale link" — which is true but is NOT a
 *          currency claim. Incident: @adhd/backlog@0.1.8 published clean,
 *          GATE 2 passed, this script logged "no stale global link" / summary
 *          `verified=true` — and the operator's CLI stayed on 0.1.7 (missing
 *          the BUG-020 singleton-lock fix) until someone manually upgraded
 *          it. A bin with NO shim at all is reported `not-installed` — there
 *          is nothing to enforce, and that is reported distinctly from
 *          `current` (installed + verified current) so `verified=true` can
 *          never be misread as "the operator's CLI is up to date" when
 *          nothing was actually installed to check.
 *      Both reasons feed the SAME downstream pipeline (gates 2/2.5, sync,
 *      verify, fail-safe restore) below.
 *   2. GATE 1 (version) — `npm view <name>@<version> version` must return
 *      exactly the on-disk source version. This is the partial-publish gate:
 *      a package whose version isn't on the registry yet (e.g. an upstream
 *      publish in the same release failed) is SKIPPED, never half-flipped.
 *   2.5. GATE 2 (CONTENT — BUG-004): the version string alone is NOT proof
 *      the worktree matches the published artifact. The local dist's STAMPED
 *      content hash (see `stampedDistHash`) must equal the published
 *      artifact's hash recorded in `published-state.json` (backfilled from
 *      the registry on a cache miss). A worktree whose dist differs from the
 *      published artifact under the SAME version string is REFUSED with
 *      "worktree ahead of published content — run release first" and NEVER
 *      flipped — the incident this fixes: published @adhd/backlog@0.1.4
 *      (pre-turso, better-sqlite3) was flipped while the worktree held
 *      turso-adapter code under the same 0.1.4 string, breaking the CLI
 *      against the live store (SQLITE_CORRUPT).
 *   3. DRY-RUN — prints `WOULD run: pnpm add -g <name>@<version>` and moves
 *      on. Nothing is modified.
 *   4. SYNC — backs up every stale shim to `<shim>.pre-sync-<ts>` (the
 *      rollback point), runs `pnpm add -g <name>@<exact-version>` (an atomic
 *      global install that replaces the link with a registry-tarball install
 *      under the global store and rewrites all of the package's bin shims),
 *      then POST-VERIFIES with `verifyShim`.
 *   5. FAIL-SAFE — if the post-sync verification fails for any stale bin of
 *      the package, every backup is copied back over its shim (restore) and
 *      an ERROR is logged. Verified against pnpm 8.15.9 on macOS 2026-08-12:
 *      `pnpm add -g @adhd/backlog@0.1.4` run from INSIDE the workspace
 *      installs the registry tarball under `~/Library/pnpm/global/5/.pnpm/`
 *      (NOT a workspace symlink) and rewrites the `backlog` shim with zero
 *      workspace references — so verification passes and the global CLI is
 *      genuinely decoupled from the worktree.
 *
 * EXIT CODE CONTRACT (BUG-027 REVISED — no longer purely advisory):
 *   exit 0 — the script ran to completion AND every package processed ended
 *            in a currency-verified state: `current`/`unchanged` (verified
 *            true), `not-installed` (nothing to enforce), or `skipped`
 *            (registry doesn't have the version yet — a partial-publish
 *            timing issue, not a currency failure; or a dry-run WOULD, which
 *            never attempted anything).
 *   exit 1 (NEW, `computeExitCode`) — at least one package ended UNRESOLVED:
 *            `refused` (BUG-004 content gate blocked a flip) or `synced`
 *            with `verified: false` (an upgrade was ATTEMPTED — `pnpm add -g`
 *            ran — and failed, or post-sync verification failed and the
 *            backup was restored). This is deliberate: BUG-027's incident was
 *            exactly a script that logged ERROR lines while exiting 0, which
 *            `run-release.mjs` (BUG-003 exit-capture pattern) then reads as
 *            "advisory, ignore" and reports the release as a full success.
 *            "A release that leaves the operator on a stale binary must not
 *            report success" (BUG-027) required this script itself to be
 *            able to say so in its own exit code — `run-release.mjs` step 3.5
 *            now folds this into the compound verdict (see its own header).
 *   exit 1 — internal failure: an unexpected exception, an unreadable
 *            manifest, or a hard spawn failure (command not found).
 *   exit 2 — usage error (unknown CLI argument).
 *   No env-var toggles — every knob is a CLI flag or an explicit function
 *   parameter.
 *
 * CLI:
 *   node tools/nx-plugins/build/executors/sync-global/sync-global.mjs [--projects=a,b,c] [--dry-run]
 *
 * `--projects` filters by the ENTRYPOINT DIRECTORY NAME (= the nx project
 * name, e.g. `backlog` — the same values `run-release.mjs` computes in its
 * `projectNames` and passes through). `--dry-run` prints the WOULD lines and
 * exits without modifying anything.
 *
 * Testability: `detectStaleShims`, `syncGlobalShims`, `verifyShim`,
 * `resolvePnpmGlobalDir`, and `contentGate` are exported and pure-ish
 * (temp-fixture friendly); `syncGlobalShims` additionally accepts optional
 * `npmView` / `pnpmAdd` / `globalDir` / `reconcilePkg` overrides so the
 * registry-gate, content-gate, sync, and verify branches are unit-testable
 * WITHOUT ever touching real globals or the network — the defaults reproduce
 * production behavior exactly (see the spec file).
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// CJS build-tooling primitives (same modules the version/reconcile/publish
// executors use) — loaded via createRequire because this script is ESM.
const require = createRequire(import.meta.url);
const { normalizedHash } = require('../version/compare-published.js');
const { generateDistManifest } = require('../manifest/generate-manifest.js');
const { readState } = require('../../lib/published-state.js');
const { reconcilePackage } = require('../reconcile/reconcile-core.js');

/** Same root-walk as run-release.mjs / clean-room-smoke.mjs — up until a dir containing nx.json. */
const findRoot = (d) => {
  while (d !== dirname(d)) {
    if (existsSync(join(d, 'nx.json'))) return d;
    d = dirname(d);
  }
  return d;
};

/**
 * `pnpm config get <key>` — read-only. Returns '' when the key is unset or
 * pnpm can't be spawned (never throws; a missing pnpm is not fatal at
 * config-read time — the caller's fallback covers it).
 *
 * PNP QUIRK (verified against pnpm 8.15.9): for an unset key, `pnpm config
 * get <key>` prints the literal string `undefined` (exit 0) rather than
 * printing nothing — so both the empty string AND "undefined" are treated as
 * unset. This bug was caught live by the very first dry-run: the truthy
 * "undefined" was being used as a relative `pnpmGlobalBinDir` path.
 */
function pnpmConfigGet(key) {
  const res = spawnSync('pnpm', ['config', 'get', key], { encoding: 'utf8', timeout: 30_000 });
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

/**
 * Detect every STALE GLOBAL LINK SHIM for this workspace's bin-shipping
 * entrypoints: a shim file in `pnpmGlobalBinDir` whose content includes
 * `workspaceRoot` (a pnpm link shim — it execs local worktree source).
 * Pure detection: no spawns, no network, never writes.
 *
 * `projects` filters by entrypoint directory name (= nx project name, the
 * same values `run-release.mjs` passes via `--projects=`); when null/empty
 * every entrypoint is scanned. Packages without a `bin` are skipped.
 *
 * @param {{ workspaceRoot: string, pnpmGlobalBinDir: string, projects?: string[] | null }} opts
 * @returns {Array<{ pkg: object, binName: string, shimPath: string, shimContent: string }>}
 *          one entry per STALE bin shim; `pkg` is the parsed manifest
 *          (`name`/`version`/`bin` for the caller), `shimContent` the full
 *          current shim text.
 */
export function detectStaleShims({ workspaceRoot, pnpmGlobalBinDir, projects = null }) {
  const stale = [];
  const projectSet = projects && projects.length > 0 ? new Set(projects) : null;
  const entrypointDir = join(workspaceRoot, 'entrypoint');
  let entries;
  try {
    entries = existsSync(entrypointDir) ? readdirSync(entrypointDir) : [];
  } catch {
    return stale;
  }
  for (const dirName of entries.sort()) {
    if (projectSet && !projectSet.has(dirName)) continue;
    const pkgJsonPath = join(entrypointDir, dirName, 'package.json');
    if (!existsSync(pkgJsonPath)) continue;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    } catch {
      continue; // unreadable manifest — skip the entrypoint, don't crash detection
    }
    if (!pkg.name || !pkg.bin) continue;
    // object-form bin: {binName: relPath}; string-form bin: npm names it
    // after the package's own (unscoped) name.
    const bins = typeof pkg.bin === 'string' ? { [pkg.name.split('/').pop()]: pkg.bin } : pkg.bin;
    for (const binName of Object.keys(bins)) {
      const shimPath = join(pnpmGlobalBinDir, binName);
      if (!existsSync(shimPath)) continue;
      let shimContent;
      try {
        shimContent = readFileSync(shimPath, 'utf8');
      } catch {
        continue; // unreadable shim — not provably stale, leave it alone
      }
      if (shimContent.includes(workspaceRoot)) {
        stale.push({ pkg, binName, shimPath, shimContent });
      }
    }
  }
  return stale;
}

/**
 * Post-sync verification for one bin shim, both halves of which must pass:
 *   (a) the shim's content no longer references `workspaceRoot` — i.e.
 *       `pnpm add -g` rewrote it away from the worktree link;
 *   (b) the global store's `node_modules/<pkg.name>/package.json` version
 *       equals the package's source version — i.e. the global install landed
 *       the exact published artifact we asked for.
 * Pure file reads, never throws (a read failure is `false`).
 *
 * @param {{ pkg: { name: string, version: string }, binName: string, shimPath: string, workspaceRoot: string, pnpmGlobalDir: string }} opts
 * @returns {boolean}
 */
export function verifyShim({ pkg, binName, shimPath, workspaceRoot, pnpmGlobalDir }) {
  if (!pkg || !pkg.name || !pkg.version || !shimPath || !pnpmGlobalDir) return false;
  let shimContent;
  try {
    shimContent = readFileSync(shimPath, 'utf8');
  } catch {
    return false;
  }
  if (shimContent.includes(workspaceRoot)) return false; // (a)
  const globalPkgJsonPath = join(pnpmGlobalDir, 'node_modules', pkg.name, 'package.json');
  if (!existsSync(globalPkgJsonPath)) return false;
  let globalPkg;
  try {
    globalPkg = JSON.parse(readFileSync(globalPkgJsonPath, 'utf8'));
  } catch {
    return false;
  }
  return globalPkg.version === pkg.version; // (b)
}

/** Restore every backed-up shim (rollback after a failed sync/verify). */
function restoreBackups(backups) {
  for (const b of backups) {
    try {
      copyFileSync(b.backupPath, b.shimPath);
      console.error(`sync-global: restored ${b.backupPath} -> ${b.shimPath}`);
    } catch (err) {
      console.error(`sync-global: ERROR could not restore ${b.shimPath} (${err.message}) — manual rollback from ${b.backupPath} needed`);
    }
  }
}

/**
 * BUG-004 CONTENT GATE — the STAMPED normalized hash of a local dist dir:
 * the same digest `publish`'s write-through records into published-state.json
 * (`normalizedHash(distDir)` AFTER `writeDistManifest` re-stamped
 * dist/package.json — see BUG-BUILD-PUBLISH-DISTMANIFEST-CLOBBERED-001 for
 * why the raw on-disk manifest cannot be trusted to match the published
 * tarball's). Hashes a temp copy of the dist with the resolved dist-root
 * manifest (`generateDistManifest`) written in place of the raw one, so the
 * result is directly comparable to the cache's `normalizedHash` — this is
 * what makes the version-only gate's blind spot (a worktree whose dist
 * differs from the published artifact under the SAME version string) visible.
 *
 * Pure-ish: never touches the real dist, never spawns, never writes outside
 * the temp copy. Throws only if the dist dir is unreadable.
 *
 * @param {string} distDir absolute {entrypointDir}/{name}/dist
 * @param {Record<string, any>} srcPkg the entrypoint's SOURCE package.json (the stamp is derived from it)
 * @returns {string} `sha256:<hex>`
 */
function stampedDistHash(distDir, srcPkg) {
  const tmp = mkdtempSync(join(tmpdir(), 'sync-global-gate-'));
  try {
    // Recurse-copy the dist into the temp dir, then overwrite its manifest
    // with the stamped one (the shape that actually ships on npm).
    const copyTree = (from, to) => {
      mkdirSync(to, { recursive: true });
      for (const entry of readdirSync(from, { withFileTypes: true })) {
        const s = join(from, entry.name);
        const d = join(to, entry.name);
        if (entry.isDirectory()) copyTree(s, d);
        else copyFileSync(s, d);
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
 * BUG-004 CACHE-MISS BACKFILL — default implementation: reconcile the ONE
 * package's published-state entry from npm via reconcile-core's
 * `reconcilePackage` (the exact same primitive `version/impl.js`'s
 * `backfillOnMiss` uses on a cache miss). Returns `{ entry }` on
 * fast/slow success, `{ error }` on reconcile failure, or `{ entry: null }`
 * when the version genuinely isn't on npm yet (the version-string gate
 * upstream already decided the version is on the registry, so this is the
 * defensive tail, not the common path).
 *
 * Injectable seam — `syncGlobalShims` accepts `reconcilePkg` so tests can
 * fake the network.
 *
 * @param {{ name: string, version: string, distDir: string, workspaceRoot: string }} args
 * @returns {Promise<{ entry?: object, error?: string }>}
 */
async function defaultReconcilePkg({ name, version, distDir, workspaceRoot }) {
  const workDir = join(workspaceRoot, 'tmp', 'sync-global-backfill', name.replace(/[^a-z0-9-]+/gi, '-'));
  try {
    const result = reconcilePackage({ name, version, distDir, workDir });
    if (result.status === 'error') return { error: result.error };
    if (result.status === 'pending') return { entry: null };
    return { entry: result.entry };
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // best-effort scratch cleanup
    }
  }
}

/**
 * BUG-004 CONTENT GATE — the fix for the version-string-only blind spot.
 *
 * Decides whether a stale global link shim may be flipped, by comparing the
 * worktree's local dist content against the PUBLISHED content at the same
 * version string — never the version string alone. The published baseline is
 * `published-state.json[<name>].normalizedHash` (the same compare-published.js
 * digest `publish`'s write-through records; zero network on the happy path).
 *
 * Verdicts:
 *   { ok: true }                 — content matches published: proceed as today.
 *   { ok: true, note }           — no authoritative baseline and backfill was
 *                                  unavailable: proceed as today (the version
 *                                  gate upstream already confirmed the version
 *                                  is on the registry).
 *   { ok: false, error }         — REFUSE: local dist content differs from the
 *                                  published artifact (or cannot be verified).
 *                                  The flip must NEVER happen here.
 *
 * Cache-miss handling: when published-state has no entry for the package —
 * or its entry records a DIFFERENT version than the worktree's — the entry is
 * BACKFILLED from the registry via the injectable `reconcilePkg` seam (the
 * same reconcile-core primitive `version/impl.js`'s `backfillOnMiss` uses).
 * The backfilled hash is the authoritative published baseline, so rule 2 then
 * applies to it exactly as it does to a committed entry: mismatch -> refuse.
 * Only when the backfill itself is unavailable (network failure / reconcile
 * error / version not on npm) does the gate degrade to "proceed as today",
 * with a loud note — verification is impossible, not merely unattempted.
 *
 * The local side is the STAMPED hash of the dist (`stampedDistHash`), not the
 * raw on-disk hash: publish's write-through recorded the hash AFTER
 * `writeDistManifest` re-stamped dist/package.json (rebase bin/exports, drop
 * files/devDeps — see BUG-BUILD-PUBLISH-DISTMANIFEST-CLOBBERED-001), so only
 * a stamped comparison is apples-to-apples. A raw comparison would falsely
 * refuse a worktree whose dist is byte-identical to the published artifact
 * but whose manifest happens to be in build-clobbered shape (verified live:
 * backlog/apigen-cli/decompile-cli/agent-mcp raw-hash differ but stamped-hash
 * match the committed published-state.json).
 *
 * @param {{ pkg: { name: string, version: string }, distDir: string, workspaceRoot: string,
 *           reconcilePkg?: ({ name: string, version: string, distDir: string, workspaceRoot: string }) => Promise<{ entry?: object | null, error?: string }> }} args
 * @returns {Promise<{ ok: boolean, error?: string, note?: string }>}
 */
export async function contentGate({ pkg, distDir, workspaceRoot, reconcilePkg = defaultReconcilePkg }) {
  if (!existsSync(distDir)) {
    return {
      ok: false,
      error: `no local dist at ${distDir} — cannot verify this worktree's content matches published ${pkg.name}@${pkg.version}; run the release/build first`,
    };
  }
  let entry = readState(workspaceRoot)[pkg.name];
  if (!entry || entry.version !== pkg.version) {
    // Cache miss for THIS version (no entry, or an entry for a different
    // version) — backfill the authoritative published baseline from the
    // registry, like compare-published's consumers do on a miss. The
    // backfilled hash is what rule 2 compares against, so the incident shape
    // (published @adhd/backlog@0.1.4 pre-turso vs a worktree holding turso
    // code under the same 0.1.4 string) is refused here exactly as it would
    // be with a committed entry.
    let backfill;
    try {
      backfill = await reconcilePkg({ name: pkg.name, version: pkg.version, distDir, workspaceRoot });
    } catch (err) {
      console.error(`sync-global: WARNING ${pkg.name}@${pkg.version}: published-state backfill threw (${err.message}) — proceeding on the version gate only`);
      return { ok: true, note: 'backfill unavailable — proceeding on the version gate only' };
    }
    if (backfill.error || !backfill.entry) {
      console.error(`sync-global: WARNING ${pkg.name}@${pkg.version}: published-state backfill ${backfill.error ? `failed (${backfill.error})` : 'returned no entry'} — proceeding on the version gate only`);
      return { ok: true, note: 'backfill unavailable — proceeding on the version gate only' };
    }
    entry = backfill.entry;
  }
  if (!entry.normalizedHash) {
    // An entry with no hash (e.g. an ancient or hand-written one) cannot gate
    // on content — degrade to today's behavior rather than block.
    return { ok: true, note: `published-state entry for ${pkg.name} has no normalizedHash — proceeding on the version gate only` };
  }
  let localHash;
  try {
    localHash = stampedDistHash(distDir, pkg);
  } catch (err) {
    return { ok: false, error: `cannot hash local dist ${distDir} (${err.message}) — refusing to flip to the published artifact` };
  }
  if (entry.normalizedHash === localHash) return { ok: true };
  return {
    ok: false,
    error: `worktree ahead of published content — run release first (local dist ${localHash} != published-state ${entry.normalizedHash} for ${pkg.name}@${pkg.version})`,
  };
}

/** Default registry gate: `npm view <name>@<version> version`. Non-zero exit (not found) -> ''. */
async function defaultNpmView(name, version) {
  const res = spawnSync('npm', ['view', `${name}@${version}`, 'version'], { encoding: 'utf8', timeout: 60_000 });
  if (res.error) throw res.error; // spawn failure (npm missing) = internal
  if (res.status !== 0) return ''; // not on the registry yet (partial publish)
  return (res.stdout || '').trim();
}

/** Default sync: `pnpm add -g <name>@<version>` (atomic global install). Non-zero exit -> { ok: false }. */
async function defaultPnpmAdd(name, version, cwd) {
  const res = spawnSync('pnpm', ['add', '-g', `${name}@${version}`], { cwd, stdio: 'inherit', timeout: 300_000 });
  if (res.error) throw res.error; // spawn failure (pnpm missing) = internal
  return { ok: res.status === 0 };
}

/**
 * BUG-027: `verified=true`/`verified=false` render as-is (both are real
 * currency claims post-fix — `verified=true` means "this global install was
 * checked against the published version and matches", not merely "no stale
 * link found"). `verified: null` (the `not-installed` action) renders as
 * `verified=n/a (not installed — nothing to verify)` so it can never be
 * misread as a currency claim about a package that was never checked because
 * it isn't installed globally at all.
 */
function printSummary(summary) {
  console.error('\nsync-global summary:');
  if (summary.length === 0) {
    console.error('  (no bin-shipping entrypoint packages processed)');
    return;
  }
  for (const row of summary) {
    const bins = `[${row.bins.join(', ')}]`;
    const verifiedStr = row.verified === null ? 'n/a (not installed — nothing to verify)' : String(row.verified);
    console.error(
      `  ${String(row.pkg).padEnd(28)} ${String(row.version).padEnd(10)} ${bins.padEnd(36)} ${row.action.padEnd(12)} verified=${verifiedStr}` +
        (row.dryRun ? '  (dry-run)' : '')
    );
  }
}

/**
 * The driver — runs the full detect -> gate -> sync -> verify pipeline for
 * every bin-shipping entrypoint (see the file header). Returns the
 * `SyncSummary`:
 *
 *   [{ pkg: string, version: string, bins: string[],
 *      action: 'synced' | 'skipped' | 'refused' | 'current' | 'not-installed',
 *      verified: boolean | null, dryRun?: true }]
 *
 *   - `not-installed`: no bin shim exists for this package at all — nothing
 *     to enforce. `verified: null` (NOT `true` — BUG-027: this must never be
 *     read as a currency claim about a package that was never checked).
 *   - `current`: a bin shim exists, is not a link shim, and its global-store
 *     version already equals the published version — a REAL currency claim.
 *     `verified: true`.
 *   - `skipped`: version not on the registry yet (partial-publish gate), OR
 *     dry-run WOULD (in which case `dryRun: true` is also set).
 *   - `refused`: BUG-004 content gate — the worktree's dist does NOT match
 *     the published artifact's content at the same version string (or no
 *     local dist exists to verify). NEVER flips; `verified: false`. Logged
 *     as an ERROR line. This is the incident shape (published backlog@0.1.4
 *     pre-turso flipped while the worktree held turso code under the same
 *     0.1.4 string) — a refusal here is the fix, not a noise failure.
 *   - `synced`: `pnpm add -g` ran, triggered by EITHER a stale link shim OR
 *     BUG-027 version drift (an ordinary, non-link global install on an
 *     older version than what was just published); `verified` is the
 *     post-sync verification result (false -> backups were restored and an
 *     ERROR was logged, and `computeExitCode` makes the overall run fail).
 *
 * Sync failures never throw — they log ERROR and are reflected in the
 * summary. Only internal failures (unreadable manifest, spawn failure of
 * npm/pnpm, unexpected exceptions) propagate.
 *
 * TEST SEAM (documented deviation): the spec'd signature is
 * `{ workspaceRoot, pnpmGlobalBinDir, projects, dryRun }`; `npmView`,
 * `pnpmAdd`, `globalDir`, and `reconcilePkg` are OPTIONAL extra keys used
 * only to make the registry-gate/sync/verify/content-gate branches
 * unit-testable without touching real globals or the network. When omitted,
 * the defaults above reproduce production behavior exactly.
 *
 * @param {{ workspaceRoot: string, pnpmGlobalBinDir: string, projects?: string[] | null, dryRun?: boolean,
 *           npmView?: (name: string, version: string) => Promise<string>,
 *           pnpmAdd?: (name: string, version: string) => Promise<{ ok: boolean }>,
 *           globalDir?: string,
 *           reconcilePkg?: ({ name: string, version: string, distDir: string, workspaceRoot: string }) => Promise<{ entry?: object, error?: string }> }} opts
 * @returns {Promise<Array<{ pkg: string, version: string, bins: string[], action: string, verified: boolean, dryRun?: boolean }>>}
 */
export async function syncGlobalShims({
  workspaceRoot,
  pnpmGlobalBinDir,
  projects = null,
  dryRun = false,
  npmView = defaultNpmView,
  pnpmAdd = defaultPnpmAdd,
  globalDir = undefined,
  reconcilePkg = defaultReconcilePkg,
}) {
  const view = npmView;
  const add = pnpmAdd || ((name, version) => defaultPnpmAdd(name, version, workspaceRoot));
  const pnpmGlobalDir = globalDir || resolvePnpmGlobalDir(pnpmGlobalBinDir);
  const summary = [];
  const projectSet = projects && projects.length > 0 ? new Set(projects) : null;
  const entrypointDir = join(workspaceRoot, 'entrypoint');

  console.error(`sync-global: workspace root: ${workspaceRoot}`);
  console.error(`sync-global: pnpm global bin dir: ${pnpmGlobalBinDir}${dryRun ? ' (dry-run — nothing will be modified)' : ''}`);
  console.error(`sync-global: pnpm global dir (post-sync verify target): ${pnpmGlobalDir}`);

  let entries;
  try {
    entries = existsSync(entrypointDir) ? readdirSync(entrypointDir).sort() : [];
  } catch (err) {
    throw new Error(`sync-global: cannot read entrypoint dir ${entrypointDir}: ${err.message}`);
  }

  for (const dirName of entries) {
    if (projectSet && !projectSet.has(dirName)) continue;
    const pkgJsonPath = join(entrypointDir, dirName, 'package.json');
    if (!existsSync(pkgJsonPath)) continue;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    } catch (err) {
      throw new Error(`sync-global: cannot parse ${pkgJsonPath}: ${err.message}`);
    }
    if (!pkg.name || !pkg.bin) continue;
    const bins = typeof pkg.bin === 'string' ? { [pkg.name.split('/').pop()]: pkg.bin } : pkg.bin;

    // Step 1 — detect stale link shims (content references the workspace) AND
    // whether the package is installed globally at all.
    const stale = [];
    const installedBins = [];
    for (const binName of Object.keys(bins)) {
      const shimPath = join(pnpmGlobalBinDir, binName);
      let shimContent = null;
      try {
        if (existsSync(shimPath)) shimContent = readFileSync(shimPath, 'utf8');
      } catch {
        shimContent = null; // unreadable shim — not provably stale
      }
      if (shimContent === null) continue; // not installed globally at all — nothing to enforce
      installedBins.push(binName);
      if (shimContent.includes(workspaceRoot)) stale.push({ binName, shimPath });
    }

    // Step 1.5 (BUG-027) — VERSION CURRENCY CHECK for a NORMAL (non-link)
    // global install. A stale link shim is not the only way the operator's
    // CLI can be left behind: `pnpm add -g <name>@<oldVersion>` installs a
    // real registry tarball whose shim content never references the
    // workspace, so the step-1 link-detection above correctly reports it
    // "not stale" — but that says nothing about whether it's the CURRENT
    // published version. Incident: `@adhd/backlog` was installed globally as
    // a normal (non-link) 0.1.7 tarball; 0.1.8 published clean, GATE 2
    // (clean-room-smoke) passed, sync-global logged "no stale global link"
    // and reported `verified=true` — but the operator's CLI stayed on 0.1.7
    // (missing the BUG-020 singleton-lock fix) until someone manually ran
    // `pnpm add -g`. `verified=true` here was never a currency claim; it
    // only meant "no link shim" — this check is what makes it one. When any
    // installed (non-link) bin's package.json version in the global store
    // differs from the source version, treat the package as needing sync
    // exactly like a stale link shim — same registry/content gates, same
    // `pnpm add -g` sync, same post-verify, same fail-safe restore.
    let versionDrift = false;
    let installedVersion = null;
    if (stale.length === 0 && installedBins.length > 0) {
      const globalPkgJsonPath = join(pnpmGlobalDir, 'node_modules', pkg.name, 'package.json');
      if (existsSync(globalPkgJsonPath)) {
        try {
          installedVersion = JSON.parse(readFileSync(globalPkgJsonPath, 'utf8')).version;
        } catch {
          installedVersion = null; // unreadable global manifest — can't prove drift, don't force a sync
        }
      }
      if (installedVersion && installedVersion !== pkg.version) versionDrift = true;
    }

    if (stale.length === 0 && !versionDrift) {
      if (installedBins.length === 0) {
        console.error(`sync-global: ${pkg.name}: not installed globally (no bin shim(s) found) — nothing to verify`);
        summary.push({ pkg: pkg.name, version: pkg.version, bins: Object.keys(bins), action: 'not-installed', verified: null });
      } else {
        console.error(`sync-global: ${pkg.name}: global install is CURRENT (${installedVersion ?? pkg.version}), no stale link — verified`);
        summary.push({ pkg: pkg.name, version: pkg.version, bins: installedBins, action: 'current', verified: true });
      }
      continue;
    }

    // Unify the two trigger reasons (stale link vs version drift) into one
    // list of {binName, shimPath} for the shared sync/backup/verify pipeline
    // below — `stale` from here on means "needs syncing", regardless of why.
    const linkStale = stale.length > 0;
    if (!linkStale && versionDrift) {
      for (const binName of installedBins) stale.push({ binName, shimPath: join(pnpmGlobalBinDir, binName) });
    }
    const staleBins = stale.map((s) => s.binName);
    if (linkStale) {
      console.error(
        `sync-global: ${pkg.name}: stale global link detected for bin(s) [${staleBins.join(', ')}] — ` +
          `shim(s) reference the workspace: ${stale.map((s) => s.shimPath).join(', ')}`
      );
    } else {
      console.error(
        `sync-global: ${pkg.name}: global install is STALE — installed version ${installedVersion} != published ${pkg.version} ` +
          `for bin(s) [${staleBins.join(', ')}] — this is what left BUG-020 inert (BUG-027)`
      );
    }

    // Step 2 — partial-publish gate: only sync versions the registry has.
    let published;
    try {
      published = await view(pkg.name, pkg.version);
    } catch (err) {
      throw new Error(`sync-global: registry check for ${pkg.name}@${pkg.version} failed (npm view spawn error): ${err.message}`);
    }
    if (published !== pkg.version) {
      console.error(
        `sync-global: SKIP ${pkg.name}@${pkg.version}: not on registry yet (npm view resolved "${published || 'nothing'}") — partial publish; will sync once it lands`
      );
      summary.push({ pkg: pkg.name, version: pkg.version, bins: staleBins, action: 'skipped', verified: false });
      continue;
    }
    console.error(`sync-global: ${pkg.name}@${pkg.version}: confirmed on registry (npm view)`);

    // Step 2.5 — BUG-004 content gate: the version string being on the
    // registry is NOT proof the worktree's dist matches the published
    // artifact. The incident: published @adhd/backlog@0.1.4 (pre-turso,
    // better-sqlite3) was flipped while this worktree held turso-adapter
    // code under the same 0.1.4 string — breaking the CLI against the live
    // store (SQLITE_CORRUPT). Only flip when the local dist's STAMPED
    // content hash equals the published artifact's hash; refuse otherwise
    // and NEVER flip to the stale artifact. See `contentGate`'s doc comment.
    const distDir = join(entrypointDir, dirName, 'dist');
    const gate = await contentGate({ pkg, distDir, workspaceRoot, reconcilePkg });
    if (!gate.ok) {
      console.error(`sync-global: ERROR ${pkg.name}@${pkg.version}: ${gate.error} — skipping sync, shim(s) [${staleBins.join(', ')}] left untouched`);
      summary.push({ pkg: pkg.name, version: pkg.version, bins: staleBins, action: 'refused', verified: false });
      continue;
    }
    if (gate.note) console.error(`sync-global: ${pkg.name}@${pkg.version}: ${gate.note}`);

    // Step 3 — dry-run: show the intent, touch nothing.
    if (dryRun) {
      console.error(`sync-global: WOULD run: pnpm add -g ${pkg.name}@${pkg.version} (dry-run — no changes made)`);
      summary.push({ pkg: pkg.name, version: pkg.version, bins: staleBins, action: 'skipped', verified: false, dryRun: true });
      continue;
    }

    // Step 4 — sync: back up every stale shim (rollback point), then the
    // atomic global install (rewrites ALL of the package's bin shims).
    const ts = Date.now();
    const backups = stale.map((s) => ({
      binName: s.binName,
      shimPath: s.shimPath,
      backupPath: `${s.shimPath}.pre-sync-${ts}`,
    }));
    let backupFailed = false;
    for (const b of backups) {
      try {
        copyFileSync(b.shimPath, b.backupPath);
        console.error(`sync-global: backed up ${b.shimPath} -> ${b.backupPath}`);
      } catch (err) {
        console.error(`sync-global: ERROR ${pkg.name}: cannot back up ${b.shimPath} (${err.message}) — skipping this package, nothing changed`);
        backupFailed = true;
        break;
      }
    }
    if (backupFailed) {
      summary.push({ pkg: pkg.name, version: pkg.version, bins: staleBins, action: 'skipped', verified: false });
      continue;
    }

    console.error(`sync-global: running: pnpm add -g ${pkg.name}@${pkg.version}`);
    let addResult;
    try {
      addResult = await add(pkg.name, pkg.version);
    } catch (err) {
      addResult = { ok: false, error: err };
    }
    if (!addResult.ok) {
      console.error(
        `sync-global: ERROR ${pkg.name}@${pkg.version}: pnpm add -g failed` +
          (addResult.error ? ` (${addResult.error.message})` : '') +
          ` — restoring ${backups.length} backup(s). ` +
          `THE OPERATOR'S GLOBAL CLI IS STILL STALE — run manually: pnpm add -g ${pkg.name}@${pkg.version}`
      );
      restoreBackups(backups);
      summary.push({ pkg: pkg.name, version: pkg.version, bins: staleBins, action: 'synced', verified: false });
      continue;
    }

    // Step 5 — post-verify every stale bin; on any failure, restore.
    const allVerified = stale.every((s) =>
      verifyShim({ pkg, binName: s.binName, shimPath: s.shimPath, workspaceRoot, pnpmGlobalDir })
    );
    if (allVerified) {
      console.error(
        `sync-global: OK ${pkg.name}@${pkg.version}: ${staleBins.length} shim(s) verified — no workspace refs, global store version ${pkg.version}`
      );
      summary.push({ pkg: pkg.name, version: pkg.version, bins: staleBins, action: 'synced', verified: true });
    } else {
      console.error(
        `sync-global: ERROR ${pkg.name}@${pkg.version}: post-sync verification failed — restoring ${backups.length} backup(s). ` +
          `THE OPERATOR'S GLOBAL CLI IS STILL STALE — run manually: pnpm add -g ${pkg.name}@${pkg.version}`
      );
      restoreBackups(backups);
      summary.push({ pkg: pkg.name, version: pkg.version, bins: staleBins, action: 'synced', verified: false });
    }
  }

  printSummary(summary);
  return summary;
}

/**
 * BUG-027 — decide the process exit code from the summary. A release must
 * NEVER report success while the operator's global CLI is left unverified
 * current. Non-zero iff any row represents an UNRESOLVED currency problem:
 *   - `refused`  — the content gate blocked a flip (worktree/published mismatch).
 *   - `synced` with `verified: false` — an upgrade was ATTEMPTED and failed
 *     (pnpm add -g failed, or post-sync verification failed) — the exact
 *     BUG-027 shape: an outdated global install that stayed outdated.
 * Deliberately NOT included: `skipped` (registry doesn't have the version
 * yet — a partial-publish timing issue, not a currency failure; or a
 * dry-run WOULD, which never attempted anything), `not-installed` (nothing
 * to enforce), `current`/`unchanged` (already verified true).
 *
 * @param {Array<{ action: string, verified: boolean | null, dryRun?: boolean }>} summary
 * @returns {number} 0 or 1
 */
export function computeExitCode(summary) {
  const unresolved = summary.filter(
    (row) => row.action === 'refused' || (row.action === 'synced' && row.verified === false)
  );
  return unresolved.length > 0 ? 1 : 0;
}

/** @param {string[]} argv */
function parseCliArgs(argv) {
  const args = { projects: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') {
      args.dryRun = true;
    } else if (a === '--projects') {
      args.projects = ((argv[++i] ?? '').split(',') || []).filter(Boolean);
    } else if (a.startsWith('--projects=')) {
      args.projects = a.slice('--projects='.length).split(',').filter(Boolean);
    } else {
      throw new Error(
        `sync-global: unknown argument "${a}" — usage: node sync-global.mjs [--projects=a,b,c] [--dry-run]`
      );
    }
  }
  return args;
}

async function main() {
  let args;
  try {
    args = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
    return;
  }
  const workspaceRoot = findRoot(dirname(fileURLToPath(import.meta.url)));
  // global bin dir: `pnpm config get global-bin-dir` || ~/Library/pnpm
  const configuredBinDir = pnpmConfigGet('global-bin-dir');
  const pnpmGlobalBinDir = configuredBinDir || join(homedir(), 'Library', 'pnpm');
  let summary;
  try {
    summary = await syncGlobalShims({ workspaceRoot, pnpmGlobalBinDir, projects: args.projects, dryRun: args.dryRun });
  } catch (err) {
    console.error(`sync-global: INTERNAL FAILURE: ${err && err.stack ? err.stack : String(err)}`);
    process.exit(1);
    return;
  }
  // BUG-027: exit non-zero when any package ended UNRESOLVED (content-gate
  // refusal, or an attempted upgrade that failed/didn't verify) — the whole
  // point of this fix is that this can no longer be silently advisory.
  const exitCode = computeExitCode(summary);
  if (exitCode !== 0) {
    console.error(
      '\nsync-global: FAILED — the operator global CLI for one or more packages could not be verified current. ' +
        'See the ERROR line(s) above for the exact `pnpm add -g <name>@<version>` remediation command.'
    );
  }
  process.exit(exitCode);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    console.error(`sync-global: INTERNAL FAILURE: ${err && err.stack ? err.stack : String(err)}`);
    process.exit(1);
  });
}
