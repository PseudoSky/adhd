/**
 * Tests for `projectMountInputSchema` (BUG-APIGEN-CLI-OUTPUT-001) — the
 * `MountedOperation.input` → `ComposedSchemas[string]`-shaped projection
 * `run.ts`'s mount-registration loop feeds into `buildOpPlan` so a mount op
 * (health, openapi, batch, or any future `--use` mount) gets real `cliFlags`.
 *
 * TEETH: every assertion checks the exact resolved `buildOpPlan(...).cliFlags`
 * table (kebab keys, `valueKind` per prop) — not mere presence — so a
 * regression in the projection or in `computeCliFlags`'s own valueKind rules
 * flips these red.
 */
import { describe, expect, it } from 'vitest';
import { buildOpPlan } from '@adhd/apigen-engine-runtime';
import type { MountedOperation, Segment } from '@adhd/apigen-core-client';
import { projectMountInputSchema } from '../lib/mount-cli-flags';

function seg(raw: string, words: string[]): Segment {
  return { raw, words };
}

function makeMountOp(
  id: string,
  input: unknown,
  overrides: Partial<MountedOperation> = {}
): MountedOperation {
  return {
    id,
    host: 'ts',
    namespace: seg('_meta', ['meta']),
    path: [seg(id.split('/')[1] ?? id, [id.split('/')[1] ?? id])],
    kind: 'action',
    async: false,
    streaming: false,
    safe: true,
    input: input as MountedOperation['input'],
    output: {},
    envelope: {},
    typeText: null,
    handler: async () => ({}),
    ...overrides,
  };
}

describe('projectMountInputSchema — flat (non-union) mount input', () => {
  it('resolves zero flags for a trivial/empty mount input (health/openapi shape) — never a regression for a zero-arg mount', () => {
    const schema = projectMountInputSchema({});
    const plan = buildOpPlan({
      op: makeMountOp('_meta/health', {}),
      schema,
      transport: 'cli',
    });
    expect(plan.cliFlags.size).toBe(0);
  });

  it('resolves zero flags for `{type:"object", properties:{}, required:[]}` (the real "meta ping" harness shape)', () => {
    const input = { type: 'object', properties: {}, required: [] };
    const schema = projectMountInputSchema(input);
    const plan = buildOpPlan({
      op: makeMountOp('_meta/ping', input),
      schema,
      transport: 'cli',
    });
    expect(plan.cliFlags.size).toBe(0);
  });

  it('resolves real flags with correct valueKind for a single-branch batch-shaped mount input (batch\'s buildBatchKindSchema, 1-op-per-kind case)', () => {
    // Mirrors apigen-core-client's branchInputSchema output verbatim for a
    // kind with exactly one batchable operation (no oneOf/discriminator).
    const input = {
      type: 'object',
      required: ['operation', 'items'],
      properties: {
        operation: { type: 'string', enum: ['catalog/getItem'] },
        items: { type: 'array', items: { type: 'object' } },
        concurrency: { type: 'number' },
        mode: { type: 'string', enum: ['parallel', 'serial', 'chained'] },
        onItemError: { type: 'string', enum: ['continue', 'abort'] },
        itemTimeoutMs: { type: 'number' },
      },
      additionalProperties: true,
    };
    const schema = projectMountInputSchema(input);
    const plan = buildOpPlan({
      op: makeMountOp('_batch/action', input),
      schema,
      transport: 'cli',
    });

    expect(plan.cliFlags.size).toBe(6);
    expect(plan.cliFlags.get('operation')).toEqual({
      camelKey: 'operation',
      kind: 'domain',
      valueKind: 'string',
    });
    expect(plan.cliFlags.get('items')).toEqual({
      camelKey: 'items',
      kind: 'domain',
      valueKind: 'json',
    });
    expect(plan.cliFlags.get('concurrency')).toEqual({
      camelKey: 'concurrency',
      kind: 'domain',
      valueKind: 'json',
    });
    expect(plan.cliFlags.get('mode')).toEqual({
      camelKey: 'mode',
      kind: 'domain',
      valueKind: 'string',
    });
    expect(plan.cliFlags.get('on-item-error')).toEqual({
      camelKey: 'onItemError',
      kind: 'domain',
      valueKind: 'string',
    });
    expect(plan.cliFlags.get('item-timeout-ms')).toEqual({
      camelKey: 'itemTimeoutMs',
      kind: 'domain',
      valueKind: 'json',
    });
  });
});

describe('projectMountInputSchema — root-level oneOf+discriminator mount input (≥2 ops sharing a kind)', () => {
  const twoOpUnionInput = {
    oneOf: [
      {
        type: 'object',
        required: ['operation', 'items'],
        properties: {
          operation: { type: 'string', enum: ['catalog/getItem'] },
          items: { type: 'array', items: { type: 'object' } },
          concurrency: { type: 'number' },
          mode: { type: 'string', enum: ['parallel', 'serial', 'chained'] },
          onItemError: { type: 'string', enum: ['continue', 'abort'] },
          itemTimeoutMs: { type: 'number' },
        },
      },
      {
        type: 'object',
        required: ['operation', 'items'],
        properties: {
          operation: { type: 'string', enum: ['catalog/deleteItem'] },
          items: { type: 'array', items: { type: 'object' } },
          concurrency: { type: 'number' },
          mode: { type: 'string', enum: ['parallel', 'serial', 'chained'] },
          onItemError: { type: 'string', enum: ['continue', 'abort'] },
          itemTimeoutMs: { type: 'number' },
        },
      },
    ],
    discriminator: {
      propertyName: 'operation',
      mapping: {
        'catalog/getItem': '#/oneOf/0',
        'catalog/deleteItem': '#/oneOf/1',
      },
    },
  };

  it('merges every branch\'s properties into ONE flag table (never fans out into N synthetic subcommands)', () => {
    const schema = projectMountInputSchema(twoOpUnionInput);
    const plan = buildOpPlan({
      op: makeMountOp('_batch/action', twoOpUnionInput),
      schema,
      transport: 'cli',
    });

    // Every shared control-plane field, present in BOTH branches, resolves to
    // exactly one flag entry — proving the merge, not a per-branch duplicate
    // or a first-branch-only projection.
    expect(plan.cliFlags.size).toBe(6);
    expect(plan.cliFlags.get('operation')?.valueKind).toBe('string');
    expect(plan.cliFlags.get('items')?.valueKind).toBe('json');
    expect(plan.cliFlags.get('concurrency')?.valueKind).toBe('json');
  });

  it('carries a field required in EVERY branch as required, and drops a field required in only SOME branches to optional', () => {
    const partialRequiredUnion = {
      oneOf: [
        {
          type: 'object',
          required: ['operation', 'items', 'onlyInBranchOne'],
          properties: {
            operation: { type: 'string', enum: ['a'] },
            items: { type: 'array' },
            onlyInBranchOne: { type: 'string' },
          },
        },
        {
          type: 'object',
          required: ['operation', 'items'],
          properties: {
            operation: { type: 'string', enum: ['b'] },
            items: { type: 'array' },
          },
        },
      ],
      discriminator: {
        propertyName: 'operation',
        mapping: { a: '#/oneOf/0', b: '#/oneOf/1' },
      },
    };
    const schema = projectMountInputSchema(partialRequiredUnion);
    // `required` is nested under `input.properties.data.required` in the
    // synthetic schema this function produces.
    const dataSchema = (
      schema.input as {
        properties: { data: { required: string[] } };
      }
    ).properties.data;
    expect(dataSchema.required).toContain('operation');
    expect(dataSchema.required).toContain('items');
    expect(dataSchema.required).not.toContain('onlyInBranchOne');
  });
});
