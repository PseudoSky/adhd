/**
 * claudecli-reap.e2e.test.ts — backlog 322a1efb (plan 9ed453c1-b113-473d-8c35-fc6dc2541306).
 *
 * ClaudeCliProvider used to SIGTERM the `claude` process group in `finally`
 * unconditionally, right after the `result` line -- killing a child that was
 * still exiting on its own (flaky TRC-AC5: spawn.exit {code:null, signal:SIGTERM}).
 *
 * Every case drives the REAL provider against a REAL child (the fake-claude
 * stand-in; only the LLM is stubbed). Deterministic: the child's exit is gated by
 * a SIGUSR2 latch the test controls, and all waits are event-driven with bounded
 * deadlines -- no sleeps. Runs by default; nothing here calls a paid service.
 *
 *   AC1  success path never signals an exiting child (REVERT-FAILING: restore the
 *        unconditional terminateProcessTree(proc) in chat()'s `finally` -> the held
 *        child is SIGTERMed and exits {code:null, signal:'SIGTERM'}).
 *   AC2  a child (and grandchild) that ignores stdin EOF and SIGTERM is reaped by
 *        the bounded SIGTERM -> SIGKILL ladder.
 *   AC3  error/abort paths still terminate immediately.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ClaudeCliProvider } from '../providers/claudecli.js';
import type { EngineConfig, EngineLogger } from '../interfaces.js';
import type { ProviderChatRequest } from '../providers/types.js';

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const logger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const request = (signal?: AbortSignal): ProviderChatRequest => ({
  messages: [{ role: 'user', content: 'run' } as ProviderChatRequest['messages'][number]],
  ...(signal ? { signal } : {}),
});

const dirs: string[] = [];
const spawned: ChildProcess[] = [];
function freshDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

interface IExitRecord { code: number | null; signal: NodeJS.Signals | null }

function harness(env: Record<string, string>, timings?: { exitGraceMs?: number; killEscalationMs?: number }) {
  chmodSync(FAKE_CLAUDE, 0o755);
  let proc: ChildProcess | undefined;
  let waitExit: (r: IExitRecord) => void = () => {};
  const exitedP = new Promise<IExitRecord>((resolve) => { waitExit = resolve; });
  const tracedSpawn = ((...a: Parameters<typeof nodeSpawn>) => {
    proc = nodeSpawn(...a);
    spawned.push(proc);
    proc.once('exit', (code, signal) => waitExit({ code, signal }));
    return proc;
  }) as unknown as typeof nodeSpawn;
  const config = {
    server: { contextLimit: 0, defaultMaxTokens: 8192 },
    queue: { concurrency: 1 },
    sse: { baseUrl: '' },
    plugins: { entries: [] },
    getProviderConfig: () => ({}),
    subprocessEnv: () => env,
    resolveEnvName: (() => undefined) as unknown as EngineConfig['resolveEnvName'],
    isEnvNameAllowed: () => true,
    wire: { tempDir: freshDir('adhd-reap-tmp-'), spawn: tracedSpawn } as unknown as EngineConfig['wire'],
  } as EngineConfig;
  const provider = new ClaudeCliProvider(
    { type: 'claudecli', claudePath: FAKE_CLAUDE, model: 'claude-haiku-4-5' },
    {},
    undefined,
    config,
    logger,
    timings
  );
  return {
    provider,
    exited: exitedP,
    proc: (): ChildProcess => {
      if (!proc) throw new Error('child was never spawned');
      return proc;
    },
  };
}

async function withDeadline<T>(p: Promise<T>, what: string, ms = 15_000): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`deadline: ${what}`)), ms); }),
    ]);
  } finally {
    clearTimeout(t);
  }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

afterEach(() => {
  for (const p of spawned.splice(0)) {
    try { if (p.pid) process.kill(-p.pid, 'SIGKILL'); } catch { /* gone */ }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('322a1efb ClaudeCliProvider reaps its child without killing a clean exit', () => {
  it('322a1efb AC1: chat() resolves while the child is still exiting and the child is NOT signalled; it then exits {code:0, signal:null}', async () => {
    const h = harness({ ADHD_FAKE_CLAUDE_HOLD: '1' }); // default (long) grace: the ladder must not fire
    const res = await withDeadline(h.provider.chat(request()), 'chat resolves');
    expect(res.message.content).toBe('OK');

    const proc = h.proc();
    // The child is held alive by the latch, so it cannot have exited on its own...
    expect(proc.exitCode).toBeNull();
    // ...and (REVERT-FAILING) nothing has signalled it: the old code SIGTERMed the group here.
    expect(proc.signalCode).toBeNull();

    // Release the latch: the child performs its own clean process.exit(0).
    proc.kill('SIGUSR2');
    expect(await withDeadline(h.exited, 'child exits')).toEqual({ code: 0, signal: null });
  }, 30_000);

  it('322a1efb AC2: a child + grandchild that ignore stdin EOF and SIGTERM are reaped (SIGTERM then SIGKILL)', async () => {
    const dir = freshDir('adhd-reap-ac2-');
    const pidFile = join(dir, 'grandchild.pid');
    const h = harness(
      { ADHD_FAKE_CLAUDE_HOLD: 'ignore', ADHD_FAKE_CLAUDE_GRANDCHILD_PID_FILE: pidFile },
      { exitGraceMs: 0, killEscalationMs: 0 }
    );
    const res = await withDeadline(h.provider.chat(request()), 'chat resolves');
    expect(res.message.content).toBe('OK');

    // The child ignores SIGTERM, so only the SIGKILL escalation can end it.
    const rec = await withDeadline(h.exited, 'child reaped');
    expect(rec.code).toBeNull();
    expect(rec.signal).toBe('SIGKILL');

    const gcPid = Number(readFileSync(pidFile, 'utf8'));
    expect(gcPid).toBeGreaterThan(0);
    // Group kill: the SIGTERM-ignoring grandchild dies too (bounded, event-yielding poll).
    const deadline = Date.now() + 10_000;
    while (isAlive(gcPid) && Date.now() < deadline) await new Promise<void>((r) => setImmediate(r));
    expect(isAlive(gcPid), 'grandchild reaped').toBe(false);
  }, 30_000);

  it('322a1efb AC3: an aborted request terminates the child immediately (SIGTERM) and rejects', async () => {
    const h = harness({ ADHD_FAKE_CLAUDE_HOLD: 'no-result' }); // default grace: must not be what ends it
    const ac = new AbortController();
    const chat = h.provider.chat(request(ac.signal));
    chat.catch(() => {});
    // Wait (event-driven) until the child exists, then abort.
    const deadline = Date.now() + 10_000;
    while (!spawned.length && Date.now() < deadline) await new Promise<void>((r) => setImmediate(r));
    ac.abort();
    await expect(withDeadline(chat, 'chat rejects')).rejects.toThrow();
    const rec = await withDeadline(h.exited, 'child terminated');
    expect(rec).toEqual({ code: null, signal: 'SIGTERM' });
  }, 30_000);
});
