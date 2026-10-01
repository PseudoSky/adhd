import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Call, Chunk, Next, Result, Transport } from '@adhd/apigen-core-client';
import {
  initTelemetry,
  _resetTelemetryForTest,
  type TelemetryHandle,
} from '@adhd/sox-telemetry';
import { tracingPlugin, makeTracingPlugin, makeTraceLayer, traceStream, TraceHandle } from './plugin';

// ---------------------------------------------------------------------------
// Harness — a real sox-telemetry sink on a throwaway log dir, OTel forced on, so the
// assertions read actual emitted records rather than inspecting code.
//
// NOTE: the real-transport end-to-end proof that a dispatched operation carries
// `apigen.transport` for each of mcp / fastify / express / cli lives next to each adapter
// (packages/apigen/apigen-plugin-*/src/test/tracing-transport.e2e.ts) — it boots the real
// transport and drives a real dispatch. A hand-fabricated `Call` literal here would prove
// nothing about the runtime stamp, which is exactly the gap this suite closes.
// ---------------------------------------------------------------------------

interface Recorded {
  event: string;
  level: string;
  trace_id?: string | null;
  [key: string]: unknown;
}

let logDir: string;
let handle: TelemetryHandle;

beforeEach(async () => {
  _resetTelemetryForTest();
  logDir = mkdtempSync(join(tmpdir(), 'tracing-spec-'));
  handle = initTelemetry({
    service: 'tracing-spec',
    role: 'cli',
    logSink: 'file',
    logDir,
    otel: true,
  });
  await handle.otelReady();
});

afterEach(() => {
  handle.close();
  _resetTelemetryForTest();
  rmSync(logDir, { recursive: true, force: true });
});

function sinkPath(): string {
  const path = handle.currentLogFilePath();
  if (path === null) throw new Error('expected a file sink for this suite');
  return path;
}

function readRecords(): Recorded[] {
  const path = sinkPath();
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Recorded);
}

/** Minimal `Extensions` impl — the ctx token map a `Call` carries. */
class TestExtensions {
  private readonly map = new Map<unknown, unknown>();
  set<T>(key: new (...args: never[]) => T, value: T): void {
    this.map.set(key, value);
  }
  get<T>(key: new (...args: never[]) => T): T | undefined {
    return this.map.get(key) as T | undefined;
  }
}

interface CallInit {
  id?: string;
  transport?: Transport;
  envelope?: Record<string, unknown>;
  data?: Record<string, unknown>;
  ctx?: TestExtensions;
}

function makeCall(init: CallInit = {}): Call {
  return {
    operation: { id: init.id ?? 'echo' },
    data: init.data ?? {},
    envelope: init.envelope ?? {},
    ctx: init.ctx ?? new TestExtensions(),
    transport: init.transport ?? 'mcp',
    signal: new AbortController().signal,
  } as unknown as Call;
}

async function* sourceOf(chunks: readonly Chunk[]): AsyncGenerator<Chunk> {
  for (const chunk of chunks) yield chunk;
}

// ---------------------------------------------------------------------------
// Unit — §7 of the implementation spec
// ---------------------------------------------------------------------------

describe('apigen-plugin-tracing — layer', () => {
  it('calls next() exactly once and returns its resolved value unchanged', async () => {
    let calls = 0;
    const out = await (makeTraceLayer()(makeCall(), async () => {
      calls += 1;
      return 'value';
    }) as Promise<Result>);
    expect(out).toBe('value');
    expect(calls).toBe(1);
  });

  it('seeds call.ctx with a TraceHandle carrying a non-empty traceId and apigen.<op> spanName', async () => {
    const call = makeCall({ id: 'echo' });
    await (makeTraceLayer()(call, async () => 'ok') as Promise<Result>);
    const trace = call.ctx.get(TraceHandle);
    expect(trace).toBeDefined();
    expect(trace!.traceId).toBeTruthy();
    expect(trace!.spanName).toBe('apigen.echo');
  });

  it('writes .start BEFORE the body settles (hang-visible) and .finish with duration_ms after', async () => {
    const call = makeCall({ id: 'hang' });

    // A body that blocks on a gate we control — the operation "never returns" until we release it.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = makeTraceLayer()(call, async () => {
      await gate;
      return 'ok';
    }) as Promise<Result>;

    // Let the microtask queue drain: the span opened synchronously when the layer ran, so the
    // .start record is already durable even though the body has not settled.
    await Promise.resolve();
    expect(readRecords().some((r) => r.event === 'apigen.hang.start')).toBe(true);

    release();
    await pending;

    const finish = readRecords().find((r) => r.event === 'apigen.hang.finish');
    expect(finish).toBeDefined();
    expect(typeof finish!.duration_ms).toBe('number');
  });

  it('propagates a thrown error AND emits an .error record (never swallows)', async () => {
    const call = makeCall({ id: 'echo' });
    const boom = new Error('boom');
    await expect(
      makeTraceLayer()(call, async () => {
        throw boom;
      }) as Promise<Result>
    ).rejects.toBe(boom);

    const records = readRecords();
    // The layer's own error trace.
    const opError = records.find((r) => r.event === 'apigen.op.error');
    expect(opError).toBeDefined();
    expect(opError!.err).toBe('boom');
    expect(opError!['apigen.op']).toBe('echo');
    expect(opError!['apigen.transport']).toBe('mcp');
    // The span-level error record from withSpan.
    expect(records.some((r) => r.event === 'apigen.echo.error')).toBe(true);
  });

  it('honours serviceName in the span name (makeTracingPlugin)', async () => {
    const call = makeCall({ id: 'echo' });
    const plugin = makeTracingPlugin({ serviceName: 'checkout' });
    await (plugin.capabilities.layer!.layer(call, async () => 'ok') as Promise<Result>);
    expect(call.ctx.get(TraceHandle)!.spanName).toBe('checkout.echo');
  });

  it('copies declared envelopeAttrs onto the span', async () => {
    const call = makeCall({ id: 'echo', envelope: { 'x-request-id': 'abc', ignored: 'nope' } });
    const plugin = makeTracingPlugin({ envelopeAttrs: ['x-request-id'] });
    await (plugin.capabilities.layer!.layer(call, async () => 'ok') as Promise<Result>);
    const start = readRecords().find((r) => r.event === 'apigen.echo.start');
    expect(start!['x-request-id']).toBe('abc');
    expect(start!.ignored).toBeUndefined();
  });

  it('reserved attrs win over a shadowing envelopeAttrs key (F14)', async () => {
    // An envelope that tries to impersonate the built-in attrs, declared via envelopeAttrs.
    const call = makeCall({
      id: 'echo',
      transport: 'cli',
      envelope: {
        trace_id: 'attacker',
        'apigen.op': 'forged',
        'apigen.transport': 'forged',
      },
    });
    const plugin = makeTracingPlugin({
      envelopeAttrs: ['trace_id', 'apigen.op', 'apigen.transport'],
    });
    await (plugin.capabilities.layer!.layer(call, async () => 'ok') as Promise<Result>);

    const start = readRecords().find((r) => r.event === 'apigen.echo.start');
    expect(start).toBeDefined();
    // The reserved keys — spread LAST — must always win over the envelope-supplied values.
    expect(start!['apigen.op']).toBe('echo');
    expect(start!['apigen.transport']).toBe('cli');
    expect(start!.trace_id).toBe(call.ctx.get(TraceHandle)!.traceId);
    expect(start!.trace_id).not.toBe('attacker');
  });
});

// ---------------------------------------------------------------------------
// Streaming branch — QUARANTINED under the current `Next` contract (CONTRACT-FIX §4).
//
// `Next = () => Promise<LayerResult>`: an `AsyncIterable` can only ever be a *resolved*
// value, so the layer cannot (and must not) branch on the unresolved `next()` promise.
// `traceStream` is therefore exercised directly here, plus a quarantine test proving the
// layer treats a resolved iterable as an opaque unary value (never fabricating a streaming
// span), and a negative control that fails if the layer ever calls `isAsyncIterable` on the
// unresolved promise again.
// ---------------------------------------------------------------------------

describe('apigen-plugin-tracing — streaming branch (quarantined)', () => {
  const attrs = { 'apigen.op': 'stream', 'apigen.transport': 'mcp', trace_id: 'tid' };

  it('traceStream passes chunks through unchanged and emits .finish with the chunk count', async () => {
    const chunks: Chunk[] = [{ n: 1 }, { n: 2 }, { n: 3 }];
    const stream = traceStream(sourceOf(chunks), 'apigen.stream', attrs);

    const collected: unknown[] = [];
    for await (const chunk of stream) collected.push(chunk);
    expect(collected).toEqual(chunks);

    const finish = readRecords().find((r) => r.event === 'apigen.stream.finish');
    expect(finish).toBeDefined();
    expect(finish!.chunks).toBe(3);
    expect(typeof finish!.duration_ms).toBe('number');
  });

  it('traceStream propagates a mid-stream throw AND emits .error with the partial count', async () => {
    const boom = new Error('mid');
    async function* failing(): AsyncGenerator<Chunk> {
      yield 1;
      throw boom;
    }
    const stream = traceStream(failing(), 'apigen.stream', attrs);

    const collected: unknown[] = [];
    await expect(
      (async () => {
        for await (const chunk of stream) collected.push(chunk);
      })()
    ).rejects.toBe(boom);
    expect(collected).toEqual([1]);

    const err = readRecords().find((r) => r.event === 'apigen.stream.error');
    expect(err).toBeDefined();
    expect(err!.err).toBe('mid');
    expect(err!.chunks).toBe(1);
  });

  it('traceStream emits .start synchronously on entry, before the body is iterated', () => {
    const stream = traceStream(sourceOf([1]), 'apigen.stream', attrs);
    // The generator has not been iterated yet, but .start must already be on disk.
    expect(readRecords().some((r) => r.event === 'apigen.stream.start')).toBe(true);
    void stream;
  });

  it('the layer treats a resolved iterable as an opaque unary value (does NOT fabricate a stream span)', async () => {
    const call = makeCall({ id: 'q' });
    const src = sourceOf([1, 2, 3]);

    // A `next` that honours the real contract: it RESOLVES to the iterable.
    const out = await (makeTraceLayer()(call, () => Promise.resolve(src)) as Promise<
      AsyncIterable<Chunk>
    >);

    // Identity is preserved — the layer did not wrap the resolved iterable in a second generator.
    expect(out).toBe(src);
    // No streaming lifecycle ran: nothing recorded a `chunks` count.
    expect(readRecords().some((r) => r.chunks !== undefined)).toBe(false);
    // The legitimate unary span for the operation still opened and closed.
    expect(readRecords().some((r) => r.event === 'apigen.q.start')).toBe(true);
    expect(readRecords().some((r) => r.event === 'apigen.q.finish')).toBe(true);
  });

  it('negative control: a bare-iterable `next` is passed through by identity (fails under the old eager branch)', async () => {
    const call = makeCall({ id: 'neg' });
    const src = sourceOf([1, 2, 3]);

    // Deliberately violates the contract (`Next` must resolve): the old code branched HERE on the
    // unresolved value and returned a NEW generator (identity broken). The current layer never
    // inspects the unresolved value, so identity holds.
    const out = await (makeTraceLayer()(call, (() => src) as unknown as Next) as Promise<
      AsyncIterable<Chunk>
    >);

    expect(out).toBe(src);
    expect(readRecords().some((r) => r.chunks !== undefined)).toBe(false);
  });
});

describe('apigen-plugin-tracing — plugin shape', () => {
  it('target.generate() returns [] (a valid no-op target)', () => {
    expect(tracingPlugin.capabilities.target!.generate({ operations: [], host: 'ts' }, {})).toEqual(
      []
    );
  });

  it('declares id "tracing" and a layer capability', () => {
    expect(tracingPlugin.id).toBe('tracing');
    expect(typeof tracingPlugin.capabilities.layer!.layer).toBe('function');
  });
});
