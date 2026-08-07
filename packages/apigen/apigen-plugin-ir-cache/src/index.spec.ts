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

import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createExtractInvokerFromPlugins, type ExtractCall, type Operation } from '@adhd/apigen-core-client';
import { irCachePlugin } from './index';

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
let sourcePath: string;
let call: ExtractCall;

const REAL_DEFAULT_PATH = path.join(process.cwd(), 'tmp', 'apigen', 'ir-cache', 'default.ir.json');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-ir-cache-index-spec-'));
  sourcePath = path.join(dir, 'entry.ts');
  fs.writeFileSync(sourcePath, `export async function doThing(): Promise<void> {}\n`);
  call = { source: sourcePath, host: 'ts', namespace: 'svc', extractorOptions: {} };
  delete process.env['APIGEN_IR_CACHE_FILE'];
  // Self-isolating: a stray prior run's real-default-path artifact (tmp/ is
  // gitignored/ephemeral, but a leftover file there would make the
  // "not the default" assertion below flaky depending on execution history).
  fs.rmSync(REAL_DEFAULT_PATH, { force: true });
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

    expect(fs.existsSync(REAL_DEFAULT_PATH)).toBe(false);
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
