// BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001 — single source of truth for
// deriving an api-fastify route + HTTP verb for a served/generated
// `(pkgId, fnName)` pair.
//
// Both `run.ts` (live serve) and `generate.ts` (codegen) previously
// hand-rolled `${routePrefix}/${pkgId}/${fnName}` — raw camelCase `fnName`,
// namespace = `pkgId` — which diverges from `@adhd/apigen-plugin-openapi`'s
// derivation (`project(op).http.route` / `.http.verb` from
// `@adhd/apigen-engine-naming`, kebab-cased, namespace + full `path`). A live
// api-fastify server therefore served `/backlog/getItem` while the OpenAPI
// doc it mounted advertised `/backlog/client-d/get-item` for the SAME
// operation — every spec-generated client 404s.
//
// This module makes api-fastify call the exact same `project()` the openapi
// plugin uses, so served + generated routes are byte-identical to the
// OpenAPI spec's `paths` for the same operations.

import { tokenize } from '@adhd/apigen-core-client';
import type { Operation, Segment } from '@adhd/apigen-core-client';
import { project } from '@adhd/apigen-engine-naming';
import type { ProjectionConfig, HttpVerb } from '@adhd/apigen-engine-naming';

/** The route + verb api-fastify should register/emit for one operation. */
export interface ResolvedRoute {
  route: string;
  verb: HttpVerb;
}

function makeSegment(raw: string): Segment {
  return { raw, words: tokenize(raw) };
}

/**
 * Resolves the canonical {@link Operation} for a served/generated
 * `(pkgId, fnName)` pair.
 *
 * Preferred path: correlate against the REAL merged `Operation[]` (threaded
 * on `RunInput.operations`, or on `generate.ts`'s `GenerateInput.operations`
 * when a caller supplies it) by matching `op.namespace.raw === pkgId` and the
 * LAST `op.path` segment's `raw === fnName`. This is the EXACT identity
 * `orchestrator.ts`'s `buildDescriptor()` Step 5 uses to key `ComposedSchemas`
 * off `Operation[]` in the first place (`fnName = op.path[op.path.length -
 * 1].raw`, `group.namespace = op.namespace.raw`), so it is guaranteed to hit
 * whenever `operations` is supplied — giving a route/verb byte-identical to
 * what `@adhd/apigen-plugin-openapi`'s `toOpenApi()` emits for the same op.
 *
 * Fallback (RESOLVED — see BACKLOG.md
 * DEBT-APIGEN-PLUGIN-MCP-GENERATE-OPERATIONS-001): `orchestrateGenerate()`
 * (`entrypoint/apigen-cli/src/lib/orchestrator.ts`) now threads
 * `descriptor.operations` into the codegen-mode `PluginInput` the same way
 * `orchestrateRun()` does for `RunInput` (both now share the same
 * `operations?: Operation[]` field on `PluginInput` itself), so `generate()`
 * receives real `Operation`s in the CLI's actual wiring today. The
 * single-segment synthesis below (`namespace = pkgId`, `path = [fnName]`,
 * tokenized with the SAME `tokenize()` the real TS extractor uses to build
 * `Segment.words` — `@adhd/apigen-core-client`) now only fires for a caller
 * that builds a bare `PluginInput`/`GenerateInput` with no `operations` at
 * all (e.g. a unit test) — the common index-file-export case still resolves
 * correctly since real `path` is exactly `[fnName]` there (SPEC §4:
 * "`index.*` drops its file segment"), and any multi-segment path (e.g.
 * `client-d/get-item`) is now resolved from the real `Operation`, not
 * reconstructed.
 */
export function resolveOperation(
  pkgId: string,
  fnName: string,
  schema: Record<string, unknown>,
  operations: Operation[] | undefined
): Operation {
  for (const op of operations ?? []) {
    const lastSeg = op.path[op.path.length - 1];
    if (op.namespace.raw === pkgId && lastSeg?.raw === fnName) return op;
  }

  // Fallback synthetic single-segment Operation — see doc comment above.
  return {
    id: `${tokenize(pkgId).join('-')}/${tokenize(fnName).join('-')}`,
    host: 'ts',
    namespace: makeSegment(pkgId),
    path: [makeSegment(fnName)],
    kind: 'action',
    async: false,
    streaming: false,
    safe: (schema['x-apigen-safe'] as boolean | undefined) ?? false,
    input: (schema['input'] as Record<string, unknown>) ?? {},
    output: (schema['output'] as Record<string, unknown>) ?? {},
    envelope: {},
    typeText: null,
  };
}

/**
 * Resolves the route + verb for a served/generated `(pkgId, fnName)` pair by
 * calling `project()` on the {@link resolveOperation} result — the SAME call
 * `@adhd/apigen-plugin-openapi`'s `toOpenApi()` makes — then prepends
 * `routePrefix` (preserved exactly as the old `${routePrefix}/${pkgId}/
 * ${fnName}` derivation did).
 */
export function resolveRoute(
  pkgId: string,
  fnName: string,
  schema: Record<string, unknown>,
  operations: Operation[] | undefined,
  routePrefix: string,
  config: ProjectionConfig
): ResolvedRoute {
  const op = resolveOperation(pkgId, fnName, schema, operations);
  const { route, verb } = project(op, config).http;
  return { route: routePrefix + route, verb };
}
