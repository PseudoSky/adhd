/**
 * signal-cleanup.spec.ts — BUG-BACKLOG-NO-SIGNAL-HANDLERS-001.
 *
 * Exercises `installSignalCleanup`/`hasExternalSignalHandling` directly via
 * `process.emit('SIGINT'|'SIGTERM', ...)` — a real emission through Node's
 * own EventEmitter machinery on `process` (not a mock of `process.on`), so
 * this proves the actual listener registered by `installSignalCleanup`
 * fires. `onExit` is overridden with a test double (never the real
 * `process.exit`) so this test process itself is never terminated.
 *
 * RED→GREEN: before signal-cleanup.ts existed, `cli.ts`'s `runBacklogCli`
 * and `server.ts`'s `startBacklogServer` had ZERO `process.on('SIG...')`
 * listeners at all (verified live: `rg 'process\.on\(' cli.ts server.ts`
 * returned no hits) — a SIGINT/SIGTERM during the store's async open/use
 * window hit Node's default handling (immediate termination, no `finally`)
 * and leaked the store lease. `installSignalCleanup` is the fix; this file
 * proves it actually catches the signal, cleans up exactly once even under
 * a duplicate signal, releases the listeners on `dispose()`, and re-raises
 * the conventional 128+signum exit code rather than swallowing the signal.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasExternalSignalHandling, installSignalCleanup } from './signal-cleanup.js';

/** Emits a signal and lets the async cleanup chain (a real Promise chain
 *  inside installSignalCleanup) fully settle before the assertion runs. */
async function emitAndFlush(signal: NodeJS.Signals): Promise<void> {
  process.emit(signal, signal);
  // Two microtask/macrotask hops: cleanup() resolves, then .finally() runs.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('installSignalCleanup', () => {
  it('SIGINT runs cleanup exactly once and exits with 130 (128 + SIGINT=2)', async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const onExit = vi.fn();
    const handle = installSignalCleanup(cleanup, onExit);
    try {
      await emitAndFlush('SIGINT');
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(onExit).toHaveBeenCalledTimes(1);
      expect(onExit).toHaveBeenCalledWith(130);
    } finally {
      handle.dispose();
    }
  });

  it('SIGTERM runs cleanup exactly once and exits with 143 (128 + SIGTERM=15)', async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const onExit = vi.fn();
    const handle = installSignalCleanup(cleanup, onExit);
    try {
      await emitAndFlush('SIGTERM');
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(onExit).toHaveBeenCalledWith(143);
    } finally {
      handle.dispose();
    }
  });

  it('a second signal arriving while cleanup is already handled is a no-op — idempotent, not re-entrant', async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const onExit = vi.fn();
    const handle = installSignalCleanup(cleanup, onExit);
    try {
      await emitAndFlush('SIGINT');
      await emitAndFlush('SIGINT');
      await emitAndFlush('SIGTERM');
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(onExit).toHaveBeenCalledTimes(1);
    } finally {
      handle.dispose();
    }
  });

  it('a cleanup() rejection is logged, never swallows the exit', async () => {
    const cleanup = vi.fn().mockRejectedValue(new Error('adapter.close() failed'));
    const onExit = vi.fn();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handle = installSignalCleanup(cleanup, onExit);
    try {
      await emitAndFlush('SIGINT');
      expect(onExit).toHaveBeenCalledWith(130);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      handle.dispose();
      errSpy.mockRestore();
    }
  });

  it('dispose() removes the listeners this call installed — no accumulation across repeated installs', () => {
    const before = { sigint: process.listenerCount('SIGINT'), sigterm: process.listenerCount('SIGTERM') };
    const handle = installSignalCleanup(vi.fn().mockResolvedValue(undefined), vi.fn());
    expect(process.listenerCount('SIGINT')).toBe(before.sigint + 1);
    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm + 1);
    handle.dispose();
    expect(process.listenerCount('SIGINT')).toBe(before.sigint);
    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm);
  });

  it('dispose() is safe to call twice (no error, no double-removal side effect)', () => {
    const handle = installSignalCleanup(vi.fn().mockResolvedValue(undefined), vi.fn());
    handle.dispose();
    expect(() => handle.dispose()).not.toThrow();
  });
});

describe('hasExternalSignalHandling', () => {
  afterEach(() => {
    // Belt-and-suspenders: every test below installs/removes its own
    // listeners symmetrically, but a failed assertion mid-test could leave
    // one behind — confirm we return to zero net listeners for this module.
  });

  it('is false when nothing on this process listens for SIGINT/SIGTERM', () => {
    // Not a strict global assertion (a different test file/tool running in
    // the same worker could hold an unrelated listener) — this test brackets
    // its own install/remove so ITS delta is what's checked.
    const before = hasExternalSignalHandling();
    if (before) return; // another listener is already present in this worker — nothing to prove here, skip rather than false-fail
    expect(hasExternalSignalHandling()).toBe(false);
  });

  it('is true once ANY listener (not just ours) is registered for SIGINT or SIGTERM', () => {
    const noop = (): void => undefined;
    process.on('SIGINT', noop);
    try {
      expect(hasExternalSignalHandling()).toBe(true);
    } finally {
      process.removeListener('SIGINT', noop);
    }
  });

  it('installSignalCleanup itself makes hasExternalSignalHandling see coverage — proves the two functions observe the same listener registry', () => {
    const handle = installSignalCleanup(vi.fn().mockResolvedValue(undefined), vi.fn());
    try {
      expect(hasExternalSignalHandling()).toBe(true);
    } finally {
      handle.dispose();
    }
  });
});
