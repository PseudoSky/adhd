/**
 * guards: the SSE projection of a streaming op writes no frame until the producer completes
 * tier: S
 * cites: 8a62ced2 AC1
 *
 * regression:8a62ced2 — the SSE projection of a streaming op emits frame 1 before the
 * producer finishes (backlog 8a62ced2, AC1).
 *
 * Consumer seam: the real `dispatch()` (engine-runtime) produces the stream a
 * streaming op returns, and the real `sendStreamSse()` (this plugin) projects it.
 * Only the HTTP socket is a mock (a `raw` response recorder and a request emitter),
 * because the default lane binds no port. The real-route framing over a live server
 * stays in plugin.e2e.ts (see the header there); this file is the default-lane proof.
 *
 * Failure mode: a streaming op whose output schema is non-empty reached the
 * transcoder as one value, so the SSE branch never fired and no data frame was
 * written while the producer was still running.
 *
 * Tier: S (in-process, default `test` lane). Fidelity gap: the socket is a mock, so
 * real HTTP chunked framing and client-disconnect timing are not observed here.
 * They cannot be observed at tier S because they require a bound socket; the
 * plugin.e2e.ts lane owns them.
 * Item: 8a62ced2 AC1 (frame 1 arrives before the producer latch opens; no sleeps).
 *
 * Determinism: the producer parks on a latch after yielding chunk 1. The test
 * resolves on whichever happens first, the first frame write or the SSE call
 * settling, so a broken implementation fails on an assertion instead of hanging.
 *
 * red: pending (user hold) — expected to fail at 5701848e^ (the parent of the
 * stream-encoding fix 5701848e) because the SSE call settles without writing the
 * Date frame (or writes an error frame), so `frame 1 contains
 * "2024-01-15T12:00:00.000Z"` fails and the latch-state assertion is never reached.
 */

import { describe, it, expect, vi } from 'vitest';
import type { FastifyRequest, FastifyReply } from 'fastify';
import EventEmitter from 'node:events';
import { sendStreamSse } from '../../src/lib/stream';
import { createStream, dispatch } from '@adhd/apigen-engine-runtime';

const ISO_A = '2024-01-15T12:00:00.000Z';
const ISO_B = '2024-01-16T12:00:00.000Z';

describe('regression:8a62ced2 — SSE frame 1 is written before the producer latch opens', () => {
  it('projects a dispatched date-time stream frame-by-frame, first frame first (8a62ced2 AC1)', async () => {
    const schema = {
      input: {
        type: 'object',
        properties: { data: { type: 'object', properties: {}, required: [] } },
        required: ['data'],
      },
      output: { type: 'string', format: 'date-time' },
    };

    let openLatch!: () => void;
    const latch = new Promise<void>((resolve) => (openLatch = resolve));
    // Set by the producer itself, only after the latch has released it.
    let producerReleased = false;

    const result = await dispatch(
      {
        ticks: () =>
          createStream<Date>({
            produce: async function* () {
              yield new Date(ISO_A);
              await latch;
              producerReleased = true;
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

    // Socket mock: records every write and signals the first data frame.
    const written: string[] = [];
    let onFirstFrame!: () => void;
    const firstFrame = new Promise<void>((resolve) => (onFirstFrame = resolve));
    const raw = {
      writeHead: vi.fn(),
      write: vi.fn((chunk: string | Buffer) => {
        written.push(String(chunk));
        if (written.length === 1) onFirstFrame();
        return true;
      }),
      end: vi.fn(),
    };
    const rawReq = new EventEmitter();
    const req = { raw: rawReq } as unknown as FastifyRequest;
    const reply = { raw, hijack: vi.fn() } as unknown as FastifyReply;

    const done = sendStreamSse(result as AsyncIterable<unknown>, req, reply);

    // Resolve on the first frame write, or on the SSE call settling. A pre-fix
    // implementation settles without a Date frame and fails the assertions below.
    await Promise.race([firstFrame, done]);

    expect(written.length).toBeGreaterThan(0);
    expect(written[0]).toContain(JSON.stringify(ISO_A));
    expect(producerReleased).toBe(false);

    openLatch();
    await done;

    expect(written[1]).toContain(JSON.stringify(ISO_B));
    expect(raw.end).toHaveBeenCalled();
  });
});
