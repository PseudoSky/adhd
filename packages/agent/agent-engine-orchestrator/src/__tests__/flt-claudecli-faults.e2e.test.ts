/**
 * 9ed453c1 / de6bee5d FLT — real-process proofs for the claudecli fault path (ADR-0009 e2e lane).
 *
 * The REAL `ClaudeCliProvider` spawns a REAL child (`fixtures/fake-claude-fault.mjs`); only the model is
 * absent. A fake clock keeps every backoff off the wall. Runs by default; nothing here is a paid service.
 *
 *  FLT-AC1/AC3  the exit status, stderr and a rejected usage window of a real child are surfaced typed.
 *  FLT-AC4      the window trip stops a sibling provider from spawning at all.
 *  FLT-AC5      abort kills the child AND its same-group grandchild (no orphan) and never re-spawns.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ClaudeCliProvider } from '../providers/claudecli.js';
import { ProviderCallError, TripRegistry, type RetryRuntime } from '../providers/provider-failure.js';
import type { EngineConfig, EngineLogger } from '../interfaces.js';
import type { ProviderChatRequest } from '../providers/types.js';
import { ToolError } from '../validation/errors.js';
import { FakeClock } from './fixtures/fake-clock.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude-fault.mjs', import.meta.url));
const logger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const dirs: string[] = [];
const pids: number[] = [];

function fresh(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'adhd-flt-')));
  dirs.push(d);
  return d;
}

function build(env: Record<string, string>, shared: { clock: FakeClock; registry: TripRegistry }) {
  chmodSync(FAKE, 0o755);
  const dir = fresh();
  const countFile = join(dir, 'count');
  const pidFile = join(dir, 'pids.json');
  const fullEnv = { ...process.env, ...env, ADHD_FAKE_CLAUDE_COUNT_FILE: countFile, ADHD_FAKE_CLAUDE_PID_FILE: pidFile } as Record<string, string>;
  const config = {
    server: { contextLimit: 0, defaultMaxTokens: 8192 },
    queue: { concurrency: 1 },
    sse: { baseUrl: '' },
    plugins: { entries: [] },
    getProviderConfig: () => ({}),
    subprocessEnv: () => fullEnv,
    resolveEnvName: (() => undefined) as unknown as EngineConfig['resolveEnvName'],
    isEnvNameAllowed: () => true,
    wire: { tempDir: fresh() } as unknown as EngineConfig['wire'],
  } as EngineConfig;
  const runtime: RetryRuntime = { clock: shared.clock, rng: () => 0, registry: shared.registry };
  const provider = new ClaudeCliProvider({ type: 'claudecli', claudePath: FAKE, model: 'claude-haiku-4-5' }, {}, undefined, config, logger, undefined, { retryRuntime: runtime });
  const spawns = (): number => (existsSync(countFile) ? readFileSync(countFile, 'utf8').split('\n').filter(Boolean).length : 0);
  return { provider, spawns, pidFile };
}

const request = (signal?: AbortSignal): ProviderChatRequest => ({
  messages: [{ role: 'user', content: 'go' } as ProviderChatRequest['messages'][number]],
  ...(signal ? { signal } : {}),
});

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 3000; i++) {
    if (cond()) return;
    await new Promise<void>((r) => setImmediate(r));
  }
  throw new Error(`deadline: ${what}`);
}

afterEach(() => {
  for (const p of pids.splice(0)) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('de6bee5d FLT e2e: real child faults', () => {
  it('FLT-AC1/AC4: a rejected window from a real child is PROVIDER_RATE_LIMITED with the reset time; a sibling spawns nothing', async () => {
    const shared = { clock: new FakeClock(), registry: new TripRegistry() };
    const resetsAt = Math.floor(shared.clock.now() / 1000) + 3600;
    const a = build({ ADHD_FAKE_CLAUDE_FAULT: 'window', ADHD_FAKE_CLAUDE_RESETS_AT: String(resetsAt) }, shared);
    const e = (await a.provider.chat(request()).catch((x: unknown) => x)) as ProviderCallError;
    expect(e).toBeInstanceOf(ProviderCallError);
    expect(e.code).toBe('PROVIDER_RATE_LIMITED');
    expect(e.data.retryable).toBe(false);
    expect(e.resetAt).toBe(new Date(resetsAt * 1000).toISOString());
    expect(a.spawns()).toBe(1);

    const b = build({ ADHD_FAKE_CLAUDE_FAULT: 'window', ADHD_FAKE_CLAUDE_RESETS_AT: String(resetsAt) }, shared);
    const e2 = (await b.provider.chat(request()).catch((x: unknown) => x)) as ProviderCallError;
    expect(e2.data.source).toBe('trip');
    expect(b.spawns()).toBe(0);
  });

  it('FLT-AC3: a real non-zero exit surfaces the exit code and stderr, never PROVIDER_AUTH_ERROR', async () => {
    const shared = { clock: new FakeClock(), registry: new TripRegistry() };
    const h = build({ ADHD_FAKE_CLAUDE_FAULT: 'exit3' }, shared);
    const e = (await h.provider.chat(request()).catch((x: unknown) => x)) as ToolError;
    expect(e.code).toBe('PROVIDER_ERROR');
    expect(e.message).toContain('exited with code 3');
    expect(e.message).toContain('boom: config unreadable');
  });

  it('FLT-AC5: abort kills the child and its grandchild (no orphan) and never re-spawns', async () => {
    const shared = { clock: new FakeClock(), registry: new TripRegistry() };
    const h = build({ ADHD_FAKE_CLAUDE_FAULT: 'hang' }, shared);
    const ac = new AbortController();
    const caught = h.provider.chat(request(ac.signal)).catch((x: unknown) => x);
    await until(() => existsSync(h.pidFile) && readFileSync(h.pidFile, 'utf8').includes('grandchild'), 'child started');
    const { child, grandchild } = JSON.parse(readFileSync(h.pidFile, 'utf8')) as { child: number; grandchild: number };
    pids.push(child, grandchild);
    expect(alive(child) && alive(grandchild)).toBe(true);
    ac.abort();
    const e = (await caught) as Error;
    expect(e.message).toContain('request aborted');
    await until(() => !alive(child) && !alive(grandchild), 'process group reaped');
    expect(h.spawns()).toBe(1);
  });
});
