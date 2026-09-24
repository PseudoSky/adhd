/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `spawn-isolated-bin.e2e.ts`.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer spawns
 * subprocesses or loads the real fastembed embedding model. This file spawns
 * nothing and embeds nothing; it exists so the future MOCKED unit-test version
 * of this suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real
 * case in `spawn-isolated-bin.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess or a real model.
 *
 * Resource lane: proc — spawns isolated bins as child processes.
 */
import { describe, it } from 'vitest';

describe("mocked: spawn-isolated-bin", () => {
  it.todo("mocked: buildIsolatedEnv redirects both HOME and the scope, and lets extraEnv win");
  it.todo("mocked: buildIsolatedEnv strips ambient store-redirect vars, while extraEnv still wins");
  it.todo("mocked: a store-free CLI run through the helper resolves dbPath UNDER the temp root");
  it.todo("mocked: ambient store-redirect vars (ADHD_ROOT / ADHD_BACKLOG_DATABASE_PATH / SOX_ECOSYSTEM_HOME / APIGEN_IR_CACHE_FILE) do not leak into the child");
  it.todo("mocked: every spec that spawns `process.execPath [DIST_INDEX, …]` imports an isolation helper");
});
