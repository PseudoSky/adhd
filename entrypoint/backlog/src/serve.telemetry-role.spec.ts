/**
 * serve.telemetry-role.spec.ts — BUG-014 red→green.
 *
 * `index.ts`'s bin-entry guard calls `initTelemetry({ service: 'backlog',
 * role: 'cli', ... })` unconditionally before ever dispatching, including
 * for `serve`, which then runs in the same process for its entire
 * multi-day lifetime. Confirmed empirically (2026-08-17, cross-tracked in
 * this item): all 1,409 `store_adapter.turso.close_checkpoint_busy` events
 * across 4 days of `backlog.cli-*.jsonl` logs were stamped `role:'cli'`,
 * indistinguishable from a sub-second one-shot invocation — the
 * investigating agent had to fall back to pairing each pid's
 * connection-open/close duration to tell CLI (median 0.47s) from serve
 * (2.5-2.8 day clusters) apart.
 *
 * RED (pre-fix): `runServeCommand` never called `initTelemetry` again, so
 * `currentRuntimeState().role` stayed whatever the bin-entry guard set —
 * `'cli'` — for the entire serve session.
 *
 * GREEN (this fix): `runServeCommand` re-initialises telemetry with
 * `role:'live-service'` (the population `Role`'s own doc comment names for
 * exactly this case — there is no `'serve'` member) before entering its
 * request loop, so serve sessions are now distinguishable from one-shot CLI
 * invocations by role alone, no forensic pid-pairing required.
 *
 * BUG-014-LOCK-ORDER (second describe block below): a follow-on fix to the
 * fix above. `initTelemetry({ logSink: 'file' })` performs real synchronous
 * file I/O and is explicitly best-effort/non-fatal — it must never delay
 * the server's real startup work. An earlier version of this change called
 * it BEFORE `startBacklogServer` — ahead of that function's synchronous
 * startup prefix (env resolution, `env.ensureDirs()`, signal-cleanup
 * registration, all before `server.ts`'s first `await`). That is never
 * correct ordering for a best-effort side-call: nothing unrelated to the
 * server's own startup correctness should be able to delay it. Fixed by
 * invoking `startBacklogServer(...)` first (unawaited) and calling
 * `initTelemetry` only after that statement — see `serve.ts`'s
 * `BUG-014-LOCK-ORDER` doc comment for the full ordering argument. (This
 * ordering originally also protected `[inv:singleton]`'s serve-lock claim
 * window; that lock has since been removed as unnecessary defense-in-depth
 * — see STATE.md A17 — but the startup-latency ordering it happened to
 * share the invariant with is unaffected and still enforced here.) The test
 * below is a deterministic invocation-order assertion (mocked
 * `startBacklogServer`/`initTelemetry`), not a timing-flake reproduction —
 * the underlying race, if any, is in a real subprocess spawn window this
 * suite cannot control on demand; this test instead pins the STATEMENT
 * ORDER in `runServeCommand` that determines whether that window can ever
 * be widened by telemetry init, so a future regression that reintroduces
 * the old ordering fails immediately and deterministically.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initTelemetry,
  currentRuntimeState,
  _resetTelemetryForTest,
} from '@adhd/sox-telemetry';

// Module-scope call-order log shared by the mocks below and the
// BUG-014-LOCK-ORDER describe block that reads it. Declared at top level
// (not inside a describe/it) so `vi.mock`'s hoisting — which moves these
// calls above all imports in this file — can close over it safely.
const serveCommandCallOrder: string[] = [];

// `startBacklogServer` (server.ts) is exercised for real (with real
// subprocesses) in `serve.singleton.spec.ts` — mocked purely here to
// observe INVOCATION ORDER, not to change its behavior. The mock resolves
// immediately (no signal wait), so `runServeCommand` completes without
// needing to deliver a real SIGTERM/SIGINT to this test process.
vi.mock('./server.js', () => ({
  startBacklogServer: vi.fn(async () => {
    serveCommandCallOrder.push('startBacklogServer');
  }),
}));

// Wraps the REAL `@adhd/sox-telemetry` module (still used directly by the
// second describe block below) purely to record call order; every call
// still forwards to the actual implementation, so behavior is unchanged.
vi.mock('@adhd/sox-telemetry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@adhd/sox-telemetry')>();
  return {
    ...actual,
    initTelemetry: vi.fn((...args: Parameters<typeof actual.initTelemetry>) => {
      serveCommandCallOrder.push('initTelemetry');
      return actual.initTelemetry(...args);
    }),
  };
});

describe('BUG-014-LOCK-ORDER: runServeCommand invokes startBacklogServer before re-stamping telemetry, never after', () => {
  beforeEach(() => {
    serveCommandCallOrder.length = 0;
  });

  afterEach(() => {
    _resetTelemetryForTest();
  });

  it('RED (pre-fix): initTelemetry ran before startBacklogServer, ahead of its synchronous startup prefix — GREEN (this fix): startBacklogServer is invoked first, unawaited, and its synchronous prefix (env resolution + ensureDirs + signal-cleanup registration) completes in this tick before initTelemetry is ever called', async () => {
    const { runServeCommand } = await import('./serve.js');
    await runServeCommand(['--transport', 'mcp']);
    expect(serveCommandCallOrder).toEqual(['startBacklogServer', 'initTelemetry']);
  });
});

describe('BUG-014: backlog serve re-stamps telemetry role away from the bin-entry guard\'s "cli"', () => {
  let logDir: string;

  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), 'backlog-serve-telemetry-'));
  });

  afterEach(() => {
    _resetTelemetryForTest();
    rmSync(logDir, { recursive: true, force: true });
  });

  it('RED-then-GREEN: role starts as "cli" (bin-entry guard) and is re-stamped "live-service" by the same init call `runServeCommand` now makes', () => {
    // Reproduce the bin-entry guard's own unconditional call — this is what
    // every `backlog <anything>` invocation does first, `serve` included.
    initTelemetry({ service: 'backlog', role: 'cli', logSink: 'file', logDir });
    expect(currentRuntimeState().role).toBe('cli');
    expect(currentRuntimeState().service).toBe('backlog');

    // Without the fix, a `serve` session never calls initTelemetry again,
    // so role stays 'cli' for its entire multi-day lifetime — this is the
    // RED state BUG-014 was filed against (asserted here as the starting
    // condition, not as a passing case: a suite that only asserted the
    // fixed call site, without first proving the guard's default is 'cli',
    // would not prove anything changed).

    // This is the exact call `serve.ts#runServeCommand` now makes before
    // entering `startBacklogServer`'s request loop (BUG-014 fix).
    initTelemetry({ service: 'backlog', role: 'live-service', logSink: 'file', logDir });

    const state = currentRuntimeState();
    expect(state.role).toBe('live-service');
    expect(state.service).toBe('backlog');
  });
});
