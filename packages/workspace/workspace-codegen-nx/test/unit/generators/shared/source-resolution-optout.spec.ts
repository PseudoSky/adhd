/**
 * source-resolution-optout.spec.ts — repo-wide invariant guard for BUG-062.
 *
 * WHY THIS EXISTS: commit 3776f937 made every project's vitest PARENT graph
 * resolve workspace `@adhd/*` to `src` by hoisting `nxViteTsPathsPre()` ahead of
 * Vite's built-in `vite:resolve` (see `tools/vite-plugins/source-resolution.mjs`).
 * A spawned REAL Node child process still resolves to `dist` and cannot be made
 * to follow the parent's tsconfig paths, so a project whose tests spawn such a
 * child would run one test run against two builds of one package. Four projects
 * are in that class and deliberately opt OUT of the plugin, keeping themselves
 * consistently all-`dist` with `^build` in their test `dependsOn`.
 *
 * This spec pins the invariant so the opt-out set cannot drift silently:
 *   - every `vite.config.ts` EITHER uses the plugin OR is a known opt-out —
 *     never both (a half-applied opt-out) and never neither (a project that
 *     forgot the plugin entirely);
 *   - the opt-out set is EXACTLY the known list below — adding or removing one
 *     fails here, forcing a conscious update (and a review of whether the new
 *     project really does spawn a real-Node `dist` child).
 *
 * WHAT IT DOES NOT DO (stated honestly): it cannot auto-DETECT a brand-new
 * project that *acquires* a real-Node child-process `dist` dependency. Static
 * detection of "spawns node against a built dist entry" across arbitrary test
 * code is not reliable, and a heuristic would be a proxy that passes while the
 * real hazard exists. So this is a regression + change-detector guard on the
 * KNOWN set, not an automatic classifier. When a new project needs to opt out,
 * add it to EXPECTED_OPTOUTS here in the same change.
 *
 * This spec reads the real filesystem (the actual repo configs), not a fixture
 * — the invariant it asserts is about the repo itself.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(path.join(dir, 'nx.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate repo root (nx.json) walking up from ${start}`);
}

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.nx', 'tmp', 'coverage']);

function findViteConfigs(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      findViteConfigs(path.join(dir, entry.name), acc);
    } else if (entry.name === 'vite.config.ts') {
      acc.push(path.join(dir, entry.name));
    }
  }
  return acc;
}

const REPO_ROOT = findRepoRoot(__dirname);
const rel = (f: string) => path.relative(REPO_ROOT, f).split(path.sep).join('/');

/** A config "uses" the plugin iff it imports the helper module. Deliberately
 *  NOT keyed on the call token: the opt-out marker comment itself contains the
 *  call token, so a substring-on-call check would misclassify an opt-out. */
const usesPlugin = (f: string) => fs.readFileSync(f, 'utf8').includes('source-resolution.mjs');
/** The opt-out marker written at each opted-out site (see the 4 configs). */
const isOptOut = (f: string) => fs.readFileSync(f, 'utf8').includes('Deliberately OMITS nxViteTsPathsPre');

/**
 * The known real-Node child-process `dist` projects (BUG-062). Each spawns a
 * real Node child that resolves `@adhd/*` to `dist`, so it must stay all-`dist`.
 */
const EXPECTED_OPTOUTS = [
  'entrypoint/agent-mcp/vite.config.ts',
  'entrypoint/dispatch-cli/vite.config.ts',
  'packages/agent/agent-engine-compiler/vite.config.ts',
  'packages/apigen/apigen-engine-conformance/vite.config.ts',
].sort();

const configs = [
  ...findViteConfigs(path.join(REPO_ROOT, 'packages')),
  ...findViteConfigs(path.join(REPO_ROOT, 'entrypoint')),
];

describe('nxViteTsPathsPre opt-out invariant (BUG-062)', () => {
  it('finds the workspace vite configs it is meant to guard', () => {
    expect(configs.length, 'expected to find the repo vite.config.ts files').toBeGreaterThan(50);
  });

  it('every vite.config.ts either uses the plugin or is a known opt-out — never both, never neither', () => {
    const inconsistent = configs
      .filter((f) => usesPlugin(f) === isOptOut(f))
      .map((f) => `${rel(f)} (uses=${usesPlugin(f)}, optedOut=${isOptOut(f)})`);
    expect(
      inconsistent,
      `configs that both use and opt out, or do neither:\n${inconsistent.join('\n')}`
    ).toEqual([]);
  });

  it('the opted-out set is exactly the known child-process-dist set', () => {
    const actual = configs.filter(isOptOut).map(rel).sort();
    expect(
      actual,
      'the opt-out set changed — review whether the added/removed project really ' +
        'spawns a real-Node child resolving @adhd/* from dist, then update EXPECTED_OPTOUTS'
    ).toEqual(EXPECTED_OPTOUTS);
  });

  it('every other config wires the plugin', () => {
    const optOutSet = new Set(EXPECTED_OPTOUTS);
    const missing = configs.filter((f) => !optOutSet.has(rel(f)) && !usesPlugin(f)).map(rel);
    expect(missing, `configs missing the plugin:\n${missing.join('\n')}`).toEqual([]);
  });
});
