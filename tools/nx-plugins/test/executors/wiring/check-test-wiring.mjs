#!/usr/bin/env node
/**
 * check-test-wiring — every project that ships spec/test files MUST declare a
 * runnable `test` target.
 *
 * Why this exists (BUG-NXTEST-001, 2026-07-16): `nx run-many -t test` reports
 * SUCCESS for projects that don't define the target at all — so a project can
 * carry hundreds of test cases that never execute while every pipeline stays
 * green. 75 cases across dispatch-core-optimizer / agent-plugin-budget /
 * agent-plugin-sanitize sat unrun this way, and two published documents cited
 * them as passing. This gate makes that class of silent green impossible.
 *
 * Exit code is the only signal (0 = wired, 1 = gap found), per the repo's
 * verification standard — never grep stdout for "passed".
 */
import { globSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../..');

/**
 * Read the resolved Nx project graph ONCE and return `{ root -> Set(targetName) }`.
 * Resolved targets include those inferred by Nx plugins (e.g. `test` from a
 * plugin's createNodes), which a literal read of project.json cannot see.
 */
export function readGraphTargets(cwd = REPO_ROOT) {
  const dir = mkdtempSync(join(tmpdir(), 'test-wiring-graph-'));
  try {
    const file = join(dir, 'graph.json');
    const nxBin = join(cwd, 'node_modules', '.bin', 'nx');
    const r = spawnSync(nxBin, ['graph', `--file=${file}`], { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`project graph read failed (nx graph) rc=${r.status}: ${r.stderr || r.stdout}`);
    const nodes = JSON.parse(readFileSync(file, 'utf8')).graph.nodes;
    const byRoot = new Map();
    for (const node of Object.values(nodes)) byRoot.set(node.data.root, new Set(Object.keys(node.data.targets ?? {})));
    return byRoot;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Pure core: projects that ship spec files but have no `test` target, literal
 * (project.json) or inferred (project graph).
 * @param {string} cwd workspace root
 * @param {Map<string, Set<string>>} graphTargets root -> resolved target names
 */
export function findWiringGaps(cwd, graphTargets) {
  const projects = globSync('{packages/*/*,entrypoint/*}/project.json', {
    cwd,
    exclude: (p) => /node_modules|\.worktrees|\.claude/.test(p),
  });
  const gaps = [];
  for (const projectJson of projects) {
    const root = dirname(projectJson);
    const specs = globSync([join(root, 'test/unit/**/*.spec.{ts,tsx}'), join(root, 'test/e2e/**/*.e2e.ts')], {
      cwd,
      exclude: (p) => /node_modules|__files__/.test(p),
    });
    if (specs.length === 0) continue;
    const literal = JSON.parse(readFileSync(join(cwd, projectJson), 'utf8')).targets ?? {};
    const resolved = graphTargets.get(root) ?? new Set();
    if (!literal.test && !resolved.has('test')) gaps.push({ root, specCount: specs.length });
  }
  return { gaps, scanned: projects.length };
}

function main() {
  const { gaps, scanned } = findWiringGaps(REPO_ROOT, readGraphTargets(REPO_ROOT));
  if (gaps.length > 0) {
    console.error('✖ projects with test files but NO `test` target, literal or inferred (their tests can NEVER run):');
    for (const { root, specCount } of gaps) console.error(`   ${root}  (${specCount} spec file(s))`);
    console.error('  Fix: add a `test` target (see packages/agent/agent-store-runtime/project.json for the shape).');
    process.exit(1);
  }
  return scanned;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const scannedCount = isMain ? main() : 0;

if (isMain) {
// The layout rules (check-test-layout.mjs) keep every test where the `test` and `e2e` lanes look for it.
const layoutCheck = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'check-test-layout.mjs')], {
  stdio: 'inherit',
});
if (layoutCheck.status !== 0) process.exit(layoutCheck.status ?? 1);

// Delegate the workspace-scoped lane-reachability assertions (rule set in
// check-lane-reachability.mjs). This keeps the two checks inseparable: a project
// can be "wired" (has a `test` target) and still have an unreachable/uncached
// heavy lane. That script is also the canonical entry point invoked by the
// pre-push hook and both CI workflows; we call the SAME file so there is one
// rule set, not two.
const laneCheck = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'check-lane-reachability.mjs')], {
  stdio: 'inherit',
});
if (laneCheck.status !== 0) process.exit(laneCheck.status ?? 1);

console.log(`✓ test wiring OK — every project with spec files (${scannedCount} projects scanned) declares a test target.`);
}
