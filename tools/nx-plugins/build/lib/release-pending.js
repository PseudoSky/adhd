'use strict';
/**
 * release-pending.js — the exact list of publishable projects with unreleased changes, with no nx graph,
 * no build, no tests and no network. Cost is one filesystem walk plus one `git diff` per distinct
 * `publishedFromRef` in published-state.json, so it is bounded by git, not by nx or cache state.
 *
 * A project is pending when ANY of:
 *   - never-published     — no published-state.json entry;
 *   - version-drift       — on-disk version differs from the recorded published version;
 *   - source-changed      — a file under its root differs from ITS OWN publishedFromRef (committed, staged,
 *                           unstaged or untracked), ignoring dist/node_modules and test/doc-only paths;
 *   - dependency-changed  — it depends (package.json @adhd/* deps, transitively) on a pending project.
 *
 * Per-package refs are used instead of the oldest-ref window in changed-set.js, so a package is judged
 * against exactly the commit it was last published from. An unresolvable ref (rebased away) marks the
 * package pending with reason `ref-unresolvable`: over-reporting is safe, silently dropping is not.
 */
const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { discoverReleaseSet } = require('./range-resolvability');
const { readState } = require('./published-state');

const IGNORED = [/(^|\/)(dist|node_modules|tmp|coverage)\//, /(^|\/)test\//, /(^|\/)eslint\.config\.[cm]?[jt]s$/, /(^|\/)tsconfig\.spec\.json$/, /(^|\/)vitest(\.[a-z0-9-]+)*\.config\.[cm]?[jt]s$/, /(^|\/)(__tests__|__mocks__|test-setup)(\/|\.)/, /\.(md|spec\.[cm]?[jt]sx?|test\.[cm]?[jt]sx?)$/];

/**
 * Workspace-level inputs that change EVERY package's built or stamped output but sit under no project root.
 * Derived from nx.json `namedInputs.sharedGlobals` (the repo's own declaration), narrowed to the paths that
 * reach `dist/`: the shared tsconfig, the vite plugins the build uses, the manifest generator, the asset copier
 * and the plugin that defines the build targets. `tools/nx-plugins/build/**` as a whole is NOT listed: it also
 * holds the release flow itself (publish, version, smoke), which never changes a built artifact. Specs are
 * excluded by IGNORED. Over-reporting here is safe — `version`'s tarball-hash comparison no-ops a false positive.
 */
const GLOBAL_INPUT_PATHS = [
  'tsconfig.base.json',
  'tools/vite-plugins/externalize.mjs',
  'tools/vite-plugins/source-resolution.mjs',
  'tools/vite-plugins/copy-readme.mjs',
  'packages/workspace/workspace-base-vite-paths/src',
  'tools/nx-plugins/build/plugin.js',
  'tools/nx-plugins/build/executors/manifest',
  'tools/nx-plugins/assets/executors/copy',
];

function git(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new Error(`release-pending: git ${args[0]} failed to spawn: ${r.error.message}`);
  return r;
}

function lines(s) {
  return String(s || '').split('\n').filter(Boolean);
}

function isRelevant(path) {
  return !IGNORED.some((re) => re.test(path));
}

/**
 * Shipped content that IGNORED would otherwise drop: the project's own README.md (`assets` copies it into dist/)
 * and anything under a package.json `assets` entry. CHANGELOG.md is NOT shipped content for this purpose — the
 * release itself writes it in the same commit as the version bump.
 */
function isShippedDoc(path, projectRoot, assets) {
  if (path === `${projectRoot}/README.md`) return true;
  return assets.some((a) => path === `${projectRoot}/${a}` || path.startsWith(`${projectRoot}/${a}/`));
}

function owner(path, roots) {
  let best = null;
  for (const r of roots) if ((path === r || path.startsWith(`${r}/`)) && (!best || r.length > best.length)) best = r;
  return best;
}

/** package.json minus the fields a release itself rewrites (version, @adhd/* ranges), so a version-bump commit is not "source". */
function releaseNeutral(text) {
  let j;
  try { j = JSON.parse(text); } catch { return text; }
  delete j.version;
  for (const f of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    if (!j[f]) continue;
    // Blank the RANGE only: adding or removing an internal dependency is a real change and must stay visible.
    for (const k of Object.keys(j[f])) if (k.startsWith('@adhd/')) j[f][k] = '';
  }
  return JSON.stringify(j);
}

function manifestChanged(root, ref, rel) {
  const old = git(root, ['show', `${ref}:${rel}`]);
  let now = '';
  try { now = readFileSync(join(root, rel), 'utf8'); } catch { return true; }
  return old.status !== 0 || releaseNeutral(old.stdout) !== releaseNeutral(now);
}

function computePending({ workspaceRoot, releaseSet, state } = {}) {
  const set = releaseSet || discoverReleaseSet(workspaceRoot);
  const st = state || readState(workspaceRoot);
  const reasons = new Map(set.map((p) => [p.name, new Set()]));
  const byRef = new Map();
  for (const p of set) {
    const e = st[p.name];
    if (!e) reasons.get(p.name).add('never-published');
    else {
      if (e.version !== p.version) reasons.get(p.name).add('version-drift');
      if (e.publishedFromRef) {
        if (!byRef.has(e.publishedFromRef)) byRef.set(e.publishedFromRef, []);
        byRef.get(e.publishedFromRef).push(p);
      } else {
        // A legacy entry with no baseline cannot be diffed. Silently skipping it would withhold a package whose source
        // changed, so it is pending: over-reporting is safe (`version` no-ops it), under-reporting is not.
        reasons.get(p.name).add('ref-unresolvable');
      }
    }
  }
  const assetsOf = new Map();
  for (const p of set) {
    let a = [];
    try { a = JSON.parse(readFileSync(join(workspaceRoot, p.projectRoot, 'package.json'), 'utf8')).assets; } catch { /* none */ }
    assetsOf.set(p.projectRoot, Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []);
  }
  const ownerOf = new Map(set.map((p) => [p.projectRoot, p.name]));
  const isGlobal = (f) => isRelevant(f) && GLOBAL_INPUT_PATHS.some((g) => f === g || f.startsWith(`${g}/`));
  /** Mark `pkgs` for one changed path `f`; `ref` null = untracked file. Returns nothing. */
  const classify = (f, pkgs, ref) => {
    if (isGlobal(f)) {
      for (const p of pkgs) reasons.get(p.name).add('global-input-changed');
      return;
    }
    const o = owner(f, pkgs.map((p) => p.projectRoot));
    if (!o) return;
    if (!isRelevant(f) && !isShippedDoc(f, o, assetsOf.get(o))) return;
    if (ref && f === `${o}/package.json` && !manifestChanged(workspaceRoot, ref, f)) return;
    reasons.get(ownerOf.get(o)).add('source-changed');
  };
  for (const f of lines(git(workspaceRoot, ['ls-files', '-o', '--exclude-standard']).stdout)) classify(f, set, null);
  for (const [recorded, pkgs] of byRef) {
    let ref = recorded;
    if (git(workspaceRoot, ['cat-file', '-e', `${ref}^{commit}`]).status !== 0) {
      // The recorded commit is gone (rebase/squash/unpushed). The commit that WROTE it into published-state.json
      // is the publish record and is the next-best baseline.
      const rec = lines(git(workspaceRoot, ['log', '-1', '--format=%H', '-S', recorded, '--', 'published-state.json']).stdout)[0];
      if (!rec) {
        for (const p of pkgs) reasons.get(p.name).add('ref-unresolvable');
        continue;
      }
      ref = rec;
    }
    const diff = git(workspaceRoot, ['diff', '--name-only', '--no-renames', ref, '--', ...pkgs.map((p) => p.projectRoot), ...GLOBAL_INPUT_PATHS]);
    if (diff.status !== 0) throw new Error(`release-pending: git diff ${ref} failed: ${diff.stderr}`);
    for (const f of lines(diff.stdout)) classify(f, pkgs, ref);
  }
  const dependents = new Map(set.map((p) => [p.name, []]));
  for (const p of set) for (const d of p.deps) if (dependents.has(d.depName)) dependents.get(d.depName).push(p.name);
  const queue = [...reasons].filter(([, r]) => r.size).map(([n]) => n);
  const seen = new Set(queue);
  while (queue.length) {
    const n = queue.shift();
    for (const dep of dependents.get(n) || []) {
      reasons.get(dep).add('dependency-changed');
      if (!seen.has(dep)) { seen.add(dep); queue.push(dep); }
    }
  }
  return set
    .filter((p) => reasons.get(p.name).size)
    .map((p) => ({ name: p.name, projectRoot: p.projectRoot, version: p.version, reasons: [...reasons.get(p.name)].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { computePending, isRelevant };
