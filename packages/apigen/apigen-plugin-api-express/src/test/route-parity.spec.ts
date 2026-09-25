/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `route-parity.e2e.ts`.
 *
 * Resource lane: proc — the moved suite probes a real free port
 * (`net.createServer(...).listen(0)`) and starts a real, live-dispatched
 * Express server via `run()`, driving it over real HTTP round-trips (`fetch`)
 * with no mocks.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer binds a
 * port. This file spawns nothing, embeds nothing and binds no port; it exists
 * so the future MOCKED unit-test version of this suite has a home that the
 * default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real case
 * in `route-parity.e2e.ts`); they are the contract a mocked version must
 * satisfy without touching a subprocess, a port, or a live server.
 */
import { describe, it } from 'vitest';

describe('mocked: route-parity', () => {
  // [BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001] route/verb parity with project(op).http
  it.todo("[positive] unsafe op → POST at exactly project(op).http.route");
  it.todo("[positive] safe op → GET at exactly project(op).http.route");
  it.todo("[negative control] the pre-fix `${pkgId}/${fnName}` formula diverges from project(op).http.route — proves this test has teeth");
  it.todo("[positive] unsafe op served at project(op).http.route via POST");
  it.todo("[positive] safe op served at project(op).http.route via GET");
  it.todo("[positive] MULTI-SEGMENT op served at project(op).http.route — full path fidelity via RunInput.operations");
  it.todo("[negative control] the pre-fix flat `${pkgId}/${fnName}` route 404s — the exact reported bug (spec client 404s against the server) is fixed");
  // [express-parity] TransportAdapter/OpPlan golden-snapshot parity gate
  it.todo("recapture deep-equals the committed golden snapshot (byte-identical classes)");
  it.todo("[DEBT-APIGEN-SERVE-CORE-003] void-return op: undefined -> null (was empty body, not 204)");
});
