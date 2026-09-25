/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `mount-delegation-conformance.e2e.ts`.
 *
 * Resource lane: proc — it starts a real in-process Fastify HTTP server bound to a port.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer pays for
 * it. This file spawns nothing, embeds nothing, binds no port, and does no
 * real extraction; it exists so the future MOCKED unit-test version of this
 * suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real case in
 * `mount-delegation-conformance.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess, a port, or the real extraction pipeline.
 */
import { describe, it } from 'vitest';

describe('mocked: mount-delegation-conformance', () => {
  it.todo("mocked: referential identity — not a re-imported or re-constructed copy");
  it.todo("mocked: the live CLI-equivalent --use path actually called plugin.capabilities.mount.operations once at server startup (not a reimplementation)");
  it.todo("mocked: a hand-wired direct consumer (the entrypoint/backlog/src/server.ts pattern) calls the SAME method");
  it.todo("mocked: both paths produce the SAME output for the SAME descriptor (regression net, secondary to delegation)");
});
