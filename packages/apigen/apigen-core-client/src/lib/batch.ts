// apigen-core-client/src/lib/batch.ts — F1 (BATCH_0.0.1.md): host-agnostic
// batch/bulk fan-out schema derivation.
//
// This module is the PORTABLE half of the batch design (§5/§F3): pure
// `Operation[] → JSON-Schema fragment` transforms over the already
// host-neutral `Operation` IR. It derives, for a set of batchable
// operations, one discriminated-union mount schema **per distinct
// `Operation.kind`** (F1 — a single static `_batch` mount cannot represent a
// polymorphic fan-out target whose `kind`/`safe` vary per selected branch,
// per the architect review's F1 finding).
//
// The non-portable half — actually fanning N calls out through
// `createInvoker`'s composed Layer stack with concurrency/cancellation
// control (`invokeBatch`) — is TS-runtime plumbing and lives in
// `@adhd/apigen-engine-runtime/src/lib/batch.ts` instead (§5). This module
// never imports it and has no runtime execution concerns of its own.
//
// Discriminator mechanism (§1.1 correction): branches here are synthetic,
// same-document, non-nominal `oneOf` variants — the `morph-walk.ts`
// `InlineDiscriminator`/`detectDiscriminator` mechanism is the correct fit
// (same-document JSON Pointer mapping into this schema's own `oneOf` array).
// `union.ts`'s `buildUnionSchema` is NOT used here: it requires ≥2
// `$ref`-based, `nominal.ts`-registered class variants, and batch branches
// are neither nominal nor `$ref`-based.

import type { Descriptor, MountedOperation } from './plugin';
import { syntheticOp } from './plugin';
import type { Operation, OperationKind, JSONSchema } from './descriptor';
import { detectDiscriminator } from './schema-builders/morph-walk';
import type { InlineDiscriminator } from './schema-builders/morph-walk';

// ---------------------------------------------------------------------------
// Options (§2.1 — Tenet-1 per-op opt-out, source-level only)
// ---------------------------------------------------------------------------

/**
 * Options accepted when deriving `_batch/<kind>` mounts (§2.1).
 *
 * `exclude` is the plugin's own opt-out switch — `--opt batch.exclude=...`
 * (CLI `--use` path) or a literal argument at a hand-wired direct-invocation
 * call site (§2.1). There is deliberately no other configuration surface
 * (no runtime flag, no `apigen.config` file — Tenet 1).
 */
export interface BatchMountOptions {
  /** Operation ids to exclude from every `_batch/<kind>` branch set. */
  exclude?: string[];
}

// ---------------------------------------------------------------------------
// §1.2 — deriveBatchOperationBranch: pure Operation → schema-fragment transform
// ---------------------------------------------------------------------------

/** One discriminator branch derived from a single batchable `Operation` (§1.2). */
export interface BatchOperationBranch {
  /** The literal `operation` value selecting this branch. */
  operationConst: string;
  /** The per-item input schema — `op.input` verbatim. */
  itemsSchema: JSONSchema;
  /** `BatchItemResult<op.output>` as a JSON Schema fragment (§3/§F3). */
  resultSchema: JSONSchema;
}

/**
 * `BatchItemResult<T>` (§3) as a JSON-Schema-describable wire fragment — the
 * portable half of `BatchItemResult` (F3). The TS union type of the same
 * name (used by `invokeBatch`'s actual return value) lives in
 * `@adhd/apigen-engine-runtime` and is deliberately kept in sync with this
 * shape by hand (there is no codegen between JSON Schema and TS types in
 * this repo today — see BATCH_0.0.1.md §7 open-question 1).
 */
function batchItemResultSchema(itemOutput: JSONSchema): JSONSchema {
  return {
    oneOf: [
      {
        type: 'object',
        required: ['index', 'status', 'value'],
        properties: {
          index: { type: 'integer' },
          status: { type: 'string', enum: ['fulfilled'] },
          value: itemOutput,
        },
      },
      {
        type: 'object',
        required: ['index', 'status', 'chunks'],
        properties: {
          index: { type: 'integer' },
          status: { type: 'string', enum: ['fulfilled'] },
          chunks: { type: 'array' },
        },
      },
      {
        type: 'object',
        required: ['index', 'status', 'reason'],
        properties: {
          index: { type: 'integer' },
          status: { type: 'string', enum: ['rejected'] },
          reason: {},
          chunksDelivered: { type: 'integer' },
        },
      },
    ],
  };
}

/**
 * Pure `Operation → schema fragment` transform (§1.2). Host-agnostic: takes
 * only the already-host-neutral `Operation` IR, produces plain JSON Schema.
 */
export function deriveBatchOperationBranch(op: Operation): BatchOperationBranch {
  return {
    operationConst: op.id,
    itemsSchema: op.input,
    resultSchema: batchItemResultSchema(op.output),
  };
}

// ---------------------------------------------------------------------------
// F1 — group batchable operations by kind, build one mount schema per group
// ---------------------------------------------------------------------------

/**
 * Group batchable operations (excluding `opts.exclude`) by `Operation.kind`
 * (F1). Each distinct kind present gets its own `_batch/<kind>` mount —
 * `_batch/query`, `_batch/action`, etc. — because `Operation.kind`/`.safe`
 * are static per-op classifications transports read for wire decisions
 * (HTTP verb/cacheability, gRPC idempotency), and a single `_batch` mount
 * whose *actual* kind varies per selected `operation` branch cannot carry
 * that truthfully (architect review F1).
 */
export function groupBatchableOperationsByKind(
  operations: readonly Operation[],
  opts: BatchMountOptions = {}
): Map<OperationKind, Operation[]> {
  const excluded = new Set(opts.exclude ?? []);
  const groups = new Map<OperationKind, Operation[]>();
  for (const op of operations) {
    if (excluded.has(op.id)) continue;
    const list = groups.get(op.kind);
    if (list) list.push(op);
    else groups.set(op.kind, [op]);
  }
  return groups;
}

/** A single literal-value branch's `operation` property, shaped for `detectDiscriminator`. */
function operationConstProp(opId: string): JSONSchema {
  // `detectDiscriminator` requires `{ type: 'string'|'number', enum: [v] }` —
  // NOT `{ const: v } — see morph-walk.ts:315-334.
  return { type: 'string', enum: [opId] };
}

function branchInputSchema(
  branch: BatchOperationBranch,
  operationProp: JSONSchema
): JSONSchema {
  return {
    type: 'object',
    required: ['operation', 'items'],
    properties: {
      operation: operationProp,
      items: { type: 'array', items: branch.itemsSchema },
      concurrency: { type: 'number' },
      mode: { type: 'string', enum: ['parallel', 'serial', 'chained'] },
      onItemError: { type: 'string', enum: ['continue', 'abort'] },
      itemTimeoutMs: { type: 'number' },
    },
    // Additive-forward-compat (§7 open-question 3): a future `batchId`
    // control-plane field must be addable without a breaking change, so this
    // branch object must never be a closed schema.
    additionalProperties: true,
  };
}

/** The input/output schema pair (+ discriminator, when applicable) for one `_batch/<kind>` mount. */
export interface BatchKindSchema {
  input: JSONSchema;
  output: JSONSchema;
  /** Present only when ≥2 operations share this kind (a 1-branch `oneOf` is not a union). */
  discriminator?: InlineDiscriminator;
}

/**
 * Build the input/output schema pair for one `_batch/<kind>` mount (F1).
 *
 * - **≥2 ops of that kind:** a real `oneOf` + `InlineDiscriminator` union,
 *   using the same-document JSON-Pointer mechanism (`morph-walk.ts`), never
 *   `union.ts`'s $ref/nominal mechanism (§1.1).
 * - **Exactly 1 op of that kind:** the single branch's shape directly, no
 *   `oneOf` wrapper — `detectDiscriminator` itself refuses below 2 variants
 *   (§1.1's "edge case the 0.0.1 draft missed"), and a one-variant `oneOf`
 *   is not a union.
 *
 * Throws if `ops` is empty — callers (mount-building) must never invoke this
 * for a kind with zero operations; `groupBatchableOperationsByKind` never
 * produces an empty group.
 */
export function buildBatchKindSchema(ops: readonly Operation[]): BatchKindSchema {
  if (ops.length === 0) {
    throw new Error('buildBatchKindSchema: at least one operation is required');
  }
  const branches = ops.map(deriveBatchOperationBranch);

  if (ops.length === 1) {
    const [op] = ops;
    const [branch] = branches;
    return {
      input: branchInputSchema(branch, operationConstProp(op.id)),
      output: { type: 'array', items: branch.resultSchema },
    };
  }

  const inputVariants = ops.map((op, i) =>
    branchInputSchema(branches[i], operationConstProp(op.id))
  );
  const discriminator = detectDiscriminator(
    inputVariants as unknown as ReadonlyArray<Record<string, unknown>>
  );
  return {
    input: {
      oneOf: inputVariants,
      ...(discriminator ? { discriminator } : {}),
    },
    output: {
      oneOf: branches.map((b) => ({ type: 'array', items: b.resultSchema })),
    },
    ...(discriminator ? { discriminator } : {}),
  };
}

// ---------------------------------------------------------------------------
// Mount — one MountedOperation-shape (sans handler) per distinct kind
// ---------------------------------------------------------------------------

/**
 * One synthetic `_batch/<kind>` operation shape, minus `handler` — mounting
 * a real, request-servable handler requires wiring `invokeBatch`
 * (`@adhd/apigen-engine-runtime`), which is TS-runtime plumbing this
 * (host-agnostic) module deliberately does not depend on. A `MountCapability`
 * implementation composes `{ ...op, handler: ... }` using this fragment plus
 * its own `invokeBatch` wiring (see BATCH_0.0.1.md §3/§5).
 */
export type BatchKindOperation = Omit<MountedOperation, 'handler'> & {
  kind: OperationKind;
  /** Ids of the operations this `_batch/<kind>` mount can fan out over. */
  operationIds: string[];
};

/**
 * Derive one `_batch/<kind>` synthetic mount per distinct kind present in the
 * batchable operation set (F1). Refuses to mount anything for a descriptor
 * with zero batchable operations (empty array — §1.1's "edge case the 0.0.1
 * draft missed" restated per-kind rather than for a single global mount).
 *
 * `kind`/`safe` are truthful per mount (query kinds are `safe: true`;
 * everything else defaults `safe: false` per the existing `Operation.safe`
 * default-from-kind rule) — never the single hardcoded
 * `kind:'action', safe:false` the 0.0.1 draft proposed for one omnibus
 * `_batch` mount (architect review F1).
 */
export function buildBatchMountedOperations(
  descriptor: Descriptor,
  opts: BatchMountOptions = {}
): BatchKindOperation[] {
  const groups = groupBatchableOperationsByKind(descriptor.operations, opts);
  const result: BatchKindOperation[] = [];
  for (const [kind, ops] of groups) {
    // `input`/`output` already carry the discriminator (embedded at
    // `input.discriminator` by `buildBatchKindSchema` when ≥2 branches).
    const { input, output } = buildBatchKindSchema(ops);
    const shape = syntheticOp(`_batch/${kind}`, descriptor, {
      kind,
      safe: kind === 'query',
      input,
      output,
    });
    result.push({
      ...shape,
      operationIds: ops.map((o) => o.id),
    });
  }
  return result;
}
