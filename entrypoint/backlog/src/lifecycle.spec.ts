/**
 * lifecycle.spec.ts — AC4's lifecycle half: the `starting / live / ready`
 * trichotomy, the failure-vs-state rule (liveness ⇒ restart, readiness ⇒
 * report-only, state unchanged), and `whenReady`.
 */
import { describe, expect, it } from 'vitest';
import { createLifecycle } from './lifecycle.js';

describe('createLifecycle', () => {
  it('walks starting → live → ready and reports non-degraded', () => {
    const lc = createLifecycle();
    expect(lc.state()).toBe('starting');
    lc.markLive();
    expect(lc.state()).toBe('live');
    lc.markReady();
    expect(lc.state()).toBe('ready');
    const report = lc.report();
    expect(report.state).toBe('ready');
    expect(report.degraded).toBe(false);
    expect(report.failure).toBeUndefined();
  });

  it('a readiness failure does NOT change state and asks for report-only', () => {
    const lc = createLifecycle();
    lc.markLive();
    const outcome = lc.fail({
      kind: 'readiness',
      code: 'probe_failed',
      message: 'op returned ok:false',
    });
    expect(outcome.action).toBe('report');
    expect(lc.state()).toBe('live');
    const report = lc.report();
    expect(report.degraded).toBe(true);
    expect(report.failure?.kind).toBe('readiness');
  });

  it('a liveness failure asks for a restart', () => {
    const lc = createLifecycle();
    lc.markLive();
    const outcome = lc.fail({
      kind: 'liveness',
      code: 'hung',
      message: 'missed ticks',
    });
    expect(outcome.action).toBe('restart');
  });

  it('whenReady resolves once markReady is called', async () => {
    const lc = createLifecycle();
    lc.markLive();
    let resolved = false;
    const p = lc.whenReady().then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);
    lc.markReady();
    await p;
    expect(resolved).toBe(true);
  });
});
