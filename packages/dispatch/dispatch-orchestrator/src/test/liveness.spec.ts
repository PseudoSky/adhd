/**
 * 7ed25125 D-AC2 — a running dispatch emits a liveness heartbeat, and a node
 * whose heartbeat stops past its deadline is marked dead. Proven with an
 * INJECTED clock: no wall-clock sleeping anywhere in this file.
 *
 * The runner is the only double (the documented external boundary); the monitor
 * and `pollUntilTerminal` are the real code.
 */
import { describe, expect, it } from 'vitest';
import { LivenessMonitor } from '../lib/liveness.js';
import { pollUntilTerminal } from '../lib/orchestrator.js';
import type { DispatchTaskStatus, IDispatchAgentRunner } from '../lib/agent-runner.js';

function fakeClock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('7ed25125 D-AC2 LivenessMonitor (injected clock)', () => {
  it('7ed25125 D-AC2: a node whose heartbeat stops past its deadline is marked dead; a beating node is not', () => {
    const clock = fakeClock();
    const m = new LivenessMonitor({ deadlineMs: 100, nowMs: clock.now });
    m.register('beating');
    m.register('silent');
    clock.advance(60);
    m.heartbeat('beating');
    clock.advance(60); // silent: 120ms since last beat > 100; beating: 60ms
    expect(m.sweep()).toEqual(['silent']);
    expect(m.isDead('silent')).toBe(true);
    expect(m.state('beating')).toBe('alive');
    expect(m.sweep()).toEqual([]); // newly-dead only reported once
  });

  it('7ed25125 D-AC2 NEGATIVE CONTROL: exactly at the deadline is still alive; a dead node is never resurrected by a late beat; finished is never dead', () => {
    const clock = fakeClock();
    const m = new LivenessMonitor({ deadlineMs: 100, nowMs: clock.now });
    m.register('edge');
    m.register('done');
    clock.advance(100);
    expect(m.sweep()).toEqual([]);
    m.finish('done');
    clock.advance(1);
    expect(m.sweep()).toEqual(['edge']);
    m.heartbeat('edge');
    expect(m.state('edge')).toBe('dead');
    clock.advance(10_000);
    expect(m.sweep()).toEqual([]);
    expect(m.state('done')).toBe('finished');
  });

  it('7ed25125 D-AC2: a non-positive deadline is rejected', () => {
    expect(() => new LivenessMonitor({ deadlineMs: 0 })).toThrow(/deadlineMs/);
  });
});

describe('7ed25125 D-AC2 pollUntilTerminal heartbeats', () => {
  type PollResult = { status: DispatchTaskStatus; usage: undefined } | Error;
  function runnerScript(script: PollResult[]): IDispatchAgentRunner {
    let i = 0;
    return {
      poll: async () => {
        const next = script[Math.min(i++, script.length - 1)];
        if (next instanceof Error) throw next;
        return next;
      },
    } as unknown as IDispatchAgentRunner;
  }

  it('7ed25125 D-AC2: answered polls are heartbeats; once polls stop answering the task is marked dead exactly one deadline after its LAST heartbeat (no wall clock)', async () => {
    const clock = fakeClock(0);
    const monitor = new LivenessMonitor({ deadlineMs: 250, nowMs: clock.now });
    const running = { status: 'running' as DispatchTaskStatus, usage: undefined };
    // Heartbeats at t=0, 100, 200; then the task stops answering.
    const runner = runnerScript([running, running, running, new Error('connection refused')]);
    const out = await pollUntilTerminal(runner, 't1', { intervalMs: 100, timeoutMs: 100_000 }, async (ms) => clock.advance(ms), monitor);
    expect(out.dead).toBe(true);
    expect(out.status).toBe('failed');
    expect(out.timedOut).toBe(false);
    expect(out.error).toContain('liveness deadline');
    expect(monitor.isDead('t1')).toBe(true);
    // last heartbeat t=200, deadline 250 -> dead at the first failed poll after t=450, i.e. t=500.
    // If heartbeats were not recorded the task would be declared dead at t=300.
    expect(clock.now()).toBe(500);
  });

  it('7ed25125 D-AC2 NEGATIVE CONTROL: a task that keeps answering (heartbeats) and then completes is never dead', async () => {
    const clock = fakeClock();
    const monitor = new LivenessMonitor({ deadlineMs: 250, nowMs: clock.now });
    const running = { status: 'running' as DispatchTaskStatus, usage: undefined };
    const runner = runnerScript([running, running, running, running, running, { status: 'completed' as DispatchTaskStatus, usage: undefined }]);
    const out = await pollUntilTerminal(runner, 't2', { intervalMs: 100, timeoutMs: 100_000 }, async (ms) => clock.advance(ms), monitor);
    expect(out.dead).toBeUndefined();
    expect(out.status).toBe('completed');
    expect(monitor.state('t2')).toBe('finished');
  });

  it('7ed25125 D-AC2: with no monitor a failing poll propagates exactly as before', async () => {
    const runner = runnerScript([new Error('boom')]);
    await expect(pollUntilTerminal(runner, 't3', { intervalMs: 1, timeoutMs: 10 }, async () => undefined)).rejects.toThrow('boom');
  });
});
