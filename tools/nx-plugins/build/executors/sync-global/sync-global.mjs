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
 * REVISION (2026-09-25) — the following defects closed in one pass; the whole
 * point is that the operator's global CLI can no longer be reported current
 * while it is stale, and can no longer be invisible because its name differs
 * from the package's declared bin OR because it points at a DIFFERENT checkout:
 *
 *   A. BIN-KEYING (BUG f1dece41) — detection/currency used to iterate the
 *      entrypoint's DECLARED `pkg.bin` keys only. The live production shim is
 *      named `backlog` while @adhd/backlog now declares `adhd-backlog`, so the
 *      executor reported `not-installed` for a shim that plainly exists — and
 *      could never repair it. `discoverPackageBins` now unions (1) the
 *      declared bin names, (2) the INSTALLED `<modulesDir>/<pkg.name>/
 *      package.json`.`bin` names, and (3) any `binDir` entry whose content
 *      references this package (its `<modulesDir>/<pkg.name>` path, or the
 *      workspace root together with the package's unscoped name as a path
 *      segment). Detection and the sync path both use it.
 *
 *   B. CURRENCY ASSERTION (BUG bea4bfe1, CRITICAL) — `current` was reported
 *      (and `verified=true` printed) from `installedVersion ?? pkg.version`,
 *      i.e. the script would print the PUBLISHED version while the INSTALLED
 *      tree held an older one, or held nothing at all. Currency is now a claim
 *      about the INSTALLED tree ONLY: `current` requires the installed
 *      `<modulesDir>/<pkg.name>/package.json` to be readable AND its version to
 *      equal `pkg.version`. Missing/unreadable ⇒ `action:'unverifiable'`,
 *      `verified:false` (never a false currency claim). Every row carries
 *      `installedVersion` and `targetVersion` so the two can never be conflated
 *      in one column.
 *
 *   C. MULTI-ROOT (DEBT ab4d0864) — the script used to scan only the pnpm
 *      global bin dir. It now loops `discoverGlobalRoots()`: the pnpm global
 *      root, the `npm prefix -g` root, and every existing NVM node version
 *      root. Each (package, root) pair produces its own row and is repaired by
 *      its own manager — `pnpm add -g` for pnpm roots, `npm i -g` (with
 *      `npm_config_prefix` + PATH from `execEnv`) for npm/NVM roots.
 *
 *   D. SOURCE-LINK DETECTION + HONEST LEGACY VERDICT (review HIGH-1, HIGH-2,
 *      MEDIUM-3, LOW-7, LOW-8; 2026-09-25 v2) —
 *      * HIGH-1: detection used to claim a source link only when the shim's
 *        content contained the RUNNING `workspaceRoot`, so a shim execing a
 *        SIBLING worktree (or the main checkout, when run from a worktree)
 *        was invisible → `not-installed`, exit 0. A shim is now claimed when
 *        its content references ANY checkout's `entrypoint/<dir>/dist`
 *        (`containsEntrypointSource`), independent of the running root.
 *      * HIGH-2: a detected-but-unrewritable LEGACY shim used to be left in
 *        place while the row reported `synced`/`verified:true`, exit 0. It now
 *        yields `legacy-pending` / `verified:false`, which `computeExitCode`
 *        FAILS — the release cannot report success while a legacy shim
 *        survives.
 *      * MEDIUM-3: a `modulesDir/<pkg.name>` symlink INTO a source worktree
 *        was accepted as the "installed" artifact (the version check read the
 *        SOURCE manifest). `isSourceLink()` realpaths it and rejects a store
 *        path that resolves into an `entrypoint` source tree; such a store is
 *        treated as not-current and repaired.
 *      * LOW-7: a shim that EXISTS but is unreadable is now `unverifiable`
 *        (fails the exit), never silently folded into `not-installed`.
 *      * LOW-8: a `not-installed` row carries `installedVersion: null`, so the
 *        summary can never print `not-installed … installed=1.0.0`.
 *      * MEDIUM-4: the manager-install argv/env construction is the pure
 *        `resolveInstallCommand` (exported), so the exact pnpm / npm-NVM
 *        command + `execEnv` are unit-tested without spawning.
 *
 * REACHABILITY — how a repair actually updates the installed CLI: `install`
 * runs `pnpm add -g <name>@<ver>` / `npm i -g <name>@<ver>` against the root,
 * which rewrites the shim(s) for the package's DECLARED bin names and lands the
 * registry tarball in that root's store; `verifyShim` re-reads the shim (no
 * workspace refs) AND the installed manifest (version match) to prove it. A
 * LEGACY bin name (e.g. the production `backlog` shim, installed when the
 * package still declared `backlog`) is a case `pnpm add -g` CANNOT repair: the
 * installer only ever writes the CURRENT declared names (`adhd-backlog`), so
 * the old shim survives. The script therefore WARNs, names the human-approved
 * quarantine (rename), AND reports the row as `legacy-pending`/`verified:false`
 * — which FAILS the run — rather than pretending it fixed it (HIGH-2).
 *
 * HOW IT WORKS (per entrypoint/* package that declares a `bin`, per root):
 *   1. DETECT — a shim is "stale" for one of THREE reasons:
 *      (a) SOURCE LINK (HIGH-1) — it exists in a discovered root's bin dir AND
 *          its content references a workspace SOURCE tree: this RUNNING root,
 *          OR any sibling worktree / the main checkout
 *          (`.../entrypoint/<dir>/dist/...`). The old test
 *          (`content.includes(workspaceRoot)`) only saw the running root, so a
 *          shim execing a sibling worktree was invisible. Its name may also be
 *          one of the package's discovered bins (see A above).
 *      (b) VERSION DRIFT (BUG-027) — it exists, is NOT a source link, but the
 *          global store's installed `node_modules/<name>/package.json`
 *          version differs from the source version. This is the ordinary
 *          case a plain `pnpm add -g <name>@<oldVersion>` install ends up
 *          in after a release: the shim never referenced the workspace, so
 *          (a) alone reports "no stale link" — which is true but is NOT a
 *          currency claim. Incident: @adhd/backlog@0.1.8 published clean,
 *          GATE 2 passed, this script logged "no stale global link" / summary
 *          `verified=true` — and the operator's CLI stayed on 0.1.7 (missing
 *          the BUG-020 singleton-lock fix) until someone manually upgraded
 *          it.
 *      (c) SOURCE-LINKED STORE (MEDIUM-3) — the store path
 *          `<modulesDir>/<pkg.name>` itself RESOLVES (realpath) into a source
 *          worktree (`isSourceLink`), so the "installed" version check would be
 *          reading the SOURCE manifest. Even at a matching version this is not
 *          an installed registry artifact — it is repaired, not reported
 *          `current`.
 *      A bin with NO shim at all is reported `not-installed` — there is
 *      nothing to enforce, and that is reported distinctly from `current`
 *      (installed + verified current) so `verified=true` can never be misread
 *      as "the operator's CLI is up to date" when nothing was actually
 *      installed to check. All three reasons feed the SAME downstream pipeline
 *      (gates 2/2.5, sync, verify, fail-safe restore) below.
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
 *      on. Nothing is modified; a detected legacy shim yields `legacy-pending`
 *      (never a success-shaped `skipped`), though a dry-run never fails the
 *      exit code.
 *   4. SYNC — backs up every stale shim to `<shim>.pre-sync-<ts>` (the
 *      rollback point), runs the root's manager install (`pnpm add -g <name>@
 *      <exact-version>` for a pnpm root; `npm i -g <name>@<exact-version>` for
 *      an npm/NVM root, with `execEnv` so it targets that root) — an atomic
 *      global install that replaces the link with a registry-tarball install
 *      under the root's store and rewrites the package's DECLARED bin shims —
 *      then POST-VERIFIES with `verifyShim`.
 *   5. FAIL-SAFE — if the post-sync verification fails for any DECLARED bin of
 *      the package, every backup is copied back over its shim (restore) and
 *      an ERROR is logged. If the declared shims verify but a LEGACY shim
 *      remains (which the install cannot rewrite), the flip is left in place
 *      but the row is `legacy-pending`/`verified:false` and the run FAILS —
 *      the release cannot report success while the legacy shim shadows the
 *      CLI (HIGH-2). Verified against pnpm 8.15.9 on macOS 2026-08-12:
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
 *            timing issue, not a currency failure). A `dryRun` row is exempt
 *            regardless of action (a preview never attempted anything).
 *   exit 1 (NEW, `computeExitCode`) — at least one package ended UNRESOLVED:
 *            `refused` (BUG-004 content gate blocked a flip), `unverifiable`
 *            (a shim is present but unreadable, or the installed manifest is
 *            missing/unreadable — no honest currency claim is possible),
 *            `legacy-pending` (HIGH-2: a legacy-named stale shim that no
 *            manager install can rewrite is left in place), or `synced`
 *            with `verified: false` (an upgrade was ATTEMPTED — the manager
 *            install ran — and failed, or post-sync verification failed and the
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
 * Testability: `detectStaleShims`, `discoverPackageBins`, `syncGlobalShims`,
 * `verifyShim`, `resolvePnpmGlobalDir` (re-exported from global-roots.mjs), and
 * `contentGate` are exported and pure-ish (temp-fixture friendly);
 * `syncGlobalShims` additionally accepts optional `npmView` / `pnpmAdd` /
 * `install` / `globalDir` / `roots` / `reconcilePkg` overrides so the
 * registry-gate, content-gate, sync, verify, multi-root, and manager-dispatch
 * branches are unit-testable WITHOUT ever touching real globals or the network
 * — the defaults reproduce production behavior exactly (see the spec file).
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Global install-root discovery (pnpm / npm-prefix / every NVM node version)
// and the pnpm global-dir resolver live in `global-roots.mjs` — imported here
// and `resolvePnpmGlobalDir` re-exported for backward compatibility.
import { discoverGlobalRoots, pnpmConfigGet, resolvePnpmGlobalDir } from './global-roots.mjs';

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

// `pnpmConfigGet` and `resolvePnpmGlobalDir` now live in `global-roots.mjs`
// (imported above). `resolvePnpmGlobalDir` is re-exported here so existing
// importers of this module keep working.
export { resolvePnpmGlobalDir };

/**
 * The bin names a package DECLARES, normalized to a plain array. Object-form
 * `bin` (`{name: path}`) yields its keys; string-form `bin` (`./cli.js`) yields
 * the package's own unscoped name — exactly how npm names it for a string bin.
 *
 * @param {{ name?: string, bin?: string | Record<string,string> } | null | undefined} pkg
 * @returns {string[]}
 */
function declaredBinNames(pkg) {
  if (!pkg || !pkg.bin) return [];
  if (typeof pkg.bin === 'string') {
    const unscoped = pkg.name ? pkg.name.split('/').pop() : null;
    return unscoped ? [unscoped] : [];
  }
  return Object.keys(pkg.bin);
}

/** A binDir entry name that is plausibly a bin shim (not a backup/editor temp). */
function isPlausibleBinName(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name.startsWith('.')) return false;
  if (name.includes('.pre-sync-')) return false;
  // A backup/temp suffix, optionally timestamped: `x.bak`, `x.bak-20260922T…`
  // (the operator's `<file>.bak-<ISO>` convention, e.g. the live
  // `~/Library/pnpm/backlog.bak-20260922T214041Z`), `x.old`, `x.orig`, `x~`…
  if (/\.(bak|old|orig|log|tmp|swp|save)([-.].*)?$/.test(name) || name.endsWith('~')) return false;
  return true;
}

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when `content` contains `name` as a WHOLE path segment (e.g. `/backlog/`,
 * `/backlog"`, or at a string boundary) — so `@adhd/backlog` does not match
 * the content of an unrelated shim that merely happens to contain the
 * substring, while the legacy `backlog` shim (whose content execs
 * `<workspace>/entrypoint/backlog/dist/index.js`) does.
 */
function containsPathSegment(content, name) {
  if (!name) return false;
  return new RegExp(`(^|[/\\\\"'])${escapeRegExp(name)}([/\\\\"']|$)`).test(content);
}

/**
 * True when `content` references a workspace SOURCE entrypoint tree —
 * `<any-root>/entrypoint/<name>/dist/…` — REGARDLESS of which checkout/worktree
 * root the absolute path begins with (`HIGH-1`). The old test was
 * `content.includes(workspaceRoot)`, which only saw a shim that pointed at the
 * RUNNING root: a shim execing a SIBLING worktree (or the main checkout, when
 * run from a worktree) was invisible. Anchoring on the stable
 * `entrypoint/<name>/dist` tail instead of the volatile absolute prefix makes
 * any source-linked shim visible from anywhere. `names` is the package's
 * entrypoint DIRECTORY name and/or its unscoped name.
 *
 * Scoped by NAME so a shared binDir cannot cross-contaminate: an
 * `other-cli` shim (`.../entrypoint/other-cli/dist/...`) is not claimed by
 * `@adhd/backlog` (segment-anchored, so `backlog` never matches `backlog-v2`).
 *
 * @param {string} content a shim's text
 * @param {Array<string | null | undefined>} names entrypoint dir name / unscoped pkg name
 * @returns {boolean}
 */
function containsEntrypointSource(content, names) {
  if (!content) return false;
  for (const n of names) {
    if (!n) continue;
    // `/entrypoint/<name>/dist` then a path/string boundary (/, \, quote, ws, EOL).
    if (new RegExp(`[/\\\\]entrypoint[/\\\\]${escapeRegExp(n)}[/\\\\]dist([/\\\\"']|\\s|$)`).test(content)) return true;
  }
  return false;
}

/**
 * `MEDIUM-3` — true when `p` is (or resolves, through a symlink) to a path
 * INSIDE a workspace SOURCE tree: a `.../entrypoint/<name>` directory. This is
 * the discriminator between "the installed artifact" and "a `pnpm link -g`
 * source link", because a real registry install never resolves through an
 * `entrypoint` path segment — an npm install is a plain dir under
 * `<prefix>/lib/node_modules`, and a pnpm install is a symlink into
 * `<globalDir>/.pnpm/<name>@<ver>/…`. The path is REALPATH'd first, so a
 * `modulesDir/<pkg.name>` symlink pointing at a sibling worktree (this
 * machine's live `~/Library/pnpm/global/5/node_modules/@adhd/backlog` →
 * `.worktrees/restore-min/…`) is correctly rejected, even though the symlink
 * itself has an innocent name.
 *
 * Never throws: an absent/dangling path is not a source link (`false`).
 *
 * @param {string} p
 * @returns {boolean}
 */
export function isSourceLink(p) {
  if (!p) return false;
  let real;
  try {
    real = realpathSync(p);
  } catch {
    return false;
  }
  return /(^|[/\\])entrypoint[/\\][^/\\]+([/\\]|$)/.test(real);
}

/**
 * True when a shim's CONTENT references a workspace SOURCE tree for `pkg` —
 * either this RUNNING `workspaceRoot`, or any checkout/worktree matched by
 * `containsEntrypointSource` (HIGH-1). This is the single predicate
 * `detectStaleShims` and `syncGlobalShims` use to decide a shim is a stale
 * source link.
 *
 * @param {string} content
 * @param {{ pkg?: object, workspaceRoot?: string, entrypointDirName?: string }} ctx
 * @returns {boolean}
 */
function shimReferencesSource(content, { pkg, workspaceRoot, entrypointDirName } = {}) {
  if (!content) return false;
  const unscoped = pkg && pkg.name ? pkg.name.split('/').pop() : null;
  // (i) ANY checkout's `entrypoint/<dir>/dist` — root-independent (HIGH-1).
  if (containsEntrypointSource(content, [entrypointDirName, unscoped])) return true;
  // (ii) the legacy test: this RUNNING root AND the package's unscoped name as
  // a path segment — kept name-scoped so a shared binDir cannot cross-
  // contaminate one package with another's workspace-referencing shim.
  if (workspaceRoot && content.includes(workspaceRoot)) {
    return containsPathSegment(content, unscoped);
  }
  return false;
}

/**
 * Decide whether a binDir entry's CONTENT belongs to `pkg` (BUG f1dece41's
 * "see the real shim" rule). Matches when the content references either
 *   (a) this package's INSTALLED path `join(modulesDir, pkg.name)` — a normal
 *       registry install whose shim points into the store, or
 *   (b) a workspace SOURCE tree for this package — `shimReferencesSource`
 *       (this RUNNING root, or ANY sibling worktree / the main checkout).
 *
 * Scoping to THIS package matters: without it, every package would claim any
 * workspace-referencing shim in the shared binDir (e.g. `apigen-cli` would try
 * to sync the `backlog` shim).
 *
 * @param {string} content
 * @param {{ pkg?: object, modulesDir?: string, workspaceRoot?: string, entrypointDirName?: string }} ctx
 * @returns {boolean}
 */
function contentBelongsToPackage(content, { pkg, modulesDir, workspaceRoot, entrypointDirName }) {
  if (!pkg || !pkg.name || !content) return false;
  if (modulesDir && content.includes(join(modulesDir, pkg.name))) return true;
  return shimReferencesSource(content, { pkg, workspaceRoot, entrypointDirName });
}

/**
 * BIN-KEYING (BUG f1dece41) — the set of bin names that may identify this
 * package's global shim in `binDir`. The union of:
 *   1. the package's SOURCE-declared bin names (`pkg.bin`);
 *   2. the INSTALLED `<modulesDir>/<pkg.name>/package.json`.`bin` names (the
 *      names a registry install actually created — catches a declared-name
 *      change where the store still knows the old name);
 *   3. any `binDir` entry whose CONTENT references this package (see
 *      `contentReferencesPackage`) — catches a LEGACY shim whose name is
 *      neither declared nor recorded in the installed store, e.g. the
 *      production `backlog` shim for a package that now declares
 *      `adhd-backlog`.
 *
 * Pure reads; never throws (unreadable entries are skipped). A `binDir` entry
 * that is too large to be a shim (e.g. the `node` binary in an NVM bin dir) is
 * skipped before reading, so scanning an NVM root is cheap.
 *
 * @param {{ pkg: object, binDir?: string, modulesDir?: string, workspaceRoot?: string, entrypointDirName?: string }} opts
 * @returns {string[]}
 */
export function discoverPackageBins({ pkg, binDir, modulesDir, workspaceRoot, entrypointDirName }) {
  const names = new Set();
  if (!pkg || !pkg.name) return [];
  for (const n of declaredBinNames(pkg)) names.add(n);

  if (modulesDir) {
    const installedPkgJsonPath = join(modulesDir, pkg.name, 'package.json');
    try {
      const installed = JSON.parse(readFileSync(installedPkgJsonPath, 'utf8'));
      for (const n of declaredBinNames(installed)) names.add(n);
    } catch {
      // no readable installed manifest — nothing to add from (2)
    }
  }

  if (binDir && existsSync(binDir)) {
    let dirents = [];
    try {
      dirents = readdirSync(binDir, { withFileTypes: true });
    } catch {
      dirents = [];
    }
    for (const e of dirents) {
      if (!isPlausibleBinName(e.name)) continue;
      if (!e.isFile() && !e.isSymbolicLink()) continue;
      const p = join(binDir, e.name);
      let size = 0;
      try {
        const st = statSync(p);
        if (!st.isFile()) continue;
        size = st.size;
      } catch {
        continue;
      }
      // A shim is ~1 KB. Skip anything large (e.g. the ~117 MB `node` binary
      // that sits in every NVM bin dir) before reading it.
      if (size > 262_144) continue;
      let content;
      try {
        content = readFileSync(p, 'utf8');
      } catch {
        continue;
      }
      if (contentBelongsToPackage(content, { pkg, modulesDir, workspaceRoot, entrypointDirName })) names.add(e.name);
    }
  }

  return [...names];
}

/**
 * Detect every STALE GLOBAL LINK SHIM for this workspace's bin-shipping
 * entrypoints: a shim file in `pnpmGlobalBinDir` whose content references a
 * SOURCE tree for this package — `workspaceRoot` (the old check) OR ANY
 * checkout/worktree's `entrypoint/<dir>/dist` (HIGH-1: a shim execing a
 * sibling worktree / the main checkout is no longer invisible) — OR a shim
 * whose NAME is one of the package's discovered bins (BUG f1dece41: the
 * legacy `backlog` name for a package that now declares `adhd-backlog`).
 * Pure detection: no spawns, no network, never writes.
 *
 * `projects` filters by entrypoint directory name (= nx project name, the
 * same values `run-release.mjs` passes via `--projects=`); when null/empty
 * every entrypoint is scanned. Packages without a `bin` are skipped.
 *
 * `modulesDir` is OPTIONAL: when supplied it lets `discoverPackageBins` also
 * key on the INSTALLED manifest's bin names and on shims that point into the
 * store; when omitted, detection still catches declared-name and
 * workspace-referencing shims.
 *
 * @param {{ workspaceRoot: string, pnpmGlobalBinDir: string, projects?: string[] | null, modulesDir?: string }} opts
 * @returns {Array<{ pkg: object, binName: string, shimPath: string, shimContent: string }>}
 *          one entry per STALE bin shim; `pkg` is the parsed manifest
 *          (`name`/`version`/`bin` for the caller), `shimContent` the full
 *          current shim text.
 */
export function detectStaleShims({ workspaceRoot, pnpmGlobalBinDir, projects = null, modulesDir = undefined }) {
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
    const binNames = discoverPackageBins({ pkg, binDir: pnpmGlobalBinDir, modulesDir, workspaceRoot, entrypointDirName: dirName });
    for (const binName of binNames) {
      const shimPath = join(pnpmGlobalBinDir, binName);
      if (!existsSync(shimPath)) continue;
      let shimContent;
      try {
        shimContent = readFileSync(shimPath, 'utf8');
      } catch {
        continue; // unreadable shim — not provably stale, leave it alone
      }
      if (shimReferencesSource(shimContent, { pkg, workspaceRoot, entrypointDirName: dirName })) {
        stale.push({ pkg, binName, shimPath, shimContent });
      }
    }
  }
  return stale;
}

/**
 * Post-sync verification for one bin shim, all of which must pass:
 *   (a) the shim's content no longer references `workspaceRoot` — i.e.
 *       the manager install rewrote it away from the worktree link;
 *   (b) the root's store `node_modules/<pkg.name>` is NOT a source link
 *       (`isSourceLink`, MEDIUM-3) — a symlink into a worktree would let the
 *       version check below read the SOURCE manifest and falsely pass;
 *   (c) the root's store `node_modules/<pkg.name>/package.json` version
 *       equals the package's source version — i.e. the global install landed
 *       the exact published artifact we asked for.
 * Pure file reads, never throws (a read failure is `false`).
 *
 * `modulesDir` is the packages dir that DIRECTLY contains `<pkg.name>` (the
 * uniform shape across roots: pnpm `<globalDir>/node_modules`, npm
 * `<prefix>/lib/node_modules`). `pnpmGlobalDir` is the legacy pnpm-global-dir
 * form — accepted for backward compatibility, it is joined with `node_modules`
 * to form `modulesDir`. One of the two must be supplied.
 *
 * @param {{ pkg: { name: string, version: string }, binName: string, shimPath: string, workspaceRoot: string, modulesDir?: string, pnpmGlobalDir?: string }} opts
 * @returns {boolean}
 */
export function verifyShim({ pkg, binName, shimPath, workspaceRoot, modulesDir, pnpmGlobalDir }) {
  if (!pkg || !pkg.name || !pkg.version || !shimPath) return false;
  const packagesDir = modulesDir || (pnpmGlobalDir ? join(pnpmGlobalDir, 'node_modules') : null);
  if (!packagesDir) return false;
  let shimContent;
  try {
    shimContent = readFileSync(shimPath, 'utf8');
  } catch {
    return false;
  }
  if (shimContent.includes(workspaceRoot)) return false; // (a)
  // (b) MEDIUM-3: a store path that resolves INTO a source worktree is not a
  // registry install — reject before reading its (source) manifest, which
  // would otherwise make the version check below pass on a dev link.
  const globalPkgDir = join(packagesDir, pkg.name);
  if (isSourceLink(globalPkgDir)) return false;
  const globalPkgJsonPath = join(globalPkgDir, 'package.json');
  if (!existsSync(globalPkgJsonPath)) return false;
  let globalPkg;
  try {
    globalPkg = JSON.parse(readFileSync(globalPkgJsonPath, 'utf8'));
  } catch {
    return false;
  }
  return globalPkg.version === pkg.version; // (c)
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

/**
 * MEDIUM-4 — PURE construction of the manager-install command + env for a root.
 * Extracted from `defaultInstall` so the exact argv and `execEnv` (the
 * `npm_config_prefix` + PATH a version-managed npm root needs, and the
 * preference for that root's OWN npm binary) are unit-testable without
 * spawning anything. `defaultInstall` is a thin spawn around this.
 *
 *   - pnpm roots:   `pnpm add -g <name>@<version>`
 *   - npm/NVM roots: `npm i -g <name>@<version>` — `<root.binDir>/npm` when it
 *     exists (so a version-managed node installs into its own prefix), else
 *     `npm` from PATH — with `<root.execEnv>` merged over `process.env`.
 *
 * @param {{ manager: 'pnpm'|'npm', name: string, version: string, root: object, env?: Record<string,string|undefined> }} args
 * @returns {{ cmd: string, argv: string[], env: Record<string,string|undefined> }}
 */
export function resolveInstallCommand({ manager, name, version, root, env = process.env }) {
  const spec = `${name}@${version}`;
  const mergedEnv = { ...env, ...(root && root.execEnv ? root.execEnv : {}) };
  if (manager === 'pnpm') {
    return { cmd: 'pnpm', argv: ['add', '-g', spec], env: mergedEnv };
  }
  const localNpm = root && root.binDir ? join(root.binDir, 'npm') : null;
  const cmd = localNpm && existsSync(localNpm) ? localNpm : 'npm';
  return { cmd, argv: ['i', '-g', spec], env: mergedEnv };
}

/**
 * Default manager install — the REACHABILITY seam. Runs inside `workspaceRoot`:
 *   - pnpm roots:  `pnpm add -g <name>@<version>`
 *   - npm / NVM roots: `npm i -g <name>@<version>` with the root's `execEnv`
 *     (`npm_config_prefix` + PATH), preferring that root's OWN npm binary so a
 *     version-managed node installs into its own prefix.
 * The install rewrites the package's DECLARED bin shims in that root and lands
 * the registry tarball in its store. Non-zero exit -> { ok: false }; a spawn
 * failure throws (internal). Command/env construction lives in the pure
 * `resolveInstallCommand` (MEDIUM-4).
 *
 * NOTE (reachability): it can only ever write the package's CURRENT declared
 * bin names. A legacy shim under an OLD name (e.g. `backlog` for a package that
 * now declares `adhd-backlog`) is NOT touched by this install — see the WARN in
 * `syncGlobalShims` and the quarantine note in PUBLISHING.md.
 *
 * @param {{ manager: 'pnpm'|'npm', name: string, version: string, root: object, workspaceRoot: string }} args
 * @returns {Promise<{ ok: boolean }>}
 */
async function defaultInstall({ manager, name, version, root, workspaceRoot }) {
  const { cmd, argv, env } = resolveInstallCommand({ manager, name, version, root });
  const res = spawnSync(cmd, argv, { cwd: workspaceRoot, env, stdio: 'inherit', timeout: 300_000 });
  if (res.error) throw res.error; // spawn failure (manager missing) = internal
  return { ok: res.status === 0 };
}

/**
 * Render one line per (package, root). `verified=true`/`false` are real
 * currency claims; `verified: null` (the `not-installed` action) renders as
 * `n/a` so it can never be misread. `installed=` and `target=` are SEPARATE
 * columns (BUG bea4bfe1: the two must never be conflated in one, so a
 * `verified=true` line can never again show the target while the install is
 * old).
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
    const installed = row.installedVersion == null ? '—' : String(row.installedVersion);
    const target = String(row.targetVersion ?? row.version);
    console.error(
      `  ${String(row.pkg).padEnd(26)} ${String(row.root || '').padEnd(22)} ${bins.padEnd(30)} ` +
        `installed=${installed.padEnd(10)} target=${target.padEnd(10)} ${row.action.padEnd(12)} verified=${verifiedStr}` +
        (row.dryRun ? '  (dry-run)' : '')
    );
  }
}

/**
 * The driver — runs the full detect -> gate -> sync -> verify pipeline for
 * every (bin-shipping entrypoint, root) pair (see the file header). Returns
 * `SyncSummary`, ONE ROW PER PAIR:
 *
 *   [{ pkg: string, root: string, version: string, targetVersion: string,
 *      installedVersion: string | null, bins: string[],
 *      action: 'synced'|'skipped'|'refused'|'unverifiable'|'legacy-pending'|'current'|'not-installed',
 *      verified: boolean | null, dryRun?: true }]
 *
 *   - `not-installed`: no bin shim exists for this package in this root —
 *     nothing to enforce. `verified: null` (NOT `true` — BUG-027: never a
 *     currency claim about a package that was never installed) and
 *     `installedVersion: null` (LOW-8: a readable store manifest may exist
 *     while NO shim does — the row must not then read
 *     `not-installed … installed=1.0.0`).
 *   - `current`: the root's INSTALLED manifest `<modulesDir>/<pkg.name>/
 *     package.json` is readable, is NOT a source link, AND its version equals
 *     `pkg.version` — the ONLY honest currency claim. `verified: true`.
 *   - `unverifiable`: a shim IS present but unreadable (LOW-7), or the
 *     installed manifest is missing/unreadable — no honest currency claim is
 *     possible (BUG bea4bfe1: replaces the old `installedVersion ?? pkg.version`
 *     false `current`). `verified: false`; `computeExitCode` FAILS on it.
 *   - `skipped`: version not on the registry yet (partial-publish gate), OR
 *     dry-run WOULD (in which case `dryRun: true` is also set).
 *   - `refused`: BUG-004 content gate — the worktree's dist does NOT match the
 *     published artifact's content at the same version string. NEVER flips;
 *     `verified: false`.
 *   - `legacy-pending` (HIGH-2): a detected legacy-named stale shim (a name
 *     the package does not declare) that NO manager install can rewrite is
 *     left in place. `verified: false`; `computeExitCode` FAILS on it — the
 *     release cannot report success while the legacy shim shadows the CLI.
 *   - `synced`: the root's manager install ran, triggered by a stale source
 *     link (HIGH-1), BUG-027 version drift, or a source-linked store
 *     (MEDIUM-3); `verified` is the post-sync verification result (false ->
 *     backups were restored and an ERROR was logged, and `computeExitCode`
 *     makes the overall run fail).
 *
 * ROOTS: `roots` overrides the discovered set. When omitted, a single pnpm root
 * is built from `pnpmGlobalBinDir` (+ `globalDir`) if that is supplied, else
 * `discoverGlobalRoots()` enumerates every pnpm / npm-prefix / NVM root.
 *
 * TEST SEAMS (documented deviation): `npmView`, `install`, `pnpmAdd`
 * (legacy adapter), `globalDir`, `roots`, and `reconcilePkg` are OPTIONAL extra
 * keys used only to make the registry-gate/sync/verify/content-gate/multi-root/
 * manager-dispatch branches unit-testable without touching real globals or the
 * network. When omitted, the defaults reproduce production behavior exactly.
 *
 * @param {{ workspaceRoot: string, pnpmGlobalBinDir?: string, projects?: string[] | null, dryRun?: boolean,
 *           roots?: Array<{ manager: 'pnpm'|'npm', label: string, binDir: string, modulesDir: string, execEnv?: object }>,
 *           npmView?: (name: string, version: string) => Promise<string>,
 *           install?: ({ manager: string, name: string, version: string, root: object }) => Promise<{ ok: boolean }>,
 *           pnpmAdd?: (name: string, version: string) => Promise<{ ok: boolean }>,
 *           globalDir?: string,
 *           reconcilePkg?: ({ name: string, version: string, distDir: string, workspaceRoot: string }) => Promise<{ entry?: object, error?: string }> }} opts
 * @returns {Promise<Array<object>>}
 */
export async function syncGlobalShims({
  workspaceRoot,
  pnpmGlobalBinDir = undefined,
  projects = null,
  dryRun = false,
  roots = undefined,
  npmView = defaultNpmView,
  install = undefined,
  pnpmAdd = undefined,
  globalDir = undefined,
  reconcilePkg = defaultReconcilePkg,
}) {
  const view = npmView;
  // The manager-install seam. Precedence: explicit `install` > legacy
  // `pnpmAdd(name, version)` adapter > the real multi-manager install.
  const doInstall = install
    ? install
    : pnpmAdd
      ? async ({ name, version }) => pnpmAdd(name, version)
      : (args) => defaultInstall({ ...args, workspaceRoot });

  const rootList =
    roots && roots.length > 0
      ? roots
      : pnpmGlobalBinDir
        ? [
            {
              manager: 'pnpm',
              label: `pnpm:${pnpmGlobalBinDir}`,
              binDir: pnpmGlobalBinDir,
              modulesDir: join(globalDir || resolvePnpmGlobalDir(pnpmGlobalBinDir), 'node_modules'),
            },
          ]
        : discoverGlobalRoots();

  const summary = [];
  const projectSet = projects && projects.length > 0 ? new Set(projects) : null;
  const entrypointDir = join(workspaceRoot, 'entrypoint');

  console.error(`sync-global: workspace root: ${workspaceRoot}${dryRun ? ' (dry-run — nothing will be modified)' : ''}`);
  for (const root of rootList) {
    console.error(`sync-global: root ${root.label} (manager=${root.manager}) bin=${root.binDir} modules=${root.modulesDir}`);
  }

  let entries;
  try {
    entries = existsSync(entrypointDir) ? readdirSync(entrypointDir).sort() : [];
  } catch (err) {
    throw new Error(`sync-global: cannot read entrypoint dir ${entrypointDir}: ${err.message}`);
  }

  const pairs = rootList.flatMap((root) => entries.map((dirName) => ({ root, dirName })));
  for (const { root, dirName } of pairs) {
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

    const declaredBins = declaredBinNames(pkg);
    // BUG f1dece41: the shim's name need not equal a declared bin name (the
    // production `backlog` shim for a package that now declares
    // `adhd-backlog`). Discover every name that could identify this package's
    // shim in THIS root.
    const binNames = discoverPackageBins({ pkg, binDir: root.binDir, modulesDir: root.modulesDir, workspaceRoot, entrypointDirName: dirName });
    const rowBase = {
      pkg: pkg.name,
      root: root.label,
      version: pkg.version,
      targetVersion: pkg.version,
    };

    // Step 1 — detect stale SOURCE-LINK shims (content references a workspace
    // source tree — this root OR any sibling worktree, HIGH-1) AND whether the
    // package is installed in this root at all. LOW-7: an entry is ABSENT
    // (skip) vs PRESENT-but-UNREADABLE (→ unverifiable, never "not installed").
    const stale = [];
    const installedBins = [];
    const unreadableBins = [];
    for (const binName of binNames) {
      const shimPath = join(root.binDir, binName);
      if (!existsSync(shimPath)) continue; // absent — not installed in this root
      let shimContent = null;
      try {
        shimContent = readFileSync(shimPath, 'utf8');
      } catch {
        shimContent = null;
      }
      if (shimContent === null) {
        unreadableBins.push(binName); // LOW-7: present but unreadable — cannot verify
        continue;
      }
      installedBins.push(binName);
      if (shimReferencesSource(shimContent, { pkg, workspaceRoot, entrypointDirName: dirName })) {
        stale.push({ binName, shimPath });
      }
    }

    // Step 1.5 (BUG-027 + BUG bea4bfe1 + MEDIUM-3) — CURRENCY is a claim about
    // the INSTALLED tree ONLY. Read `<modulesDir>/<pkg.name>/package.json`; a
    // readable manifest whose version equals the target is the only `current`.
    // A shim present with an unreadable manifest is `unverifiable` — never the
    // old `installedVersion ?? pkg.version`, which printed the TARGET version
    // while the install was old (or absent). A readable version that differs is
    // version drift -> sync; a store path that RESOLVES INTO a source worktree
    // is a dev link, not an install -> sync (MEDIUM-3).
    const installedPkgDir = join(root.modulesDir, pkg.name);
    const installedPkgJsonPath = join(installedPkgDir, 'package.json');
    let installedVersion = null;
    try {
      const parsed = JSON.parse(readFileSync(installedPkgJsonPath, 'utf8'));
      installedVersion = parsed && typeof parsed.version === 'string' ? parsed.version : null;
    } catch {
      installedVersion = null;
    }
    const installedReadable = installedVersion != null;
    const installedIsSourceLink = isSourceLink(installedPkgDir);

    // LOW-7: a shim that EXISTS but cannot be read is unverifiable — never
    // silently treated as absent (which the header frames as `unverifiable`
    // and which `computeExitCode` fails).
    if (unreadableBins.length > 0) {
      console.error(
        `sync-global: ERROR ${pkg.name} @ ${root.label}: bin shim(s) [${unreadableBins.join(', ')}] present but unreadable — cannot verify currency (unverifiable)`
      );
      summary.push({ ...rowBase, bins: unreadableBins, action: 'unverifiable', verified: false, installedVersion });
      continue;
    }

    const versionDrift =
      stale.length === 0 && installedBins.length > 0 && installedReadable && installedVersion !== pkg.version;
    const sourceLinkOnly =
      stale.length === 0 && !versionDrift && installedBins.length > 0 && installedReadable && installedIsSourceLink;

    if (stale.length === 0 && !versionDrift && !sourceLinkOnly) {
      if (installedBins.length === 0) {
        console.error(`sync-global: ${pkg.name} @ ${root.label}: not installed globally (no bin shim(s) found) — nothing to verify`);
        // LOW-8: a not-installed row must NEVER carry an installedVersion. A
        // readable store manifest can exist while NO shim does, which made the
        // summary self-contradictory ("not-installed … installed=1.0.0").
        summary.push({ ...rowBase, bins: binNames, action: 'not-installed', verified: null, installedVersion: null });
      } else if (!installedReadable) {
        console.error(
          `sync-global: ERROR ${pkg.name} @ ${root.label}: bin shim(s) [${installedBins.join(', ')}] present but the installed manifest is missing/unreadable at ${installedPkgJsonPath} — cannot verify currency (unverifiable)`
        );
        summary.push({ ...rowBase, bins: installedBins, action: 'unverifiable', verified: false, installedVersion });
      } else {
        console.error(`sync-global: ${pkg.name} @ ${root.label}: global install is CURRENT (installed ${installedVersion} === target ${pkg.version}) — verified`);
        summary.push({ ...rowBase, bins: installedBins, action: 'current', verified: true, installedVersion });
      }
      continue;
    }

    // Unify the THREE trigger reasons (stale source link, BUG-027 version
    // drift, MEDIUM-3 source-linked store) into one list of {binName, shimPath}
    // for the shared sync/backup/verify pipeline — `stale` from here on means
    // "needs syncing", regardless of why.
    const linkStale = stale.length > 0;
    if (!linkStale && (versionDrift || sourceLinkOnly)) {
      for (const binName of installedBins) stale.push({ binName, shimPath: join(root.binDir, binName) });
    }
    const staleBins = stale.map((s) => s.binName);
    if (linkStale) {
      console.error(
        `sync-global: ${pkg.name} @ ${root.label}: stale global source-link shim detected for bin(s) [${staleBins.join(', ')}] — ` +
          `shim(s) reference a workspace source tree (any checkout, not just this one): ${stale.map((s) => s.shimPath).join(', ')}`
      );
    } else if (sourceLinkOnly) {
      console.error(
        `sync-global: ${pkg.name} @ ${root.label}: global install is a SOURCE LINK — ${installedPkgDir} resolves into a source worktree, not a registry install (bin(s) [${staleBins.join(', ')}])`
      );
    } else {
      console.error(
        `sync-global: ${pkg.name} @ ${root.label}: global install is STALE — installed version ${installedVersion} != target ${pkg.version} ` +
          `for bin(s) [${staleBins.join(', ')}] — this is what left BUG-020 inert (BUG-027)`
      );
    }

    // REACHABILITY WARN — a discovered bin name the package does NOT declare
    // cannot be rewritten by the manager install (it writes only the CURRENT
    // declared names). The legacy `backlog` shim is exactly this case; it needs
    // a human-approved quarantine (rename), not a silent "fixed". Its presence
    // makes the row an UNRESOLVED `legacy-pending` at the end of this pass
    // (HIGH-2), so the release can never report success while it survives.
    const legacyBins = staleBins.filter((b) => !declaredBins.includes(b));
    if (legacyBins.length > 0) {
      console.error(
        `sync-global: WARNING ${pkg.name} @ ${root.label}: legacy bin name(s) [${legacyBins.join(', ')}] do not match the declared bin(s) [${declaredBins.join(', ')}] — ` +
          `the manager install writes only [${declaredBins.join(', ')}]; it CANNOT repair [${legacyBins.join(', ')}]. Quarantine (rename) each legacy shim after human approval.`
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
        `sync-global: SKIP ${pkg.name}@${pkg.version} @ ${root.label}: not on registry yet (npm view resolved "${published || 'nothing'}") — partial publish; will sync once it lands`
      );
      // HIGH-2: a legacy shim's staleness does not depend on the registry — it
      // is unresolved regardless, so it must still fail the gate.
      summary.push({
        ...rowBase,
        bins: staleBins,
        action: legacyBins.length > 0 ? 'legacy-pending' : 'skipped',
        verified: false,
        installedVersion,
      });
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
      summary.push({ ...rowBase, bins: staleBins, action: 'refused', verified: false, installedVersion });
      continue;
    }
    if (gate.note) console.error(`sync-global: ${pkg.name}@${pkg.version}: ${gate.note}`);

    // Step 3 — dry-run: show the intent, touch nothing. A legacy bin that no
    // install can rewrite is reported as its real unresolved state
    // (`legacy-pending`), never as a plain success-shaped `skipped` (HIGH-2).
    const manualCmd = root.manager === 'pnpm' ? `pnpm add -g ${pkg.name}@${pkg.version}` : `npm i -g ${pkg.name}@${pkg.version}`;
    if (dryRun) {
      console.error(`sync-global: WOULD run: ${manualCmd} (in ${root.label}; dry-run — no changes made)`);
      if (legacyBins.length > 0) {
        summary.push({ ...rowBase, bins: staleBins, action: 'legacy-pending', verified: false, dryRun: true, installedVersion });
      } else {
        summary.push({ ...rowBase, bins: staleBins, action: 'skipped', verified: false, dryRun: true, installedVersion });
      }
      continue;
    }

    // Step 4 — sync: back up every stale shim (rollback point), then the
    // root's manager install (writes the package's DECLARED bin shims).
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
      summary.push({ ...rowBase, bins: staleBins, action: 'skipped', verified: false, installedVersion });
      continue;
    }

    console.error(`sync-global: running: ${manualCmd} (in ${root.label})`);
    let addResult;
    try {
      addResult = await doInstall({ manager: root.manager, name: pkg.name, version: pkg.version, root });
    } catch (err) {
      addResult = { ok: false, error: err };
    }
    if (!addResult.ok) {
      console.error(
        `sync-global: ERROR ${pkg.name}@${pkg.version} @ ${root.label}: ${manualCmd} failed` +
          (addResult.error ? ` (${addResult.error.message})` : '') +
          ` — restoring ${backups.length} backup(s). ` +
          `THE OPERATOR'S GLOBAL CLI IS STILL STALE — run manually: ${manualCmd}`
      );
      restoreBackups(backups);
      summary.push({ ...rowBase, bins: staleBins, action: 'synced', verified: false, installedVersion });
      continue;
    }

    // Step 5 — post-verify. The manager install writes the package's DECLARED
    // bin names — so verify those. When the trigger was a LEGACY name the
    // installer cannot rewrite (e.g. `backlog` for a package declaring
    // `adhd-backlog`), there is nothing of ITS to verify; the installer still
    // wrote the declared shim(s), so verify those. The legacy shim remains and
    // was WARNed above — and its survival makes the final row `legacy-pending`
    // (verified:false), which `computeExitCode` FAILS (HIGH-2): a release must
    // not report success while a legacy shim is left stale.
    let verifyTargets = stale.filter((s) => declaredBins.includes(s.binName));
    if (verifyTargets.length === 0) {
      verifyTargets = declaredBins.map((b) => ({ binName: b, shimPath: join(root.binDir, b) }));
    }
    const allVerified =
      verifyTargets.length > 0 &&
      verifyTargets.every(
        (t) =>
          existsSync(t.shimPath) &&
          verifyShim({ pkg, binName: t.binName, shimPath: t.shimPath, workspaceRoot, modulesDir: root.modulesDir })
      );
    if (allVerified && legacyBins.length > 0) {
      // Declared shims are fixed, but a detected legacy-named stale shim
      // survives — `pnpm add -g`/`npm i -g` only write the declared names. This
      // is UNRESOLVED: the release must not claim success.
      console.error(
        `sync-global: UNRESOLVED ${pkg.name}@${pkg.version} @ ${root.label}: declared shim(s) [${verifyTargets.map((t) => t.binName).join(', ')}] verified, ` +
          `but legacy bin(s) [${legacyBins.join(', ')}] remain stale and CANNOT be rewritten by any manager install — quarantine (rename) each legacy shim after human approval.`
      );
      summary.push({ ...rowBase, bins: staleBins, action: 'legacy-pending', verified: false, installedVersion });
    } else if (allVerified) {
      console.error(
        `sync-global: OK ${pkg.name}@${pkg.version} @ ${root.label}: ${verifyTargets.length} shim(s) verified — no workspace refs, root store version ${pkg.version}`
      );
      summary.push({ ...rowBase, bins: staleBins, action: 'synced', verified: true, installedVersion });
    } else {
      console.error(
        `sync-global: ERROR ${pkg.name}@${pkg.version} @ ${root.label}: post-sync verification failed — restoring ${backups.length} backup(s). ` +
          `THE OPERATOR'S GLOBAL CLI IS STILL STALE — run manually: ${manualCmd}`
      );
      restoreBackups(backups);
      summary.push({ ...rowBase, bins: staleBins, action: 'synced', verified: false, installedVersion });
    }
  }

  printSummary(summary);
  return summary;
}

/**
 * BUG-027 + BUG bea4bfe1 + HIGH-2 — decide the process exit code from the
 * summary. A release must NEVER report success while the operator's global CLI
 * is left unverified current. Non-zero iff any NON-dry-run row represents an
 * UNRESOLVED currency problem:
 *   - `refused`  — the content gate blocked a flip (worktree/published mismatch).
 *   - `unverifiable` — a shim is present but unreadable, or the installed
 *     manifest is missing/unreadable (BUG bea4bfe1; LOW-7).
 *   - `legacy-pending` (HIGH-2) — a detected legacy-named stale shim that no
 *     manager install can rewrite is left in place; the release CANNOT claim
 *     success while it shadows the current CLI.
 *   - `synced` with `verified: false` — an upgrade was ATTEMPTED and failed
 *     (manager install failed, or post-sync verification failed) — the exact
 *     BUG-027 shape: an outdated global install that stayed outdated.
 * Deliberately NOT included: `skipped` (registry doesn't have the version yet
 * — a partial-publish timing issue, not a currency failure), `not-installed`
 * (nothing to enforce), `current` (already verified true). A `dryRun` row
 * never attempted anything, so it is exempt regardless of action — dry-run is
 * an explicit preview and must exit 0.
 *
 * @param {Array<{ action: string, verified: boolean | null, dryRun?: boolean }>} summary
 * @returns {number} 0 or 1
 */
export function computeExitCode(summary) {
  const unresolved = summary.filter((row) => {
    if (row.dryRun) return false; // preview only — nothing was attempted
    return (
      row.action === 'refused' ||
      row.action === 'unverifiable' ||
      row.action === 'legacy-pending' ||
      (row.action === 'synced' && row.verified === false)
    );
  });
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
  // global bin dir: `pnpm config get global-bin-dir` || ~/Library/pnpm, then
  // enumerate EVERY global root (pnpm + npm prefix + every NVM node version)
  // so a stale CLI outside the pnpm store is no longer invisible (ab4d0864).
  const configuredBinDir = pnpmConfigGet('global-bin-dir');
  const pnpmGlobalBinDir = configuredBinDir || join(homedir(), 'Library', 'pnpm');
  const roots = discoverGlobalRoots({ pnpmGlobalBinDir });
  let summary;
  try {
    summary = await syncGlobalShims({ workspaceRoot, pnpmGlobalBinDir, roots, projects: args.projects, dryRun: args.dryRun });
  } catch (err) {
    console.error(`sync-global: INTERNAL FAILURE: ${err && err.stack ? err.stack : String(err)}`);
    process.exit(1);
    return;
  }
  // BUG-027 + BUG bea4bfe1: exit non-zero when any package ended UNRESOLVED
  // (content-gate refusal, an unverifiable install, or an attempted upgrade
  // that failed/didn't verify) — this can no longer be silently advisory.
  const exitCode = computeExitCode(summary);
  if (exitCode !== 0) {
    console.error(
      '\nsync-global: FAILED — the operator global CLI for one or more packages could not be verified current. ' +
        'See the ERROR/WARNING line(s) above for the exact per-root remediation command ' +
        '(`pnpm add -g <name>@<version>` for pnpm roots; `npm i -g <name>@<version>` for npm/NVM roots). ' +
        'A LEGACY bin name that does not match the package declaration must be quarantined (renamed) with human approval.'
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
