/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING self-test lives in
 * the sibling `isolated-git.e2e.ts`.
 *
 * Resource lane: proc — every case drives REAL `git` subprocesses
 * (`execFileSync('git', …)`) that create and mutate disposable repositories on
 * disk, so each assertion pays real process spawns plus real filesystem work.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer lists
 * it. The sibling suite is currently `describe.skip`'d (CPU-THRASH-SKIP,
 * owner-requested) — that skip marker moved with it, VERBATIM and NOT
 * un-skipped; the e2e lane is simply the correct, documented home for it when
 * the owner chooses to re-enable it (see
 * docs/backlog/grooming/test-perf-improvements.md), so it is not left in the
 * default lane.
 *
 * The `it.todo` entries below inventory the moved cases (one per real case in
 * `isolated-git.e2e.ts`); they are the contract a mocked version must satisfy
 * without spawning `git`, creating a repo, or touching the real filesystem.
 */
import { describe, it } from 'vitest';

// CPU-THRASH-SKIP (owner-requested, 2026-09-23): real-git harness.
describe('mocked: BUG-APIGEN-052 isolated-git escape mechanism + fix', () => {
  it.todo(
    'mocked: [negative control] the OLD unsafe pattern DOES corrupt the victim repo under leaked hook env'
  );
  it.todo(
    'mocked: runGit (env-sanitized, -C scoped) is immune to the SAME leaked env at the SAME nested layout'
  );
  it.todo(
    'mocked: createIsolatedScratchRepo end-to-end stays isolated under the same leaked hook env'
  );
  it.todo(
    'mocked: assertIsolatedRepoRoot throws loudly when the target resolves to a DIFFERENT repo root'
  );
  it.todo(
    'mocked: assertIsolatedRepoRoot throws loudly when the target is not inside any git repo at all'
  );
});
