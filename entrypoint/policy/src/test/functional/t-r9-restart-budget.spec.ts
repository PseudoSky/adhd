/**
 * guards: a `serve` upstream that keeps crashing is restarted forever (or the budget is never spent / spent too early / never rolls off), so the verb never exits non-zero; and a crash-after-ready loop is not bounded.
 * tier: S
 * cites: docs/plan/policy-core/REMEDIATION-PLAN.md T-R9, §3 R9 behaviour change 2 (BA-6 restart budget); SERVE_MAX_RESTARTS, SERVE_RESTART_WINDOW_MS in verbs/serve.ts
 * red-run: 2026-10-21 control: watchRestartBudget `exitTimes.length > maxRestarts + 100` -> 4 failed (3 window tests and the serve crash-loop exit test).
 */
import type { HostAdapter } from '@adhd/apigen-engine-gateway';
import { describe, expect, it, vi } from 'vitest';
import { SERVE_MAX_RESTARTS, SERVE_RESTART_WINDOW_MS, watchRestartBudget } from '../../wrapper/verbs/serve';
import { createStubMcpUpstream } from '../helpers/stub-mcp-upstream';
import { startServeSession } from '../helpers/mcp-memory-client';
import { withTmpDir } from '../helpers/tmp';

/** A scriptable adapter: the test decides what `start` and `ready` answer and when the host "crashes". */
function fakeAdapter(): {
  readonly adapter: HostAdapter;
  readonly script: { start: 'ok' | 'throw'; ready: boolean };
  readonly crash: () => void;
  readonly stops: () => number;
} {
  const listeners: Array<(reason: unknown) => void> = [];
  const script = { start: 'ok' as 'ok' | 'throw', ready: true };
  let stopped = 0;
  const adapter: HostAdapter = {
    host: 'mcp:fake',
    hopCost: 1,
    async start() {
      if (script.start === 'throw') throw new Error('cannot start');
    },
    async ready() {
      return script.ready;
    },
    async invoke() {
      return 'invoked';
    },
    onExit(listener) {
      listeners.push(listener);
      return () => undefined;
    },
    async stop() {
      stopped += 1;
    },
  };
  return { adapter, script, crash: () => listeners.forEach((listener) => listener(new Error('crash'))), stops: () => stopped };
}

describe('watchRestartBudget - rolling window of exits', () => {
  it('the default budget is five restarts in sixty seconds', () => {
    expect(SERVE_MAX_RESTARTS).toBe(5);
    expect(SERVE_RESTART_WINDOW_MS).toBe(60_000);
  });

  it('the exit that exceeds maxRestarts inside the window spends the budget, exactly once; earlier exits do not', () => {
    const fake = fakeAdapter();
    let now = 1_000;
    const spent = vi.fn();
    const watched = watchRestartBudget(fake.adapter, 3, spent, { windowMs: 10_000, now: () => now });
    watched.onExit(() => undefined);
    for (let exit = 1; exit <= 3; exit += 1) {
      now += 100;
      fake.crash();
      expect(spent, `after exit ${exit}`).not.toHaveBeenCalled();
    }
    now += 100;
    fake.crash();
    expect(spent).toHaveBeenCalledTimes(1);
    now += 100;
    fake.crash();
    expect(spent).toHaveBeenCalledTimes(1);
  });

  it('exits that fall out of the window no longer count: a slow trickle of crashes never spends the budget', () => {
    const fake = fakeAdapter();
    let now = 0;
    const spent = vi.fn();
    const watched = watchRestartBudget(fake.adapter, 2, spent, { windowMs: 1_000, now: () => now });
    watched.onExit(() => undefined);
    for (let exit = 0; exit < 20; exit += 1) {
      now += 600; // two exits are 1200 ms apart at worst inside the window of 1000 ms: never more than 2 in a window
      fake.crash();
    }
    expect(spent).not.toHaveBeenCalled();
    // the same crashes, packed into one window, do spend it
    for (let exit = 0; exit < 3; exit += 1) {
      now += 10;
      fake.crash();
    }
    expect(spent).toHaveBeenCalledTimes(1);
  });

  it('a host that comes back ready and crashes again in a loop is still bounded (ready does not reset the window count)', async () => {
    const fake = fakeAdapter();
    let now = 0;
    const spent = vi.fn();
    const watched = watchRestartBudget(fake.adapter, 3, spent, { windowMs: 60_000, now: () => now });
    watched.onExit(() => undefined);
    for (let cycle = 0; cycle < 4; cycle += 1) {
      now += 1_000;
      fake.crash();
      await watched.start();
      expect(await watched.ready()).toBe(true);
    }
    expect(spent).toHaveBeenCalledTimes(1);
  });

  it('listeners registered on the wrapper still receive every exit reason', () => {
    const fake = fakeAdapter();
    const seen: unknown[] = [];
    watchRestartBudget(fake.adapter, 3, () => undefined).onExit((reason) => void seen.push(reason));
    fake.crash();
    expect(seen).toHaveLength(1);
  });
});

describe('watchRestartBudget - consecutive failed restarts', () => {
  it('maxRestarts restart attempts that fail to start spend the budget; an attempt that succeeds first resets the count', async () => {
    const fake = fakeAdapter();
    const spent = vi.fn();
    const watched = watchRestartBudget(fake.adapter, 3, spent, { windowMs: 60_000, now: () => 0 });
    watched.onExit(() => undefined);
    fake.crash();
    fake.script.start = 'throw';
    await expect(watched.start()).rejects.toThrow('cannot start');
    await expect(watched.start()).rejects.toThrow('cannot start');
    expect(spent).not.toHaveBeenCalled();
    // a restart that gets ready clears the failures
    fake.script.start = 'ok';
    await watched.start();
    expect(await watched.ready()).toBe(true);
    fake.crash();
    fake.script.start = 'throw';
    await expect(watched.start()).rejects.toThrow();
    await expect(watched.start()).rejects.toThrow();
    expect(spent, 'two failures after the reset are still under three').not.toHaveBeenCalled();
    await expect(watched.start()).rejects.toThrow();
    expect(spent).toHaveBeenCalledTimes(1);
  });

  it('a restart whose readiness probe keeps answering false counts as a failed attempt', async () => {
    const fake = fakeAdapter();
    const spent = vi.fn();
    const watched = watchRestartBudget(fake.adapter, 2, spent, { windowMs: 60_000, now: () => 0 });
    watched.onExit(() => undefined);
    fake.crash();
    fake.script.ready = false;
    expect(await watched.ready()).toBe(false);
    expect(spent).not.toHaveBeenCalled();
    expect(await watched.ready()).toBe(false);
    expect(spent).toHaveBeenCalledTimes(1);
  });

  it('a start or probe failure before any crash is the initial handshake, not a restart: it never spends the budget', async () => {
    const fake = fakeAdapter();
    const spent = vi.fn();
    const watched = watchRestartBudget(fake.adapter, 1, spent);
    fake.script.start = 'throw';
    await expect(watched.start()).rejects.toThrow('cannot start');
    fake.script.start = 'ok';
    fake.script.ready = false;
    expect(await watched.ready()).toBe(false);
    expect(spent).not.toHaveBeenCalled();
  });

  it('calls and stop pass straight through to the inner adapter', async () => {
    const fake = fakeAdapter();
    const watched = watchRestartBudget(fake.adapter, 3, () => undefined);
    expect(watched.host).toBe('mcp:fake');
    expect(watched.hopCost).toBe(1);
    expect(await watched.invoke({} as never, new AbortController().signal)).toBe('invoked');
    await watched.stop();
    expect(fake.stops()).toBe(1);
  });
});

describe('serve - a crash loop ends the verb with a non-zero exit', () => {
  it('an upstream that crashes after every restart exhausts the budget: exit 1 naming the restart budget, bounded restarts, the child stopped', async () => {
    await withTmpDir('t-r9-loop', async (dir) => {
      const upstream = createStubMcpUpstream({ tools: [{ name: 'notes_add', description: 'Add' }] });
      const session = await startServeSession(['bin:notes-server', '--name', 'notes'], { cwd: dir, home: dir, launcher: upstream.launcher });
      let crashed = 0;
      let outcome: number | undefined;
      void session.exit.then((code) => void (outcome = code));
      // Crash each incarnation as soon as the gateway has relaunched it (events, not sleeps), until serve gives up.
      while (outcome === undefined && crashed < SERVE_MAX_RESTARTS + 5) {
        const target = crashed + 1;
        await vi.waitFor(() => expect(outcome !== undefined || upstream.started.length >= target).toBe(true), { timeout: 5000 });
        if (outcome !== undefined) break;
        upstream.proc().exit(1);
        crashed += 1;
      }
      expect(await session.exit).toBe(1);
      expect(session.stderr.join('')).toMatch(/exceeded its restart budget/);
      expect(upstream.started.length).toBeLessThanOrEqual(SERVE_MAX_RESTARTS + 2);
      expect(crashed).toBeLessThanOrEqual(SERVE_MAX_RESTARTS + 2);
      expect(upstream.proc().hasExited).toBe(true);
    });
  });
});
