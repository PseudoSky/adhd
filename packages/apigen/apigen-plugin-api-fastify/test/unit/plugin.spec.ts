/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `plugin.e2e.ts`.
 *
 * Resource lane: proc — the moved suite probes a real free port
 * (`net.createServer(...).listen(0)`) and starts real, live-dispatched Fastify
 * servers via `run()`, driving them over real HTTP round-trips (`fetch`) and a
 * live SSE frame stream.
 *
 * It was moved there so the default `test` target — and therefore
 * `nx affected -t test` / the pre-commit + pre-push hooks — no longer binds a
 * port. This file spawns nothing, embeds nothing and binds no port; it exists
 * so the future MOCKED unit-test version of this suite has a home that the
 * default target picks up.
 *
 * The `it.todo` entries below inventory the original cases (one per real case
 * in `plugin.e2e.ts`); they are the contract a mocked version must satisfy
 * without touching a subprocess, a port, or a live server.
 */
import { describe, it } from 'vitest';

describe('mocked: plugin-api-fastify', () => {
  // generate()
  it.todo("[plugin-api-fastify.1] emits routes.ts with POST routes for unsafe fns");
  it.todo("[plugin-api-fastify.2] generated routes.ts imports dispatch from @adhd/apigen-engine-runtime");
  it.todo("respects routePrefix option");
  it.todo("[plugin-api-fastify.4] no schema body attachment in generate output");
  it.todo("[v2-fastify.verb.1] safe op (x-apigen-safe:true) → app.get()");
  it.todo("[v2-fastify.verb.2] unsafe op (no x-apigen-safe) → app.post()");
  it.todo("[v2-fastify.verb.3] projection override flips unsafe→GET");
  it.todo("[v2-fastify.env.1] envelope field bound to x-<pluginId>-<field> header in generated code");
  it.todo("[v2-fastify.env.2] (negative) envelope NOT extracted from req.body in generated code");
  // apiFastifyPlugin
  it.todo("satisfies OutputPlugin interface");
  it.todo("delegates generate() to generate module");
  // run() — real Fastify server
  it.todo("[plugin-api-fastify.3] POST /test-pkg/get-user returns correct JSON");
  it.todo("POST /test-pkg/list-users returns correct JSON");
  it.todo("[plugin-api-fastify.4] routes have no AJV schema attachment (runtime check)");
  // [v2-proj-transport] run() — safe→GET / envelope from headers
  it.todo("[v2-fastify.run.verb.1] safe op responds to GET (x-apigen-safe:true)");
  it.todo("[v2-fastify.run.verb.2] (negative) safe op does NOT respond to POST");
  it.todo("[v2-fastify.run.verb.3] unsafe op responds to POST");
  it.todo("[v2-fastify.run.env.1] envelope field bound from x-<pluginId>-<field> header");
  it.todo("[v2-fastify.run.env.2] (negative) sending session in body does NOT route it as envelope");
  // [BUG-APIGEN-009/010] run() — validate-Layer + health mount (Fastify)
  it.todo("[009] malformed date-time → 400 invalid_argument, fn never called");
  it.todo("[009] missing required field → 400 invalid_argument, fn never called");
  it.todo("[009] valid date-time → 200 and the fn runs");
  it.todo("[010] --use health mounts GET /_meta/health → 200 { status: ok }");
  // [BUG-APIGEN-024] run() — --use openapi mount serves real paths (Fastify)
  it.todo("[024] GET /_meta/openapi returns 200 with a well-formed doc shell");
  it.todo("[024] paths is NOT empty — contains both real extracted routes");
  it.todo("[024] getUser (safe:false) → POST /test-pkg/get-user with requestBody");
  it.todo("[024] listUsers (safe:true) → GET /test-pkg/list-users with no requestBody");
  it.todo("[024] (regression control) omitting RunInput.operations falls back to empty paths, not a crash");
  // [BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001] generate() route/verb parity with project()
  it.todo("emits routes byte-identical to project(op).http for GET / POST / multi-segment ops");
  // [BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001] run() route/verb parity with project()
  it.todo("serves each op at EXACTLY project(op).http.route + .http.verb");
  it.todo("[teeth] the multi-segment op is served at /backlog/client-d/get-item, matching a real /_meta/openapi doc for the same op");
  it.todo("[negative control] the OLD `${pkgId}/${fnName}` route is NOT served for the multi-segment op");
  it.todo("[negative control] the OLD raw-camelCase route is NOT served for the single-segment unsafe op");
  // api-fastify plugin — language declaration
  it.todo('explicitly declares language: "ts" (FAILS if declaration is dropped)');
  // [fastify-parity] TransportAdapter/OpPlan golden-snapshot parity gate
  it.todo("recapture deep-equals the committed golden snapshot");
  it.todo("serves a streaming:true op as live SSE frames [1,2,3] (not mis-serialized JSON)");
});
