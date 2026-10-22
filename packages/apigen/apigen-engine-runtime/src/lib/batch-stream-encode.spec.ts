/**
 * guards: a streaming batch item yields un-encoded values instead of wire-encoded chunks
 * tier: S
 * cites: 8a62ced2 (batch-level AC)
 *
 * regression:8a62ced2 — a streaming batch item yields wire-encoded chunks
 * (backlog 8a62ced2, batch.ts streaming collection at ~line 233).
 *
 * Consumer seam: `invokeBatch` over the real `createInvoker([])` composition, which
 * terminates in the real `dispatch()`. Nothing is mocked; the op returns a real
 * `createStream` of Date chunks.
 *
 * Failure mode: a streaming item whose output schema is non-empty reached
 * collection as an un-encoded value, so batch results carried Date objects (or an
 * empty transcoded object) instead of the wire strings a consumer receives.
 *
 * Tier: S (in-process, default `test` lane, no socket). Fidelity gap: none for S.
 * Item: 8a62ced2 (batch chunks are wire-encoded). Batch-level AC.
 *
 * red: pending (user hold) — expected to fail at 5701848e^ (the parent of the
 * stream-encoding fix 5701848e) because the chunks assertion fails: the item
 * reports a transcoded object or non-string chunks instead of the RFC 3339 strings.
 */

import { describe, it, expect } from 'vitest';
import { createInvoker, LayerContext } from './invoke';
import type { Call, InvokeOptions } from './invoke';
import type { ComposedSchemas } from './types';
import { createStream } from './stream';
import { invokeBatch } from './batch';

const ISO_A = '2024-01-15T12:00:00.000Z';
const ISO_B = '2024-01-16T12:00:00.000Z';

describe('regression:8a62ced2 — streaming batch item chunks are wire-encoded', () => {
  it('collects a date-time streaming item into RFC 3339 string chunks (8a62ced2 batch)', async () => {
    const schemas: ComposedSchemas = {
      ticks: {
        input: {
          type: 'object',
          properties: { data: { type: 'object', properties: {}, required: [] } },
          required: ['data'],
        },
        output: { type: 'string', format: 'date-time' },
      },
    };
    const fns = {
      ticks: () =>
        createStream<Date>({
          produce: async function* () {
            yield new Date(ISO_A);
            yield new Date(ISO_B);
          },
        }),
    };
    const opts: InvokeOptions = { fns, schemas };
    const call: Call = {
      operation: { id: 'ticks' },
      ctx: new LayerContext(),
      envelope: {},
      domainArgs: {},
      transport: 'http',
    };

    const results = await invokeBatch(createInvoker([]), 'ticks', [call], opts);
    expect(results[0]).toEqual({
      index: 0,
      status: 'fulfilled',
      chunks: [ISO_A, ISO_B],
    });
  });
});
