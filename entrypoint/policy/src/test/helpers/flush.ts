// Copied from packages/apigen/apigen-engine-gateway/src/test/helpers (nx module-boundaries forbids a deep import across packages). Shared-helper candidate: see the T17 report.
// Deterministic "let everything already queued run" barriers. Neither waits for wall-clock
// time: `flush` drains promise continuations, `settle` additionally drains the I/O and
// nextTick queues (stream events) by yielding whole event-loop turns.

export async function flush(): Promise<void> {
  for (let i = 0; i < 25; i++) await Promise.resolve();
}

export async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await flush();
  }
}
