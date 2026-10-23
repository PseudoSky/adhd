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

const IGNORED = [/(^|\/)(dist|node_modules|tmp|coverage)\//, /(^|\/)test\//, /(^|\/)(project\.json|eslint\.config\.[cm]?js)$/, /\.(md|spec\.[cm]?[jt]sx?|test\.[cm]?[jt]sx?)$/];

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
    for (const k of Object.keys(j[f])) if (k.startsWith('@adhd/')) delete j[f][k];
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
  const roots = set.map((p) => p.projectRoot);
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
      }
    }
  }
  const untracked = lines(git(workspaceRoot, ['ls-files', '-o', '--exclude-standard']).stdout).filter(isRelevant);
  const ownerOf = new Map(set.map((p) => [p.projectRoot, p.name]));
  for (const f of untracked) {
    const o = owner(f, roots);
    if (o) reasons.get(ownerOf.get(o)).add('source-changed');
  }
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
    const diff = git(workspaceRoot, ['diff', '--name-only', '--no-renames', ref, '--', ...pkgs.map((p) => p.projectRoot)]);
    if (diff.status !== 0) throw new Error(`release-pending: git diff ${ref} failed: ${diff.stderr}`);
    const mine = new Set(pkgs.map((p) => p.projectRoot));
    for (const f of lines(diff.stdout).filter(isRelevant)) {
      const o = owner(f, [...mine]);
      if (!o) continue;
      if (f === `${o}/package.json` && !manifestChanged(workspaceRoot, ref, f)) continue;
      reasons.get(ownerOf.get(o)).add('source-changed');
    }
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
