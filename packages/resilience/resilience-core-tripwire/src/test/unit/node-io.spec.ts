/**
 * Ticket 8468f7b1 - nodeTripwireIo, the single Node adapter of
 * TripwireIo (TW31: the only lib module touching the process streams and
 * environment): prompts go to stderr, out/err are line-oriented, piped
 * answers are never lost between questions, and a question resolves null
 * once the input ended or closed (never a hang).
 * Criteria: [tripwire-interactive.8] TW31, [tripwire-interactive.2] TW25.
 */
import { PassThrough } from 'node:stream';
import { nodeTripwireIo } from '../../index';

function sink(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') };
}

function make(input: PassThrough, isTTY?: boolean) {
  const out = sink();
  const err = sink();
  const io = nodeTripwireIo({
    input,
    output: out.stream,
    errorOutput: err.stream,
    env: { CONFIRM: 'x' },
    ...(isTTY === undefined ? {} : { isTTY }),
  });
  return { io, out, err };
}

describe('[tripwire-interactive.8] TW31 nodeTripwireIo', () => {
  it('defaults to the process streams and environment', () => {
    const io = nodeTripwireIo();
    expect(io.env).toBe(process.env);
    expect(io.isTTY).toBe(process.stdin.isTTY === true);
  });

  it('out and err write one line each to their own stream', async () => {
    const { io, out, err } = make(new PassThrough());
    io.out('to stdout');
    io.err('to stderr');
    await new Promise((r) => setImmediate(r));
    expect(out.text()).toBe('to stdout\n');
    expect(err.text()).toBe('to stderr\n');
    expect(io.env).toEqual({ CONFIRM: 'x' });
  });

  it('isTTY follows the input unless overridden', () => {
    const tty = Object.assign(new PassThrough(), { isTTY: true });
    expect(make(tty).io.isTTY).toBe(true);
    expect(make(new PassThrough()).io.isTTY).toBe(false);
    expect(make(tty, false).io.isTTY).toBe(false);
  });

  it('question writes the prompt to stderr and resolves the answer line',
    async () => {
      const input = new PassThrough();
      const { io, out, err } = make(input, true);
      const p = io.question('ok? ');
      input.write('yes\r\n');
      expect(await p).toBe('yes');
      expect(err.text()).toBe('ok? ');
      expect(out.text()).toBe('');
      input.end();
    });

  it('piped answers written at once are not lost between questions',
    async () => {
      const input = new PassThrough();
      input.end('first\nsecond\n\nthird');
      const { io } = make(input);
      expect(await io.question('1')).toBe('first');
      expect(await io.question('2')).toBe('second');
      expect(await io.question('3')).toBe('');
      expect(await io.question('4')).toBe('third');
      expect(await io.question('5')).toBeNull();
      expect(await io.question('6')).toBeNull();
    });
});

describe('[tripwire-interactive.8] TW31 an idle prompt reader does not ' +
  'keep the process alive', () => {
  it('the input handle is ref\'d while a question waits and unref\'d after ' +
    'the answer', async () => {
    const calls: string[] = [];
    const input = Object.assign(new PassThrough(), {
      ref: () => calls.push('ref'),
      unref: () => calls.push('unref'),
    });
    const { io } = make(input, true);
    const p = io.question('1');
    expect(calls).toEqual(['ref']);
    input.write('a\n');
    expect(await p).toBe('a');
    expect(calls).toEqual(['ref', 'unref']);
    const q = io.question('2');
    input.write('b\n');
    expect(await q).toBe('b');
    expect(calls).toEqual(['ref', 'unref', 'ref', 'unref']);
    input.end();
  });
});

describe('[tripwire-interactive.2] TW25 EOF resolves null, never a hang',
  () => {
    it('an input already ended answers null', async () => {
      const input = new PassThrough();
      input.end();
      expect(await make(input).io.question('?')).toBeNull();
    });

    it('an input ended while a question waits answers null', async () => {
      const input = new PassThrough();
      const { io } = make(input);
      const p = io.question('?');
      input.end();
      expect(await p).toBeNull();
    });

    it('a destroyed input answers null', async () => {
      const input = new PassThrough();
      input.destroy();
      await new Promise((r) => setImmediate(r));
      expect(await make(input).io.question('?')).toBeNull();
    });

    it('a partial line before EOF is still delivered, then null', async () => {
      const input = new PassThrough();
      const { io } = make(input);
      const p = io.question('?');
      input.end('no newline');
      expect(await p).toBe('no newline');
      expect(await io.question('?')).toBeNull();
    });
  });
