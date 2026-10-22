/**
 * guards: the IR cache, driven through the one core-client extraction entry (`extractSourceEntry`), serves a stale or wrong-option result: a call differing only in dropFileSegment hits the other call's entry, an edit to a file the extractor read (an import, or a base tsconfig in the `extends` chain) does not invalidate, or the cache walks imports itself for an extractor that reported nothing
 * tier: S
 * cites: REMEDIATION-PLAN T-R8p (policy-core, R8p) AC1 dropFileSegment-only difference is a MISS (backlog a66aca5d); AC2 an extractor that reports no sourceFiles gets a source-only key and a source-only staleness record (backlog bbf1f0e3 / disposition 15e); AC3 editing a base tsconfig in the extends chain re-extracts (backlog 9025607e); AC4 an edit to an imported file re-extracts (backlog 39c4e00c regression)
 * tags: regression:a66aca5d, regression:9025607e, regression:39c4e00c, contract
 * teeth: red: npx vitest run --config packages/apigen/apigen-plugin-ir-cache/vite.config.ts src/lib/ir-cache-entry.spec.ts -> exit 1 under production negative controls (each restored with git restore): AC1 (callIdentity drops dropFileSegment) `expected [ 'run' ] to deeply equal [ 'api', 'run' ]`; AC2 (the layer adds an import to an unreported dependency set) `expected 2 to be 1`; AC3 (TS extractor stops reporting the extends chain) `expected [ ... ] to include '<base.json>'`; AC4 (reported files dropped from the dependency set) `expected 1 to be 2`
 *
 * Consumer path: the real `extractSourceEntry`, the real `irCachePlugin` extractLayer (`createLayer({cache})`, the same path `--use ir-cache --opt cache=<file>` takes), the real single-file backend and the real ts-morph TS extractor over a real temp tree. The only addition is a call-counting wrapper registered under `ts` that delegates untouched to the registry's real `ts` extractor, to prove a HIT never reaches the extractor. No sleeps: edits set an explicit, strictly increasing future mtime.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createExtractorRegistry,
  extractSourceEntry,
  resolveSourceReference,
  type ExtractCall,
  type ExtractorRegistry,
  type IExtractionResult,
  type Operation,
} from '@adhd/apigen-core-client';
import { irCachePlugin } from '../index';

const SCRATCH_ROOT = path.resolve(__dirname, '../../../../../tmp/apigen-plugin-ir-cache');

let root: string;
let cacheFile: string;
let clock = 0;
let seq = 0;

beforeEach(() => {
  fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
  root = fs.mkdtempSync(path.join(SCRATCH_ROOT, `entry-${String(seq++)}-`));
  cacheFile = path.join(root, 'cache', 'ir.json');
  clock = Math.floor(Date.now() / 1000) + 3600;
});

afterEach(() => {
  // Guarded: only ever remove a directory created under the scratch root.
  const resolved = path.resolve(root);
  if (!resolved.startsWith(SCRATCH_ROOT + path.sep)) {
    throw new Error(`refusing to remove ${resolved}: outside ${SCRATCH_ROOT}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
});

/** Write `file` and give it a unique, strictly increasing mtime (no sleeping). */
function put(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  clock += 60;
  fs.utimesSync(file, clock, clock);
}

/** A source `api.ts` that imports a sibling `types.ts`; a local tsconfig so ts-morph never reads the repo's. */
function makeTree(): { entry: string; types: string; tsconfig: string } {
  const entry = path.join(root, 'src', 'api.ts');
  const types = path.join(root, 'src', 'types.ts');
  const tsconfig = path.join(root, 'src', 'tsconfig.json');
  put(types, 'export interface IIn { a: string }\n');
  put(entry, "import { IIn } from './types';\nexport async function run(input: IIn): Promise<string> { return input.a; }\n");
  put(tsconfig, JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'commonjs' } }));
  return { entry, types, tsconfig };
}

interface IHarness {
  registry: ExtractorRegistry;
  calls: { n: number };
  extract: (
    entry: string,
    extra?: { dropFileSegment?: boolean; tsconfig?: string }
  ) => Promise<IExtractionResult>;
}

/**
 * A fresh registry whose `ts` extractor counts calls and delegates to the real one.
 * With `reportNothing`, the result is returned as a bare `Operation[]` (no `sourceFiles`).
 */
function harness(opts: { reportNothing?: boolean } = {}): IHarness {
  const calls = { n: 0 };
  const registry = createExtractorRegistry();
  const realTs = registry.get('ts');
  if (realTs === undefined) throw new Error('no ts extractor registered');
  registry.register('ts', async (call: ExtractCall) => {
    calls.n++;
    const result = await realTs(call);
    return opts.reportNothing === true ? ([...result] as Operation[]) : result;
  });
  return {
    registry,
    calls,
    extract: async (entry, extra = {}) => {
      const resolved = resolveSourceReference(entry);
      if (!resolved.ok) throw new Error(resolved.error.message);
      return extractSourceEntry({
        reference: entry,
        resolution: resolved.value,
        namespace: 'pkg',
        tsconfig: extra.tsconfig,
        dropFileSegment: extra.dropFileSegment,
        usePlugins: [irCachePlugin as never],
        extractLayerOptions: { cache: cacheFile, extractorVersion: 'entry-spec-1' },
        registry,
      });
    },
  };
}

const rawPath = (ops: Operation[]): string[] => ops[0].path.map((s) => s.raw);

describe('T-R8p AC1 (a66aca5d): calls differing only in dropFileSegment, through the entry', () => {
  it('a different dropFileSegment is a MISS with the other path shape; an identical call hits', async () => {
    const { entry } = makeTree();
    const h = harness();
    const dropped = await h.extract(entry, { dropFileSegment: true });
    expect(rawPath(dropped.operations)).toEqual(['run']);
    const full = await h.extract(entry, { dropFileSegment: false });
    expect(rawPath(full.operations)).toEqual(['api', 'run']);
    expect(h.calls.n).toBe(2);
    const again = await h.extract(entry, { dropFileSegment: false });
    expect(rawPath(again.operations)).toEqual(['api', 'run']);
    expect(h.calls.n).toBe(2);
  });
});

describe('T-R8p AC4 (39c4e00c): an imported file edit, through the entry', () => {
  it('re-extracts after the imported file changes; an unchanged tree hits', async () => {
    const { entry, types, tsconfig } = makeTree();
    const h = harness();
    const first = await h.extract(entry, { tsconfig });
    expect(first.files.map((f) => path.basename(f))).toContain('types.ts');
    await h.extract(entry, { tsconfig });
    expect(h.calls.n).toBe(1);
    put(types, 'export interface IIn { a: string; b: number }\n');
    const after = await h.extract(entry, { tsconfig });
    expect(h.calls.n).toBe(2);
    const props = (after.operations[0].input as { properties: Record<string, { properties?: Record<string, unknown> }> })
      .properties;
    expect(JSON.stringify(props)).toContain('"b"');
  });
});

describe('T-R8p AC3 (9025607e): the tsconfig extends chain invalidates', () => {
  it('editing only the BASE tsconfig a named tsconfig extends re-extracts; touching it without a content change does not', async () => {
    const { entry } = makeTree();
    const base = path.join(root, 'src', 'base.json');
    const child = path.join(root, 'src', 'child.json');
    put(base, JSON.stringify({ compilerOptions: { strict: false, target: 'ES2022', module: 'commonjs' } }));
    put(child, JSON.stringify({ extends: './base.json' }));
    const h = harness();
    const first = await h.extract(entry, { tsconfig: child });
    expect(first.files.map((f) => fs.realpathSync(f))).toContain(fs.realpathSync(base));
    await h.extract(entry, { tsconfig: child });
    expect(h.calls.n).toBe(1);
    put(base, JSON.stringify({ compilerOptions: { strict: false, target: 'ES2022', module: 'commonjs' } }));
    await h.extract(entry, { tsconfig: child });
    expect(h.calls.n).toBe(1); // same bytes, newer mtime: still a HIT
    put(base, JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'commonjs' } }));
    await h.extract(entry, { tsconfig: child });
    expect(h.calls.n).toBe(2);
  });
});

describe('T-R8p AC2 (bbf1f0e3 / 15e): an extractor that reports nothing gets a source-only key', () => {
  it('an imported-file edit is still a HIT, and the staleness record lists no dependency', async () => {
    const { entry, types, tsconfig } = makeTree();
    const h = harness({ reportNothing: true });
    const first = await h.extract(entry, { tsconfig });
    expect(first.files).toEqual([]);
    put(types, 'export interface IIn { a: string; b: number }\n');
    await h.extract(entry, { tsconfig });
    expect(h.calls.n).toBe(1);
    const stored = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as {
      staleness: { source: { path: string }; deps: Array<{ path: string }> };
    };
    expect(stored.staleness.source.path).toBe(entry);
    expect(stored.staleness.deps.map((d) => d.path)).toEqual([tsconfig]); // the named tsconfig only, never an import
  });

  it('editing the source itself is still a MISS', async () => {
    const { entry, tsconfig } = makeTree();
    const h = harness({ reportNothing: true });
    await h.extract(entry, { tsconfig });
    put(entry, "export async function run2(input: { a: string }): Promise<string> { return input.a; }\n");
    const after = await h.extract(entry, { tsconfig });
    expect(h.calls.n).toBe(2);
    expect(rawPath(after.operations)).toEqual(['api', 'run2']);
  });
});
