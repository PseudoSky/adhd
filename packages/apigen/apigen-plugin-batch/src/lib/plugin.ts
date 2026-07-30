// @adhd/apigen-plugin-batch — mount plugin exposing generic N-way fan-out
// batch operations (`_batch/<kind>`) over an entrypoint's own already-mounted
// operations (BATCH_0.0.1.md).
//
// This plugin implements the `mount` capability (SPEC §7.1 / §7.2b/§7.2c): for
// every distinct `Operation.kind` present in the descriptor's batchable
// operation set, it contributes one synthetic `_batch/<kind>` operation whose
// handler fans a batch request out to N invocations of a caller-selected
// TARGET operation, via `invokeBatch` (`@adhd/apigen-engine-runtime`).
//
// Schema/mount derivation (`buildBatchMountedOperations`, `groupBatchable-
// OperationsByKind`, `buildBatchKindSchema`) is host-agnostic and lives in
// `@adhd/apigen-core-client/src/lib/batch.ts` (F1/§1). The actual fan-out
// execution (`invokeBatch`) is TS-runtime plumbing and lives in
// `@adhd/apigen-engine-runtime/src/lib/batch.ts` (F1/§3/§5). This plugin is
// the piece that WIRES the two together into a real, dispatchable handler —
// per the batch-rollout design note + architect review, this requires a host
// to supply a `MountHostBridge` (BATCH_0.0.1.md §2) so the handler can invoke
// the caller-selected target operation through the SAME composed `--use`
// Layer stack (auth/logging/validate) every other request goes through.
//
// Usage (SPEC §7):
//   adhd-apigen run --source api.ts --type http-fastify --use batch --opt batch.exclude=opId1,opId2

import { ApiError } from '@adhd/apigen-base-errors';
import type {
  BatchMountOptions,
  Call,
  Descriptor,
  MountedOperation,
  MountHostBridge,
  Plugin,
} from '@adhd/apigen-core-client';
import { buildBatchMountedOperations } from '@adhd/apigen-core-client';
import type {
  BatchItemResult,
  BatchOptions,
  Call as RuntimeCall,
  InvokeOptions,
} from '@adhd/apigen-engine-runtime';
import { invokeBatch, LayerContext } from '@adhd/apigen-engine-runtime';

// ---------------------------------------------------------------------------
// Plugin-specific options
// ---------------------------------------------------------------------------

/** Options accepted by the batch mount plugin (§2.1 — the plugin's own opt-out switch). */
export type BatchPluginOptions = BatchMountOptions;

// ---------------------------------------------------------------------------
// Batch request parsing (§1.1 — one discriminated-union branch per target op)
// ---------------------------------------------------------------------------

/** The parsed shape of one `_batch/<kind>` request, mirroring `branchInputSchema` (§1.1). */
interface ParsedBatchRequest {
  operation: string;
  items: unknown[];
  concurrency?: number;
  mode?: 'parallel' | 'serial' | 'chained';
  onItemError?: 'continue' | 'abort';
  itemTimeoutMs?: number;
}

/**
 * Parse+validate a `_batch/<kind>` request body (§1.1's discriminated-union
 * branch shape) into {@link ParsedBatchRequest}. Defense-in-depth: the
 * validate-Layer (SPEC §6/§8.1) should already reject a schema-violating
 * request before the handler is ever called, but the handler must never
 * silently misbehave (e.g. fan out over an empty array, or invoke
 * `undefined` as an operation id) if it somehow is.
 */
function parseBatchRequest(
  data: Record<string, unknown>,
  operationIds: readonly string[]
): ParsedBatchRequest {
  const operation = data['operation'];
  if (typeof operation !== 'string' || operation.length === 0) {
    throw new ApiError(
      'invalid_argument',
      '@adhd/apigen-plugin-batch: "operation" must be a non-empty string naming the target operation id'
    );
  }
  if (!operationIds.includes(operation)) {
    throw new ApiError(
      'invalid_argument',
      `@adhd/apigen-plugin-batch: "operation" ("${operation}") is not one of this mount's batchable operations: ${operationIds.join(', ')}`
    );
  }
  const items = data['items'];
  if (!Array.isArray(items)) {
    throw new ApiError(
      'invalid_argument',
      '@adhd/apigen-plugin-batch: "items" must be an array'
    );
  }

  const concurrency = data['concurrency'];
  if (concurrency !== undefined && typeof concurrency !== 'number') {
    throw new ApiError('invalid_argument', '@adhd/apigen-plugin-batch: "concurrency" must be a number');
  }
  const mode = data['mode'];
  if (mode !== undefined && mode !== 'parallel' && mode !== 'serial' && mode !== 'chained') {
    throw new ApiError(
      'invalid_argument',
      '@adhd/apigen-plugin-batch: "mode" must be one of "parallel" | "serial" | "chained"'
    );
  }
  const onItemError = data['onItemError'];
  if (onItemError !== undefined && onItemError !== 'continue' && onItemError !== 'abort') {
    throw new ApiError(
      'invalid_argument',
      '@adhd/apigen-plugin-batch: "onItemError" must be one of "continue" | "abort"'
    );
  }
  const itemTimeoutMs = data['itemTimeoutMs'];
  if (itemTimeoutMs !== undefined && typeof itemTimeoutMs !== 'number') {
    throw new ApiError('invalid_argument', '@adhd/apigen-plugin-batch: "itemTimeoutMs" must be a number');
  }

  return {
    operation,
    items,
    concurrency: concurrency as number | undefined,
    mode: mode as ParsedBatchRequest['mode'],
    onItemError: onItemError as ParsedBatchRequest['onItemError'],
    itemTimeoutMs: itemTimeoutMs as number | undefined,
  };
}

// ---------------------------------------------------------------------------
// Handler — wires the host-agnostic mount shape to invokeBatch via hostBridge
// ---------------------------------------------------------------------------

/**
 * Build the real, dispatchable handler for one `_batch/<kind>` mount.
 *
 * Requires a {@link MountHostBridge} — a host that has not wired one (an
 * older host build, or a hand-wired consumer that forgot to supply one) gets
 * a clear, actionable error rather than a silent no-op (per the task's own
 * explicit requirement and BATCH_0.0.1.md's own emphasis on never silently
 * degrading a mount's contract).
 */
function buildBatchHandler(
  operationIds: readonly string[],
  hostBridge: MountHostBridge | undefined
): (call: Call) => Promise<BatchItemResult[]> {
  return async (call: Call): Promise<BatchItemResult[]> => {
    if (!hostBridge) {
      // 'internal' (not 'invalid_argument'): this is a host/server misconfiguration
      // — no request from any client could ever fix it by sending different input.
      throw new ApiError(
        'internal',
        '@adhd/apigen-plugin-batch: this host has not supplied a MountHostBridge to ' +
          'MountCapability.operations() (BATCH_0.0.1.md §2/§F1) — `_batch` cannot invoke ' +
          'another operation without one. Upgrade the host\'s run.ts to thread a ' +
          'MountHostBridge through its mount-collection call site, or do not mount the ' +
          '`batch` plugin (`--use batch`) on this host.'
      );
    }

    const request = parseBatchRequest(call.data, operationIds);
    const batchOptions: BatchOptions = {
      concurrency: request.concurrency,
      mode: request.mode,
      onItemError: request.onItemError,
      itemTimeoutMs: request.itemTimeoutMs,
    };

    // Each fanned-out item needs a full runtime `Call` (`operation`/`ctx`
    // included) to satisfy `invokeBatch`'s real `Call[]` signature — mirrors
    // `dispatchForPlan`'s own mount-branch adaptation (`apigen-engine-runtime/
    // src/lib/dispatch-for-plan.ts`). `hostBridge.invoke`'s own host-side
    // implementation fills in `operation`/`ctx` itself from `fnName` (see each
    // host's `run.ts`), so these fields are effectively unused by the bridge —
    // present only to satisfy the real `InvokeFn` type `invokeBatch` composes
    // against.
    const calls: RuntimeCall[] = request.items.map((item) => ({
      operation: { id: request.operation },
      ctx: new LayerContext(),
      domainArgs: (item ?? {}) as Record<string, unknown>,
      envelope: call.envelope,
      signal: call.signal,
    }));

    // `hostBridge.invokeOptions.schemas` is deliberately typed as the loose,
    // duck-typed `Record<string, unknown>` in `MountHostBridge` (core tier,
    // never importing engine-runtime's real `ComposedSchemas` — Finding 3);
    // every real host builds it FROM a real `ComposedSchemas` object (see each
    // host's `run.ts` hostBridge construction), so this narrowing back to the
    // real `InvokeOptions` shape `invokeBatch` expects is safe by
    // construction, not a genuine type escape.
    return invokeBatch(
      hostBridge.invoke,
      request.operation,
      calls,
      hostBridge.invokeOptions as unknown as InvokeOptions,
      batchOptions
    );
  };
}

// ---------------------------------------------------------------------------
// Mount capability implementation
// ---------------------------------------------------------------------------

/**
 * Build every `_batch/<kind>` mounted operation for the given descriptor
 * (F1 — one per distinct `Operation.kind` present in the batchable set).
 * Returns `[]` when the descriptor has zero batchable operations
 * (`buildBatchMountedOperations` already refuses to mount anything in that
 * case — §1.1's "edge case the 0.0.1 draft missed").
 */
function buildBatchOperations(
  descriptor: Descriptor,
  opts: BatchPluginOptions = {},
  hostBridge: MountHostBridge | undefined
): MountedOperation[] {
  const kindOperations = buildBatchMountedOperations(descriptor, opts);
  return kindOperations.map((shape) => ({
    ...shape,
    handler: buildBatchHandler(shape.operationIds, hostBridge),
  }));
}

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

/**
 * v2 batch mount plugin (SPEC §7.1 / §7.2b — BATCH_0.0.1.md).
 *
 * Contributes one `_batch/<kind>` synthetic operation per distinct `kind`
 * present in the descriptor's batchable operation set — `_batch/query`,
 * `_batch/action`, etc. Each fans a `{operation, items, concurrency, mode,
 * onItemError, itemTimeoutMs}` request out to N invocations of the named
 * target operation via `invokeBatch`, through the SAME composed `--use` Layer
 * stack every other request goes through (never a bypass of it).
 *
 * Requires the host to supply a `MountHostBridge` (3rd arg to
 * `MountCapability.operations()`) — hosts without one get a clear,
 * actionable error at request time rather than a silent no-op.
 */
export const batchPlugin: Plugin<BatchPluginOptions> = {
  id: 'batch',
  description:
    'Mount plugin: exposes _batch/<kind> generic N-way fan-out over already-mounted operations (BATCH_0.0.1.md)',
  language: 'ts',

  optionsSchema: {
    type: 'object',
    properties: {
      exclude: {
        type: 'array',
        items: { type: 'string' },
        description: 'Operation ids to exclude from every _batch/<kind> branch set',
      },
    },
    additionalProperties: false,
  },

  capabilities: {
    mount: {
      operations(
        descriptor: Descriptor,
        opts?: Record<string, unknown>,
        hostBridge?: MountHostBridge
      ): MountedOperation[] {
        return buildBatchOperations(
          descriptor,
          opts as BatchPluginOptions | undefined,
          hostBridge
        );
      },
    },
  },
};

export default batchPlugin;
