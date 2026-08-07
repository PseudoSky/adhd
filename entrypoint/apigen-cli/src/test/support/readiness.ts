// Shared LIVE-test readiness helpers.
//
// Context: `nx test apigen-cli` in isolation passes green (157/157, proven
// twice), but under a massively-parallel release run (`nx run-many -t
// publish`, 479 tasks) the same LIVE cross-language tests (serve.spec.ts,
// cross-host-response-envelope.spec.ts, real-consumer.spec.ts) intermittently
// fail with `waitForHttp: … never responded within 15000ms — TypeError:
// fetch failed`. Root cause: these tests spawn REAL TS + Python subprocess
// servers and the fixed ~15s per-host readiness deadline is marginal even
// solo (serve.spec.ts alone takes ~18.7s) and gets blown by CPU/port
// contention from concurrent sibling builds/tests.
//
// This module centralizes the fix:
//   - A single, generous, ENV-overridable deadline (default 60s — a bounded
//     wait, never infinite) shared by every LIVE readiness probe in this
//     package's test suite.
//   - Fail-FAST-and-LOUD if the process being probed exits/errors before
//     becoming ready — we never silently burn the full deadline polling a
//     dead child. The child's captured stderr is included in the thrown
//     error so a real startup crash (missing python3/flask/grpc, import
//     error, port-in-use) is diagnosable immediately, not just "timed out".
//
// This does NOT weaken any assertion — it only makes the readiness WAIT
// itself robust. Every behavioral assertion downstream (dead-host → 503,
// zero orphans, byte-identical Decimal, gRPC on shared port, etc.) is
// untouched.

import type { ChildProcess } from 'node:child_process';

/**
 * Overall budget for a single readiness probe (HTTP polling, stdout
 * `{"ready":true}` scan, etc.). Overridable via `APIGEN_TEST_READY_TIMEOUT_MS`
 * for environments with even heavier contention than the default anticipates;
 * always a bounded number, never unbounded.
 */
export const READY_TIMEOUT_MS = (() => {
  const raw = process.env['APIGEN_TEST_READY_TIMEOUT_MS'];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000;
})();

/** Poll interval between readiness probe attempts. */
export const READY_POLL_INTERVAL_MS = 100;

/**
 * A vitest `it(...)` timeout that comfortably contains one or more
 * `READY_TIMEOUT_MS` readiness waits plus the test's own assertion work.
 * Pass the number of sequential readiness waits the test performs (default
 * 1); a 20s buffer is added for the actual request/assertion traffic.
 */
export function liveTestTimeoutMs(waits = 1): number {
  return READY_TIMEOUT_MS * waits + 20_000;
}

/** Captures a child's stderr into a bounded ring buffer for error reporting. */
export function captureStderr(child: ChildProcess, maxBytes = 4000): () => string {
  let buf = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    if (buf.length > maxBytes) buf = buf.slice(buf.length - maxBytes);
  });
  return () => buf;
}

/**
 * Wait for an HTTP endpoint to respond — bounded poll, never a fixed sleep.
 *
 * Fails FAST (before the deadline) if `child` exits/errors first, including
 * the child's captured stderr in the thrown error so a real startup crash
 * (missing dependency, port conflict, import error) is diagnosable instead
 * of surfacing as an opaque timeout.
 *
 * @param url        - The endpoint to probe (any response, including non-2xx,
 *                      counts as "responded" — this proves the socket is
 *                      accepting connections, matching prior per-file
 *                      `waitForHttp` semantics).
 * @param opts.child  - Optional child process to race against; if it exits
 *                      before the endpoint responds, rejects immediately.
 * @param opts.timeoutMs - Overall budget (default `READY_TIMEOUT_MS`).
 * @param opts.intervalMs - Delay between probe attempts.
 * @param opts.getStderr - Optional accessor for captured child stderr,
 *                      included in the fail-fast error message.
 */
export async function waitForHttp(
  url: string,
  opts: {
    child?: ChildProcess;
    timeoutMs?: number;
    intervalMs?: number;
    getStderr?: () => string;
  } = {}
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? READY_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? READY_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;

  let childExited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    childExited = { code, signal };
  };
  opts.child?.once('exit', onExit);

  try {
    while (Date.now() < deadline) {
      if (childExited) {
        const stderr = opts.getStderr?.() ?? '';
        throw new Error(
          `waitForHttp: process exited (code=${childExited.code} signal=${childExited.signal}) ` +
            `before ${url} became ready` +
            (stderr ? ` — stderr:\n${stderr}` : '')
        );
      }
      try {
        await fetch(url);
        return;
      } catch (e) {
        lastErr = e;
        await new Promise<void>((r) => setTimeout(r, intervalMs));
      }
    }
    const stderr = opts.getStderr?.() ?? '';
    throw new Error(
      `waitForHttp: ${url} never responded within ${timeoutMs}ms — last error: ${String(
        lastErr
      )}` + (stderr ? ` — stderr:\n${stderr}` : '')
    );
  } finally {
    opts.child?.off('exit', onExit);
  }
}

/**
 * Bounded poll of an arbitrary async condition (e.g. a specific HTTP status,
 * a specific health payload). Fails FAST if `child` exits first.
 */
export async function pollUntilReady<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  opts: {
    child?: ChildProcess;
    timeoutMs?: number;
    intervalMs?: number;
    getStderr?: () => string;
    describe?: string;
  } = {}
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? READY_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? READY_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  let lastErr: unknown;

  let childExited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    childExited = { code, signal };
  };
  opts.child?.once('exit', onExit);

  try {
    while (Date.now() < deadline) {
      if (childExited) {
        const stderr = opts.getStderr?.() ?? '';
        throw new Error(
          `pollUntilReady${opts.describe ? ` (${opts.describe})` : ''}: process exited ` +
            `(code=${childExited.code} signal=${childExited.signal}) before condition held` +
            (stderr ? ` — stderr:\n${stderr}` : '')
        );
      }
      try {
        last = await fn();
        if (predicate(last)) return last;
      } catch (e) {
        lastErr = e;
      }
      await new Promise<void>((r) => setTimeout(r, intervalMs));
    }
    throw new Error(
      `pollUntilReady${opts.describe ? ` (${opts.describe})` : ''} exceeded ${timeoutMs}ms` +
        (lastErr ? ` (last error: ${String(lastErr)})` : '') +
        (last !== undefined ? ` (last value: ${JSON.stringify(last)})` : '')
    );
  } finally {
    opts.child?.off('exit', onExit);
  }
}
