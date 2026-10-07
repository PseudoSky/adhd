/**
 * Phase-6 bucket C acceptance specs — release / CI / workspace-toolchain integrity.
 * Every test names "<backlog uid> <AC id>" and every AC carries a NEGATIVE CONTROL:
 * the same check is run against a deliberately-wrong input and must report the defect.
 * Fixtures are real throwaway git repos / trees under os.tmpdir(), removed in `finally`.
 *
 *   8c0c314e C-AC3  deepsource config is wired to a workflow or gone
 *   255394d0 C-AC4  no stale vite ~5 / vitest ^1 pins (entrypoint/backlog is sequenced after A/B — see EXEMPT)
 *   b83f167d C-AC5  `nx run <p>:test <file>` runs only that file (vitest-reported file count)
 *   420a7051 C-AC6  published-vs-source parity fails when source is behind
 *   e92e2b92 C-AC7  tree-clean gate exits non-zero on a dirty tree and is invoked by both CI workflows
 *   7b7d5e38 C-AC8  scripts/worktree-setup.sh gives a worktree a REAL node_modules
 *   ddceb069 C-AC9  demo gate is an nx target invoked by CI (its teeth: docs/plan/actionable-store/demo/fixture/demo-gate.spec.mjs)
 *
 * Run: node --test tools/nx-plugins/build/ci-hygiene.spec.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..', '..');
const { cleanGitEnv } = require('../lib/git-env.js');
const { checkParity, publishedFromState } = require('./lib/published-parity.js');
const { discoverReleaseSet } = require('./lib/range-resolvability.js');

// 50e8c966: every spawn here runs git (directly or via worktree-setup.sh / nx) against throwaway
// repos — ambient hook-exported GIT_* must never reach them. An explicit opts.env is scrubbed too.
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts, env: cleanGitEnv(opts.env ?? process.env) });
const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const read = (rel) => readFileSync(join(REPO, rel), 'utf8');

// ── C-AC3 ────────────────────────────────────────────────────────────────────
/** Violations of "`.deepsource.toml` is either invoked by a workflow step or deleted". */
function deepsourceViolations(root) {
  const out = [];
  const tomlExists = existsSync(join(root, '.deepsource.toml'));
  const wfDir = join(root, '.github/workflows');
  const wfText = existsSync(wfDir) ? readdirSync(wfDir).map((f) => readFileSync(join(wfDir, f), 'utf8')).join('\n') : '';
  const wfMentions = /deepsource/i.test(wfText);
  if (tomlExists && !wfMentions) out.push('.deepsource.toml exists but no workflow step invokes DeepSource');
  if (!tomlExists && wfMentions) out.push('.deepsource.toml is deleted but a workflow still references DeepSource');
  return out;
}

test('8c0c314e C-AC3: .deepsource.toml is wired to a workflow or deleted — and the live repo agrees', () => {
  assert.deepEqual(deepsourceViolations(REPO), []);
  assert.ok(!existsSync(join(REPO, '.deepsource.toml')), 'decision: deleted (docs/PIPELINE.md records why)');
  // the CI-equivalent claim in docs must match the decision
  assert.doesNotMatch(read('docs/PIPELINE.md'), /configured by\s+the committed `\.deepsource\.toml`/);
});

test('8c0c314e C-AC3 NEGATIVE CONTROL: an unwired config / a dangling workflow reference is reported', () => {
  const root = tmp('c-ac3-');
  try {
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    writeFileSync(join(root, '.github/workflows/ci.yml'), 'name: CI\njobs: {}\n');
    writeFileSync(join(root, '.deepsource.toml'), 'version = 1\n');
    assert.equal(deepsourceViolations(root).length, 1);
    rmSync(join(root, '.deepsource.toml'));
    writeFileSync(join(root, '.github/workflows/ci.yml'), 'steps:\n  - run: deepsource report\n');
    assert.equal(deepsourceViolations(root).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── C-AC4 ────────────────────────────────────────────────────────────────────
// entrypoint/backlog/package.json is deliberately EXEMPT: its vite bump is
// sequenced after buckets A/B merge (owner constraint, recorded as a residual on 255394d0).
const EXEMPT = new Set(['entrypoint/backlog/package.json']);
const STALE = /"vite":\s*"~5|"vitest":\s*"\^1/;

function packageJsonFiles(root) {
  const found = [];
  for (const top of ['packages', 'entrypoint', 'tools']) {
    const dir = join(root, top);
    if (!existsSync(dir)) continue;
    const walk = (d, depth) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.nx') continue;
        const p = join(d, e.name);
        if (e.isDirectory() && depth < 4) walk(p, depth + 1);
        else if (e.isFile() && e.name === 'package.json') found.push(p);
      }
    };
    walk(dir, 0);
  }
  return found;
}
function stalePins(root, exempt = EXEMPT) {
  return packageJsonFiles(root)
    .map((p) => p.slice(root.length + 1))
    .filter((rel) => !exempt.has(rel) && STALE.test(readFileSync(join(root, rel), 'utf8')));
}

test('255394d0 C-AC4: no package.json under packages/entrypoint/tools pins vite ~5 or vitest ^1 (backlog exempt, sequenced)', () => {
  assert.deepEqual(stalePins(REPO), []);
  // the exemption is the ONLY remaining stale pin — if backlog is bumped this must be removed
  assert.deepEqual(stalePins(REPO, new Set()), packageJsonFiles(REPO).map((p) => p.slice(REPO.length + 1)).filter((r) => EXEMPT.has(r) && STALE.test(read(r))));
});

test('255394d0 C-AC4 NEGATIVE CONTROL: a package.json with the old pins is reported', () => {
  const root = tmp('c-ac4-');
  try {
    mkdirSync(join(root, 'packages/agent/x'), { recursive: true });
    writeFileSync(join(root, 'packages/agent/x/package.json'), '{"devDependencies":{"vite":"~5.0.13","vitest":"^1.6.0"}}');
    assert.deepEqual(stalePins(root), ['packages/agent/x/package.json']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── C-AC5 ────────────────────────────────────────────────────────────────────
const FILE = 'packages/agent/agent-core-env/src/__tests__/open-registry-db.test.ts';
function nxTest(extra) {
  const env = cleanGitEnv(process.env, { CI: 'true' });
  for (const k of Object.keys(env)) if (k.startsWith('NX_TASK') || k === 'NX_WORKSPACE_ROOT_PATH') delete env[k];
  const r = sh('npx', ['nx', 'run', 'agent-core-env:test', '--excludeTaskDependencies', ...extra], { cwd: REPO, env });
  const m = /Test Files\s+(?:\d+ failed \| )?(\d+) passed \((\d+)\)/.exec(r.stdout + r.stderr);
  return { status: r.status, files: m ? Number(m[2]) : null };
}
function assertSingleFile(run) {
  assert.equal(run.status, 0);
  assert.equal(run.files, 1, `vitest must report exactly 1 test file, got ${run.files}`);
}

test('b83f167d C-AC5: `nx run <project>:test <file>` runs only that file (vitest-reported file count = 1)', () => {
  assertSingleFile(nxTest([FILE]));
});

test('b83f167d C-AC5 NEGATIVE CONTROL: an unfiltered run reports more than one file and trips the assertion', () => {
  const full = nxTest([]);
  assert.equal(full.status, 0);
  assert.ok(full.files > 1, `the whole project suite is more than one file (got ${full.files})`);
  assert.throws(() => assertSingleFile(full), /exactly 1 test file/);
});

// ── C-AC6 ────────────────────────────────────────────────────────────────────
test('420a7051 C-AC6: no publishable project is behind published-state.json (real tree)', () => {
  const state = JSON.parse(read('published-state.json'));
  const { ok, violations } = checkParity(discoverReleaseSet(REPO), publishedFromState(state));
  assert.deepEqual(violations, []);
  assert.ok(ok);
});

test('420a7051 C-AC6: the CLI exits 0 on parity and 1 when a source version is behind (exit codes)', () => {
  const cli = join(here, 'executors/range-check/check-published-parity.mjs');
  const root = tmp('c-ac6-');
  const mk = (srcVersion, pubVersion) => {
    const proj = join(root, 'packages/d/d-core-x');
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(root, 'nx.json'), '{}');
    writeFileSync(join(proj, 'package.json'), JSON.stringify({ name: '@adhd/d-core-x', version: srcVersion, main: './dist/index.js' }));
    writeFileSync(join(proj, 'project.json'), JSON.stringify({ name: 'd-core-x', targets: { build: { executor: 'nx:noop' } } }));
    writeFileSync(join(root, 'published-state.json'), JSON.stringify({ '@adhd/d-core-x': { version: pubVersion } }));
  };
  try {
    // the script locates the workspace from ITS OWN location, so drive the exported runner with an explicit root
    const run = (src, pub) => {
      mk(src, pub);
      const r = sh(process.execPath, ['--input-type=module', '-e',
        `import { runParity } from ${JSON.stringify(pathToFileURL(cli).href)};
         const r = await runParity({ workspaceRoot: ${JSON.stringify(root)} });
         process.exit(r.ok ? 0 : 1);`]);
      return r.status;
    };
    assert.equal(run('0.1.4', '0.1.4'), 0, 'equal is settled');
    assert.equal(run('0.1.5', '0.1.4'), 0, 'ahead is an in-progress bump');
    assert.equal(run('0.1.3', '0.1.4'), 1, 'behind is the 420a7051 defect');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('420a7051 C-AC6 NEGATIVE CONTROL: the pure check reports the exact 0.1.3-vs-0.1.4 case and ignores never-published projects', () => {
  const set = [{ name: '@adhd/a', projectRoot: 'p/a', version: '0.1.3' }, { name: '@adhd/b', projectRoot: 'p/b', version: '0.0.1' }];
  const { ok, violations } = checkParity(set, new Map([['@adhd/a', ['0.1.2', '0.1.4']]]));
  assert.equal(ok, false);
  assert.deepEqual(violations.map((v) => [v.name, v.source, v.published]), [['@adhd/a', '0.1.3', '0.1.4']]);
});

// ── C-AC7 ────────────────────────────────────────────────────────────────────
const TREE_CLEAN = join(here, 'executors/tree-clean/check-tree-clean.mjs');
function scratchRepo() {
  const root = tmp('c-ac7-');
  sh('git', ['init', '-q'], { cwd: root });
  sh('git', ['config', 'user.email', 't@example.com'], { cwd: root });
  sh('git', ['config', 'user.name', 'T'], { cwd: root });
  writeFileSync(join(root, 'tracked.txt'), 'a\n');
  sh('git', ['add', '-A'], { cwd: root });
  sh('git', ['commit', '-q', '-m', 'init'], { cwd: root });
  return root;
}
const wiresTreeClean = (yaml) => /nx run @adhd\/source:check-tree-clean/.test(yaml);

test('e92e2b92 C-AC7: the tree-clean gate exits 0 on a clean tree and non-zero when a step touches a tracked file or leaves an untracked one', () => {
  const root = scratchRepo();
  try {
    assert.equal(sh(process.execPath, [TREE_CLEAN], { cwd: root }).status, 0);
    writeFileSync(join(root, 'tracked.txt'), 'changed by a CI step\n');
    const red = sh(process.execPath, [TREE_CLEAN], { cwd: root });
    assert.equal(red.status, 1);
    assert.match(red.stderr, /tracked\.txt/);
    writeFileSync(join(root, 'tracked.txt'), 'a\n'); // restore the committed content
    writeFileSync(join(root, 'stray.txt'), 'untracked\n');
    assert.equal(sh(process.execPath, [TREE_CLEAN], { cwd: root }).status, 1, 'an untracked file is also a dirty tree');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('e92e2b92 C-AC7: it is an nx target and BOTH CI workflows invoke it', () => {
  const project = JSON.parse(read('project.json'));
  assert.match(project.targets['check-tree-clean'].options.command, /check-tree-clean\.mjs/);
  assert.ok(wiresTreeClean(read('.github/workflows/ci.yml')), 'ci.yml must invoke the gate');
  assert.ok(wiresTreeClean(read('.github/workflows/pull-request.yml')), 'pull-request.yml must invoke the gate');
});

test('e92e2b92 C-AC7 NEGATIVE CONTROL: a workflow without the step is detected', () => {
  assert.equal(wiresTreeClean('steps:\n  - run: npx nx affected -t test\n'), false);
});

// ── C-AC8 ────────────────────────────────────────────────────────────────────
const SETUP = join(REPO, 'scripts/worktree-setup.sh');
function assertRealNodeModules(dir) {
  const nm = join(dir, 'node_modules');
  assert.ok(existsSync(nm), 'node_modules must exist');
  assert.equal(lstatSync(nm).isSymbolicLink(), false, 'node_modules must not be a symlink');
  assert.ok(lstatSync(nm).isDirectory(), 'node_modules must be a directory');
}

test('7b7d5e38 C-AC8: worktree-setup.sh <name> creates .worktrees/<name> with an installed, non-symlink node_modules', () => {
  const root = tmp('c-ac8-');
  try {
    sh('git', ['init', '-q'], { cwd: root });
    sh('git', ['config', 'user.email', 't@example.com'], { cwd: root });
    sh('git', ['config', 'user.name', 'T'], { cwd: root });
    // an offline-installable dependency so pnpm has something to put in node_modules
    mkdirSync(join(root, 'local-dep'));
    writeFileSync(join(root, 'local-dep/package.json'), JSON.stringify({ name: 'local-dep', version: '1.0.0' }));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'scratch', version: '1.0.0', private: true, packageManager: 'pnpm@8.15.9', dependencies: { 'local-dep': 'file:./local-dep' } }));
    const lock = sh('corepack', ['pnpm', 'install', '--lockfile-only'], { cwd: root });
    assert.equal(lock.status, 0, lock.stderr);
    writeFileSync(join(root, '.gitignore'), 'node_modules\n.worktrees\n');
    sh('git', ['add', '-A'], { cwd: root });
    sh('git', ['commit', '-q', '-m', 'init'], { cwd: root });

    const r = sh('bash', [SETUP, 'wt-one'], { cwd: root });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const wt = join(root, '.worktrees/wt-one');
    assert.ok(existsSync(join(wt, '.git')), 'a real git worktree');
    assertRealNodeModules(wt);
    assert.ok(existsSync(join(wt, 'node_modules/.modules.yaml')), 'pnpm actually installed into it');
    assert.equal(sh('git', ['status', '--porcelain'], { cwd: wt }).stdout, '', 'the frozen install must not dirty the worktree');
    assert.equal(sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: wt }).stdout.trim(), 'feat/wt-one');

    // refusals: existing path, bad name
    assert.equal(sh('bash', [SETUP, 'wt-one'], { cwd: root }).status, 1);
    assert.equal(sh('bash', [SETUP, 'a/b'], { cwd: root }).status, 2);
    assert.equal(sh('bash', [SETUP], { cwd: root }).status, 2);

    // invoked from INSIDE a worktree it still creates under the MAIN checkout's .worktrees
    const r2 = sh('bash', [SETUP, 'wt-two'], { cwd: wt });
    assert.equal(r2.status, 0, r2.stdout + r2.stderr);
    assertRealNodeModules(join(root, '.worktrees/wt-two'));
  } finally {
    // Remove ONLY worktrees living under this fixture's own <realpath(root)>/.worktrees/ — never
    // anything else `git worktree list` prints (50e8c966), and never --force outside that scope.
    const fixtureWorktrees = join(realpathOf(root), '.worktrees') + '/';
    const list = sh('git', ['worktree', 'list', '--porcelain'], { cwd: root }).stdout;
    for (const m of list.matchAll(/^worktree (.+)$/gm)) if (m[1].startsWith(fixtureWorktrees)) sh('git', ['worktree', 'remove', '--force', m[1]], { cwd: root });
    rmSync(root, { recursive: true, force: true });
  }
});
function realpathOf(p) { return sh('realpath', [p]).stdout.trim(); }

test('7b7d5e38 C-AC8 NEGATIVE CONTROL: a symlinked node_modules fails the same assertion', () => {
  const root = tmp('c-ac8n-');
  try {
    mkdirSync(join(root, 'real'));
    symlinkSync(join(root, 'real'), join(root, 'node_modules'));
    assert.throws(() => assertRealNodeModules(root), /must not be a symlink/);
    const empty = tmp('c-ac8e-');
    try { assert.throws(() => assertRealNodeModules(empty), /must exist/); } finally { rmSync(empty, { recursive: true, force: true }); }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.doesNotMatch(read('docs/contributing/conventions/worktree-workflow.md'), /\(not yet written/);
});

// ── C-AC9 ────────────────────────────────────────────────────────────────────
const wiresDemo = (yaml) => /nx run @adhd\/source:demo-acceptance\b/.test(yaml);

test('ddceb069 C-AC9: the demo runner is an nx target (builds backlog first) and the CI workflow invokes it and its teeth check', () => {
  const t = JSON.parse(read('project.json')).targets;
  assert.match(t['demo-acceptance'].options.command, /actionable-store\/demo\/fixture\/run\.mjs/);
  assert.ok(t['demo-acceptance'].dependsOn.includes('backlog:build'));
  assert.match(t['demo-acceptance-teeth'].options.command, /demo-gate\.spec\.mjs/);
  const ci = read('.github/workflows/ci.yml');
  assert.ok(wiresDemo(ci));
  assert.match(ci, /nx run @adhd\/source:demo-acceptance-teeth/);
});

test('ddceb069 C-AC9 NEGATIVE CONTROL: a workflow without the step is detected (the red-on-broken-control proof is demo-gate.spec.mjs)', () => {
  assert.equal(wiresDemo('steps:\n  - run: npx nx affected -t test\n'), false);
  assert.ok(existsSync(join(REPO, 'docs/plan/actionable-store/demo/fixture/demo-gate.spec.mjs')));
});
