/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `envelope-capability-use-plugin.e2e.ts`.
 *
 * Resource lane: proc — it spawns the built `dist/index.js` and drives the real HTTP server it hosts.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer pays for
 * it. This file spawns nothing, embeds nothing, binds no port, and does no
 * real extraction; it exists so the future MOCKED unit-test version of this
 * suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real case in
 * `envelope-capability-use-plugin.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess, a port, or the real extraction pipeline.
 */
import { describe, it } from 'vitest';

describe('mocked: envelope-capability-use-plugin', () => {
  it.todo("mocked: a --use plugin declaring EnvelopeCapability surfaces its field through a real HTTP transport");
});
