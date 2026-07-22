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
 * So: refuse to run `@nx/dependency-checks` (fix OR check mode) against a
 * workspace whose `node_modules` isn't really installed.
 *
 * BEHAVIOR CHANGE (BUILD-TOOLING-VERSION-SYNC-DEPS-001 — see CHANGELOG.md):
 * this guard used to `process.exit(2)` (hard-fail) here. It now WARNS and
 * no-ops with exit 0 instead. Reason: `sync-deps` is now a `dependsOn` of
 * every project's `lint` target (tools/nx-plugins/lint dependency, wired via
 * nx.json `targetDefaults.lint`), so a hard failure here would fail every
 * `lint` task — and therefore every `build` (`build` depends on `lint`) — in
 * any bare/fresh worktree, even for projects with zero actual dependency
 * drift. The safety guarantee this guard exists for is unchanged: it still
 * refuses to let a broken-graph @nx/dependency-checks run at all (so it can
 * never misreport a used dep as unused, nor `--fix`-strip one) — it just
 * reports that refusal as a loud, visible warning instead of a fatal exit.
 * The pre-commit hook (`.githooks/pre-commit`) keeps its OWN, separate,
 * hard-fail node_modules check that runs BEFORE it ever invokes `nx affected
 * -t lint` at all — that is still the actual commit-blocking guarantee; this
 * guard is the defense-in-depth backstop for every other caller (direct
 * `nx run <project>:sync-deps`, `nx affected -t lint` run standalone outside
 * the hook, etc).
 */

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Locate the workspace root by walking up to nx.json — robust to where this
// script lives (it moved from scripts/ into tools/nx-plugins/deps/).
export const findRoot = (d) => { while (d !== dirname(d)) { if (existsSync(join(d, 'nx.json'))) return d; d = dirname(d); } return d; };
const workspaceRoot = findRoot(__dirname);

/**
 * pnpm's install marker. Written by pnpm into node_modules on a real install;
 * absent in a freshly-created git worktree (git does not copy node_modules).
 * (Was `.yarn-state.yml` under the pre-migration yarn Berry setup.)
 */
const pnpmInstallMarker = (root) => join(root, 'node_modules', '.modules.yaml');
/** Cheap secondary sanity check: a real, sizeable, always-present dep. */
const canaryPackage = (root) => join(root, 'node_modules', 'nx', 'package.json');

/** True iff `root/node_modules` looks like a real package-manager install. */
export function isRealInstall(root) {
  return existsSync(pnpmInstallMarker(root)) && existsSync(canaryPackage(root));
}

/** Print the (non-fatal) "skipping, node_modules isn't real" warning. */
export function warnSkip(root) {
  process.stderr.write(
    [
      '',
      '⚠ eslint-dependency-checks: node_modules in this workspace root',
      `  (${root}) was not written by a real package-manager install`,
      '  (missing node_modules/.modules.yaml and/or node_modules/nx).',
      '  Running @nx/dependency-checks here would misreport EVERY',
      '  project-level dependency as unused (BUG-REPO-PRECOMMIT-DEPCHECK-',
      '  STRIPS-USED-DEPS-001) and --fix would silently delete real,',
      '  statically-imported runtime dependencies from package.json.',
      '',
      '  Skipping this dependency check (no-op) rather than running it',
      '  against a broken graph. Fix: run a real install in this workspace',
      '  root first, e.g. `pnpm install`, then re-run this command.',
      '',
    ].join('\n')
  );
}

/**
 * Run the guarded `eslint <package.json> [--fix]` check.
 *
 * @param {string[]} argv `[packageJsonRelativePath, ...flags]`
 * @param {{workspaceRoot?: string}} [opts] test seam — defaults to the real,
 *   discovered workspace root; a test may pass a fake one to exercise the
 *   node_modules-missing branch without touching the real repo's install.
 * @returns {number} the intended process exit code (0 = ok/no-op-skip).
 */
export function main(argv = process.argv.slice(2), { workspaceRoot: root = workspaceRoot } = {}) {
  if (argv.length === 0) {
    process.stderr.write(
      'Usage: eslint-dependency-checks.mjs <package.json-relative-path> [--fix]\n'
    );
    return 2;
  }

  if (!isRealInstall(root)) {
    warnSkip(root);
    return 0;
  }

  const eslintBin = join(root, 'node_modules', '.bin', 'eslint');
  const eslintCmd = existsSync(eslintBin) ? eslintBin : 'eslint';

  try {
    execFileSync(eslintCmd, argv, { cwd: root, stdio: 'inherit' });
    return 0;
  } catch (err) {
    return typeof err.status === 'number' ? err.status : 1;
  }
}

// Only run as a CLI when invoked directly (`node eslint-check.mjs ...`) — not
// when imported by a test for the exported pure-ish helpers above.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  process.exit(main());
}
