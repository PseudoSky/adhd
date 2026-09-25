// index.spec.ts — proves `irCachePlugin.capabilities.extractLayer.createLayer`
// actually honors a caller-supplied `--opt cache=<path>` value, per AGENTS.md
// §7's verification standard (SHOULD_FIX finding: this used to be silently
// ignored — the plugin only ever read `APIGEN_IR_CACHE_FILE`).
//
// REAL components: real temp source file, real `createExtractInvokerFromPlugins`
// composition (the exact function `entrypoint/apigen-cli`'s orchestrator uses),
// real cache files on disk. The only mock is `runExtractor` (the terminal
// extraction step) — a call-counting spy, the external boundary this plugin
// wraps, never the thing under test.
//
// TEETH: two DIFFERENT `--opt cache=<path>` values against the SAME source in
// the SAME process must land in two DIFFERENT files — proving the opts value
// is actually read, not the env-var/default path silently reused regardless
// of what `--opt` says (the exact bug this test exists to catch).
//
// BUG-APIGEN-058 default-path teeth: the bare default (no `--opt cache=`, no
// `APIGEN_IR_CACHE_FILE`) must (a) land under the `@adhd/environment`-
// namespaced global cache root, NOT the invocation cwd, (b) be PER-SOURCE so
// two distinct extraction targets never overwrite each other's entry, and
// (c) HIT on a repeat extraction of the same source. `ADHD_ROOT` points the
// plugin's default at a throwaway temp root so these tests never touch the
// real `~/.adhd`.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createExtractInvokerFromPlugins, type ExtractCall, type Operation } from '@adhd/apigen-core-client';
import { irCachePlugin } from './index';
import { defaultCacheFileName, resolveDefaultCacheFile } from './lib/default-cache-file';

function makeOp(id: string): Operation {
  return {
    id,
    host: 'ts',
    namespace: { raw: 'svc', words: ['svc'] },
    path: [{ raw: 'doThing', words: ['do', 'thing'] }],
    kind: 'action',
    async: true,
    streaming: false,
    safe: false,
    input: { type: 'object', properties: {}, required: [] },
    output: { type: 'object' },
    envelope: {},
    typeText: null,
  };
}

/** vitest 1.x has no `expect.poll` — bounded-deadline poll for a real observable effect. */
async function waitUntil(check: () => boolean): Promise<void> {
  await vi.waitFor(
    () => {
      expect(check()).toBe(true);
    },
    { timeout: 2000, interval: 10 }
  );
}

let dir: string;
let adhdRootDir: string;
let sourcePath: string;
let call: ExtractCall;

/**
 * The pre-BUG-APIGEN-058 default: a cwd-relative cache file the plugin must
 * never write. Scoped to a caller-supplied cwd so the assertion below runs
 * against THIS test's own throwaway cwd, never the shared repo cwd.
 */
const oldCwdDefaultPath = (cwd: string): string =>
  path.join(cwd, 'tmp', 'apigen', 'ir-cache', 'default.ir.json');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-ir-cache-index-spec-'));
  adhdRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-ir-cache-adhdroot-spec-'));
  sourcePath = path.join(dir, 'entry.ts');
  fs.writeFileSync(sourcePath, `export async function doThing(): Promise<void> {}\n`);
  call = { source: sourcePath, host: 'ts', namespace: 'svc', extractorOptions: {} };
  delete process.env['APIGEN_IR_CACHE_FILE'];
  process.env['ADHD_ROOT'] = adhdRootDir;

  // HERMETIC cwd (bug ad00d505). Every test runs as if invoked from its OWN
  // throwaway dir, so the "never writes into the invocation cwd" assertion is
  // scoped to a directory this test owns and removes in `afterEach` — never the
  // shared, gitignored `tmp/apigen/` scratch a previous run may have left in the
  // real repo cwd. Without this, any leftover `cwd/tmp/apigen/` reds the spec
  // regardless of the plugin's behaviour (the non-hermetic failure this fixes).
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['ADHD_ROOT'];
  delete process.env['APIGEN_IR_CACHE_FILE'];
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(adhdRootDir, { recursive: true, force: true });
});

describe('irCachePlugin.capabilities.extractLayer.createLayer — --opt cache=<path> is honored', () => {
  it('a runExtractor spy runs on MISS, and the entry is written to the --opt cache path (not the default)', async () => {
    const cachePathA = path.join(dir, 'a.ir.json');
    let calls = 0;
    const runExtractor = async (): Promise<Operation[]> => {
      calls++;
      return [makeOp('svc/doThing')];
    };

    const invoke = createExtractInvokerFromPlugins([irCachePlugin], runExtractor, {
      cache: cachePathA,
    });

    await invoke(call);
    expect(calls).toBe(1);
    // Writes are fire-and-forget — poll for the real observable effect.
    await waitUntil(() => fs.existsSync(cachePathA));

    // The default location must NOT have been written either.
    expect(fs.existsSync(resolveDefaultCacheFile(call))).toBe(false);
  });

  it('two DIFFERENT --opt cache=<path> values against the same source produce two DIFFERENT cache files, each independently a HIT on repeat', async () => {
    const cachePathA = path.join(dir, 'a.ir.json');
    const cachePathB = path.join(dir, 'b.ir.json');
    let calls = 0;
    const runExtractor = async (): Promise<Operation[]> => {
      calls++;
      return [makeOp('svc/doThing')];
    };

    const invokeA = createExtractInvokerFromPlugins([irCachePlugin], runExtractor, { cache: cachePathA });
    const invokeB = createExtractInvokerFromPlugins([irCachePlugin], runExtractor, { cache: cachePathB });

    await invokeA(call); // MISS #1 → writes cachePathA
    await invokeB(call); // MISS #2 (different configured file — must NOT reuse cachePathA) → writes cachePathB
    expect(calls).toBe(2);

    await waitUntil(() => fs.existsSync(cachePathA) && fs.existsSync(cachePathB));

    // Repeat calls through EACH configured path are HITs (extractor not re-run).
    await invokeA(call);
    await invokeB(call);
    expect(calls).toBe(2);
  });

  it('opts.extractorVersion is honored too — a different override changes the stored extractorVersion', async () => {
    const cachePath = path.join(dir, 'c.ir.json');
    const runExtractor = async (): Promise<Operation[]> => [makeOp('svc/doThing')];

    const invoke = createExtractInvokerFromPlugins([irCachePlugin], runExtractor, {
      cache: cachePath,
      extractorVersion: 'custom-version@9.9.9',
    });
    await invoke(call);

    await waitUntil(() => fs.existsSync(cachePath));
    const entry = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as { extractorVersion: string };
    expect(entry.extractorVersion).toBe('custom-version@9.9.9');
  });

  it('no --opt at all (empty opts bag) falls back to the env-var/default middleware — unchanged pre-fix behaviour', async () => {
    // Point the default at a temp path (never the real repo tmp/) so this
    // test can't leak a stray file into the working tree.
    process.env['APIGEN_IR_CACHE_FILE'] = path.join(dir, 'default.ir.json');
    const runExtractor = async (): Promise<Operation[]> => [makeOp('svc/doThing')];
    const invoke = createExtractInvokerFromPlugins([irCachePlugin], runExtractor, {});
    // Must not throw and must still return real operations via the default path.
    const ops = await invoke(call);
    expect(ops).toHaveLength(1);
  });
});

describe('irCachePlugin default path — machine-global, environment-namespaced, per-source (BUG-APIGEN-058)', () => {
  it('a bare invocation (no --opt cache=, no APIGEN_IR_CACHE_FILE) caches under the @adhd/environment-namespaced root — NEVER the invocation cwd', async () => {
    let calls = 0;
    const runExtractor = async (): Promise<Operation[]> => {
      calls++;
      return [makeOp('svc/doThing')];
    };

    const invoke = createExtractInvokerFromPlugins([irCachePlugin], runExtractor, {});
    await invoke(call); // MISS → writes through to the default file
    expect(calls).toBe(1);

    const defaultPath = resolveDefaultCacheFile(call);
    // Namespaced under the (redirected) adhd root, not the cwd.
    expect(defaultPath.startsWith(path.join(adhdRootDir, 'apigen', 'default', 'cache'))).toBe(true);
    await waitUntil(() => fs.existsSync(defaultPath));

    // No cache artifact may appear in the invocation cwd. `process.cwd()` is
    // mocked to THIS test's own throwaway dir (beforeEach), so this is hermetic:
    // it fires only if the plugin genuinely writes cwd-relative, never because a
    // prior run left a `tmp/apigen/` scratch dir in the real repo cwd.
    expect(fs.existsSync(oldCwdDefaultPath(dir))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'tmp', 'apigen'))).toBe(false);
  });

  it('a repeat extraction of the SAME source HITs its own default file — extractor not re-run (cross-invocation reuse)', async () => {
    let calls = 0;
    const runExtractor = async (): Promise<Operation[]> => {
      calls++;
      return [makeOp('svc/doThing')];
    };

    const invoke = createExtractInvokerFromPlugins([irCachePlugin], runExtractor, {});
    await invoke(call);
    await waitUntil(() => fs.existsSync(resolveDefaultCacheFile(call)));
    expect(calls).toBe(1);

    // A SECOND invoker (a fresh "process" in the reuse story) against the
    // same source answers from the same default file — no re-extraction.
    const invokeAgain = createExtractInvokerFromPlugins([irCachePlugin], runExtractor, {});
    await invokeAgain(call);
    expect(calls).toBe(1);
  });

  it('two DIFFERENT sources through the bare default get two DIFFERENT files — they cannot overwrite each other', async () => {
    const otherSource = path.join(dir, 'other.ts');
    fs.writeFileSync(otherSource, `export async function other(): Promise<void> {}\n`);
    const callB: ExtractCall = { source: otherSource, host: 'ts', namespace: 'svc', extractorOptions: {} };
    let calls = 0;
    const runExtractor = async (): Promise<Operation[]> => {
      calls++;
      return [makeOp('svc/doThing')];
    };

    const invoke = createExtractInvokerFromPlugins([irCachePlugin], runExtractor, {});
    await invoke(call);
    await invoke(callB);
    expect(calls).toBe(2);

    const pathA = resolveDefaultCacheFile(call);
    const pathB = resolveDefaultCacheFile(callB);
    expect(pathA).not.toBe(pathB);
    await waitUntil(() => fs.existsSync(pathA) && fs.existsSync(pathB));

    // Each repeat HITs its OWN file — no cross-contamination.
    await invoke(call);
    await invoke(callB);
    expect(calls).toBe(2);
  });

  it('defaultCacheFileName is stable per extraction identity and distinct across identities', () => {
    const sameSource = { ...call, source: sourcePath };
    expect(defaultCacheFileName(call)).toBe(defaultCacheFileName(sameSource));
    const otherSource = { ...call, source: path.join(dir, 'other.ts') };
    expect(defaultCacheFileName(otherSource)).not.toBe(defaultCacheFileName(call));
    const otherNs = { ...call, namespace: 'other-ns' };
    expect(defaultCacheFileName(otherNs)).not.toBe(defaultCacheFileName(call));
    const otherHost = { ...call, host: 'py' };
    expect(defaultCacheFileName(otherHost)).not.toBe(defaultCacheFileName(call));
  });
});
