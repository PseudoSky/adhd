'use strict';
/**
 * git-env.js — the single canonical scrub for ambient `GIT_*` environment
 * variables (50e8c966).
 *
 * WHY: git exports `GIT_DIR` (and `GIT_INDEX_FILE`, sometimes `GIT_WORK_TREE`,
 * `GIT_COMMON_DIR`, `GIT_PREFIX`) into every hook it runs. From a linked
 * worktree, `GIT_DIR=<repo>/.git/worktrees/<name>`. Those variables outrank
 * `cwd` / `-C`, so a hook-run spec that spawns `git init` / `git config` /
 * `git commit` inside an `mkdtemp` dir silently operates on the REAL repo
 * (core.bare=true, repo-local identity, fixture commits on a real branch) and
 * still exits 0. Every test/script that spawns `git` against a throwaway repo
 * MUST pass `env: cleanGitEnv(...)`.
 *
 * Plain CommonJS, node builtins only (none, in fact): loadable by
 * `tools/nx-plugins` and `.githooks` specs before `pnpm install` has run.
 * TypeScript packages cannot import across project roots (Nx boundaries), so
 * the backlog project keeps a typed twin at
 * `entrypoint/backlog/src/test/helpers/git-env.ts`; both are pinned to the
 * same contract (delete every /^GIT_/ key).
 */

const GIT_VAR = /^GIT_/;

/**
 * Return a copy of `base` with every `GIT_*` key removed.
 * @param {NodeJS.ProcessEnv} [base] defaults to `process.env`
 * @param {Record<string, string | undefined>} [extra] vars to layer on AFTER
 *   the scrub (e.g. deliberate `GIT_AUTHOR_DATE` pins) — these are intentional.
 * @returns {NodeJS.ProcessEnv}
 */
function cleanGitEnv(base = process.env, extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (!GIT_VAR.test(key)) env[key] = value;
  }
  return { ...env, ...extra };
}

/**
 * Delete every `GIT_*` key from `process.env` in place. For specs that run a
 * CLI's `main()` in-process (whose internal git spawns inherit `process.env`).
 * @returns {void}
 */
function scrubProcessGitEnv() {
  for (const key of Object.keys(process.env)) {
    if (GIT_VAR.test(key)) delete process.env[key];
  }
}

module.exports = { cleanGitEnv, scrubProcessGitEnv };
