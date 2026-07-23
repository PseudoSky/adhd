// route.ts — shared HTTP route/verb derivation for api-express
// (BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001).
//
// Both `generate()` (static codegen) and `run()` (live server) MUST derive
// their route path + HTTP verb via `@adhd/apigen-engine-naming`'s `project()` — the
// SAME call `@adhd/apigen-plugin-openapi` uses to build the OpenAPI spec's
// `paths` — so a served/generated route is byte-identical to what the spec
// document advertises. The pre-fix shape hand-rolled
// `${routePrefix}/${pkg.id}/${fnName}` — the raw, un-kebab-cased export name,
// never run through `project()` — which never matched
// `project(op).http.route`'s `'/' + [namespace, ...path].map(toKebab).join('/')`
// formula the moment a package id or export name wasn't already a single
// kebab word (`getUser` served at `/pkg/getUser`, spec advertised
// `/pkg/get-user`): client code generated FROM the spec 404'd against the
// real server.
//
// `run()` has the REAL merged `Operation[]` available (`RunInput.operations`,
// threaded by the orchestrator since BUG-APIGEN-024) and always prefers it —
// a real `Operation.path` can be multi-segment (e.g. `[file, export]` for any
// non-`index.*` source), which only the extractor can produce.
//
// DEBT-APIGEN-PLUGIN-MCP-GENERATE-OPERATIONS-001 (RESOLVED): `PluginInput`
// now ALSO carries an optional `operations?: Operation[]`
// (`@adhd/apigen-core-client`), threaded through by `entrypoint/apigen-cli`'s
// `orchestrateGenerate()` the same way `orchestrateRun()` already threads
// `RunInput.operations`. `generate.ts` builds an index from it via
// `buildOperationIndex()` below and passes it to `resolveRoute()`, so codegen
// gets the SAME full multi-segment path fidelity `run()` always had.
// `synthesizeOperation()` below remains as the fallback reconstruction of a
// single-path-segment `Operation` from `(pkgId, fnName)` — using the SAME
// canonical tokenizer the real extractor uses (`tokenize()` from
// `@adhd/apigen-core-client`) — for the rare caller that builds a bare
// `PluginInput` with no `operations` at all (e.g. a unit test).
import { tokenize } from '@adhd/apigen-core-client';
import type { Operation, Segment } from '@adhd/apigen-core-client';
import { project } from '@adhd/apigen-engine-naming';
import type { HttpVerb, ProjectionConfig } from '@adhd/apigen-engine-naming';

/**
 * Builds a casing-neutral {@link Segment} from a raw identifier — the exact
 * shape the real TS extractor produces (`apigen-core-client`'s `extract.ts`
 * private `makeSeg`), using the same canonical `tokenize()` so casing NEVER
 * drifts from the real extraction pipeline.
 */
function seg(raw: string): Segment {
  return { raw, words: tokenize(raw) };
}

/**
 * Indexes a merged `Operation[]` (e.g. `RunInput.operations`) by the exact key
 * every HTTP-emitting plugin already used for verb overrides pre-fix
 * (`${pkgId}:${fnName}`) — `fnName` is always `op.path[op.path.length -
 * 1].raw` (orchestrator.ts's `buildDescriptor` Step 5's flat dispatch-table
 * key), so this mirrors the SAME terminal-name correlation already baked into
 * how `ComposedSchemas` itself was built; it carries no additional collision
 * risk beyond what `pkg.schemas` already assumes (a namespace with two
 * distinct action ops sharing a terminal export name already collide there).
 */
export function buildOperationIndex(
  operations: readonly Operation[]
): Map<string, Operation> {
  const index = new Map<string, Operation>();
  for (const op of operations) {
    if (op.kind !== 'action') continue;
    index.set(`${op.namespace.raw}:${op.path[op.path.length - 1].raw}`, op);
  }
  return index;
}

/**
 * Reconstructs a single-path-segment `Operation` from a package id + terminal
 * export name — see this module's header comment for when/why this fallback
 * is used, and its documented multi-segment limitation.
 *
 * `safe` is read directly off the ALREADY-composed `x-apigen-safe` stamp
 * (`compose-schemas.ts`'s `op.safe === true || isPrimitiveOnlyInputSchema(op.
 * input)`, fully evaluated against the real domain input) rather than
 * re-derived here — `input` is deliberately left with no `properties` key so
 * `project()`'s OWN `isPrimitiveOnlyInputSchema(op.input)` term is
 * structurally `false` (`get-safety.ts`: an absent `properties` key ⇒
 * `false`) and never double-applies — or wrongly re-applies against a shape
 * that isn't the real bare domain input — the GET-hoist.
 */
export function synthesizeOperation(
  pkgId: string,
  fnName: string,
  schema: Record<string, unknown>
): Operation {
  const namespace = seg(pkgId);
  const path = [seg(fnName)];
  return {
    id: [namespace, ...path].map((s) => s.words.join('-')).join('/'),
    host: 'ts',
    namespace,
    path,
    kind: 'action',
    async: true,
    streaming: false,
    safe: schema['x-apigen-safe'] === true,
    input: {},
    output: {},
    envelope: {},
    typeText: null,
  };
}

/** Resolved route + verb for one package function, per `project(op).http`. */
export interface ResolvedRoute {
  route: string;
  verb: HttpVerb;
}

/**
 * The single, shared route+verb resolver for BOTH `generate()` and `run()`
 * (BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001) — prefers the REAL `Operation`
 * from `operationIndex` (full path fidelity) and falls back to
 * {@link synthesizeOperation} only when no real one is indexed (both
 * `generate()` and `run()` fall back defensively when no `operations` were
 * threaded through — e.g. a bare `PluginInput`/`RunInput` built directly by a
 * test, or a non-TS-extraction run path per `RunInput.operations`'s own doc
 * comment — so a missing/absent descriptor never crashes codegen or the
 * server). `routePrefix` is
 * prepended verbatim (already-validated CLI/plugin option), matching the
 * pre-fix `${routePrefix}/${pkg.id}/${fnName}` prefixing shape exactly.
 */
export function resolveRoute(
  pkgId: string,
  fnName: string,
  schema: Record<string, unknown>,
  operationIndex: ReadonlyMap<string, Operation>,
  routePrefix: string,
  projection: ProjectionConfig
): ResolvedRoute {
  const op =
    operationIndex.get(`${pkgId}:${fnName}`) ??
    synthesizeOperation(pkgId, fnName, schema);
  const { route, verb } = project(op, projection).http;
  return { route: `${routePrefix}${route}`, verb };
}
