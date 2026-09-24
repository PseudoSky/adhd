/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `streaming.e2e.ts`.
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
 * `streaming.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess, a port, or the real extraction pipeline.
 */
import { describe, it } from 'vitest';

describe('mocked: streaming', () => {
  it.todo("mocked: delivers ordered chunks then an in-band error AFTER the first chunk");
  it.todo("mocked: mid-stream cancel terminates via the END path (producer return), not error");
});
