/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `server.verbs.e2e.ts`.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer spawns
 * subprocesses or loads the real fastembed embedding model. This file spawns
 * nothing and embeds nothing; it exists so the future MOCKED unit-test version
 * of this suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real
 * case in `server.verbs.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess or a real model.
 *
 * Resource lane: proc — spawns the built bin across all four transport mounts.
 */
import { describe, it } from 'vitest';

describe("mocked: server.verbs", () => {
  it.todo("mocked: projects a non-empty operation surface from ONE buildBacklogApigenPackage call, without opening the store");
  it.todo("mocked: the probe discriminates: an unmounted route really does 404");
  it.todo("mocked: REST: every projected route is registered on the live Fastify listener");
  it.todo("mocked: OpenAPI: the served document's paths are EXACTLY the projected routes (derived, not hand-written)");
  it.todo("mocked: OpenAPI: each path carries the same verb the Fastify mount registered");
  it.todo("mocked: MCP: tools/list is EXACTLY the projected tool names (plus the batch mount op)");
  it.todo("mocked: CLI: the built bin's command table is EXACTLY the projected commands (plus the batch mount op)");
  it.todo("mocked: THE PARITY CLAIM: the four live surfaces name the same operation set, per operation");
  it.todo("mocked: mount-plugin operations are transport-scoped exactly as declared");
  it.todo("mocked: SPLIT-BRAIN GUARD: the pinned verb list matches the live surface exactly, both ways");
  it.todo("mocked: install / install-skill / serve are not projected as operations");
  it.todo("mocked: no MCP tool, OpenAPI path, or CLI command exposes a host command");
  it.todo("mocked: they remain reachable as HOST commands — carved out, not deleted");
});
