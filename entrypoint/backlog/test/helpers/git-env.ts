/**
 * Typed twin of `tools/nx-plugins/lib/git-env.js` (50e8c966). Nx module
 * boundaries forbid importing that file from a TS project, so the contract is
 * duplicated here in ~8 lines: delete every `GIT_*` key.
 *
 * git exports GIT_DIR/GIT_INDEX_FILE into hooks; from a linked worktree they
 * outrank `cwd`, so a hook-run spec's `git init` in an mkdtemp dir would write
 * into the REAL repo. Every git spawn in a backlog test MUST use `gitEnv()`.
 */

/** `base` (default `process.env`) minus every `GIT_*` key, plus deliberate `extra` vars. */
export function gitEnv(
  extra: Record<string, string> = {},
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (!/^GIT_/.test(key)) env[key] = value;
  }
  return { ...env, ...extra };
}
