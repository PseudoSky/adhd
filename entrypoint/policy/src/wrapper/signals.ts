/**
 * Returns an AbortSignal that aborts on the first SIGINT or SIGTERM. Both
 * handlers are removed once either fires, so a second signal gets the default
 * (terminating) behaviour instead of being swallowed.
 */
export function installAbortOnSignals(): AbortSignal {
  const controller = new AbortController();
  const onSignal = (): void => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    controller.abort();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  return controller.signal;
}
