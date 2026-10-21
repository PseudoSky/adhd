// guards: the argv and mcp translators are not registered with the core extractor registry, do not return IR (host argv or mcp, binding bin:<base> or mcp:<name>), do not report the files they read, start a process where extraction must not, or leak the upstream they opened
// tier: S
// cites: policy-core REMEDIATION-PLAN T-R7 AC1 (R7b, G-2), SOURCE-MODEL-GAP-ANALYSIS section 3e
// teeth: red: npx vitest run src/test/sources-extractors.spec.ts -> exit 1; extractors.ts mcp withSourceFiles(operations, []) -> ['x'] fails "an MCP upstream reads no local file: it reports an empty dependency list"

/* eslint-disable @typescript-eslint/no-non-null-assertion -- specs index arrays/maps the test has just arranged; a miss would fail the very next assertion */
// registerSourceExtractors, driven the way the orchestration entry drives it: a registry from the
// core `createExtractorRegistry()`, a classification from the core `resolveSourceReference`, and
// the core `extractSourceEntry` for the end-to-end rows; the extractor itself is called directly
// where an extractor option (`args`, `name`, ...) has to travel in the `ExtractCall`. The upstream
// is the in-process stub behind a fake launcher; no process is spawned.

import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@adhd/apigen-base-errors';
import {
  createExtractorRegistry,
  extractSourceEntry,
  resolveSourceReference,
  sourceFilesOf,
} from '@adhd/apigen-core-client';
import type { ExtractCall, ExtractorRegistry, ISourceResolution, TranslatorId } from '@adhd/apigen-core-client';
import { isGatewayError, registerSourceExtractors } from '../index';
import { createFakeLauncher } from './helpers/fake-launcher';
import { flush } from './helpers/flush';
import { createStubMcpUpstream } from './helpers/stub-mcp-upstream';
import type { IStubOptions } from './helpers/stub-mcp-upstream';

const OBJECT_SCHEMA = { type: 'object', properties: { path: { type: 'string' } } };
const TOOLS: IStubOptions['tools'] = [
  { name: 'read_file', title: 'Read', description: 'Reads', inputSchema: OBJECT_SCHEMA, annotations: { readOnlyHint: true } },
  { name: 'write_file', inputSchema: OBJECT_SCHEMA },
];

function classify(reference: string, translator?: TranslatorId): ISourceResolution {
  const result = resolveSourceReference(reference);
  if (!result.ok) throw new Error(result.error.message);
  return translator === undefined ? result.value : { ...result.value, translator };
}

function entry(
  registry: ExtractorRegistry,
  resolution: ISourceResolution,
  namespace?: string
): ReturnType<typeof extractSourceEntry> {
  return extractSourceEntry({
    reference: resolution.reference,
    resolution,
    ...(namespace !== undefined ? { namespace } : {}),
    usePlugins: [],
    extractLayerOptions: {},
    registry,
  });
}

function mcpCall(overrides: Partial<ExtractCall> = {}): ExtractCall {
  return { source: 'node', host: 'mcp', extractorOptions: {}, ...overrides };
}

function extractor(registry: ExtractorRegistry, host: string) {
  const found = registry.get(host);
  if (!found) throw new Error(`no ${host} extractor registered`);
  return found;
}

async function rejectionOf(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    return e as ApiError;
  }
  throw new Error('expected a rejection');
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Feature: the gateway registers its translators with the core registry', () => {
  it('@register argv and mcp join the TypeScript extractor; hosts are listed in registration order', () => {
    const registry = createExtractorRegistry();
    expect(registry.hosts()).toEqual(['ts']);
    registerSourceExtractors(registry, { launcher: createFakeLauncher() });
    expect(registry.hosts()).toEqual(['ts', 'argv', 'mcp']);
    expect(registry.get('argv')).toBeTypeOf('function');
    expect(registry.get('mcp')).toBeTypeOf('function');
  });

  it('@register the ts extractor is left alone', () => {
    const registry = createExtractorRegistry();
    const ts = registry.get('ts');
    registerSourceExtractors(registry);
    expect(registry.get('ts')).toBe(ts);
  });

  it('@register registering twice replaces, never duplicates', () => {
    const registry = createExtractorRegistry();
    registerSourceExtractors(registry);
    registerSourceExtractors(registry);
    expect(registry.hosts()).toEqual(['ts', 'argv', 'mcp']);
  });
});

describe('Feature: the argv translator returns IR and reports its dependency, starting nothing', () => {
  it('@T-R7 a bare command is one bin/<base> operation: host argv, binding bin:<base>, no file read', async () => {
    const launcher = createFakeLauncher();
    const registry = createExtractorRegistry();
    registerSourceExtractors(registry, { launcher });
    const result = await entry(registry, classify('bin:touch', 'argv'));
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]).toMatchObject({ id: 'bin/touch', host: 'argv', binding: 'bin:touch', safe: false });
    expect(result.files).toEqual([]);
    expect(launcher.started).toHaveLength(0);
  });

  it('@T-R7 the dependency is REPORTED even when empty: the result carries sourceFiles [] (no walk by the cache)', async () => {
    const registry = createExtractorRegistry();
    registerSourceExtractors(registry);
    const ops = await extractor(registry, 'argv')({ source: 'touch', host: 'argv' });
    expect(sourceFilesOf(ops)).toEqual([]);
  });

  it('@T-R7 an absolute executable path is its own dependency; a relative one is resolved against the cwd', async () => {
    const registry = createExtractorRegistry();
    registerSourceExtractors(registry);
    const run = extractor(registry, 'argv');
    expect(sourceFilesOf(await run({ source: '/opt/tools/runner.js', host: 'argv' }))).toEqual(['/opt/tools/runner.js']);
    expect(sourceFilesOf(await run({ source: './tools/run.sh', host: 'argv' }))).toEqual([path.resolve('./tools/run.sh')]);
    const viaEntry = await entry(registry, classify('bin:/opt/tools/runner.js', 'argv'));
    expect(viaEntry.files).toEqual(['/opt/tools/runner.js']);
    expect(viaEntry.operations[0]).toMatchObject({ id: 'bin/runner', binding: 'bin:runner' });
  });

  it('@T-R7 an empty source is ApiError invalid_argument', async () => {
    const registry = createExtractorRegistry();
    registerSourceExtractors(registry);
    const err = await rejectionOf(extractor(registry, 'argv')({ source: '', host: 'argv' }));
    expect(err).toMatchObject({ code: 'invalid_argument' });
    expect(err.message).toContain('needs an executable source');
  });

  it('@T-R7 extraction is deterministic: the same call returns the same IR (what a cache key assumes)', async () => {
    const registry = createExtractorRegistry();
    registerSourceExtractors(registry);
    const run = extractor(registry, 'argv');
    const first = await run({ source: 'touch', host: 'argv' });
    const second = await run({ source: 'touch', host: 'argv' });
    expect(JSON.parse(JSON.stringify(first))).toEqual(JSON.parse(JSON.stringify(second)));
  });
});

describe('Feature: the mcp translator lists the upstream once and returns IR', () => {
  it('@T-R7 the stub upstream exposing tools, extracted as source notes, yields host mcp, binding mcp:notes and copied tool metadata', async () => {
    const stub = createStubMcpUpstream({ tools: TOOLS });
    const registry = createExtractorRegistry();
    registerSourceExtractors(registry, { launcher: stub.launcher, onWarn: () => undefined });
    const result = await entry(registry, classify('bin:node', 'mcp'), 'notes');
    expect(result.operations.map((o) => o.id)).toEqual(['notes/read-file', 'notes/write-file']);
    expect(result.operations[0]).toMatchObject({
      host: 'mcp',
      binding: 'mcp:notes',
      safe: false,
      tool: { title: 'Read', description: 'Reads', annotations: { readOnlyHint: true } },
    });
    expect(JSON.stringify(result.operations)).not.toContain('liar');
  });

  it('@T-R7 an MCP upstream reads no local file: it reports an empty dependency list', async () => {
    const stub = createStubMcpUpstream({ tools: TOOLS });
    const registry = createExtractorRegistry();
    registerSourceExtractors(registry, { launcher: stub.launcher });
    const ops = await extractor(registry, 'mcp')(mcpCall({ namespace: 'n' }));
    expect(sourceFilesOf(ops)).toEqual([]);
  });

  it('@T-R7 extraction is not a connection: the upstream is started once, listed, and disposed before the result returns', async () => {
    const stub = createStubMcpUpstream({ tools: TOOLS });
    const registry = createExtractorRegistry();
    registerSourceExtractors(registry, { launcher: stub.launcher });
    await extractor(registry, 'mcp')(mcpCall({ namespace: 'n' }));
    expect(stub.started).toHaveLength(1);
    expect(stub.proc().stdinEnded).toBe(true);
    expect(stub.proc().kills).toEqual(['SIGTERM']);
    expect(stub.proc().hasExited).toBe(true);
    expect(stub.calls).toEqual([]); // no tool was called
  });

  it('@T-R7 the process is started from the call: command is the source, args/cwd/env come from extractorOptions', async () => {
    const stub = createStubMcpUpstream({ tools: [] });
    const registry = createExtractorRegistry();
    registerSourceExtractors(registry, { launcher: stub.launcher });
    await extractor(registry, 'mcp')(
      mcpCall({
        source: '/opt/bin/notes-server',
        extractorOptions: { args: ['--stdio', '--verbose'], cwd: '/work', env: { TOKEN: 'x' } },
      })
    );
    expect(stub.started).toEqual([
      { command: '/opt/bin/notes-server', args: ['--stdio', '--verbose'], cwd: '/work', env: { TOKEN: 'x' } },
    ]);
  });

  it('@T-R7 defaults: no args, the process cwd, no env key', async () => {
    const stub = createStubMcpUpstream({ tools: [] });
    const registry = createExtractorRegistry();
    registerSourceExtractors(registry, { launcher: stub.launcher });
    await extractor(registry, 'mcp')(mcpCall());
    expect(stub.started).toEqual([{ command: 'node', args: [], cwd: process.cwd() }]);
  });

  it('@G2 the source name is options.name, then call.namespace, then the command basename; sanitised, never the upstream\'s', async () => {
    const run = async (call: Partial<ExtractCall>) => {
      const stub = createStubMcpUpstream({ tools: [{ name: 't', inputSchema: OBJECT_SCHEMA }] });
      const registry = createExtractorRegistry();
      registerSourceExtractors(registry, { launcher: stub.launcher });
      const ops = await extractor(registry, 'mcp')(mcpCall(call));
      return ops[0]!;
    };
    const byName = await run({ namespace: 'ignored', extractorOptions: { name: 'Files' } });
    expect([byName.id, byName.binding]).toEqual(['files/t', 'mcp:files']);
    const byNamespace = await run({ namespace: 'Notes App' });
    expect([byNamespace.id, byNamespace.binding]).toEqual(['notes-app/t', 'mcp:notes-app']);
    const byCommand = await run({ source: '/opt/My_Server.JS' });
    expect([byCommand.id, byCommand.binding]).toEqual(['my-server/t', 'mcp:my_server']);
    const fallback = await run({ source: '...', extractorOptions: { name: '!!!' } });
    expect(fallback.binding).toBe('mcp:server');
  });

  it('@G6 a tool the translator skips is reported through onWarn, one line each, and the rest are extracted', async () => {
    const stub = createStubMcpUpstream({
      tools: [
        { name: 'ok', inputSchema: OBJECT_SCHEMA },
        { name: 'bad', inputSchema: { type: 'string' } },
      ],
    });
    const warnings: string[] = [];
    const registry = createExtractorRegistry();
    registerSourceExtractors(registry, { launcher: stub.launcher, onWarn: (l) => warnings.push(l) });
    const ops = await extractor(registry, 'mcp')(mcpCall({ namespace: 's' }));
    expect(ops.map((o) => o.id)).toEqual(['s/ok']);
    expect(warnings).toEqual(['apigen-gateway: skipping upstream tool "bad" of s: non-object inputSchema']);
  });

  it('@G6 with no onWarn the default reports on stderr, one line per skip', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stub = createStubMcpUpstream({ tools: [{ name: 'bad', inputSchema: { type: 'string' } }] });
    const registry = createExtractorRegistry();
    registerSourceExtractors(registry, { launcher: stub.launcher });
    await extractor(registry, 'mcp')(mcpCall());
    expect(write).toHaveBeenCalledTimes(1);
    expect(String(write.mock.calls[0]![0])).toMatch(/skipping upstream tool "bad" of node: non-object inputSchema\n$/);
  });

  it('@T-R7 a handshake failure is the gateway unavailable error for mcp:<name>; the upstream is killed, nothing leaks', async () => {
    const stub = createStubMcpUpstream({ initialize: 'error', tools: TOOLS });
    const registry = createExtractorRegistry();
    registerSourceExtractors(registry, { launcher: stub.launcher });
    const err = await rejectionOf(extractor(registry, 'mcp')(mcpCall({ namespace: 'notes' })));
    expect(isGatewayError(err)).toBe(true);
    expect(err.details).toMatchObject({ gatewayCode: 'unavailable', host: 'mcp:notes', operationId: '(start)' });
    expect(stub.proc().kills).toContain('SIGTERM');
    expect(stub.proc().hasExited).toBe(true);
  });

  it('@T-R7 handshakeTimeoutMs travels in extractorOptions and bounds initialize', async () => {
    vi.useFakeTimers();
    const stub = createStubMcpUpstream({ initialize: 'silent', tools: [] });
    const registry = createExtractorRegistry();
    registerSourceExtractors(registry, { launcher: stub.launcher });
    const pending = rejectionOf(extractor(registry, 'mcp')(mcpCall({ extractorOptions: { handshakeTimeoutMs: 250 } })));
    await vi.advanceTimersByTimeAsync(249);
    expect(stub.proc().kills).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    const err = await pending;
    expect(isGatewayError(err)).toBe(true);
    expect(stub.proc().kills).toContain('SIGTERM');
  });

  it('@T-R7 a launcher that cannot start the command is unavailable for the binding', async () => {
    const stub = createStubMcpUpstream({ failStart: true, tools: [] });
    const registry = createExtractorRegistry();
    registerSourceExtractors(registry, { launcher: stub.launcher });
    const err = await rejectionOf(extractor(registry, 'mcp')(mcpCall({ source: 'nope', namespace: 'x' })));
    expect(err.details).toMatchObject({ gatewayCode: 'unavailable', host: 'mcp:x' });
  });

  it('@T-R7 an empty source is ApiError invalid_argument and nothing starts', async () => {
    const stub = createStubMcpUpstream({ tools: [] });
    const registry = createExtractorRegistry();
    registerSourceExtractors(registry, { launcher: stub.launcher });
    const err = await rejectionOf(extractor(registry, 'mcp')(mcpCall({ source: '' })));
    expect(err).toMatchObject({ code: 'invalid_argument' });
    expect(stub.started).toHaveLength(0);
  });

  it.each([
    ['args', ['ok', 5], 'an array of strings'],
    ['args', 'not-an-array', 'an array of strings'],
    ['cwd', 7, 'a string'],
    ['env', { A: 1 }, 'a string-to-string object'],
    ['env', ['A=1'], 'a string-to-string object'],
    ['name', 3, 'a string'],
    ['handshakeTimeoutMs', 0, 'a positive number'],
    ['handshakeTimeoutMs', -5, 'a positive number'],
    ['handshakeTimeoutMs', '250', 'a positive number'],
    ['handshakeTimeoutMs', Number.POSITIVE_INFINITY, 'a positive number'],
  ])('@T-R7 a malformed option %s=%j is ApiError invalid_argument naming it; nothing starts', async (key, value, expected) => {
    const stub = createStubMcpUpstream({ tools: [] });
    const registry = createExtractorRegistry();
    registerSourceExtractors(registry, { launcher: stub.launcher });
    const err = await rejectionOf(extractor(registry, 'mcp')(mcpCall({ extractorOptions: { [key]: value } })));
    expect(err).toMatchObject({ code: 'invalid_argument' });
    expect(err.message).toContain(JSON.stringify(key));
    expect(err.message).toContain(expected);
    expect(stub.started).toHaveLength(0);
  });

  it('@T-R7 two upstreams extracted through one registry stay separate sources (distinct ids and bindings)', async () => {
    const a = createStubMcpUpstream({ tools: [{ name: 'add', inputSchema: OBJECT_SCHEMA }] });
    const b = createStubMcpUpstream({ tools: [{ name: 'add', inputSchema: OBJECT_SCHEMA }] });
    const regA = createExtractorRegistry();
    const regB = createExtractorRegistry();
    registerSourceExtractors(regA, { launcher: a.launcher });
    registerSourceExtractors(regB, { launcher: b.launcher });
    const [opsA, opsB] = await Promise.all([
      extractor(regA, 'mcp')(mcpCall({ namespace: 'a' })),
      extractor(regB, 'mcp')(mcpCall({ namespace: 'b' })),
    ]);
    await flush();
    expect([opsA[0]!.id, opsA[0]!.binding]).toEqual(['a/add', 'mcp:a']);
    expect([opsB[0]!.id, opsB[0]!.binding]).toEqual(['b/add', 'mcp:b']);
    expect(opsA[0]!.host).toBe(opsB[0]!.host); // both producers are 'mcp': only the binding separates them
  });
});
