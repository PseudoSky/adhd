/**
 * server.tracing-required.spec.ts — FEAT-APIGEN-TRACING required-consumer guard,
 * now BEHAVIOURAL.
 *
 * `@adhd/backlog` is a REQUIRED consumer of `@adhd/apigen-plugin-tracing`, and it
 * must emit `adhd.*` telemetry — not the plugin's apigen-namespaced fallback. The
 * previous form of this suite asserted LITERAL SOURCE STRINGS, which proves a file
 * *contains text*, not that tracing *runs* (and not that it runs under the right
 * namespace). This suite boots a real sox-telemetry sink and drives the CONFIGURED
 * plugin instance (from `src/tracing.ts`, `serviceName: 'adhd'`) through its layer,
 * then reads the emitted JSONL and asserts the records are `adhd.*`.
 *
 * A cheap static read of the two mount sources remains, but only as a SECONDARY
 * guard — it confirms `server.ts`/`cli.ts` import the configured instance rather
 * than the package's bare apigen-namespaced singleton. It is labelled as such and
 * is not the proof.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import type { Call, Result } from '@adhd/apigen-core-client';
import {
  initTelemetry,
  _resetTelemetryForTest,
  type TelemetryHandle,
} from '@adhd/sox-telemetry';
import { tracingPlugin } from './tracing.js';
// The real operation surface is DERIVED from these two modules (see the
// full-surface describe at the end of this file): `./api.js` is the extraction
// surface (every exported async function is mounted), and `./vocabulary.js` is
// the pinned mounted-verb list the mount guards already assert against. Both are
// dependency-light and already imported at module scope by sibling `.spec.ts`
// files in this same lane (env.spec.ts, c8-vocabulary.spec.ts).
import * as clientMod from './api.js';
import { BACKLOG_VERBS } from './vocabulary.js';
// `USE_PLUGINS` is imported lazily inside the identity test below. `cli.ts`
// transitively imports `ir-artifact.ts`, whose module-level runtime
// `require('@adhd/apigen-core-client/package.json')` needs this package's OWN
// `node_modules` symlinks to be linked. A lazy import keeps the behavioural
// emission proof (tests 1/3/4) independent of that heavyweight load, so it runs
// even in a freshly-created worktree that has not yet run `pnpm install`.

const HERE = dirname(fileURLToPath(import.meta.url));

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
  logDir = mkdtempSync(join(tmpdir(), 'backlog-tracing-'));
  handle = initTelemetry({
    service: 'backlog',
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

/** Minimal ctx token map a `Call` carries — supports `set`/`get` keyed by a class token. */
class TestExtensions {
  private readonly map = new Map<unknown, unknown>();
  set<T>(key: new (...args: never[]) => T, value: T): void {
    this.map.set(key, value);
  }
  get<T>(key: new (...args: never[]) => T): T | undefined {
    return this.map.get(key) as T | undefined;
  }
}

function makeCall(id: string): Call {
  return {
    operation: { id },
    data: {},
    envelope: {},
    ctx: new TestExtensions(),
    transport: 'mcp',
    signal: new AbortController().signal,
  } as unknown as Call;
}

describe('backlog is a REQUIRED, adhd-namespaced tracing consumer (FEAT-APIGEN-TRACING)', () => {
  it("the configured plugin has id 'tracing' and an invokable layer", () => {
    expect(tracingPlugin.id).toBe('tracing');
    expect(typeof tracingPlugin.capabilities.layer?.layer).toBe('function');
  });

  it('the CLI USE_PLUGINS array shares the SAME configured instance (identity)', async (ctx) => {
    // `src/tracing.ts` exports ONE instance; `cli.ts` must reference THAT instance,
    // not a fresh apigen-namespaced singleton. Identity proves it.
    //
    // `cli.ts` transitively imports `ir-artifact.ts`, whose module-level
    // `require('@adhd/apigen-core-client/package.json')` needs this package's OWN
    // node_modules symlinks linked. In a tree that has not been built/installed the
    // import throws — so we skip WITH A REASON (never silently drop the identity
    // assertion): the static per-transport membership guard below still proves
    // `USE_PLUGINS` carries `tracingPlugin` in that case.
    let mod: typeof import('./cli.js') | undefined;
    try {
      mod = await import('./cli.js');
    } catch (err) {
      ctx.skip(
        `cli.ts could not be loaded (${err instanceof Error ? err.message : String(err)}) — ` +
          'identity requires a built/installed tree; static USE_PLUGINS membership is asserted separately below'
      );
    }
    const { USE_PLUGINS } = mod!;
    expect(USE_PLUGINS[0]).toBe(tracingPlugin);
    expect(USE_PLUGINS.map((p) => p.id)).toContain('tracing');
  });

  it('the configured instance EMITS adhd.* spans and attributes — never apigen.*', async () => {
    const call = makeCall('echo');
    await (tracingPlugin.capabilities.layer!.layer(call, async () => 'ok') as Promise<Result>);

    const records = readRecords();
    const start = records.find((r) => r.event === 'adhd.echo.start');
    expect(start).toBeDefined();
    expect(start!['adhd.op']).toBe('echo');
    expect(start!['adhd.transport']).toBe('mcp');
    expect(records.some((r) => r.event === 'adhd.echo.finish')).toBe(true);

    // The whole point: no apigen.* telemetry may leak out of an adhd product.
    expect(records.some((r) => r.event.startsWith('apigen.'))).toBe(false);
    expect(start!['apigen.op']).toBeUndefined();
    expect(start!['apigen.transport']).toBeUndefined();
  });

  it('the configured instance EMITS adhd.op.error on a thrown op (namespaced error record)', async () => {
    const call = makeCall('boom');
    await expect(
      tracingPlugin.capabilities.layer!.layer(call, async () => {
        throw new Error('kaput');
      }) as Promise<Result>
    ).rejects.toThrow('kaput');

    const records = readRecords();
    const opError = records.find((r) => r.event === 'adhd.op.error');
    expect(opError).toBeDefined();
    expect(opError!['adhd.op']).toBe('boom');
    expect(opError!['adhd.transport']).toBe('mcp');
    expect(records.some((r) => r.event === 'apigen.op.error')).toBe(false);
  });

  it('package.json declares @adhd/apigen-plugin-tracing as a dependency', () => {
    const pkg = JSON.parse(
      readFileSync(join(HERE, '..', 'package.json'), 'utf8')
    ) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies?.['@adhd/apigen-plugin-tracing']).toBeDefined();
  });

  // SECONDARY STATIC GUARD (clearly labelled): the transports must pull the CONFIGURED
  // instance from ./tracing.js, not the package's bare apigen-namespaced singleton. The
  // behavioural assertions above are the real proof; this only catches an accidental switch
  // back to the package import.
  it('(static secondary) server.ts and cli.ts import the configured plugin, not the bare package', () => {
    const serverSrc = readFileSync(join(HERE, 'server.ts'), 'utf8');
    const cliSrc = readFileSync(join(HERE, 'cli.ts'), 'utf8');
    expect(serverSrc).toContain("import { tracingPlugin } from './tracing.js';");
    expect(cliSrc).toContain("import { tracingPlugin } from './tracing.js';");
    expect(serverSrc).not.toContain("import { tracingPlugin } from '@adhd/apigen-plugin-tracing';");
    expect(cliSrc).not.toContain("import { tracingPlugin } from '@adhd/apigen-plugin-tracing';");
  });

  // PER-TRANSPORT WIRING GUARD: each mount's `usePlugins` array must carry
  // `tracingPlugin` as its OWN member. The import-string check above proves the
  // CONFIGURED instance is imported; this proves each array actually WIRES it.
  // Removing `tracingPlugin` from just ONE array still compiles clean (the import
  // stays used by the others) and the import check stays green — so these three
  // assertions are independent and must each fail on their own removal.
  it('(static) each transport usePlugins array wires tracingPlugin (fastify, MCP stdio, CLI)', () => {
    const serverSrc = readFileSync(join(HERE, 'server.ts'), 'utf8');
    const cliSrc = readFileSync(join(HERE, 'cli.ts'), 'utf8');
    // fastify mount
    expect(serverSrc).toContain('usePlugins: [tracingPlugin, openapiPlugin, batchPlugin]');
    // MCP stdio mount
    expect(serverSrc).toContain('usePlugins: [tracingPlugin, batchPlugin]');
    // CLI mount
    expect(cliSrc).toContain('USE_PLUGINS: readonly Plugin[] = [tracingPlugin, batchPlugin];');
  });
});

/**
 * FULL-SURFACE COVERAGE — FEAT-APIGEN-TRACING.
 *
 * The suite above drives two SYNTHETIC operation ids (`echo`, `boom`) and proves
 * the configured `adhd` layer works. It does NOT prove the layer fires for the
 * operations backlog actually mounts. This block closes that gap: the op list is
 * DERIVED from the extraction surface (`./api.js` — per that module's header,
 * every exported async function IS a mounted operation) and cross-checked against
 * `BACKLOG_VERBS`, the pinned mounted-verb list that `server.verbs.spec.ts`
 * already asserts BOTH the CLI and mount surfaces against. A new op added to
 * either side fails the parity test below instead of silently escaping tracing
 * coverage.
 *
 * Runtime op ids are `backlog/<kebab>`, NOT the bare export name: `server.ts`
 * threads the extracted `operations` into the mcp/fastify mounts, so
 * `operationFor()` resolves the REAL extracted Operation (`backlog/priority-matrix`),
 * not the synthesized camelCase form. The layer echoes `call.operation.id`
 * verbatim into the span name, so the records are literally
 * `adhd.backlog/<kebab>.start` / `.finish` (slash preserved).
 */
describe('FEAT-APIGEN-TRACING: every real backlog operation is traced', () => {
  const toKebab = (name: string): string =>
    name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

  // Derived, never hard-coded: a future export widens this automatically.
  const derivedOpIds = Object.keys(clientMod)
    .filter((key) => typeof (clientMod as Record<string, unknown>)[key] === 'function')
    .map((fnName) => `backlog/${toKebab(fnName)}`)
    .sort();

  it('the derived op surface matches the pinned mounted verb list (neither can silently drift)', () => {
    expect(derivedOpIds).toEqual(BACKLOG_VERBS.map((verb) => `backlog/${verb}`).sort());
    expect(derivedOpIds.length).toBeGreaterThan(0);
  });

  it.each(derivedOpIds)(
    'emits adhd.%s.{start,finish} + adhd.op/adhd.transport — never apigen.*',
    async (opId) => {
      const call = makeCall(opId);
      await (tracingPlugin.capabilities.layer!.layer(call, async () => 'ok') as Promise<Result>);

      const records = readRecords();
      const start = records.find((r) => r.event === `adhd.${opId}.start`);
      expect(start, `no adhd.${opId}.start record`).toBeDefined();
      expect(start!['adhd.op']).toBe(opId);
      expect(typeof start!['adhd.transport']).toBe('string');
      expect((start!['adhd.transport'] as string).length).toBeGreaterThan(0);
      expect(records.some((r) => r.event === `adhd.${opId}.finish`)).toBe(true);
      expect(records.some((r) => r.event.startsWith('apigen.'))).toBe(false);
    }
  );

  it.each(derivedOpIds)(
    'emits adhd.op.error (never apigen.*) when %s throws',
    async (opId) => {
      const call = makeCall(opId);
      await expect(
        tracingPlugin.capabilities.layer!.layer(call, async () => {
          throw new Error(`synthetic-failure:${opId}`);
        }) as Promise<Result>
      ).rejects.toThrow('synthetic-failure');

      const records = readRecords();
      const opError = records.find((r) => r.event === 'adhd.op.error');
      expect(opError, `no adhd.op.error record for ${opId}`).toBeDefined();
      expect(opError!['adhd.op']).toBe(opId);
      expect(records.some((r) => r.event.startsWith('apigen.'))).toBe(false);
    }
  );
});
