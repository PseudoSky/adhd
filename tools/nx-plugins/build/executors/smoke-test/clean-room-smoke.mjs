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
 * SCOPE (UPDATED — DEBT-002 #6 closure follow-up): every publishable package
 * in the workspace, not just entrypoints. The original "entrypoints only"
 * scoping assumed every entrypoint's transitive dependency closure covered
 * the full publishable set; `computeEntrypointClosureGap` (below) proved
 * that assumption FALSE for this repo (19 of 53 publishable packages —
 * mostly library-only families like `@adhd/dispatch-*`, `@adhd/apigen-base-
 * *`, `@adhd/workspace-*` — are never depended on by any smoked entrypoint).
 * Rather than hard-failing the gate on that gap forever, GATE 2 now closes
 * it directly:
 *   - packages that declare a `bin` (an "entrypoint" in the general sense —
 *     this now includes any publishable package with a `bin` field, not
 *     only those physically under `entrypoint/`; `@adhd/agent-engine-
 *     compiler` under `packages/` ships a bin and was previously missed
 *     entirely by the old `entrypoint/`-only scan) get the original
 *     install-@latest + bin-crash smoke.
 *   - every OTHER publishable package (no `bin` — a pure library) gets a
 *     NEW install-@latest-into-an-isolated-tmpdir + real module-load smoke:
 *     resolve its `exports`/`main` entry from the INSTALLED
 *     `node_modules/<name>/package.json` (what a real consumer actually
 *     resolves against, not the source manifest) and `import()` it in a
 *     fresh child process, asserting it loads without throwing — the
 *     registry-level analog of `verify-dist-load`, but against the real
 *     published tarball instead of local `dist/`.
 * Every publishable package is therefore either bin-smoked or
 * library-load-smoked — 100% coverage by construction. The transitive
 * `@adhd/*` closure computation is KEPT (`computeEntrypointClosureGap`) and
 * combined with the directly-smoked set (`computeCoverageGap`) purely as a
 * sanity assertion: if the union of {bin-entrypoint closure} ∪ {every
 * directly-smoked package} still doesn't equal the full publishable set,
 * something is wrong with package discovery itself (e.g. a manifest this
 * script can't parse) and the gate fails loud rather than silently trusting
 * an incomplete scan.
 *
 * PERFORMANCE: every target (bin or library) is smoked in its own child
 * process, run with a bounded concurrency pool (`ADHD_SMOKE_CONCURRENCY`,
 * default 8) rather than unbounded `Promise.all` — 53 simultaneous `npm
 * install` processes would thrash the local network/disk and the shared npm
 * cache lock for no benefit; 8-wide keeps wall time close to
 * `ceil(N/8) * slowest-install` while staying gentle on the machine.
 *
 * Usage:
 *   node tools/nx-plugins/build/executors/smoke-test/clean-room-smoke.mjs [--json]
 *
 * Exit 0 — every publishable package installed from the real registry and
 *          (bin) came up cleanly / (library) loaded without throwing, AND
 *          the coverage assertion found zero uncovered publishable packages.
 * Exit 1 — at least one package failed to install, its bin crashed
 *          immediately on start, its module threw on load, or the coverage
 *          assertion found an uncovered publishable package.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
/** How long an `npm install` may take before this gate gives up on that one package. */
const INSTALL_TIMEOUT_MS = Number(process.env.ADHD_SMOKE_INSTALL_TIMEOUT_MS) || 120_000;
/** How long a library's `import()` may take before being treated as a hang (never a legitimate outcome for a pure library — unlike a bin, nothing here should still be "running" once the module graph finishes evaluating). */
const LIBRARY_LOAD_TIMEOUT_MS = Number(process.env.ADHD_SMOKE_LIBRARY_LOAD_TIMEOUT_MS) || 15_000;
/** How many packages may be smoked concurrently (see file header "PERFORMANCE"). */
const SMOKE_CONCURRENCY = Number(process.env.ADHD_SMOKE_CONCURRENCY) || 8;
/**
 * How many EXTRA `npm install` attempts (beyond the first) this gate makes
 * when the install lands but resolves a version OLDER than the workspace's
 * own on-disk version for that package — see `isInstallStale` / the
 * "STALE PACKUMENT CACHE" note on `cleanRoomInstall` below. Bounded and
 * overridable (mirrors `ADHD_SMOKE_*` elsewhere in this file) — never an
 * unbounded/wall-clock wait.
 */
const INSTALL_RETRIES = Number(process.env.ADHD_SMOKE_INSTALL_RETRIES) || 3;
/** Backoff between bounded stale-install retries (see `INSTALL_RETRIES`). */
const INSTALL_RETRY_DELAY_MS = Number(process.env.ADHD_SMOKE_INSTALL_RETRY_DELAY_MS) || 5000;

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

/**
 * DEBT-002 #6: discover EVERY `package.json`-bearing project in the
 * workspace (two levels under `packages/<domain>/<pkg>/`, one level under
 * `entrypoint/<name>/`) — the full manifest universe this assertion reasons
 * over. Pure filesystem reads, no nx invocation.
 *
 * @param {string} root
 * @returns {Map<string, { name: string, pkg: object, projectRoot: string }>} keyed by package name
 */
export function discoverAllPackageManifests(root) {
  const byName = new Map();
  const scan = (base, depth) => {
    let entries;
    try {
      entries = readdirSync(base, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'tmp') continue;
      const dir = join(base, entry.name);
      if (depth === 1) {
        const pkgJsonPath = join(dir, 'package.json');
        if (!existsSync(pkgJsonPath)) continue;
        let pkg;
        try {
          pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
        } catch {
          continue;
        }
        if (!pkg.name) continue;
        const projectRoot = dir.slice(root.length + 1).split('\\').join('/');
        byName.set(pkg.name, { name: pkg.name, pkg, projectRoot });
      } else {
        scan(dir, depth - 1);
      }
    }
  };
  scan(join(root, 'packages'), 2);
  scan(join(root, 'entrypoint'), 1);
  return byName;
}

/**
 * Split every publishable package into the two smoke lanes this gate now
 * runs (see file header "SCOPE"): `binTargets` (declares a `bin` — smoked by
 * install + bin-crash check) and `libraryTargets` (everything else — smoked
 * by install + real module-load check). Deliberately NOT scoped to
 * `entrypoint/` — `@adhd/agent-engine-compiler` (under `packages/`) ships a
 * `bin` and belongs in `binTargets` exactly like an `entrypoint/*` CLI does;
 * classification is purely "does the manifest declare `bin`", never "which
 * directory is it in".
 *
 * Each returned target also carries `version` — the on-disk source
 * `package.json` version — so a caller (`cleanRoomInstall`, via
 * `smokeOneEntrypoint`/`smokeOneLibrary`) can detect a stale npm packument
 * cache resolving an OLDER version than what this workspace just published.
 * This reuses the manifest map `discoverAllPackageManifests` already built —
 * it does not re-glob the workspace independently.
 *
 * @param {string} root
 * @returns {{ binTargets: {projectRoot: string, name: string, version: string}[], libraryTargets: {projectRoot: string, name: string, version: string}[] }}
 */
export function classifyPublishableTargets(root) {
  const manifests = discoverAllPackageManifests(root);
  const binTargets = [];
  const libraryTargets = [];
  for (const { name, pkg, projectRoot } of manifests.values()) {
    if (pkg.private === true) continue;
    const hasBin = pkg.bin != null && (typeof pkg.bin === 'string' || Object.keys(pkg.bin).length > 0);
    (hasBin ? binTargets : libraryTargets).push({ projectRoot, name, version: pkg.version });
  }
  return { binTargets, libraryTargets };
}

/**
 * BFS over `@adhd/*` dependency edges (dependencies + peerDependencies)
 * starting from `seedNames`, resolved purely from already-loaded manifest
 * data (no disk I/O, no nx). Shared by `computeEntrypointClosureGap` and
 * `computeCoverageGap` below.
 *
 * @param {Map<string, {name: string, pkg: object, projectRoot: string}>} manifests
 * @param {string[]} seedNames
 * @returns {Set<string>}
 */
function transitiveAdhdClosure(manifests, seedNames) {
  const closure = new Set();
  const queue = [...seedNames];
  while (queue.length > 0) {
    const name = queue.shift();
    if (closure.has(name)) continue;
    closure.add(name);
    const entry = manifests.get(name);
    if (!entry) continue; // not a workspace-local manifest (e.g. an external @adhd/* scope collision) — nothing to recurse into
    const deps = { ...(entry.pkg.dependencies || {}), ...(entry.pkg.peerDependencies || {}) };
    for (const depName of Object.keys(deps)) {
      if (depName.startsWith('@adhd/') && !closure.has(depName)) queue.push(depName);
    }
  }
  return closure;
}

/**
 * DEBT-002 #6 (original): the transitive `@adhd/*`-dependency closure
 * reachable from `entrypoints` alone, compared against the full publishable
 * set. KEPT (still exported, still exercised by its own tests) as the
 * diagnostic that originally proved the "entrypoints-only" scoping
 * insufficient for this repo (19/53 uncovered) — `computeCoverageGap` below
 * is what the gate now actually asserts against, since GATE 2 no longer
 * relies on closure alone for coverage.
 *
 * @param {string} root
 * @param {{ name: string }[]} entrypoints
 * @returns {{ publishableCount: number, closureCount: number, uncovered: string[] }}
 */
export function computeEntrypointClosureGap(root, entrypoints) {
  const manifests = discoverAllPackageManifests(root);
  const publishable = new Set();
  for (const { name, pkg } of manifests.values()) {
    if (pkg.private === true) continue;
    publishable.add(name);
  }
  const closure = transitiveAdhdClosure(manifests, entrypoints.map((e) => e.name));
  const uncovered = [...publishable].filter((name) => !closure.has(name)).sort();
  return { publishableCount: publishable.size, closureCount: closure.size, uncovered };
}

/**
 * DEBT-002 #6 (closure follow-up): the assertion GATE 2 actually enforces
 * now. Coverage = {transitive `@adhd/*` closure reachable from `binTargets`}
 * ∪ {every package directly smoked — both `binTargets` and
 * `libraryTargets`}. Since `classifyPublishableTargets` partitions the ENTIRE
 * publishable set into exactly those two arrays, `directlySmoked` alone is
 * already the full publishable set by construction — the closure term is
 * retained purely as a cross-check that `discoverAllPackageManifests` and
 * `classifyPublishableTargets` agree with each other; a real gap here would
 * mean package discovery itself is broken (e.g. an unreadable manifest),
 * which must fail loud rather than be silently trusted.
 *
 * @param {string} root
 * @param {{ name: string }[]} binTargets
 * @param {{ name: string }[]} libraryTargets
 * @returns {{ publishableCount: number, closureCount: number, directlySmokedCount: number, coveredCount: number, uncovered: string[] }}
 */
export function computeCoverageGap(root, binTargets, libraryTargets) {
  const manifests = discoverAllPackageManifests(root);
  const publishable = new Set();
  for (const { name, pkg } of manifests.values()) {
    if (pkg.private === true) continue;
    publishable.add(name);
  }
  const closure = transitiveAdhdClosure(manifests, binTargets.map((e) => e.name));
  const directlySmoked = new Set([...binTargets, ...libraryTargets].map((e) => e.name));
  const covered = new Set([...closure, ...directlySmoked]);
  const uncovered = [...publishable].filter((name) => !covered.has(name)).sort();
  return {
    publishableCount: publishable.size,
    closureCount: closure.size,
    directlySmokedCount: directlySmoked.size,
    coveredCount: covered.size,
    uncovered,
  };
}

/**
 * Run `fn` over `items` with at most `limit` in flight concurrently. A
 * bounded worker-pool, not `p-queue`/a new dependency — this repo already
 * depends on `p-queue` for other things, but pulling it into a standalone
 * build-tool script for one `while` loop's worth of logic isn't worth the
 * import; see AGENTS.md §"evaluate best-of-class 3rd party tools" — this is
 * genuinely simpler inline than wiring an external queue for a fixed-size
 * pool with no priority/backpressure requirements.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
  await Promise.all(workers);
  return results;
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
 * Build the argv for the clean-room `npm install <name>@latest` invocation.
 * Extracted as a pure, spawn-free function specifically so the
 * `--prefer-online` flag (see `cleanRoomInstall`'s header) is unit-testable
 * without spawning a real npm process.
 *
 * @param {string} name npm package name
 * @param {string} installDir the `--prefix` target directory
 * @param {{ registryUrl?: string }} [opts]
 * @returns {string[]}
 */
export function buildNpmInstallArgs(name, installDir, opts = {}) {
  const args = [
    'install',
    '--prefix',
    installDir,
    `${name}@latest`,
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
    // MANDATORY for a POST-publish gate — see the BUG-012 follow-up incident
    // recorded on `cleanRoomInstall` below (`@adhd/backlog@0.1.1` published,
    // but `install @latest` resolved the stale cached `0.1.0`). Without this
    // flag npm is free to trust its local packument cache, which is exactly
    // the metadata this gate must NOT trust immediately after a publish.
    '--prefer-online',
  ];
  if (opts.registryUrl) args.push('--registry', opts.registryUrl);
  return args;
}

/**
 * Compare two dotted numeric version strings (`"1.2.3"` vs `"1.10.0"`),
 * pure/spawn-free. Deliberately NOT a full semver parser (no prerelease/build
 * metadata handling) — every version this gate ever compares is either an
 * npm-registry `dist-tags.latest` resolution or a workspace `package.json`
 * `version` field, both of which are plain `major.minor.patch` in this repo's
 * release flow (see PUBLISHING.md). A missing/non-numeric segment is treated
 * as `0`.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} negative if a<b, 0 if equal, positive if a>b
 */
export function compareSemver(a, b) {
  const partsA = String(a ?? '').split('.');
  const partsB = String(b ?? '').split('.');
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const na = parseInt(partsA[i], 10) || 0;
    const nb = parseInt(partsB[i], 10) || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

/**
 * The staleness predicate this gate retries against (task requirement #2):
 * TRUE only when `resolvedVersion` (what `npm install @latest` actually
 * pulled down) is strictly OLDER than `onDiskVersion` (this workspace's own
 * source `package.json` version for that package — i.e. the version that was
 * just published). Equal or NEWER is always fine — "newer" legitimately
 * happens when something else published after this workspace's checkout, and
 * is never a reason to retry.
 *
 * @param {string | undefined | null} resolvedVersion
 * @param {string | undefined | null} onDiskVersion
 * @returns {boolean}
 */
export function isInstallStale(resolvedVersion, onDiskVersion) {
  if (!resolvedVersion || !onDiskVersion) return false;
  return compareSemver(resolvedVersion, onDiskVersion) < 0;
}

/**
 * Stderr/error signatures indicating a REGISTRY-PROPAGATION-shaped failure —
 * npm couldn't resolve a version/tarball that (per the workspace's own
 * on-disk manifest) should exist, most plausibly because the just-published
 * metadata/CDN hasn't fully propagated yet. Distinct from a genuine broken
 * install: this is about the INSTALL ITSELF failing to resolve at all
 * (ETARGET/E404), not about it succeeding-but-stale (that's `isInstallStale`,
 * checked separately after a successful install).
 *
 * @param {string} stderr
 * @returns {boolean}
 */
export function looksLikeTransientRegistryError(stderr) {
  const text = stderr || '';
  return text.includes('ETARGET') || text.includes('E404') || text.includes('code E404');
}

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read the version actually resolved by a completed install, straight from
 * `node_modules/<name>/package.json` — the ground truth for "what did npm
 * really give us", as opposed to trusting `npm install`'s stdout/exit code
 * alone. Never throws — returns `null` on any read/parse failure (the caller
 * treats "unknown resolved version" as "not stale", never as a hard error;
 * the subsequent bin/library smoke will surface a missing-install failure on
 * its own if the install truly didn't land).
 *
 * @param {string} installDir
 * @param {string} name
 * @returns {string | null}
 */
function readInstalledVersion(installDir, name) {
  try {
    const pkgJsonPath = join(installDir, 'node_modules', name, 'package.json');
    if (!existsSync(pkgJsonPath)) return null;
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * `npm install <name>@latest` into an ephemeral, throwaway directory — a
 * genuine clean-room install against the REAL registry. No `package.json` is
 * created first; npm installs directly into `<dir>/node_modules` regardless
 * (verified empirically against the npm version pinned in this workspace).
 *
 * STALE PACKUMENT CACHE (the reason for `--prefer-online` + bounded retry
 * below): this gate runs immediately AFTER `npm publish` in the release
 * flow. A live release run proved that timing is dangerous — `npm install
 * @adhd/backlog@latest` (no `--prefer-online`) resolved the OLD `0.1.0`
 * tarball from npm's LOCAL packument cache even though `@adhd/backlog@0.1.1`
 * had just been published successfully and `npm view` already showed
 * `0.1.1` as the registry's `dist-tags.latest`. GATE 2 red-failed on an
 * already-fixed package, purely because `npm install` (unlike `npm view`)
 * is willing to trust stale local metadata by default. `--prefer-online`
 * (see `buildNpmInstallArgs`) forces npm to revalidate packument metadata
 * against the registry instead of trusting that cache. On top of that, a
 * SEPARATE and real failure mode is registry/CDN propagation lag of a few
 * seconds right after publish — `--prefer-online` alone can't fix "the
 * registry itself hasn't finished propagating yet" — so this function also
 * retries (bounded: `INSTALL_RETRIES` attempts, `INSTALL_RETRY_DELAY_MS`
 * backoff, both overridable via `ADHD_SMOKE_INSTALL_RETRIES` /
 * `ADHD_SMOKE_INSTALL_RETRY_DELAY_MS`) whenever the install either (a) fails
 * with an ETARGET/E404-shaped error (`looksLikeTransientRegistryError`), or
 * (b) succeeds but resolves a version OLDER than this workspace's own
 * on-disk `package.json` version for that package (`isInstallStale` — the
 * exact 0.1.0-vs-0.1.1 shape of the live incident). If retries are exhausted
 * and the install is STILL stale, that is a genuine, surfaced propagation
 * problem — the returned `staleness` field records it rather than silently
 * treating the stale-but-successful install as a pass (see
 * `smokeOneEntrypoint` / `smokeOneLibrary`, which turn a still-stale result
 * into a hard FAIL with the staleness detail in the reason).
 *
 * @param {string} name npm package name
 * @param {string} scratchRoot a dir under `{workspaceRoot}/tmp` to nest the ephemeral install dir in
 * @param {{ registryUrl?: string, onDiskVersion?: string, installRetries?: number, installRetryDelayMs?: number }} [opts]
 */
async function cleanRoomInstall(name, scratchRoot, opts = {}) {
  mkdirSync(scratchRoot, { recursive: true });
  const installDir = mkdtempSync(join(scratchRoot, 'install-'));
  const maxAttempts = 1 + Math.max(0, opts.installRetries ?? INSTALL_RETRIES);
  const retryDelayMs = opts.installRetryDelayMs ?? INSTALL_RETRY_DELAY_MS;

  let result = null;
  let staleness = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const args = buildNpmInstallArgs(name, installDir, opts);
    result = await run('npm', args, { timeoutMs: INSTALL_TIMEOUT_MS, cwd: workspaceRoot });
    staleness = null;

    if (result.code !== 0) {
      const transient = looksLikeTransientRegistryError(result.stderr || '');
      if (transient && attempt < maxAttempts) {
        await delay(retryDelayMs);
        continue;
      }
      break; // either a genuine (non-transient) install failure, or retries exhausted
    }

    if (opts.onDiskVersion) {
      const resolvedVersion = readInstalledVersion(installDir, name);
      if (isInstallStale(resolvedVersion, opts.onDiskVersion)) {
        staleness = { resolvedVersion, onDiskVersion: opts.onDiskVersion, attempt, attemptsMade: attempt };
        if (attempt < maxAttempts) {
          await delay(retryDelayMs);
          continue;
        }
        break; // still stale after exhausting retries — surfaced via `staleness`, not silently passed
      }
    }
    break; // success, and not stale (or staleness not checkable)
  }

  return { installDir, ...result, staleness };
}

/**
 * Stderr signatures that indicate the process crashed trying to LOAD/RESOLVE
 * code — a broken install (missing dep, unresolved module, syntax error from
 * a bad bundle). KEPT purely as an informational annotation on a FAIL verdict
 * (so a report can call out "this looks like a known crash-on-load shape")
 * — it is NO LONGER part of the pass/fail decision. See BUG-012: a real
 * `@adhd/backlog@0.1.0` install threw `Error: @adhd/backlog: cannot mount —
 * .../node_modules/@adhd/dist/client.d.ts does not exist. Run "nx build
 * backlog" first ...` on `--help`, which matches NONE of these signatures,
 * and the old verdict (PASS unless a signature matched) let a genuine
 * startup crash through as "controlled argument-parsing rejection". The
 * verdict is now fail-safe by default — see `BENIGN_ARGPARSE` /
 * `classifyBinHelpExit` below — so this list can never again be the reason a
 * crash is misclassified as benign.
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
 * Stderr signatures that indicate a bin exited non-zero on `--help` for a
 * genuinely BENIGN reason: it loaded fully, ran ITS OWN argument-parsing
 * code, and made an ordinary "I don't recognize this flag" decision — never
 * a signal that the install/bundle itself is broken. This is an ALLOWLIST,
 * not a denylist (see `classifyBinHelpExit`): a non-zero exit is FAIL by
 * default now, and only escapes that default by matching one of these,
 * empirically observed against real `@latest` installs from the registry
 * (see clean-room-smoke.spec.mjs and the task's bin-enumeration table):
 *   - `@adhd/agent-mcp`'s `agent-mcp-tail` bin uses `node:util`'s
 *     `parseArgs`, which throws `ERR_PARSE_ARGS_UNKNOWN_OPTION` on `--help`.
 *   - `@adhd/agent-engine-compiler`'s `agent-compiler` bin prints its own
 *     `<bin>: Expected sub-command '<cmd>', got: --help` usage rejection
 *     (no stack trace, no `Error:` prefix — a deliberate, printed decision).
 *   - commander-based CLIs (this workspace's `apigen`/`backlog`/`decompile`)
 *     print `error: unknown option` / `error: unknown command` for a flag
 *     they don't recognize, though in practice every commander bin in this
 *     workspace recognizes `--help` and exits 0, so this is defense-in-depth
 *     rather than an observed live case.
 * DELIBERATELY EXCLUDES anything that could also appear in a real crash: a
 * bare `Error:` + stack trace, `does not exist`, `ENOENT`, `cannot mount`,
 * or `Run "nx build` (all present in the live BUG-012 backlog crash) must
 * NEVER be added here.
 */
const BENIGN_ARGPARSE = ['ERR_PARSE_ARGS_UNKNOWN_OPTION', 'error: unknown option', 'error: unknown command', 'Expected sub-command'];

/** @param {string} stderr @returns {string | null} the matched signature, or null */
function matchBenignArgparse(stderr) {
  return BENIGN_ARGPARSE.find((sig) => stderr.includes(sig)) ?? null;
}

/**
 * The verdict for a single `<bin> --help` invocation. Pure and
 * spawn-free — exactly the seam BUG-012 needed unit-testable without a real
 * child process. FAIL-SAFE BY DEFAULT (BUG-012 fix): a non-zero, non-timed-
 * out exit is FAIL unless it matches the empirically-grounded
 * `BENIGN_ARGPARSE` allowlist. Before this fix the default for a non-zero
 * exit was PASS ("no crash-on-load signature found") — a permissive
 * denylist that a real startup crash (`@adhd/backlog@0.1.0`, whose stderr
 * matched none of `CRASH_ON_LOAD_SIGNATURES`) slipped straight through.
 *
 * Verdict:
 *   - exit 0                                                -> PASS
 *   - still running at timeout (server-style entrypoint)     -> PASS
 *   - exit non-zero AND stderr matches `BENIGN_ARGPARSE`      -> PASS
 *   - exit non-zero, otherwise                                -> FAIL (the
 *     fail-safe default — covers both "matches a known crash-on-load
 *     signature" and, critically, "matches neither list", which is exactly
 *     the BUG-012 case)
 *
 * @param {{ code: number | null, timedOut: boolean, stderr: string, stdout?: string }} outcome
 * @returns {{ ok: true, mode: string } | { ok: false, reason: string }}
 */
export function classifyBinHelpExit({ code, timedOut, stderr }) {
  if (code === 0) {
    return { ok: true, mode: 'exited-0' };
  }
  if (timedOut) {
    return { ok: true, mode: 'still-running-at-timeout (server-style entrypoint, treated as healthy start)' };
  }
  const benignMatch = matchBenignArgparse(stderr || '');
  if (benignMatch) {
    return {
      ok: true,
      mode: `exited ${code} matched benign arg-parse rejection ("${benignMatch}") — the bin loaded and ran its own arg parser, not a broken install`,
    };
  }
  const knownCrashSignature = looksLikeCrashOnLoad(stderr || '');
  return {
    ok: false,
    reason:
      `exited ${code} with no benign arg-parse signature — fail-safe default treats this as a startup crash (BUG-012)` +
      (knownCrashSignature ? ' [matches a known crash-on-load signature]' : ' [no known signature matched either — still FAIL by default]') +
      ` — stderr: ${(stderr || '').slice(0, 2000)}`,
  };
}

/**
 * Resolve the installed package's own declared `bin` entries (from what
 * ACTUALLY landed in `node_modules`, not the source manifest) and smoke each:
 * spawn it with a small, framework-agnostic safe argv and a bounded timeout.
 *
 * Verdict is FAIL-SAFE BY DEFAULT (BUG-012 fix — see `classifyBinHelpExit`
 * for the pure decision function this delegates to): the thing this gate
 * must catch is an IMMEDIATE crash (module resolution failure, syntax error,
 * uncaught throw during startup, a thrown "cannot mount"/setup error), not
 * "did it exit 0" (a long-running MCP/server bin is SUPPOSED to keep
 * running, and a real, working CLI rejecting an unrecognized flag via its
 * own arg parser is SUPPOSED to exit non-zero). A non-zero exit is now FAIL
 * UNLESS it is proven benign:
 *   - exits 0 before the timeout                       -> PASS
 *   - still running when the timeout fires (killed)    -> PASS (a server-style
 *     entrypoint staying alive IS the healthy outcome — this is exactly
 *     `verify-dist-load`'s own "existenceOnly" reasoning for `bin`-shipping
 *     packages, applied to a real installed artifact instead of local dist)
 *   - exits non-zero, stderr matches the empirically-grounded
 *     `BENIGN_ARGPARSE` allowlist (e.g. `ERR_PARSE_ARGS_UNKNOWN_OPTION`)
 *     -> PASS (a controlled argument-parsing rejection, not a broken install)
 *   - exits non-zero, otherwise                          -> FAIL (fail-safe
 *     default — this is what BUG-012 needed: `@adhd/backlog@0.1.0`'s real
 *     `--help` crash — `Error: @adhd/backlog: cannot mount — .../
 *     node_modules/@adhd/dist/client.d.ts does not exist. Run "nx build
 *     backlog" first ...` — matched NONE of the old `CRASH_ON_LOAD_SIGNATURES`
 *     denylist and was misclassified PASS under the previous "permissive
 *     unless proven bad" verdict; it now correctly FAILs because it matches
 *     no benign-allowlist signature either)
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
    const verdict = classifyBinHelpExit(res);
    results.push(verdict.ok ? { binName, ok: true, mode: verdict.mode } : { binName, ok: false, reason: verdict.reason });
  }
  const ok = results.every((r) => r.ok);
  return { ok, results };
}

/**
 * Resolve a single `exports` condition node to a file path, preferring
 * conditions in the order a real Node consumer's dynamic `import()` would
 * try them for a package whose actual module format is unknown up front
 * (this gate loads every library via `import()` regardless of its declared
 * `type`, since dynamic `import()` loads CJS targets too) — `import` first
 * (an explicit ESM entry, if the package ships a dual build), then `node`
 * (Node-specific override), then `default`/`require` (whichever exists) as
 * the universal fallback most single-format packages actually declare.
 *
 * @param {unknown} node
 * @returns {string | null}
 */
function resolveExportsCondition(node) {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return null;
  for (const condition of ['import', 'node', 'default', 'require']) {
    if (node[condition] != null) {
      const resolved = resolveExportsCondition(node[condition]);
      if (resolved) return resolved;
    }
  }
  return null;
}

/**
 * Resolve the entry file a real consumer would load for this INSTALLED
 * package — `exports["."]` first (the modern, authoritative resolution
 * field when present), falling back to `main`, falling back to the Node
 * default of `./index.js` for a package that declares neither (rare, but
 * not itself a reason to skip the smoke — let the missing-file check below
 * report the real failure instead of this function silently giving up).
 *
 * @param {object} installedPkg parsed `node_modules/<name>/package.json`
 * @returns {string}
 */
export function resolveInstalledEntry(installedPkg) {
  if (installedPkg.exports) {
    const rootExport = typeof installedPkg.exports === 'string' ? installedPkg.exports : installedPkg.exports['.'] ?? installedPkg.exports;
    const resolved = resolveExportsCondition(rootExport);
    if (resolved) return resolved;
  }
  if (typeof installedPkg.main === 'string' && installedPkg.main.length > 0) return installedPkg.main;
  return './index.js';
}

/**
 * The registry-level analog of `verify-dist-load` for a LIBRARY (non-`bin`)
 * package: resolve its real installed entry point and `import()` it in a
 * dedicated, fresh child process (never in-process in this gate's own
 * process — an arbitrary installed package's module-level side effects
 * must never be able to corrupt or crash the gate itself, exactly why
 * `smokeInstalledBin` already spawns rather than requiring in-process).
 * Mocks nothing: the real installed file, the real Node module resolution,
 * a real dynamic `import()`.
 *
 * Verdict:
 *   - `import()` resolves                              -> PASS
 *   - `import()` rejects/throws                         -> FAIL
 *   - resolved entry file missing from the install      -> FAIL
 *   - load exceeds `LIBRARY_LOAD_TIMEOUT_MS`             -> FAIL (unlike a
 *     bin, a pure library finishing module evaluation and then just SITTING
 *     there is not a legitimate outcome — there is no "server-style" excuse
 *     here, so a hang is always a real defect, never treated as healthy)
 *
 * @param {string} installDir
 * @param {string} pkgName
 */
export async function smokeInstalledLibraryLoad(installDir, pkgName) {
  const installedPkgJsonPath = join(installDir, 'node_modules', pkgName, 'package.json');
  if (!existsSync(installedPkgJsonPath)) {
    return { ok: false, reason: `installed package.json not found at ${installedPkgJsonPath} — install did not land where expected` };
  }
  let installedPkg;
  try {
    installedPkg = JSON.parse(readFileSync(installedPkgJsonPath, 'utf8'));
  } catch (err) {
    return { ok: false, reason: `could not parse installed package.json: ${err.message}` };
  }

  const entryRel = resolveInstalledEntry(installedPkg);
  const entryAbs = join(installDir, 'node_modules', pkgName, entryRel);
  if (!existsSync(entryAbs)) {
    return {
      ok: false,
      reason: `resolved entry file missing on disk: ${entryAbs} (resolved from declared exports/main: "${entryRel}") — the published tarball does not contain the file its own manifest points to`,
    };
  }

  const entryUrl = pathToFileURL(entryAbs).href;
  // A fresh, isolated child process per package (see function header) — the
  // script itself is trivial: dynamic-import the resolved entry, exit 0 on
  // success, print the real stack and exit 1 on any rejection/throw.
  const loadScript =
    `import(${JSON.stringify(entryUrl)}).then(() => { process.exit(0); }, (err) => { ` +
    `console.error(err && err.stack ? err.stack : String(err)); process.exit(1); });`;
  const res = await run(process.execPath, ['-e', loadScript], { timeoutMs: LIBRARY_LOAD_TIMEOUT_MS, cwd: installDir });

  if (res.code === 0) {
    return { ok: true, entryRel };
  }
  if (res.timedOut) {
    return {
      ok: false,
      reason: `module load timed out after ${LIBRARY_LOAD_TIMEOUT_MS}ms importing "${entryRel}" — a pure library hanging at import time (not exiting once its module graph finishes evaluating) is itself a defect`,
    };
  }
  return { ok: false, reason: `import() threw loading "${entryRel}" — stderr: ${res.stderr.slice(0, 2000)}` };
}

/**
 * Full clean-room smoke for one LIBRARY package: install from the real
 * registry, then real-load-smoke it. Mirrors `smokeOneEntrypoint`'s
 * structure/cleanup guarantee exactly, swapping the bin-crash check for the
 * module-load check.
 *
 * @param {{ projectRoot: string, name: string }} target
 * @param {{ registryUrl?: string }} [opts]
 */
export async function smokeOneLibrary(target, opts = {}) {
  const scratchRoot = join(workspaceRoot, 'tmp', 'nx-build-smoke');
  const t0 = Date.now();
  const install = await cleanRoomInstall(target.name, scratchRoot, { ...opts, onDiskVersion: target.version });
  try {
    if (install.code !== 0) {
      return {
        name: target.name,
        projectRoot: target.projectRoot,
        kind: 'library',
        ok: false,
        stage: 'install',
        reason: install.timedOut
          ? `npm install timed out after ${INSTALL_TIMEOUT_MS}ms`
          : `npm install exited ${install.code} — stderr: ${install.stderr.slice(0, 4000)}`,
        elapsedMs: Date.now() - t0,
      };
    }
    if (install.staleness) {
      return {
        name: target.name,
        projectRoot: target.projectRoot,
        kind: 'library',
        ok: false,
        stage: 'install',
        reason:
          `npm install @latest resolved a STALE version after ${install.staleness.attemptsMade} attempt(s): resolved ` +
          `"${install.staleness.resolvedVersion}" but this workspace's on-disk source version is "${install.staleness.onDiskVersion}" — ` +
          `real registry/CDN propagation lag (or a genuinely un-published bump); see cleanRoomInstall's "STALE PACKUMENT CACHE" note`,
        elapsedMs: Date.now() - t0,
      };
    }
    const load = await smokeInstalledLibraryLoad(install.installDir, target.name);
    return {
      name: target.name,
      projectRoot: target.projectRoot,
      kind: 'library',
      ok: load.ok,
      stage: load.ok ? 'complete' : 'module-load',
      reason: load.ok ? null : load.reason,
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
  const install = await cleanRoomInstall(entrypoint.name, scratchRoot, { ...opts, onDiskVersion: entrypoint.version });
  try {
    if (install.code !== 0) {
      return {
        name: entrypoint.name,
        projectRoot: entrypoint.projectRoot,
        kind: 'bin',
        ok: false,
        stage: 'install',
        reason: install.timedOut
          ? `npm install timed out after ${INSTALL_TIMEOUT_MS}ms`
          : `npm install exited ${install.code} — stderr: ${install.stderr.slice(0, 4000)}`,
        elapsedMs: Date.now() - t0,
      };
    }
    if (install.staleness) {
      return {
        name: entrypoint.name,
        projectRoot: entrypoint.projectRoot,
        kind: 'bin',
        ok: false,
        stage: 'install',
        reason:
          `npm install @latest resolved a STALE version after ${install.staleness.attemptsMade} attempt(s): resolved ` +
          `"${install.staleness.resolvedVersion}" but this workspace's on-disk source version is "${install.staleness.onDiskVersion}" — ` +
          `real registry/CDN propagation lag (or a genuinely un-published bump); see cleanRoomInstall's "STALE PACKUMENT CACHE" note`,
        elapsedMs: Date.now() - t0,
      };
    }
    const smoke = await smokeInstalledBin(install.installDir, entrypoint.name);
    return {
      name: entrypoint.name,
      projectRoot: entrypoint.projectRoot,
      kind: 'bin',
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
 * Run the full gate: classify every publishable package into bin/library
 * lanes (`classifyPublishableTargets`), smoke ALL of them (both lanes,
 * merged into one bounded-concurrency pool — see `SMOKE_CONCURRENCY`), and
 * assert the coverage union (`computeCoverageGap`) leaves nothing
 * uncovered. A coverage gap fails the gate loudly.
 *
 * @param {{ workspaceRoot?: string, registryUrl?: string, concurrency?: number, classify?: typeof classifyPublishableTargets }} [opts]
 */
export async function runCleanRoomSmoke(opts = {}) {
  const root = opts.workspaceRoot || workspaceRoot;
  const classify = opts.classify || classifyPublishableTargets;
  const { binTargets, libraryTargets } = classify(root);
  const concurrency = opts.concurrency || SMOKE_CONCURRENCY;

  const jobs = [
    ...binTargets.map((t) => ({ target: t, run: () => smokeOneEntrypoint(t, opts) })),
    ...libraryTargets.map((t) => ({ target: t, run: () => smokeOneLibrary(t, opts) })),
  ];
  const results = await mapWithConcurrency(jobs, concurrency, (job) => job.run());

  const coverageGap = computeCoverageGap(root, binTargets, libraryTargets);
  const ok = results.every((r) => r.ok) && coverageGap.uncovered.length === 0;
  return { ok, binTargets, libraryTargets, results, coverageGap };
}

async function main() {
  const asJson = process.argv.includes('--json');
  const t0 = Date.now();
  const { ok, binTargets, libraryTargets, results, coverageGap } = await runCleanRoomSmoke();
  const elapsedMs = Date.now() - t0;

  if (asJson) {
    process.stdout.write(JSON.stringify({ ok, elapsedMs, binCount: binTargets.length, libraryCount: libraryTargets.length, results, coverageGap }, null, 2) + '\n');
  } else {
    console.error(
      `clean-room-smoke: ${results.length} publishable package(s) smoked (${binTargets.length} bin + ${libraryTargets.length} library, ` +
        `concurrency=${SMOKE_CONCURRENCY}, ${elapsedMs}ms wall time).`
    );
    for (const r of results) {
      console.error(`  ${r.ok ? '✓' : '✖'} ${r.name} [${r.kind}] (${r.stage}, ${r.elapsedMs}ms)${r.ok ? '' : ' — ' + r.reason}`);
    }
    console.error(
      `\nclean-room-smoke: coverage — ${coverageGap.directlySmokedCount} package(s) directly smoked, ${coverageGap.closureCount} reachable via the ` +
        `bin-entrypoint dependency closure, ${coverageGap.coveredCount}/${coverageGap.publishableCount} publishable package(s) covered.`
    );
    if (coverageGap.uncovered.length > 0) {
      console.error(
        `clean-room-smoke: DEBT-002 #6 — ${coverageGap.uncovered.length} publishable package(s) are covered by NEITHER a direct smoke NOR the ` +
          'bin-entrypoint closure (package discovery itself is inconsistent — see classifyPublishableTargets/discoverAllPackageManifests):'
      );
      for (const name of coverageGap.uncovered) console.error(`    - ${name}`);
    }
    console.error(
      ok
        ? '\nclean-room-smoke: OK — every publishable package installed from the real registry and (bin) started cleanly / (library) loaded without throwing; 100% coverage confirmed.'
        : '\nclean-room-smoke: FAILED.'
    );
  }
  process.exit(ok ? 0 : 1);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main();
}
