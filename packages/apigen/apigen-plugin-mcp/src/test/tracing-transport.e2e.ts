import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import type { RunInput } from '@adhd/apigen-core-client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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

const mcpSchema = {
  echo: {
    input: {
      type: 'object',
      properties: {
        data: { type: 'object', properties: { msg: { type: 'string' } }, required: [] },
      },
      required: ['data'],
    },
    // Array-typed output (ADR-0004): the mcp adapter advertises NO outputSchema
    // for array/union returns, so the SDK does not demand structuredContent —
    // keeping this fixture focused on the transport stamp under test.
    output: { type: 'array', items: { type: 'string' } },
  },
};

// AC0.3 — real-transport e2e for the mcp adapter: a REAL MCP server is booted
// with the tracing plugin and driven by a REAL StreamableHTTP client. The
// durable `.start` record must carry `apigen.transport === 'mcp'`, never
// `undefined`. A hand-fabricated `Call` proves nothing here.
describe('[tracing-transport] mcp — the .start record carries apigen.transport=mcp', () => {
  let port: number;
  let controller: AbortController;
  let handle: TelemetryHandle;
  let logDir: string;

  beforeAll(async () => {
    _resetTelemetryForTest();
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracing-mcp-'));
    handle = initTelemetry({
      service: 'tracing-e2e',
      role: 'cli',
      logSink: 'file',
      logDir,
      otel: true,
    });
    await handle.otelReady();

    port = await freePort();
    controller = new AbortController();
    const runInput: RunInput = {
      packages: [
        {
          id: 'trace-pkg',
          schemas: mcpSchema,
          importPath: '@test/trace-pkg',
          fns: { echo: (msg: unknown) => [`echo:${String(msg)}`] },
        },
      ],
      outputDir: '/tmp/out',
      options: { transport: 'streaming-http', port, usePlugins: [tracingPlugin] },
      signal: controller.signal,
    };
    run(runInput).catch(() => {
      /* swallowed after abort */
    });
  }, 15000);

  afterAll(() => {
    controller.abort();
    handle.close();
    _resetTelemetryForTest();
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  it('a real client call emits an .start record whose apigen.transport is mcp (never undefined)', async () => {
    const client = new Client({ name: 'tracing-transport-mcp', version: '1.0.0' });
    const deadline = Date.now() + 10000;
    for (;;) {
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
        );
        break;
      } catch {
        if (Date.now() > deadline) throw new Error('mcp server did not become ready in 10s');
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    try {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name.includes('echo'));
      expect(tool).toBeDefined();
      const result = await client.callTool({
        name: tool!.name,
        arguments: { data: { msg: 'hi' } },
      });
      expect(result.isError).not.toBe(true);

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
          typeof r.event === 'string' &&
          (r.event as string).endsWith('.start') &&
          'apigen.op' in r
      );
      expect(start).toBeDefined();
      expect(start!['apigen.transport']).toBe('mcp');
      expect(start!['apigen.transport']).not.toBeUndefined();
    } finally {
      await client.close();
    }
  });
});
