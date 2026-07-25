// @adhd/apigen-plugin-mcp — canonical Operation resolution for tool registration.
//
// serve-core migration (mcp-adapter, [mcp-adapter.3]): the MCP tool NAME
// projection this module used to perform (`deriveToolName`) is now `OpPlan`'s
// job — `buildOpPlan()` (`@adhd/apigen-engine-runtime`) calls the exact same
// naming-projection helper (`@adhd/apigen-engine-naming`) derivation every
// other transport uses, so `plan.mcp.name` IS the canonical tool name
// (`run.ts`/`generate.ts` read it off the plan they already build for
// envelope/streaming/mount resolution — never re-derive a name here). The
// former name-deriving helper and its internal operation-lookup companion
// (the pre-collapse two-function shim) are both DELETED and collapsed into
// `OpPlan.mcp.name`.
//
// What remains here is ONLY Operation *resolution* — finding (or, absent a
// real descriptor, synthesizing) the `Operation` that `buildOpPlan()`
// consumes — mirroring `apigen-plugin-api-fastify/src/lib/route-projection.ts`'s
// `operationFor` (the REFERENCE TransportAdapter's equivalent helper).
//
// ⚠️ BEHAVIOR CHANGE (BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001, still in
// effect after this collapse): MCP tool names are the naming projection's
// `mcp.name` for an op (snake_case, namespace+file+export segments joined
// with `_`), never the raw exported fn name (e.g. `getItem`, camelCase). Any
// MCP host with a hardcoded reference to an OLD tool name must update it.

import * as path from 'node:path';
import { tokenize } from '@adhd/apigen-core-client';
import type { Operation, Segment } from '@adhd/apigen-core-client';
import { normalizeFileName } from '@adhd/apigen-engine-naming';

function makeSeg(raw: string): Segment {
  return { raw, words: tokenize(raw) };
}

/**
 * Best-effort reconstruction of `Operation.path`'s leading "file" segment
 * from a package's `importPath`, mirroring `apigen-core-client/extract.ts`'s
 * own `fileSegment = makeSeg(normalizeFileName(path.basename(filePath)))`
 * exactly (same `tokenize` + `normalizeFileName`) — see {@link operationFor}'s
 * doc comment for when/why this fallback is used.
 */
function fileSegFromImportPath(importPath: string): Segment {
  return makeSeg(normalizeFileName(path.basename(importPath)));
}

/**
 * Resolves the canonical {@link Operation} behind a `(pkg, fnName)` pair —
 * the input `buildOpPlan()` (`@adhd/apigen-engine-runtime`) projects to every
 * transport surface, MCP tool name (`plan.mcp.name`) included.
 *
 * Two resolution modes:
 *
 * - **Exact** (`operations` supplied and a match is found — the live `run()`
 *   path via `RunInput.operations`): the real, matching `Operation` (full
 *   multi-segment `path`, e.g. `[file, export]`) is returned directly —
 *   `buildOpPlan()` then projects it byte-identically to what
 *   `checkCollisions()` / every other transport computes for the same op. If
 *   `operations` is supplied but genuinely has no match, that is an
 *   orchestrator invariant violation (every fn in `pkg.schemas` is derived
 *   FROM `operations` — see orchestrator.ts's `buildDescriptor` Step 5) —
 *   this throws rather than silently guessing, so a real correlation bug
 *   fails loudly instead of reintroducing a masked naming mismatch.
 *
 * - **Best-effort** (`operations` absent — now only when a caller builds a
 *   bare `PluginInput` with no `operations` at all, e.g. a unit test;
 *   `PluginInput` itself carries `operations?: Operation[]` since
 *   `DEBT-APIGEN-PLUGIN-MCP-GENERATE-OPERATIONS-001` was RESOLVED — see
 *   BACKLOG.md): a synthetic `Operation` is reconstructed from `pkg.id`
 *   (namespace), `pkg.importPath` (file segment, via
 *   {@link fileSegFromImportPath}), and `fnName` (export segment), using the
 *   exact same tokenization (`@adhd/apigen-core-client`'s `tokenize`) and
 *   file-name normalisation (`@adhd/apigen-engine-naming`'s
 *   `normalizeFileName`) the real extractor uses. This reproduces the true
 *   canonical name exactly whenever `importPath` is the physical single
 *   source file apigen extracted from (the default, single-source
 *   `generate`/`run` invocation — see orchestrator.ts's BUG-APIGEN-035 note
 *   that "generate/run only ever pass one source") and diverges only for two
 *   currently-unexercised edge cases: an `importPath` explicitly overridden
 *   to a published npm specifier (registry sources), or a default-object
 *   export's extra `'default'` path segment.
 *
 * Scoped to `kind === 'action'` — the only kind MCP ever serves (mirrors
 * `orchestrator.ts`'s own `if (op.kind !== 'action') continue` when building
 * `ComposedSchemas`).
 */
export function operationFor(
  pkg: { id: string; importPath: string; dropFileSegment?: boolean },
  fnName: string,
  operations?: Operation[]
): Operation {
  if (operations) {
    const real = operations.find(
      (op) =>
        op.kind === 'action' &&
        op.namespace.raw === pkg.id &&
        op.path[op.path.length - 1]?.raw === fnName
    );
    if (!real) {
      throw new Error(
        `@adhd/apigen-plugin-mcp: no Operation found for package "${pkg.id}" ` +
          `fn "${fnName}" in the supplied operations[] — every fn in ` +
          `pkg.schemas must correspond to a real extracted Operation ` +
          `(orchestrator.ts buildDescriptor Step 5 invariant). This indicates ` +
          `a correlation bug, not a naming gap.`
      );
    }
    return real;
  }

  // Best-effort fallback — see doc comment above. Honors `pkg.dropFileSegment`
  // (mirroring `extract.ts`'s `ExtractOptions.dropFileSegment`) so this
  // synthesized path never diverges from the real extractor's for a source
  // whose file segment is dropped.
  const exportSeg = makeSeg(fnName);
  return {
    id: `${pkg.id}/${fnName}`,
    host: 'ts',
    namespace: makeSeg(pkg.id),
    path: pkg.dropFileSegment
      ? [exportSeg]
      : [fileSegFromImportPath(pkg.importPath), exportSeg],
    kind: 'action',
    async: false,
    streaming: false,
    safe: false,
    input: {},
    output: {},
    envelope: {},
    typeText: null,
  };
}
