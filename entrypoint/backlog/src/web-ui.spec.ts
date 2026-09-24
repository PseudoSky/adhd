/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `web-ui.e2e.ts`.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer spawns
 * subprocesses or loads the real fastembed embedding model. This file spawns
 * nothing and embeds nothing; it exists so the future MOCKED unit-test version
 * of this suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real
 * case in `web-ui.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess or a real model.
 */
import { describe, it } from 'vitest';

describe("mocked: web-ui", () => {
  it.todo("mocked: serves the UI at / (static file, same origin as the API)");
  it.todo("mocked: round-trips create → query → get through the proxy against an isolated store");
  it.todo("mocked: surfaces API failures as proxy responses (not silent dead-ends)");
  it.todo("mocked: every verb this UI's own script calls resolves to a real mounted endpoint — no admin, no dead verbs");
  it.todo("mocked: the create form's real payload-construction logic (createItem()) creates an issue through the proxy");
  it.todo("mocked: the edit form's real payload-construction logic (selectItem()+startEdit()+saveItem()) updates+transitions an issue through the proxy, following the minted uid");
  it.todo("mocked: the batch bar's real payload-construction logic (batchSetStatus()/batchDelete()) drives _batch/action through the proxy");
  it.todo("mocked: shuts down cleanly on SIGTERM: orchestrator exits 0 and the API port refuses connections");
});
