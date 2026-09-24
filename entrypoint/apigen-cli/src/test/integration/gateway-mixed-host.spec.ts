/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `gateway-mixed-host.e2e.ts`.
 *
 * Resource lane: proc — it spawns a real out-of-process `python3` sidecar.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer pays for
 * it. This file spawns nothing, embeds nothing, binds no port, and does no
 * real extraction; it exists so the future MOCKED unit-test version of this
 * suite has a home that the default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real case in
 * `gateway-mixed-host.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess, a port, or the real extraction pipeline.
 */
import { describe, it } from 'vitest';

describe('mocked: gateway-mixed-host', () => {
  it.todo("mocked: routes each op to its owning runtime; both return ground truth (dod.12)");
  it.todo("mocked: killing the Python sidecar fails ONLY its ops; TS keeps serving (dod.17)");
});
