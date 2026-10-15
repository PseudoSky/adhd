#!/usr/bin/env node
/**
 * check-spawn-isolation — the repo-wide static guard for the HOME-redirect
 * isolation posture (backlog 0945d1b9, decisions D1 + D2).
 *
 * THE CLASS. A spec or e2e test that spawns a Node bin (`process.execPath`, or
 * the literal `node`) hands the child the parent's environment. The child builds
 * its own `@adhd/environment` cascade from argv, env and `HOME`, so a child that
 * inherits the real `HOME` reads the machine's real `~/.adhd` config and stores.
 * The isolation mechanism is therefore the HOME redirect: every spawn site must
 * either route through an isolation helper (which sets `HOME` to a throwaway
 * root) or set `HOME` explicitly in its own env. A resolver-side gate cannot
 * protect a child process, so this guard is the control (see
 * docs/decisions/0002 and the spec's D1 rationale).
 *
 * SCOPE. A file is checked when its owning package (nearest `package.json` at or
 * above it) declares a dependency on any `@adhd/environment*` package: those are
 * the packages whose children resolve the cascade. Only `*.spec.*`, `*.test.*` and
 * `*.e2e.*` files under `packages/` and `entrypoint/` are scanned.
 *
 * WHAT IT CHECKS (any violation => exit 1). For each in-scope file, with comments
 * stripped:
 *   A. (spawn-isolation-unrouted) the file spawns a node bin
 *      (`spawn|spawnSync|execFile|execFileSync|fork` with `process.execPath`,
 *      `'node'` or `"node"` as the executable) AND neither imports an isolation
 *      helper (`spawn-isolated-bin` or `spawn-backlog-bin`, or any name passed in
 *      `helpers`) NOR sets an explicit `HOME:` key in an env object.
 *      A file listed in `spawn-isolation.baseline.json` `unrouted` is tolerated
 *      while it still offends; the ratchet can only shrink.
 *   B. (spawn-isolation-baseline-stale) a baseline entry under a scanned root that
 *      no longer offends (routed, moved, renamed or deleted) must be removed.
 *
 * Exit code is the only signal (0 = clean, 1 = violation), per the repo's
 * verification standard. Invoked by check-lane-reachability.mjs (rule 9), which
 * the pre-push hook and both CI workflows run, and by the backlog package's
 * `vocabulary-gate` through a thin caller.
 *
 * `--workspace-root <dir>` points the scan at a fixture workspace; `--baseline <file>`
 * overrides spawn-isolation.baseline.json (fixture runs).
 */
import { existsSync, globSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './check-agent-lane-spawn.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../..');
const BASELINE_PATH = join(HERE, 'spawn-isolation.baseline.json');

const IGNORE = ['**/node_modules/**', '**/dist/**', '**/.worktrees/**', '**/.claude/**'];
const SPEC_FILE = /\.(spec|test|e2e)\.[cm]?[jt]sx?$/;

/** Default workspace roots scanned, relative to the workspace root. */
export const DEFAULT_ROOTS = ['packages', 'entrypoint'];

/** Isolation helpers whose import marks a spawn site as routed. */
export const ISOLATION_HELPERS = ['spawn-isolated-bin', 'spawn-backlog-bin'];

/** A direct spawn of a Node bin: the executable is `process.execPath`, `node` or `"node"`. */
export const NODE_SPAWN = /\b(?:spawn|spawnSync|execFile|execFileSync|fork)\s*\(\s*(?:process\.execPath|'node'|"node")/;

/**
 * The owning package of a workspace-relative file: the nearest `package.json` at
 * or above its directory, read as `{ dir, pkg }`, or `undefined` if none exists.
 * @param {string} workspaceRoot Absolute workspace root.
 * @param {string} relFile Workspace-relative file path.
 * @returns {{ dir: string, pkg: object } | undefined}
 */
export function owningPackage(workspaceRoot, relFile) {
  let dir = dirname(relFile);
  for (;;) {
    const abs = join(workspaceRoot, dir, 'package.json');
    if (existsSync(abs)) return { dir, pkg: JSON.parse(readFileSync(abs, 'utf8')) };
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * True when the package declares any `@adhd/environment*` dependency (runtime,
 * dev or peer). Such a package's children resolve the environment cascade.
 * @param {object} pkg Parsed `package.json`.
 * @returns {boolean}
 */
export function usesEnvironmentFamily(pkg) {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
  return Object.keys(deps).some((name) => name.startsWith('@adhd/environment'));
}

/**
 * Why a spec or e2e source (raw text) spawns a Node bin without isolation, or
 * `undefined` when it does not spawn one or it is routed (imports a helper, or
 * sets an explicit `HOME:` key). Comments are stripped first, so a commented
 * `HOME:` or helper import does not count.
 * @param {string} rawSrc Raw file contents.
 * @param {readonly string[]} [helpers] Helper module names that mark a routed site.
 * @returns {string | undefined}
 */
export function spawnIsolationReason(rawSrc, helpers = ISOLATION_HELPERS) {
  const src = stripComments(rawSrc);
  if (!NODE_SPAWN.test(src)) return undefined;
  const alternation = helpers.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  if (new RegExp(`from\\s+['"][^'"]*(?:${alternation})(?:\\.js)?['"]`).test(src)) return undefined;
  if (/\bHOME\s*:/.test(src)) return undefined;
  return 'spawns a node bin (process.execPath / node) without an isolation helper or an explicit HOME override';
}

/**
 * Run the repo-wide spawn-isolation scan.
 * @param {string} workspaceRoot Absolute workspace root.
 * @param {{ baseline?: { unrouted?: string[] }, roots?: string[], helpers?: string[] }} [opts]
 *   `baseline` overrides the on-disk baseline; `roots` limits the scan (and the
 *   stale-entry check) to those workspace-relative directories.
 * @returns {{ violations: Array<{ rule: string, detail: string }>, scanned: number }}
 */
export function collectSpawnIsolationViolations(workspaceRoot, opts = {}) {
  const roots = opts.roots ?? DEFAULT_ROOTS;
  const helpers = opts.helpers ?? ISOLATION_HELPERS;
  const baseline =
    opts.baseline ?? (existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) : { unrouted: [] });
  const known = new Set(baseline.unrouted ?? []);
  const offending = new Set();
  const violations = [];
  let scanned = 0;

  for (const root of roots) {
    if (!existsSync(join(workspaceRoot, root))) continue;
    for (const f of globSync('**/*.*', { cwd: join(workspaceRoot, root), ignore: IGNORE })) {
      if (!SPEC_FILE.test(f)) continue;
      const rel = `${root}/${f}`;
      const owner = owningPackage(workspaceRoot, rel);
      if (!owner || !usesEnvironmentFamily(owner.pkg)) continue;
      scanned += 1;
      const why = spawnIsolationReason(readFileSync(join(workspaceRoot, rel), 'utf8'), helpers);
      if (!why) continue;
      offending.add(rel);
      if (!known.has(rel)) {
        violations.push({
          rule: 'spawn-isolation-unrouted',
          detail: `${rel} — ${why}. Route the spawn through an isolation helper (spawn-isolated-bin or spawn-backlog-bin) or set an explicit HOME in the child env (backlog 0945d1b9 AC1).`,
        });
      }
    }
  }

  for (const rel of known) {
    const underScannedRoot = roots.some((root) => rel.startsWith(`${root}/`));
    if (underScannedRoot && !offending.has(rel)) {
      violations.push({
        rule: 'spawn-isolation-baseline-stale',
        detail: `${rel} — listed in spawn-isolation.baseline.json unrouted but no longer an unrouted spawn (routed, moved, renamed or deleted); remove the entry.`,
      });
    }
  }

  return { violations, scanned };
}

function isEntry() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return process.argv[1] === fileURLToPath(import.meta.url);
  }
}

function main() {
  const i = process.argv.indexOf('--workspace-root');
  const workspaceRoot = i >= 0 ? resolve(process.argv[i + 1]) : REPO_ROOT;
  const b = process.argv.indexOf('--baseline');
  const baseline = b >= 0 ? JSON.parse(readFileSync(resolve(process.argv[b + 1]), 'utf8')) : undefined;
  const { violations, scanned } = collectSpawnIsolationViolations(workspaceRoot, { baseline });
  if (violations.length > 0) {
    console.error('✖ spawn-isolation check FAILED:');
    for (const v of violations) console.error(`   [${v.rule}] ${v.detail}`);
    process.exit(1);
  }
  console.log(
    `✓ spawn-isolation OK — ${scanned} spec/e2e file(s) in @adhd/environment-family packages checked; every node spawn is routed or baselined.`,
  );
}

if (isEntry()) main();
