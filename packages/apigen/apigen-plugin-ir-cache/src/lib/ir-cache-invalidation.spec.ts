/**
 * guards: the runtime IR cache serves a stale or wrong-option operation list (installed-package dependency edits, and call options that change the extracted IR, never invalidating the cached entry)
 * tier: S
 * cites: backlog 39c4e00c (staleness record has deps: [], imported .d.ts edits never invalidate) AC1 editing an imported type file the extractor reported reading invalidates the cache, and an extractor that reports nothing gets a source-only key (REMEDIATION-PLAN R8p, G-2; backlog bbf1f0e3); backlog a66aca5d (computeCacheKey omits extraction-affecting options) AC2 a call that differs only in extractorOptions, namespace, host, versionHint or tsconfig content misses and re-extracts, and an identical call hits
 *
 * Consumer path: a real cache layer (`createIrCacheLayer` over the real single-file backend) wrapped around the real
 * ts-morph `extract()` of a real temp source tree, composed with the real `createExtractInvoker`. The only addition is a
 * call-counting wrapper around the terminal extractor, to prove a HIT never reaches it. No sleeps: edits set an explicit
 * future mtime.
 *
 * red run (the unfixed layer and extractor, 2026-10-14): 5 of 9 failed - installed-tree edit (`expected [ 'a' ] to deeply
 * equal [ 'a', 'b' ]`), staleness deps (`expected [] to include '<types.d.ts>'`), dropFileSegment (`expected [ 'run' ] to deeply
 * equal [ 'api-d', 'run' ]`), namespace/host/versionHint (`expected 'one' to be 'two'`), tsconfig edit (`expected 1 to be 2`).
 * The 4 that passed are controls that already held (ordinary tree, bare Operation[] extractor, deleted dependency, session handle).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createExtractInvoker,
  createExtractionSession,
  extract,
  type ExtractCall,
  type Operation,
} from '@adhd/apigen-core-client';
import { createIrCacheLayer } from './ir-cache-layer';

let root: string;
let cacheFile: string;
let clock = 0;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-cache-inval-'));
  cacheFile = path.join(root, 'cache', 'ir.json');
  clock = Math.floor(Date.now() / 1000) + 3600;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Write `file` and give it a unique, strictly increasing mtime (no sleeping). */
function put(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  clock += 60;
  fs.utimesSync(file, clock, clock);
}

/** A temp package whose entry imports a sibling `.d.ts` the way backlog's installed api.d.ts does. */
function makePackage(base: string, fields: string): { entry: string; types: string } {
  const entry = path.join(base, 'api.d.ts');
  const types = path.join(base, 'types.d.ts');
  put(types, `export interface IIn { ${fields} }\n`);
  put(entry, "import { IIn } from './types.js';\nexport declare function run(input: IIn): Promise<string>;\n");
  return { entry, types };
}

function realExtractor(counter: { n: number }) {
  return async (call: ExtractCall): Promise<Operation[]> => {
    counter.n++;
    const o = call.extractorOptions ?? {};
    return extract({
      sourceFile: call.source,
      namespace: call.namespace,
      dropFileSegment: o['dropFileSegment'] === true,
      tsconfig: typeof o['tsconfig'] === 'string' ? o['tsconfig'] : undefined,
    });
  };
}

function invoker(terminal: (call: ExtractCall) => Promise<Operation[]>) {
  return createExtractInvoker(
    [createIrCacheLayer({ cache: cacheFile, extractorVersion: 'test-1' })],
    terminal
  );
}

const inputProps = (ops: Operation[]): string[] =>
  Object.keys((ops[0].input as { properties: Record<string, unknown> }).properties).flatMap((k) => {
    const inner = (ops[0].input as { properties: Record<string, { properties?: Record<string, unknown> }> })
      .properties[k];
    return inner.properties ? Object.keys(inner.properties) : [k];
  });

describe('39c4e00c: an edit to an imported type file invalidates the runtime cache', () => {
  it('[AC1] entry installed under node_modules: editing the sibling .d.ts it imports re-extracts', async () => {
    const { entry, types } = makePackage(path.join(root, 'node_modules', '@scope', 'pkg'), 'a: string;');
    const calls = { n: 0 };
    const run = invoker(realExtractor(calls));
    const call: ExtractCall = { source: entry, host: 'ts', namespace: 'pkg' };

    expect(inputProps(await run(call))).toEqual(['a']);
    expect(calls.n).toBe(1);
    expect(inputProps(await run(call))).toEqual(['a']);
    expect(calls.n).toBe(1); // unchanged tree: a HIT, the extractor is not reached

    put(types, 'export interface IIn { a: string; b: number }\n');
    expect(inputProps(await run(call))).toEqual(['a', 'b']);
    expect(calls.n).toBe(2);
  });

  it('[AC1] the recorded staleness lists the imported file', async () => {
    const { entry, types } = makePackage(path.join(root, 'node_modules', '@scope', 'pkg'), 'a: string;');
    await invoker(realExtractor({ n: 0 }))({ source: entry, host: 'ts', namespace: 'pkg' });
    const stored = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as {
      staleness: { deps: Array<{ path: string }> };
    };
    expect(stored.staleness.deps.map((d) => fs.realpathSync(d.path))).toContain(fs.realpathSync(types));
  });

  it('[AC1] an ordinary (non node_modules) tree invalidates too', async () => {
    const { entry, types } = makePackage(path.join(root, 'src'), 'a: string;');
    const calls = { n: 0 };
    const run = invoker(realExtractor(calls));
    const call: ExtractCall = { source: entry, host: 'ts', namespace: 'pkg' };
    await run(call);
    put(types, 'export interface IIn { a: string; b: number }\n');
    expect(inputProps(await run(call))).toEqual(['a', 'b']);
    expect(calls.n).toBe(2);
  });

  it('[AC1] an extractor that reports no file list gets a source-only key: an imported-file edit is a HIT and the staleness record has no dependency (G-2: the layer never walks imports)', async () => {
    const { entry, types } = makePackage(path.join(root, 'src'), 'a: string;');
    const calls = { n: 0 };
    const plain = async (call: ExtractCall): Promise<Operation[]> => [...(await realExtractor(calls)(call))];
    const run = invoker(plain);
    const call: ExtractCall = { source: entry, host: 'ts', namespace: 'pkg' };
    await run(call);
    put(types, 'export interface IIn { a: string; b: number }\n');
    expect(inputProps(await run(call))).toEqual(['a']);
    expect(calls.n).toBe(1);
    const stored = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as { staleness: { deps: unknown[] } };
    expect(stored.staleness.deps).toEqual([]);
  });

  it('[AC1] deleting an imported file is a MISS, not a thrown error', async () => {
    const { entry, types } = makePackage(path.join(root, 'src'), 'a: string;');
    const calls = { n: 0 };
    const run = invoker(realExtractor(calls));
    const call: ExtractCall = { source: entry, host: 'ts', namespace: 'pkg' };
    await run(call);
    fs.rmSync(types);
    put(entry, 'export declare function run(input: { a: string; c: boolean }): Promise<string>;\n');
    expect(inputProps(await run(call))).toEqual(['a', 'c']);
    expect(calls.n).toBe(2);
  });
});

describe('a66aca5d: the cache key covers every extraction-affecting input of the call', () => {
  function setup() {
    const { entry } = makePackage(path.join(root, 'src'), 'a: string;');
    const calls = { n: 0 };
    return { entry, calls, run: invoker(realExtractor(calls)) };
  }

  it('[AC2] dropFileSegment in extractorOptions: each setting gets its own result, an identical call hits', async () => {
    const { entry, calls, run } = setup();
    const base = { source: entry, host: 'ts', namespace: 'pkg' };
    const dropped = await run({ ...base, extractorOptions: { dropFileSegment: true } });
    const full = await run({ ...base, extractorOptions: { dropFileSegment: false } });
    expect(dropped[0].path.map((s) => s.raw)).toEqual(['run']);
    expect(full[0].path.map((s) => s.raw)).toEqual(['api-d', 'run']);
    expect(calls.n).toBe(2);
    const again = await run({ ...base, extractorOptions: { dropFileSegment: false } });
    expect(again[0].path.map((s) => s.raw)).toEqual(['api-d', 'run']);
    expect(calls.n).toBe(2);
  });

  it('[AC2] namespace, host and versionHint changes miss', async () => {
    const { entry, calls, run } = setup();
    await run({ source: entry, host: 'ts', namespace: 'one' });
    const two = await run({ source: entry, host: 'ts', namespace: 'two' });
    expect(two[0].namespace.raw).toBe('two');
    await run({ source: entry, host: 'ts', namespace: 'two', versionHint: 'build-7' });
    await run({ source: entry, host: 'ts2', namespace: 'two', versionHint: 'build-7' });
    expect(calls.n).toBe(4);
    await run({ source: entry, host: 'ts2', namespace: 'two', versionHint: 'build-7' });
    expect(calls.n).toBe(4);
  });

  it('[AC2] a run-scoped session handle in extractorOptions does not defeat a HIT', async () => {
    const { entry, calls, run } = setup();
    const call = (): ExtractCall => ({
      source: entry,
      host: 'ts',
      namespace: 'pkg',
      extractorOptions: { session: createExtractionSession() },
    });
    await run(call());
    await run(call());
    expect(calls.n).toBe(1);
  });

  it('[AC2] editing the tsconfig the call names re-extracts', async () => {
    const { entry, calls, run } = setup();
    const tsconfig = path.join(root, 'src', 'tsconfig.json');
    put(tsconfig, JSON.stringify({ compilerOptions: { strict: false } }));
    const call: ExtractCall = { source: entry, host: 'ts', namespace: 'pkg', extractorOptions: { tsconfig } };
    await run(call);
    await run(call);
    expect(calls.n).toBe(1);
    put(tsconfig, JSON.stringify({ compilerOptions: { strict: true } }));
    await run(call);
    expect(calls.n).toBe(2);
  });
});
