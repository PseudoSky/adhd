// route.ts — resolves the canonical `Operation` behind a served/generated
// `(pkgId, fnName)` pair (BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001).
//
// serve-core migration (express-adapter): the route+verb PROJECTION this
// module used to perform (a two-step index-then-lookup route/verb resolver)
// is now `OpPlan`'s job — `buildOpPlan()` (`@adhd/apigen-engine-runtime`)
// calls the exact same `project()`/`@adhd/apigen-engine-naming` derivation
// the OpenAPI plugin uses, so served + generated routes stay byte-identical
// to the OpenAPI spec's `paths`. This module therefore no longer projects at
// all — it only resolves the `Operation` (real or synthesized) that
// `buildOpPlan()` consumes, mirroring the REFERENCE `operationFor` in
// `apigen-plugin-api-fastify/src/lib/route-projection.ts`. The former
// index-builder + lookup + single-segment-synthesis exports are DELETED —
// collapsed into `operationFor` below [express-adapter.2].
import { tokenize } from '@adhd/apigen-core-client';
import type { Operation, Segment } from '@adhd/apigen-core-client';

function makeSegment(raw: string): Segment {
  return { raw, words: tokenize(raw) };
}

/**
 * Resolves the canonical {@link Operation} for a served/generated
 * `(pkgId, fnName)` pair — the input `buildOpPlan()` (`@adhd/apigen-engine-
 * runtime`) projects to route/verb/envelope/streaming/mount facts.
 *
 * Preferred path: correlate against the REAL merged `Operation[]` (threaded
 * on `RunInput.operations`, or `PluginInput.operations` for `generate()`) by
 * matching `op.namespace.raw === pkgId` and the LAST `op.path` segment's
 * `raw === fnName`. This is the EXACT identity `orchestrator.ts`'s
 * `buildDescriptor()` Step 5 uses to key `ComposedSchemas` off `Operation[]`
 * in the first place, so it is guaranteed to hit whenever `operations` is
 * supplied — giving a route/verb byte-identical to what
 * `@adhd/apigen-plugin-openapi`'s `toOpenApi()` emits for the same op.
 *
 * Fallback (RESOLVED — see BACKLOG.md
 * DEBT-APIGEN-PLUGIN-MCP-GENERATE-OPERATIONS-001): a synthesized
 * single-segment `Operation` (`namespace = pkgId`, `path = [fnName]`,
 * tokenized with the SAME `tokenize()` the real TS extractor uses to build
 * `Segment.words` — `@adhd/apigen-core-client`) fires only for a caller that
 * builds a bare `PluginInput`/`RunInput` with no `operations` at all (e.g. a
 * unit test) — the common index-file-export case still resolves correctly
 * since real `path` is exactly `[fnName]` there, and any multi-segment path
 * is resolved from the real `Operation`, not reconstructed.
 *
 * NOTE (mirrors the fastify reference exactly): the synthesized op's `input`
 * is the COMPOSED schema entry's `input` (data-wrapped), not a bare domain
 * schema — this is never primitive-only, so `project()`'s
 * `isPrimitiveOnlyInputSchema(op.input)` GET-hoist term is always
 * structurally `false` here and never wrongly re-applies; `safe` is read
 * directly off the already-composed `x-apigen-safe` stamp instead. An op
 * whose transport facts depend on fields the composed schema cannot carry —
 * a `streaming:true` export, or the FEAT-APIGEN-022 GET-hoist of an UNSAFE
 * primitive-only op (which needs the BARE `Operation.input`) — MUST be
 * supplied via real `operations` for those facts to survive.
 */
export function operationFor(
  pkgId: string,
  fnName: string,
  schema: Record<string, unknown>,
  operations: Operation[] | undefined
): Operation {
  for (const op of operations ?? []) {
    const lastSeg = op.path[op.path.length - 1];
    if (op.namespace.raw === pkgId && lastSeg?.raw === fnName) return op;
  }

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
