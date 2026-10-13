/**
 * `nodeTripwireIo`: the one Node adapter of {@link TripwireIo}.
 *
 * This is the ONLY module of the package that touches the process
 * streams or environment (guard TW31); everything else takes a
 * `TripwireIo`. Prompts and banners go to stderr so stdout stays clean
 * for machine output (the status JSON line is always the last stdout
 * line).
 */
import { createInterface, type Interface } from 'node:readline';
import type { TripwireIo } from './io.js';

/** A readable input as the adapter needs it. */
export type NodeIoInput = NodeJS.ReadableStream & {
  isTTY?: boolean;
  readableEnded?: boolean;
  destroyed?: boolean;
};

/** Overrides of {@link nodeTripwireIo} (defaults: the process streams). */
export interface NodeTripwireIoOptions {
  input?: NodeIoInput;
  output?: NodeJS.WritableStream;
  errorOutput?: NodeJS.WritableStream;
  env?: Record<string, string | undefined>;
  /** Overrides `input.isTTY`. */
  isTTY?: boolean;
}

/**
 * Build the Node IO. Streams and environment are read when this is
 * called. `question` writes the prompt to stderr and resolves with the
 * next input line, or `null` once the input has ended or closed (it never
 * hangs on EOF). One line reader is kept for the life of the io, so piped
 * answers are never lost between questions; it is paused between
 * questions so an idle prompt reader does not keep the process alive.
 */
export function nodeTripwireIo(o: NodeTripwireIoOptions = {}): TripwireIo {
  const input: NodeIoInput = o.input ?? process.stdin;
  const output = o.output ?? process.stdout;
  const errorOutput = o.errorOutput ?? process.stderr;
  const env = o.env ?? process.env;
  const isTTY = o.isTTY ?? input.isTTY === true;

  let rl: Interface | null = null;
  let closed = input.readableEnded === true || input.destroyed === true;
  const lines: string[] = [];
  const waiters: Array<(line: string | null) => void> = [];

  const reader = (): Interface => {
    if (rl) return rl;
    const r = createInterface({ input, terminal: false, crlfDelay: Infinity });
    r.on('line', (line) => {
      const w = waiters.shift();
      if (w) w(line);
      else lines.push(line);
      if (waiters.length === 0) r.pause();
    });
    r.once('close', () => {
      closed = true;
      for (const w of waiters.splice(0)) w(null);
    });
    rl = r;
    return r;
  };

  return {
    isTTY,
    env,
    question(prompt) {
      errorOutput.write(prompt);
      const queued = lines.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      if (closed) return Promise.resolve(null);
      return new Promise<string | null>((resolve) => {
        waiters.push(resolve);
        reader().resume();
      });
    },
    out(line) {
      output.write(`${line}\n`);
    },
    err(line) {
      errorOutput.write(`${line}\n`);
    },
  };
}
