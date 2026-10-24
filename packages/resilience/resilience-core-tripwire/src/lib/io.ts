/**
 * The injected IO of the interactive and CLI surface.
 *
 * `interactiveGate`, `confirmSolved` and `runUnlockCli` touch nothing but a
 * {@link TripwireIo}, so every human-in-the-loop path is unit-testable with
 * a scripted fake. `nodeTripwireIo` (node-io.ts) is the single adapter over
 * the real process streams and environment.
 */

/** The only IO the interactive code uses. */
export interface TripwireIo {
  /** True when a human can answer prompts (stdin is a terminal). */
  isTTY: boolean;
  /** Environment snapshot (e.g. `CONFIRM` for the unlock CLI). */
  env: Record<string, string | undefined>;
  /**
   * Ask one question and resolve with the answer line (without the line
   * terminator), or `null` when the input is at EOF or closed.
   */
  question(prompt: string): Promise<string | null>;
  /** Write one line to the standard output channel. */
  out(line: string): void;
  /** Write one line to the diagnostic channel (banners, prompts, errors). */
  err(line: string): void;
}
