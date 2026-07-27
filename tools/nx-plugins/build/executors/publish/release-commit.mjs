#!/usr/bin/env node
/**
 * release-commit.mjs
 *
 * Opt-in final release step: commits exactly the `version` bumps and the
 * `published-state.json` cache write-through together, closing
 * DEBT-BUILD-VERSION-NO-AUTOCOMMIT-001 (BACKLOG.md) — a completed release
 * previously left every bumped `package.json` + generated `CHANGELOG.md` +
 * the (new) `published-state.json` update uncommitted, indistinguishable
 * from stray churn.
 *
 * DELIBERATELY OPT-IN (per that debt item's own "Fix direction: … Keep it
 * opt-in so a dry/review flow still leaves the diff for inspection"): this
 * is a SEPARATE step from `pnpm release`/`pnpm release:dry`, run only when a
 * human decides the release output looks right. It never runs automatically.
 *
 * WHAT IT STAGES — explicit pathspecs only, NEVER `git add -A`/`git add .`
 * (AGENTS.md: "a concurrent agent's commit will bury an uncommitted edit"):
 *   - every `package.json` under `packages/<domain>/<pkg>/` and
 *     `entrypoint/<pkg>/` that `git status` reports as modified (the
 *     `version` bumps)
 *   - every `CHANGELOG.md` under those same roots that's modified (per-
 *     project changelog entries `version` generated)
 *   - `published-state.json` at the workspace root, IF present and modified
 *     (the cache write-through from `reconcile`/`publish`)
 *
 * Anything else dirty in the tree (unrelated in-flight work from another
 * agent/human) is left completely untouched — never staged, never touched.
 *
 * Usage:
 *   node tools/nx-plugins/build/executors/publish/release-commit.mjs --dry-run   # preview only, stages/commits nothing
 *   node tools/nx-plugins/build/executors/publish/release-commit.mjs             # stage + commit for real
 *   npm run release:commit -- --dry-run
 *
 * Exit code: 0 on success (including "nothing to commit" — not an error);
 * non-zero if git itself fails. Never uses `--no-verify` (git hooks still run).
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

/**
 * Locate the workspace root by walking up from the CALLER's cwd to find
 * `nx.json` — deliberately NOT `__dirname` (this script's own location):
 * resolving from `__dirname` would always point at THIS repo regardless of
 * where the tool is invoked from, which is wrong both for portability and
 * for testability (release-commit.spec.mjs drives this as a real subprocess
 * against a throwaway scratch git repo and must never touch this repo's own
 * git history).
 */
function findRoot(d) {
  while (d !== dirname(d)) {
    if (existsSync(join(d, 'nx.json'))) return d;
    d = dirname(d);
  }
  return d;
}
const workspaceRoot = findRoot(process.cwd());

function git(args, opts = {}) {
  return spawnSync('git', args, { cwd: workspaceRoot, encoding: 'utf8', ...opts });
}

/**
 * `git status --porcelain` modified/added/UNTRACKED file paths
 * (workspace-root-relative, forward-slash).
 *
 * BUG-006 (HIGH): this previously passed `--untracked-files=no`, which hides
 * untracked files from `git status` entirely. A package's brand-new
 * (first-ever release) `CHANGELOG.md` is untracked — `nx release changelog
 * --first-release` creates it fresh, it has never been committed — so it was
 * invisible here and never staged. The next release then ran
 * `--first-release` again (nothing recorded it happened), re-dumping the
 * package's FULL commit history into the changelog every subsequent release
 * instead of appending just the new entry.
 *
 * Fixed by dropping the flag (default is `--untracked-files=all` for
 * `--porcelain=v1`, listing every untracked file individually rather than
 * collapsing untracked directories). This is intentionally safe to widen:
 * the result still passes through `isReleaseArtifact()` below, which only
 * matches `package.json`/`CHANGELOG.md` directly under
 * `packages/<domain>/<pkg>/` or `entrypoint/<pkg>/` — any other untracked
 * file (unrelated in-flight work from another agent/human) is filtered out
 * exactly as before, never staged.
 */
function dirtyPaths() {
  const res = git(['status', '--porcelain=v1']);
  if (res.status !== 0) throw new Error(`git status failed: ${res.stderr || res.stdout}`);
  return res.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .map((p) => p.split(' -> ').pop()); // handle renames, keep the new path
}

/** True iff `relPath` is a package.json or CHANGELOG.md under packages/<domain>/<pkg>/ or entrypoint/<pkg>/. */
function isReleaseArtifact(relPath) {
  const isPkgJson = /^(packages\/[^/]+\/[^/]+|entrypoint\/[^/]+)\/package\.json$/.test(relPath);
  const isChangelog = /^(packages\/[^/]+\/[^/]+|entrypoint\/[^/]+)\/CHANGELOG\.md$/.test(relPath);
  return isPkgJson || isChangelog;
}

function collectReleasePaths() {
  const dirty = dirtyPaths();
  const paths = dirty.filter(isReleaseArtifact);
  if (dirty.includes('published-state.json')) paths.push('published-state.json');
  return paths;
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const paths = collectReleasePaths();

  if (paths.length === 0) {
    console.error('release-commit: nothing to commit — no bumped package.json/CHANGELOG.md or published-state.json changes found.');
    return 0;
  }

  console.error(`release-commit: ${dryRun ? '[dry-run] would stage' : 'staging'} ${paths.length} file(s):`);
  for (const p of paths) console.error(`  - ${p}`);

  const bumpedPkgCount = paths.filter((p) => p.endsWith('package.json')).length;
  const message = `chore(release): version bumps${paths.includes('published-state.json') ? ' + published-state.json' : ''} (${bumpedPkgCount} package${bumpedPkgCount === 1 ? '' : 's'})`;

  if (dryRun) {
    console.error(`release-commit: [dry-run] would commit with message: "${message}"`);
    return 0;
  }

  // Explicit pathspecs only — never `-A`/`.` — so unrelated concurrent work
  // (another agent's in-flight edits) is never swept into this commit.
  const addRes = git(['add', '--', ...paths]);
  if (addRes.status !== 0) {
    console.error(`release-commit: git add FAILED:\n${addRes.stderr || addRes.stdout}`);
    return addRes.status ?? 1;
  }
  const commitRes = git(['commit', '-m', message]);
  if (commitRes.status !== 0) {
    console.error(`release-commit: git commit FAILED:\n${commitRes.stderr || commitRes.stdout}`);
    return commitRes.status ?? 1;
  }
  console.error(`release-commit: committed — "${message}"`);
  return 0;
}

process.exit(main());
