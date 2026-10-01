import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import type { PluginInput, RunInput } from '@adhd/apigen-core-client';
import { initTelemetry, _resetTelemetryForTest, type TelemetryHandle } from '@adhd/sox-telemetry';
import { tracingPlugin } from '@adhd/apigen-plugin-tracing';
import { run } from '../lib/run';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error('failed to allocate a port'));
      }
    });
  });
}

const testFns = {
  echo: (msg: unknown) => `echo:${String(msg)}`,
};

const testSchema = {
  echo: {
    input: {
      type: 'object',
      properties: {
        data: { type: 'object', properties: { msg: { type: 'string' } }, required: [] },
      },
      required: ['data'],
    },
    output: { type: 'object' },
  },
};

const baseInput: PluginInput = {
  packages: [
    { id: 'trace-pkg', schemas: testSchema, importPath: '@test/trace-pkg', fns: testFns },
  ],
  outputDir: '/tmp/out',
  options: {},
};

// AC0.3 — the real-transport end-to-end that would have caught the HIGH finding.
// A high-fidelity call (not a hand-fabricated `Call`) is driven through the REAL
// fastify adapter with the tracing plugin installed, and the durable telemetry
// sink is asserted to carry `apigen.transport === 'http'` (never `undefined`).
describe('[tracing-transport] fastify — the .start record carries apigen.transport=http', () => {
  let controller: AbortController;
  let baseUrl: string;
  let handle: TelemetryHandle;
  let logDir: string;

  beforeAll(async () => {
    _resetTelemetryForTest();
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracing-fastify-'));
    handle = initTelemetry({
      service: 'tracing-e2e',
      role: 'cli',
      logSink: 'file',
      logDir,
      otel: true,
    });
    await handle.otelReady();

    controller = new AbortController();
    const port = await freePort();
    const runInput: RunInput = {
      ...baseInput,
      options: { port, usePlugins: [tracingPlugin] },
      signal: controller.signal,
    };
    // `run()` rejects on abort during teardown (expected); surface anything else.
    run(runInput).catch((err) => {
      if (!controller.signal.aborted) {
        console.error('[tracing-transport] fastify run() rejected', err);
      }
    });
    baseUrl = `http://127.0.0.1:${port}`;

    const deadline = Date.now() + 10000;
    for (;;) {
      try {
        const r = await fetch(`${baseUrl}/trace-pkg/echo`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ data: { msg: 'ready' } }),
        });
        if (r.ok || r.status < 500) break;
      } catch {
        /* server not up yet */
      }
      if (Date.now() > deadline) throw new Error('fastify server did not become ready in 10s');
      await new Promise((r) => setTimeout(r, 50));
    }
  }, 15000);

  afterAll(() => {
    controller.abort();
    handle.close();
    _resetTelemetryForTest();
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  it('dispatching a real op emits an .start record whose apigen.transport is http (never undefined)', async () => {
    const res = await fetch(`${baseUrl}/trace-pkg/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { msg: 'hi' } }),
    });
    expect(res.ok).toBe(true);
    await res.json();

    await handle.flush();
    const p = handle.currentLogFilePath();
    expect(p).toBeTruthy();
    const records = fs
      .readFileSync(p as string, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    const start = records.find(
      (r) =>
        typeof r.event === 'string' && (r.event as string).endsWith('.start') && 'apigen.op' in r
    );
    expect(start).toBeDefined();
    expect(start!['apigen.transport']).toBe('http');
    expect(start!['apigen.transport']).not.toBeUndefined();
  });
});
