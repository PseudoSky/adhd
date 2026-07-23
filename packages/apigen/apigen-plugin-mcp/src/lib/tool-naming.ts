// @adhd/apigen-plugin-mcp — canonical MCP tool-name derivation.
//
// BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001 (MCP side): every apigen
// transport must derive its operation identifiers from the ONE shared
// authority, `@adhd/apigen-engine-naming`'s `project(op)` —
// `project(op).http.route` (kebab HTTP path, used by openapi/api-fastify/
// api-express) and `project(op).mcp.name` (the canonical MCP tool name:
// `[op.namespace, ...op.path].map(toSnake).join('_')`). Before this fix this
// plugin named tools from the raw exported fn name (camelCase, e.g.
// `getItem`) in `run.ts`'s tool registration/dispatch and in `generate.ts` —
// never via `project()` — inconsistent with every other transport.
//
// ⚠️ BEHAVIOR CHANGE: MCP tool names change under this fix, e.g.
//   `getItem`  (OLD: raw exported fn name, camelCase)
//   → `<namespace>_<file>_get_item`  (NEW: canonical `project(op).mcp.name`,
//      snake_case — namespace + file + export segments joined with `_`)
// Any MCP host with a hardcoded reference to an OLD tool name must update it.
//
// This module is the single place `run.ts` and `generate.ts` derive a tool
// name from — never inline `project()`/segment-building logic at either call
// site (DRY, and keeps the "exact vs best-effort" distinction below in one
// auditable place).

import * as path from 'node:path';
import { tokenize } from '@adhd/apigen-core-client';
import type { Operation, Segment } from '@adhd/apigen-core-client';
import { project, normalizeFileName } from '@adhd/apigen-engine-naming';

function makeSeg(raw: string): Segment {
  return { raw, words: tokenize(raw) };
}

/**
 * Finds the real {@link Operation} behind a `(namespace, fnName)` pair.
 *
 * `fnName` — the flat key every apigen transport (this one included)
 * dispatches by, i.e. a `ComposedSchemas`/`pkg.schemas` key — is always the
 * RAW terminal path segment (`op.path[op.path.length - 1].raw`); see
 * `entrypoint/apigen-cli/orchestrator.ts`'s `buildDescriptor` Step 5 comment
 * ("the flat dispatch-table key: always the terminal path segment's raw
 * spelling"). So this correlation is EXACT whenever a real `Operation[]` is
 * available — i.e. the live `run()` path, via `RunInput.operations`
 * (BUG-APIGEN-024 threaded the real merged descriptor through
 * `orchestrateRun`).
 *
 * Scoped to `kind === 'action'` — the only kind MCP ever serves (mirrors
 * `orchestrator.ts`'s own `if (op.kind !== 'action') continue` when building
 * `ComposedSchemas`).
 */
export function findOperation(
  operations: Operation[] | undefined,
  namespace: string,
  fnName: string
): Operation | undefined {
  if (!operations) return undefined;
  return operations.find(
    (op) =>
      op.kind === 'action' &&
      op.namespace.raw === namespace &&
      op.path[op.path.length - 1]?.raw === fnName
  );
}

/**
 * Best-effort reconstruction of `Operation.path`'s leading "file" segment
 * from a package's `importPath`, mirroring `apigen-core-client/extract.ts`'s
 * own `fileSegment = makeSeg(normalizeFileName(path.basename(filePath)))`
 * exactly (same `tokenize` + `normalizeFileName`) — see {@link deriveToolName}'s
 * doc comment for when/why this fallback is used instead of a real `Operation`.
 */
function fileSegFromImportPath(importPath: string): Segment {
  return makeSeg(normalizeFileName(path.basename(importPath)));
}

/**
 * Derives the canonical MCP tool name for one `(pkg, fnName)` pair via the
 * single shared authority, `@adhd/apigen-engine-naming`'s `project(op).mcp.name`
 * (BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001).
 *
 * Two resolution modes:
 *
 * - **Exact** (`operations` supplied and a match is found — the live `run()`
 *   path via `RunInput.operations`): the real, matching `Operation` (full
 *   multi-segment `path`, e.g. `[file, export]`) is projected directly —
 *   byte-identical to what `checkCollisions()` / every other transport
 *   computes for the same op. If `operations` is supplied but genuinely has
 *   no match, that is an orchestrator invariant violation (every fn in
 *   `pkg.schemas` is derived FROM `operations` — see orchestrator.ts's
 *   `buildDescriptor` Step 5) — this throws rather than silently
 *   guessing, so a real correlation bug fails loudly instead of reintroducing
 *   a masked naming mismatch.
 *
 * - **Best-effort** (`operations` absent — now only when a caller builds a
 *   bare `PluginInput` with no `operations` at all, e.g. a unit test;
 *   `PluginInput` itself carries `operations?: Operation[]` since
 *   `DEBT-APIGEN-PLUGIN-MCP-GENERATE-OPERATIONS-001` was RESOLVED — see
 *   BACKLOG.md): a synthetic `Operation` is reconstructed from `pkg.id` (namespace),
 *   `pkg.importPath` (file segment, via {@link fileSegFromImportPath}), and
 *   `fnName` (export segment), using the exact same tokenization
 *   (`@adhd/apigen-core-client`'s `tokenize`) and file-name normalisation
 *   (`@adhd/apigen-engine-naming`'s `normalizeFileName`) the real extractor uses.
 *   This reproduces the true canonical name exactly whenever `importPath` is
 *   the physical single source file apigen extracted from (the default,
 *   single-source `generate`/`run` invocation — see orchestrator.ts's
 *   BUG-APIGEN-035 note that "generate/run only ever pass one source") and
 *   diverges only for two currently-unexercised edge cases: an `importPath`
 *   explicitly overridden to a published npm specifier (registry sources),
 *   or a default-object export's extra `'default'` path segment.
 */
export function deriveToolName(
  pkg: { id: string; importPath: string },
  fnName: string,
  operations?: Operation[]
): string {
  if (operations) {
    const real = findOperation(operations, pkg.id, fnName);
    if (!real) {
      throw new Error(
        `@adhd/apigen-plugin-mcp: no Operation found for package "${pkg.id}" ` +
          `fn "${fnName}" in the supplied operations[] — every fn in ` +
          `pkg.schemas must correspond to a real extracted Operation ` +
          `(orchestrator.ts buildDescriptor Step 5 invariant). This indicates ` +
          `a correlation bug, not a naming gap.`
      );
    }
    return project(real).mcp.name;
  }

  // Best-effort fallback — see doc comment above.
  const shim: Operation = {
    id: `${pkg.id}/${fnName}`,
    host: 'ts',
    namespace: makeSeg(pkg.id),
    path: [fileSegFromImportPath(pkg.importPath), makeSeg(fnName)],
    kind: 'action',
    async: false,
    streaming: false,
    safe: false,
    input: {},
    output: {},
    envelope: {},
    typeText: null,
  };
  return project(shim).mcp.name;
}
