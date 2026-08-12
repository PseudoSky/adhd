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
 *   1. DETECT — a shim is "stale" iff it exists in the pnpm global bin dir
 *      AND its content includes the workspace root path (a link shim).
 *      Shims that don't reference the workspace are already pointing at
 *      published artifacts (or nothing) — left alone.
 *   2. GATE — `npm view <name>@<version> version` must return exactly the
 *      on-disk source version. This is the partial-publish gate: a package
 *      whose version isn't on the registry yet (e.g. an upstream publish in
 *      the same release failed) is SKIPPED, never half-flipped.
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
 * EXIT CODE CONTRACT (advisory — it must never fail the release):
 *   exit 0 — the script ran to completion. Sync-level failures (registry
 *            gate, `pnpm add -g` failing, post-verify failing + restore)
 *            are logged as `ERROR` lines but do NOT change the exit code.
 *   exit 1 — internal failure only: an unexpected exception, an unreadable
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
 * Testability: `detectStaleShims`, `syncGlobalShims`, `verifyShim`, and
 * `resolvePnpmGlobalDir` are exported and pure-ish (temp-fixture friendly);
 * `syncGlobalShims` additionally accepts optional `npmView` / `pnpmAdd` /
 * `globalDir` overrides so the registry-gate, sync, and verify branches are
 * unit-testable WITHOUT ever touching real globals or the network — the
 * defaults reproduce production behavior exactly (see the spec file).
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

function printSummary(summary) {
  console.error('\nsync-global summary:');
  if (summary.length === 0) {
    console.error('  (no bin-shipping entrypoint packages processed)');
    return;
  }
  for (const row of summary) {
    const bins = `[${row.bins.join(', ')}]`;
    console.error(
      `  ${String(row.pkg).padEnd(28)} ${String(row.version).padEnd(10)} ${bins.padEnd(36)} ${row.action.padEnd(10)} verified=${row.verified}` +
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
 *      action: 'synced' | 'skipped' | 'unchanged', verified: boolean,
 *      dryRun?: true }]
 *
 *   - `unchanged`: no stale global link (nothing to do; `verified: true`).
 *   - `skipped`: version not on the registry yet (partial-publish gate), OR
 *     dry-run WOULD (in which case `dryRun: true` is also set).
 *   - `synced`: `pnpm add -g` ran; `verified` is the post-sync verification
 *     result (false -> backups were restored and an ERROR was logged).
 *
 * Sync failures never throw — they log ERROR and are reflected in the
 * summary. Only internal failures (unreadable manifest, spawn failure of
 * npm/pnpm, unexpected exceptions) propagate.
 *
 * TEST SEAM (documented deviation): the spec'd signature is
 * `{ workspaceRoot, pnpmGlobalBinDir, projects, dryRun }`; `npmView`,
 * `pnpmAdd`, and `globalDir` are OPTIONAL extra keys used only to make the
 * registry-gate/sync/verify branches unit-testable without touching real
 * globals or the network. When omitted, the defaults above reproduce
 * production behavior exactly.
 *
 * @param {{ workspaceRoot: string, pnpmGlobalBinDir: string, projects?: string[] | null, dryRun?: boolean,
 *           npmView?: (name: string, version: string) => Promise<string>,
 *           pnpmAdd?: (name: string, version: string) => Promise<{ ok: boolean }>,
 *           globalDir?: string }} opts
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

    // Step 1 — detect stale link shims (content references the workspace).
    const stale = [];
    for (const binName of Object.keys(bins)) {
      const shimPath = join(pnpmGlobalBinDir, binName);
      let shimContent = null;
      try {
        if (existsSync(shimPath)) shimContent = readFileSync(shimPath, 'utf8');
      } catch {
        shimContent = null; // unreadable shim — not provably stale
      }
      if (shimContent !== null && shimContent.includes(workspaceRoot)) stale.push({ binName, shimPath });
    }
    if (stale.length === 0) {
      console.error(`sync-global: ${pkg.name}: no stale global link`);
      summary.push({ pkg: pkg.name, version: pkg.version, bins: Object.keys(bins), action: 'unchanged', verified: true });
      continue;
    }
    const staleBins = stale.map((s) => s.binName);
    console.error(
      `sync-global: ${pkg.name}: stale global link detected for bin(s) [${staleBins.join(', ')}] — ` +
        `shim(s) reference the workspace: ${stale.map((s) => s.shimPath).join(', ')}`
    );

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
          ` — restoring ${backups.length} backup(s)`
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
        `sync-global: ERROR ${pkg.name}@${pkg.version}: post-sync verification failed — restoring ${backups.length} backup(s)`
      );
      restoreBackups(backups);
      summary.push({ pkg: pkg.name, version: pkg.version, bins: staleBins, action: 'synced', verified: false });
    }
  }

  printSummary(summary);
  return summary;
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
  try {
    await syncGlobalShims({ workspaceRoot, pnpmGlobalBinDir, projects: args.projects, dryRun: args.dryRun });
  } catch (err) {
    console.error(`sync-global: INTERNAL FAILURE: ${err && err.stack ? err.stack : String(err)}`);
    process.exit(1);
    return;
  }
  // Sync-level errors were advisory (ERROR lines above) — exit 0 by contract.
  process.exit(0);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    console.error(`sync-global: INTERNAL FAILURE: ${err && err.stack ? err.stack : String(err)}`);
    process.exit(1);
  });
}
