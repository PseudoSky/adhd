/**
 * STUB (mocked placeholder) — the real, RESOURCE-CONSUMING test lives in the
 * sibling `plugin.e2e.ts`.
 *
 * Resource lane: proc — the moved suite probes a real free port
 * (`net.createServer(...).listen(0)`) and starts real Express servers via
 * `run()`, driving them over real HTTP round-trips (`fetch`).
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

describe('mocked: plugin-api-express', () => {
  // generate()
  it.todo("[plugin-api-express.1] emits routes.ts using Router from express");
  it.todo("[plugin-api-express.2] generated routes.ts imports dispatch from @adhd/apigen-engine-runtime");
  it.todo("[plugin-api-express.4] route shape is POST /<packageId>/<fnName> for unsafe ops");
  it.todo("generated routes.ts calls res.json(result) not return");
  it.todo("respects routePrefix option");
  it.todo("[v2-express.verb.1] safe op (x-apigen-safe:true) → router.get()");
  it.todo("[v2-express.verb.2] unsafe op (no x-apigen-safe) → router.post()");
  it.todo("[v2-express.verb.3] projection override flips unsafe→GET");
  it.todo("[v2-express.env.1] envelope field bound to x-<pluginId>-<field> header in generated code");
  it.todo("[v2-express.env.2] (negative) envelope NOT spread from req.body in generated code");
  // apiExpressPlugin
  it.todo("satisfies OutputPlugin interface");
  it.todo("delegates generate() to generate module");
  // run() — real Express server
  it.todo("[plugin-api-express.3] POST /test-pkg/get-user returns correct JSON via res.json");
  it.todo("POST /test-pkg/list-users returns correct JSON");
  it.todo("[plugin-api-express.4] body envelope — extra fields pass through, data routes to fn");
  // [v2-proj-transport] run() — safe→GET / envelope from headers
  it.todo("[v2-express.run.verb.1] safe op responds to GET (x-apigen-safe:true)");
  it.todo("[v2-express.run.verb.2] (negative) safe op does NOT respond to POST");
  it.todo("[v2-express.run.verb.3] unsafe op responds to POST");
  it.todo("[v2-express.run.env.1] envelope field bound from x-<pluginId>-<field> header");
  it.todo("[v2-express.run.env.2] (negative) session in body without header does not crash server");
  // [BUG-APIGEN-009/010] run() — validate-Layer + health mount (Express)
  it.todo("[009] malformed date-time → 400 invalid_argument, fn never called");
  it.todo("[009] missing required field → 400 invalid_argument, fn never called");
  it.todo("[009] valid date-time → 200 and the fn runs");
  it.todo("[010] --use health mounts GET /_meta/health → 200 { status: ok }");
  // [BUG-APIGEN-024] run() — --use openapi mount serves real paths (Express)
  it.todo("[024] GET /_meta/openapi returns 200 with a well-formed doc shell");
  it.todo("[024] paths is NOT empty — contains both real extracted routes");
  it.todo("[024] getUser (safe:false) → POST /test-pkg/get-user with requestBody");
  it.todo("[024] listUsers (safe:true) → GET /test-pkg/list-users with no requestBody");
  it.todo("[024] (regression control) omitting RunInput.operations falls back to empty paths, not a crash");
  // api-express plugin — language declaration
  it.todo('explicitly declares language: "ts" (FAILS if declaration is dropped)');
});
