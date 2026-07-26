#!/usr/bin/env node
/**
 * tools/nx-plugins/build/executors/smoke-test/clean-room-smoke.mjs
 *
 * GATE 2 — post-publish clean-room smoke (the gate every existing check
 * skipped; see `../../lib/range-resolvability.js`'s header for GATE 1 and
 * the full reconciliation matrix in PUBLISHING.md).
 *
 * WHY THIS EXISTS: `verify-dist-load` (`executors/verify/verify-dist-load.mjs`)
 * loads a project's built dist the way "a consumer would" — but it resolves
 * every `@adhd/*` import through the LOCAL pnpm workspace symlink
 * (`node-linker=hoisted` + `link-workspace-packages=true` in `.npmrc`), which
 * always has SOME copy of every sibling on disk regardless of what actually
 * got published. It can never observe an `ETARGET` — that error only exists
 * inside a REAL `npm install` resolving REAL registry metadata, which nothing
 * in this repo's test/build/lint pipeline ever performs. This script is that
 * missing step: for every publishable, `bin`-shipping ENTRYPOINT, in an
 * ephemeral directory, run a genuine `npm install <name>@latest` against the
 * real registry, then a light "did the installed bin come up cleanly"
 * smoke — exactly the sequence a new user runs, and exactly where
 * BUG-RELEASE-UNINSTALLABLE-AGENTMCP-001 (and, confirmed live during this
 * gate's own development, a SECOND live instance: `@adhd/apigen-plugin-api-
 * fastify@latest`/`@adhd/apigen-plugin-openapi@latest` both currently declare
 * `"@adhd/apigen-core-client": "^0.1.5"` while the registry's max published
 * `apigen-core-client` is `0.1.4` — `npm install @adhd/apigen-plugin-api-
 * fastify` is ETARGET RIGHT NOW) would have failed loudly.
 *
 * SCOPE: entrypoints only (not all 50+ publishable packages) — an
 * entrypoint's install pulls in its entire internal dependency tree
 * transitively, so installing every CLI entrypoint already exercises every
 * internal edge in the graph that actually matters to an end user. Checking
 * every library package individually would be O(n) redundant installs of
 * the same transitive tree for no additional coverage.
 *
 * PERFORMANCE: entrypoints are smoked IN PARALLEL (one child process per
 * entrypoint, `Promise.all`) — the whole gate's wall time is bounded by the
 * SLOWEST single install, not the sum.
 *
 * Usage:
 *   node tools/nx-plugins/build/executors/smoke-test/clean-room-smoke.mjs [--json]
 *
 * Exit 0 — every publishable entrypoint installed from the real registry and
 *          its bin came up cleanly.
 * Exit 1 — at least one entrypoint failed to install, or its bin crashed
 *          immediately on start.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const findRoot = (d) => {
  while (d !== dirname(d)) {
    if (existsSync(join(d, 'nx.json'))) return d;
    d = dirname(d);
  }
  return d;
};
const workspaceRoot = findRoot(dirname(fileURLToPath(import.meta.url)));

/** How long a bin is allowed to run before being treated as "started cleanly, still alive" (a server/long-running CLI) rather than gated on it exiting. */
const BIN_SMOKE_TIMEOUT_MS = Number(process.env.ADHD_SMOKE_BIN_TIMEOUT_MS) || 8000;
/** How long an `npm install` may take before this gate gives up on that one entrypoint. */
const INSTALL_TIMEOUT_MS = Number(process.env.ADHD_SMOKE_INSTALL_TIMEOUT_MS) || 120_000;

/**
 * Discover every publishable, `bin`-shipping project directly under
 * `entrypoint/` — the real installable CLI surface of this workspace.
 *
 * @param {string} root
 * @returns {{ projectRoot: string, name: string }[]}
 */
export function discoverSmokeEntrypoints(root) {
  const entrypointDir = join(root, 'entrypoint');
  if (!existsSync(entrypointDir)) return [];
  const out = [];
  for (const name of readdirSync(entrypointDir)) {
    const projectRoot = `entrypoint/${name}`;
    const pkgJsonPath = join(root, projectRoot, 'package.json');
    if (!existsSync(pkgJsonPath)) continue;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    } catch {
      continue;
    }
    if (pkg.private === true) continue;
    if (!pkg.name) continue;
    const hasBin = pkg.bin != null && (typeof pkg.bin === 'string' || Object.keys(pkg.bin).length > 0);
    if (!hasBin) continue;
    out.push({ projectRoot, name: pkg.name });
  }
  return out;
}

/** Promisified spawn with a bounded timeout. Never throws — resolves a result object. */
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, opts.timeoutMs)
      : null;
    child.stdout?.on('data', (d) => (stdout += d));
    child.stderr?.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, stdout, stderr, timedOut, spawnError: err });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, spawnError: null });
    });
  });
}

/**
 * `npm install <name>@latest` into an ephemeral, throwaway directory — a
 * genuine clean-room install against the REAL registry. No `package.json` is
 * created first; npm installs directly into `<dir>/node_modules` regardless
 * (verified empirically against the npm version pinned in this workspace).
 *
 * @param {string} name npm package name
 * @param {string} scratchRoot a dir under `{workspaceRoot}/tmp` to nest the ephemeral install dir in
 * @param {{ registryUrl?: string }} [opts]
 */
async function cleanRoomInstall(name, scratchRoot, opts = {}) {
  mkdirSync(scratchRoot, { recursive: true });
  const installDir = mkdtempSync(join(scratchRoot, 'install-'));
  const args = ['install', '--prefix', installDir, `${name}@latest`, '--no-audit', '--no-fund', '--loglevel=error'];
  if (opts.registryUrl) args.push('--registry', opts.registryUrl);
  const result = await run('npm', args, { timeoutMs: INSTALL_TIMEOUT_MS, cwd: workspaceRoot });
  return { installDir, ...result };
}

/**
 * Stderr signatures that indicate the process crashed trying to LOAD/RESOLVE
 * code — a broken install (missing dep, unresolved module, syntax error from
 * a bad bundle) — as opposed to a controlled, intentional non-zero exit from
 * argument parsing (e.g. Node's `util.parseArgs` or commander rejecting an
 * unrecognized flag). Only the former is what this gate exists to catch; the
 * latter proves the opposite — the bin loaded, ran ITS OWN code, and made an
 * ordinary CLI-usage decision. Verified empirically: `@adhd/agent-mcp`'s
 * `agent-mcp-tail` bin uses `node:util`'s `parseArgs`, which throws
 * `ERR_PARSE_ARGS_UNKNOWN_OPTION` on `--help` — a real, working bin exiting
 * non-zero for reasons that have nothing to do with installability.
 */
const CRASH_ON_LOAD_SIGNATURES = [
  'Cannot find module',
  'ERR_MODULE_NOT_FOUND',
  'MODULE_NOT_FOUND',
  'ERR_REQUIRE_ESM',
  'is not a constructor',
  'is not a function',
  "Cannot read propert",
  'SyntaxError',
  'ReferenceError',
];

/** @param {string} stderr @returns {boolean} */
function looksLikeCrashOnLoad(stderr) {
  return CRASH_ON_LOAD_SIGNATURES.some((sig) => stderr.includes(sig));
}

/**
 * Resolve the installed package's own declared `bin` entries (from what
 * ACTUALLY landed in `node_modules`, not the source manifest) and smoke each:
 * spawn it with a small, framework-agnostic safe argv and a bounded timeout.
 *
 * Verdict is deliberately permissive about *how* a bin ends its run — the
 * thing this gate must catch is an IMMEDIATE crash (module resolution
 * failure, syntax error, uncaught throw during startup), not "did it exit 0"
 * (a long-running MCP/server bin is SUPPOSED to keep running, and a
 * commander/`util.parseArgs`-based CLI rejecting an unrecognized flag is
 * SUPPOSED to exit non-zero):
 *   - exits 0 before the timeout                       -> PASS
 *   - still running when the timeout fires (killed)    -> PASS (a server-style
 *     entrypoint staying alive IS the healthy outcome — this is exactly
 *     `verify-dist-load`'s own "existenceOnly" reasoning for `bin`-shipping
 *     packages, applied to a real installed artifact instead of local dist)
 *   - exits non-zero, stderr has NO crash-on-load signature -> PASS (a
 *     controlled argument-parsing rejection, not a broken install)
 *   - exits non-zero, stderr HAS a crash-on-load signature   -> FAIL
 *
 * @param {string} installDir
 * @param {string} pkgName
 */
async function smokeInstalledBin(installDir, pkgName) {
  const pkgDirName = pkgName.startsWith('@') ? pkgName : pkgName;
  const installedPkgJsonPath = join(installDir, 'node_modules', pkgDirName, 'package.json');
  if (!existsSync(installedPkgJsonPath)) {
    return { ok: false, reason: `installed package.json not found at ${installedPkgJsonPath} — install did not land where expected` };
  }
  let installedPkg;
  try {
    installedPkg = JSON.parse(readFileSync(installedPkgJsonPath, 'utf8'));
  } catch (err) {
    return { ok: false, reason: `could not parse installed package.json: ${err.message}` };
  }
  const bin = installedPkg.bin;
  const binEntries =
    typeof bin === 'string' ? [[pkgDirName.split('/').pop(), bin]] : bin && typeof bin === 'object' ? Object.entries(bin) : [];
  if (binEntries.length === 0) {
    return { ok: false, reason: 'installed package declares no bin — nothing to smoke' };
  }

  const results = [];
  for (const [binName, binRelPath] of binEntries) {
    const binAbs = join(installDir, 'node_modules', pkgDirName, binRelPath);
    if (!existsSync(binAbs)) {
      results.push({ binName, ok: false, reason: `declared bin file missing on disk: ${binAbs}` });
      continue;
    }
    // `--help` is safe/fast for every commander-based CLI this workspace
    // ships (apigen, backlog, decompile). For a bin that doesn't recognize
    // `--help` (e.g. a bare server bootstrap like agent-mcp), the permissive
    // verdict above still passes it via the "still alive at timeout" branch.
    const res = await run(process.execPath, [binAbs, '--help'], { timeoutMs: BIN_SMOKE_TIMEOUT_MS, cwd: installDir });
    if (res.code === 0) {
      results.push({ binName, ok: true, mode: 'exited-0' });
    } else if (res.timedOut) {
      results.push({ binName, ok: true, mode: 'still-running-at-timeout (server-style entrypoint, treated as healthy start)' });
    } else if (!looksLikeCrashOnLoad(res.stderr)) {
      results.push({
        binName,
        ok: true,
        mode: `exited ${res.code} but no crash-on-load signature (controlled argument-parsing rejection, not a broken install)`,
      });
    } else {
      results.push({
        binName,
        ok: false,
        reason: `exited ${res.code} before timeout with a crash-on-load signature — stderr: ${res.stderr.slice(0, 2000)}`,
      });
    }
  }
  const ok = results.every((r) => r.ok);
  return { ok, results };
}

/**
 * Full clean-room smoke for one entrypoint: install from the real registry,
 * then smoke its bin(s). Always cleans up its ephemeral install dir
 * (`fs.rmSync`, scoped to the exact dir this function itself created under
 * `{workspaceRoot}/tmp` — never a caller-supplied/variable-composed path).
 *
 * @param {{ projectRoot: string, name: string }} entrypoint
 * @param {{ registryUrl?: string }} [opts]
 */
export async function smokeOneEntrypoint(entrypoint, opts = {}) {
  const scratchRoot = join(workspaceRoot, 'tmp', 'nx-build-smoke');
  const t0 = Date.now();
  const install = await cleanRoomInstall(entrypoint.name, scratchRoot, opts);
  try {
    if (install.code !== 0) {
      return {
        name: entrypoint.name,
        projectRoot: entrypoint.projectRoot,
        ok: false,
        stage: 'install',
        reason: install.timedOut
          ? `npm install timed out after ${INSTALL_TIMEOUT_MS}ms`
          : `npm install exited ${install.code} — stderr: ${install.stderr.slice(0, 4000)}`,
        elapsedMs: Date.now() - t0,
      };
    }
    const smoke = await smokeInstalledBin(install.installDir, entrypoint.name);
    return {
      name: entrypoint.name,
      projectRoot: entrypoint.projectRoot,
      ok: smoke.ok,
      stage: smoke.ok ? 'complete' : 'bin-smoke',
      reason: smoke.ok ? null : (smoke.results || []).filter((r) => !r.ok).map((r) => `${r.binName}: ${r.reason}`).join('; ') || smoke.reason,
      binResults: smoke.results || null,
      elapsedMs: Date.now() - t0,
    };
  } finally {
    try {
      rmSync(install.installDir, { recursive: true, force: true });
    } catch {
      // best-effort scratch cleanup — never fail the gate over cleanup
    }
  }
}

/**
 * Run the full gate: discover entrypoints, smoke them ALL IN PARALLEL.
 *
 * @param {{ workspaceRoot?: string, registryUrl?: string, discover?: typeof discoverSmokeEntrypoints }} [opts]
 */
export async function runCleanRoomSmoke(opts = {}) {
  const root = opts.workspaceRoot || workspaceRoot;
  const discover = opts.discover || discoverSmokeEntrypoints;
  const entrypoints = discover(root);
  const results = await Promise.all(entrypoints.map((e) => smokeOneEntrypoint(e, opts)));
  const ok = results.every((r) => r.ok);
  return { ok, entrypoints, results };
}

async function main() {
  const asJson = process.argv.includes('--json');
  const t0 = Date.now();
  const { ok, results } = await runCleanRoomSmoke();
  const elapsedMs = Date.now() - t0;

  if (asJson) {
    process.stdout.write(JSON.stringify({ ok, elapsedMs, results }, null, 2) + '\n');
  } else {
    console.error(`clean-room-smoke: ${results.length} publishable entrypoint(s) smoked in parallel (${elapsedMs}ms wall time).`);
    for (const r of results) {
      console.error(`  ${r.ok ? '✓' : '✖'} ${r.name} (${r.stage}, ${r.elapsedMs}ms)${r.ok ? '' : ' — ' + r.reason}`);
    }
    console.error(ok ? '\nclean-room-smoke: OK — every entrypoint installed from the real registry and started cleanly.' : '\nclean-room-smoke: FAILED.');
  }
  process.exit(ok ? 0 : 1);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main();
}
