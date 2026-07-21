#!/usr/bin/env node
/**
 * scripts/eslint-dependency-checks.mjs
 *
 * Thin, guarded wrapper around `eslint <package.json> [--fix]` for the
 * `@nx/dependency-checks` rule. Backs the `sync-deps` / `sync-deps-check`
 * targets (tools/nx-plugins/dependency-sync/plugin.js) and the reduced
 * pre-commit hook (.githooks/pre-commit).
 *
 * WHY THIS GUARD EXISTS — BUG-REPO-PRECOMMIT-DEPCHECK-STRIPS-USED-DEPS-001
 * (BACKLOG.md), root-caused during the devops-engineer dep-sync session:
 *
 * `@nx/dependency-checks` derives a project's "expected" npm deps from Nx's
 * project graph. For this repo (which has a legacy, still git-tracked
 * `yarn.lock` alongside `pnpm-lock.yaml` — `nx/src/utils/package-manager.js`
 * `detectPackageManager()` checks `yarn.lock` BEFORE `pnpm-lock.yaml`, so
 * Nx parses `yarn.lock`), that graph is built by
 * `nx/src/plugins/js/lock-file/yarn-parser.js`. For every package NOT
 * declared at the monorepo ROOT `package.json` (i.e. almost everything —
 * per-project deps live in each project's own `package.json`), the parser's
 * `findHoistedNode()` can only learn "the" canonical version behind the
 * bare `npm:<pkg>` external-node key by calling `getHoistedPackageVersion`
 * (`nx/src/plugins/js/lock-file/utils/package-json.js`), which does:
 *
 *   readFileSync(`${workspaceRoot}/node_modules/${packageName}/package.json`)
 *
 * — an absolute, NON-walking-up read straight off disk. In a workspace root
 * whose own `node_modules` was never populated by a real package-manager
 * install (verified: every fresh `git worktree add` in this repo — worktree
 * creation does not copy/install `node_modules`), EVERY one of those reads
 * fails, so NO bare `npm:<pkg>` external node gets created for any
 * project-level dependency. `@nx/dependency-checks` looks up exactly that
 * bare key to decide whether a package.json dependency is "used" — so with
 * an empty `node_modules`, it concludes essentially everything is unused,
 * and `--fix` silently DELETES real, statically-imported runtime deps
 * (verified: `fs-extra`, `source-map`, `tough-cookie`, `ajv`, `yaml` were
 * stripped from real package.jsons this way — see BACKLOG for the full
 * differential: identical yarn.lock/package.json bytes, only
 * node_modules-population differs between a broken worktree and clean
 * main; confirmed by directly stubbing `node_modules/fs-extra/package.json`
 * in the broken worktree, which alone made the bare key reappear).
 *
 * IMPORTANT: this is a *different, more severe* mechanism than the
 * dynamic-import gap documented in the dependency-sync plugin header —
 * that one only strips deps reached via a computed (non-literal)
 * require()/import() expression; THIS one strips deps reached via
 * completely ordinary, fully-static `import x from 'pkg'` the instant
 * node_modules isn't installed. Both are real; this one is the one that
 * actually shipped broken commits (BUG-REPO-PRECOMMIT-DEPCHECK-STRIPS-
 * USED-DEPS-001, worktree agent-ab0393d4188e5ce5f, commit c176c2e6).
 *
 * So: refuse to run `@nx/dependency-checks` (fix OR check mode) at all in a
 * workspace whose `node_modules` isn't really installed — fail LOUDLY with
 * an actionable one-command fix, rather than silently producing (and, in
 * --fix mode, silently applying) false-positive results.
 */

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Locate the workspace root by walking up to nx.json — robust to where this
// script lives (it moved from scripts/ into tools/nx-plugins/deps/).
const findRoot = (d) => { while (d !== dirname(d)) { if (existsSync(join(d, 'nx.json'))) return d; d = dirname(d); } return d; };
const workspaceRoot = findRoot(__dirname);

/**
 * Yarn Berry's node-modules-linker install marker. Present only after a
 * real `yarn install` has written this workspace's node_modules; absent
 * in a freshly-created git worktree (git does not copy node_modules).
 */
const YARN_INSTALL_MARKER = join(workspaceRoot, 'node_modules', '.yarn-state.yml');
/** Cheap secondary sanity check: a real, sizeable, always-present dep. */
const CANARY_PACKAGE = join(workspaceRoot, 'node_modules', 'nx', 'package.json');

function assertNodeModulesInstalled() {
  if (existsSync(YARN_INSTALL_MARKER) && existsSync(CANARY_PACKAGE)) {
    return;
  }
  process.stderr.write(
    [
      '',
      '✖ eslint-dependency-checks: node_modules in this workspace root',
      `  (${workspaceRoot}) was not written by a real package-manager`,
      '  install (missing node_modules/.yarn-state.yml and/or node_modules/nx).',
      '',
      '  Running @nx/dependency-checks here would misreport EVERY',
      '  project-level dependency as unused (BUG-REPO-PRECOMMIT-DEPCHECK-',
      '  STRIPS-USED-DEPS-001) and --fix would silently delete real,',
      '  statically-imported runtime dependencies from package.json.',
      '',
      '  Fix: run a real install in this workspace root first, e.g.:',
      '    corepack yarn install',
      '  then re-run this command.',
      '',
    ].join('\n')
  );
  process.exit(2);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.stderr.write(
      'Usage: eslint-dependency-checks.mjs <package.json-relative-path> [--fix]\n'
    );
    process.exit(2);
  }

  assertNodeModulesInstalled();

  const eslintBin = join(workspaceRoot, 'node_modules', '.bin', 'eslint');
  const eslintCmd = existsSync(eslintBin) ? eslintBin : 'eslint';

  try {
    execFileSync(eslintCmd, args, { cwd: workspaceRoot, stdio: 'inherit' });
  } catch (err) {
    process.exit(typeof err.status === 'number' ? err.status : 1);
  }
}

main();
