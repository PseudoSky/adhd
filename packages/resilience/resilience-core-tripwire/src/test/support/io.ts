/**
 * A scripted fake of TripwireIo for the interactive and CLI specs (ticket
 * 8468f7b1): answers come from a script (a string, `null` for EOF, or a
 * function run when the question is asked), every out/err line and
 * prompt is captured. An exhausted script answers `null` (EOF), so a
 * buggy loop terminates instead of hanging.
 */
import type { TripwireIo } from '../../index';

export type Answer = string | null | (() => string | null | Promise<string | null>);

export interface FakeIo extends TripwireIo {
  outLines: string[];
  errLines: string[];
  prompts: string[];
  /** All out and err lines in emission order, tagged. */
  transcript: Array<['out' | 'err', string]>;
  /** Text written to err. */
  errText(): string;
  outText(): string;
}

export function fakeIo(
  answers: Answer[] = [],
  over: { isTTY?: boolean; env?: Record<string, string | undefined> } = {},
): FakeIo {
  const script = [...answers];
  const io: FakeIo = {
    isTTY: over.isTTY ?? true,
    env: over.env ?? {},
    outLines: [],
    errLines: [],
    prompts: [],
    transcript: [],
    async question(prompt) {
      io.prompts.push(prompt);
      if (script.length === 0) return null;
      const a = script.shift() as Answer;
      return typeof a === 'function' ? await a() : a;
    },
    out(line) {
      io.outLines.push(line);
      io.transcript.push(['out', line]);
    },
    err(line) {
      io.errLines.push(line);
      io.transcript.push(['err', line]);
    },
    errText: () => io.errLines.join('\n'),
    outText: () => io.outLines.join('\n'),
  };
  return io;
}
