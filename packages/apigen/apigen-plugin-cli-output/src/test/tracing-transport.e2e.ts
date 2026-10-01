import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Operation } from '@adhd/apigen-core-client';
import { initTelemetry, _resetTelemetryForTest, type TelemetryHandle } from '@adhd/sox-telemetry';
import { tracingPlugin } from '@adhd/apigen-plugin-tracing';
import { run } from '../lib/run';

function seg(raw: string, words: string[]) {
  return { raw, words };
}

const schema = {
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

const operations: Operation[] = [
  {
    id: 'trace-pkg/echo',
    host: 'ts',
    namespace: seg('trace-pkg', ['trace-pkg']),
    path: [seg('echo', ['echo'])],
    kind: 'action',
    async: false,
    streaming: false,
    safe: false,
    input: schema.echo.input,
    output: schema.echo.output,
    envelope: {},
    typeText: null,
  },
];

const packages = [
  {
    id: 'trace-pkg',
    schemas: schema,
    importPath: '@test/trace-pkg',
    fns: { echo: (msg: unknown) => `echo:${String(msg)}` },
  },
];

const silentLogger = { info: () => undefined, error: () => undefined, warn: () => undefined, debug: () => undefined };

// AC0.3 — real-transport e2e for the cli adapter: the REAL `run()` entrypoint is
// invoked with a real argv + real schema + the tracing plugin installed, and the
// durable `.start` record must carry `apigen.transport === 'cli'`, never
// `undefined`.
describe('[tracing-transport] cli — the .start record carries apigen.transport=cli', () => {
  let handle: TelemetryHandle;
  let logDir: string;

  beforeAll(async () => {
    _resetTelemetryForTest();
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracing-cli-'));
    handle = initTelemetry({
      service: 'tracing-e2e',
      role: 'cli',
      logSink: 'file',
      logDir,
      otel: true,
    });
    await handle.otelReady();
  }, 15000);

  afterAll(() => {
    handle.close();
    _resetTelemetryForTest();
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  it('dispatching a real op emits an .start record whose apigen.transport is cli (never undefined)', async () => {
    await run({
      packages,
      operations,
      outputDir: '/tmp/out',
      options: { argv: ['trace-pkg', 'echo', '--msg', 'hi'], usePlugins: [tracingPlugin] },
      logger: silentLogger,
    });

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
    expect(start!['apigen.transport']).toBe('cli');
    expect(start!['apigen.transport']).not.toBeUndefined();
  });
});
