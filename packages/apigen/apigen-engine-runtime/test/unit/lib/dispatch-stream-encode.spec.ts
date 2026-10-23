/**
 * guards: a streaming op result is transcoded as one value instead of encoded per chunk
 * tier: S
 * cites: 8a62ced2 AC2, AC3
 *
 * regression:8a62ced2 — a streaming op's result is encoded per chunk, not transcoded
 * as a single value (backlog 8a62ced2).
 *
 * Consumer seam: the real `dispatch()` entrypoint in run mode, consuming the
 * returned stream the way a transport does (`for await`). Only the operation
 * function is a closure; `createStream` is the real runtime primitive.
 *
 * Failure mode: a streaming op with a non-empty output schema reached the
 * transcoder as one value. The transcoder walked the schema's properties against
 * the iterator object and returned `{}`, so the SSE branch never fired.
 *
 * Tier: S (in-process, default `test` lane). Fidelity gap: none for S; the SSE
 * wire framing is covered in the fastify stream spec.
 * Items: 8a62ced2 AC2 (result stays an ApiStream, asserted by isApiStream, never by
 * identity), AC3 (createStream yielding Date chunks drains to RFC 3339 strings;
 * consumer break reaches the source's return(); an empty-schema stream passes
 * through untouched).
 *
 * red: pending (user hold) — expected to fail at 5701848e^ (the parent of the fix
 * commit 5701848e) because the date-time stream test fails at `isApiStream(result)`
 * (the result is a transcoded object, not a stream), and the break test fails with a
 * TypeError from iterating a non-iterable result. The empty-schema test pins the
 * CURRENT behavior and is expected green on both commits by design.
 *
 * OPEN ARCHITECT QUESTION (backlog): the empty-schema test below pins that an
 * empty output schema yields RAW host values (Date) for stream chunks while typed
 * schemas yield RFC 3339 strings. That is the CURRENT behavior, not a contract; it
 * is under review and may change. Do not cite it as a guarantee.
 */

import { describe, it, expect } from 'vitest';
import { dispatch } from '../../../src/lib/dispatch';
import { createStream, drainStream, isApiStream } from '../../../src/lib/stream';
import type { ComposedSchemas } from '../../../src/lib/types';

const ISO_A = '2024-01-15T12:00:00.000Z';
const ISO_B = '2024-01-16T12:00:00.000Z';

type Schema = ComposedSchemas[string];

const noArgsInput = {
  type: 'object',
  properties: { data: { type: 'object', properties: {}, required: [] } },
  required: ['data'],
};

describe('regression:8a62ced2 — dispatch encodes a stream per chunk', () => {
  it('AC3: a stream of Date chunks with a date-time chunk schema drains to RFC 3339 strings (8a62ced2 AC2/AC3)', async () => {
    const schema: Schema = {
      input: noArgsInput,
      output: { type: 'string', format: 'date-time' },
    };
    const result = await dispatch(
      {
        ticks: () =>
          createStream<Date>({
            produce: async function* () {
              yield new Date(ISO_A);
              yield new Date(ISO_B);
            },
          }),
      },
      undefined,
      schema,
      'ticks',
      {},
      {}
    );
    // AC2: the result is still a stream (not transcoded as a single value).
    expect(isApiStream(result)).toBe(true);
    const chunks = await drainStream(result as AsyncIterable<unknown>);
    expect(chunks).toEqual([ISO_A, ISO_B]);
  });

  it('AC3: a consumer break reaches the source generator and runs its cleanup (8a62ced2 AC3)', async () => {
    const schema: Schema = {
      input: noArgsInput,
      output: { type: 'string', format: 'date-time' },
    };
    let sourceClosed = false;
    const result = await dispatch(
      {
        ticks: () =>
          createStream<Date>({
            produce: async function* () {
              try {
                yield new Date(ISO_A);
                yield new Date(ISO_B);
              } finally {
                sourceClosed = true;
              }
            },
          }),
      },
      undefined,
      schema,
      'ticks',
      {},
      {}
    );
    for await (const chunk of result as AsyncIterable<unknown>) {
      expect(chunk).toBe(ISO_A);
      break;
    }
    expect(sourceClosed).toBe(true);
  });

  it('AC3: CURRENT behavior (open architect question, not a contract): an empty-schema stream passes through untouched; chunks stay raw Date instances (8a62ced2 AC3 guard)', async () => {
    const schema: Schema = { input: noArgsInput, output: {} };
    const result = await dispatch(
      {
        ticks: () =>
          createStream<Date>({
            produce: async function* () {
              yield new Date(ISO_A);
            },
          }),
      },
      undefined,
      schema,
      'ticks',
      {},
      {}
    );
    expect(isApiStream(result)).toBe(true);
    const chunks = await drainStream(result as AsyncIterable<unknown>);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBeInstanceOf(Date);
  });
});
