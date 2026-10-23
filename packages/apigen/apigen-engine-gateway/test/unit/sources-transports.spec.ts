// guards: the launcher transport loses, reorders or double-closes JSON-RPC messages over a process handle, or the stdio host transport keeps running after stdin EOF
// tier: S
// cites: REVIEW-FIXES G11 (launcher transport) and G8 (stdio host transport follows stdin EOF)

// The two transports of the bin: source: the launcher transport (SDK Transport over a
// process handle, G11) and the stdio HOST transport that follows stdin EOF (G8).

import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { createLauncherTransport, createStdioHostTransport } from '../../src/index';
import { FakeProcess } from '../helpers/fake-process';
import { flush, settle } from '../helpers/flush';

const ping = (id: number): JSONRPCMessage => ({ jsonrpc: '2.0', id, method: 'ping' });

async function started(proc: FakeProcess, opts?: Parameters<typeof createLauncherTransport>[1]) {
  const transport = createLauncherTransport(proc.handle, opts);
  const messages: JSONRPCMessage[] = [];
  const errors: Error[] = [];
  let closes = 0;
  transport.onmessage = (m) => messages.push(m);
  transport.onerror = (e) => errors.push(e);
  transport.onclose = () => {
    closes += 1;
  };
  await transport.start();
  return { transport, messages, errors, closes: () => closes };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Feature: the launcher transport frames JSON-RPC over a process handle', () => {
  it('@frame sends one JSON line per message to stdin', async () => {
    const proc = new FakeProcess();
    const { transport } = await started(proc);
    await transport.send(ping(1));
    await transport.send(ping(2));
    expect(proc.stdinChunks).toEqual([`${JSON.stringify(ping(1))}\n`, `${JSON.stringify(ping(2))}\n`]);
  });

  it('@frame reassembles messages split across chunks and tolerates CRLF and blank lines', async () => {
    const proc = new FakeProcess();
    const { messages, errors } = await started(proc);
    const wire = `${JSON.stringify(ping(1))}\r\n\n${JSON.stringify(ping(2))}\n`;
    proc.stdout(wire.slice(0, 7));
    proc.stdout(wire.slice(7, 30));
    expect(messages).toHaveLength(0);
    proc.stdout(wire.slice(30));
    expect(messages).toEqual([ping(1), ping(2)]);
    expect(errors).toEqual([]);
  });

  it('@frame a malformed line is reported and the next good line still arrives', async () => {
    const proc = new FakeProcess();
    const { messages, errors } = await started(proc);
    proc.stdout(`not json\n${JSON.stringify({ jsonrpc: '2.0', nope: true })}\n${JSON.stringify(ping(3))}\n`);
    expect(errors).toHaveLength(2);
    expect(messages).toEqual([ping(3)]);
  });

  it('@frame stderr goes to onStderr only and is never parsed as protocol', async () => {
    const proc = new FakeProcess();
    const seen: string[] = [];
    const { messages, errors } = await started(proc, { onStderr: (t) => seen.push(t) });
    proc.stderr(`${JSON.stringify(ping(9))}\n`);
    expect(seen).toEqual([`${JSON.stringify(ping(9))}\n`]);
    expect(messages).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('@G11 an unterminated line over 8 Mi characters errors and closes the transport', async () => {
    const proc = new FakeProcess();
    const { transport, errors, closes } = await started(proc);
    proc.stdout('a'.repeat(8 * 1024 * 1024 + 1));
    expect(errors.map((e) => e.message)).toEqual([expect.stringMatching(/over 8388608 characters/)]);
    await flush();
    expect(closes()).toBe(1);
    expect(proc.kills[0]).toBe('SIGTERM');
    expect(proc.stdinEnded).toBe(true);
    await expect(transport.send(ping(1))).rejects.toThrow('transport is closed');
  });

  it('@G11 a line exactly at the cap is accepted', async () => {
    const proc = new FakeProcess();
    const { errors } = await started(proc);
    proc.stdout('a'.repeat(8 * 1024 * 1024));
    expect(errors).toEqual([]);
    expect(proc.kills).toEqual([]);
  });
});

describe('Feature: the launcher transport tears the process down', () => {
  it('@close ends stdin, SIGTERMs, fires onclose once; later close and send are inert', async () => {
    const proc = new FakeProcess();
    const { transport, closes } = await started(proc);
    await transport.close();
    expect(proc.stdinEnded).toBe(true);
    expect(proc.kills).toEqual(['SIGTERM']);
    expect(closes()).toBe(1);
    await transport.close();
    expect(closes()).toBe(1);
    await expect(transport.send(ping(1))).rejects.toThrow('transport is closed');
  });

  it('@close a process that ignores SIGTERM is SIGKILLed after the grace period', async () => {
    vi.useFakeTimers();
    const proc = new FakeProcess({ ignoreSigterm: true });
    const { transport, closes } = await started(proc);
    const closing = transport.close();
    await vi.advanceTimersByTimeAsync(1999);
    expect(proc.kills).toEqual(['SIGTERM']);
    expect(closes()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(proc.kills).toEqual(['SIGTERM', 'SIGKILL']);
    expect(closes()).toBe(1);
  });

  it('@close the process exiting on its own closes the transport (once)', async () => {
    const proc = new FakeProcess();
    const { transport, closes } = await started(proc);
    proc.exit(0);
    await flush();
    expect(closes()).toBe(1);
    expect(proc.kills).toEqual([]);
    await transport.close();
    expect(closes()).toBe(1);
  });
});

describe('Feature: the stdio host transport follows the host going away (G8)', () => {
  async function host() {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const transport = createStdioHostTransport(stdin, stdout);
    const messages: JSONRPCMessage[] = [];
    let closes = 0;
    transport.onmessage = (m) => messages.push(m);
    transport.onclose = () => {
      closes += 1;
    };
    await transport.start();
    return { stdin, stdout, transport, messages, closes: () => closes };
  }

  it('@G8 messages flow both ways over the streams', async () => {
    const { stdin, stdout, transport, messages } = await host();
    stdin.write(`${JSON.stringify(ping(1))}\n`);
    await settle();
    expect(messages).toEqual([ping(1)]);
    const chunks: string[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(c.toString('utf8')));
    await transport.send({ jsonrpc: '2.0', id: 1, result: {} });
    expect(chunks.join('')).toBe(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })}\n`);
  });

  it('@G8 stdin end-of-file closes the transport', async () => {
    const { stdin, closes } = await host();
    stdin.end();
    await settle();
    expect(closes()).toBe(1);
  });

  it('@G8 stdin close (without end) closes the transport, and only once', async () => {
    const { stdin, closes } = await host();
    stdin.destroy();
    await settle();
    expect(closes()).toBe(1);
    stdin.emit('end');
    expect(closes()).toBe(1);
  });

  it('@G8 an explicit close detaches the stdin listeners', async () => {
    const { stdin, transport } = await host();
    const before = stdin.listenerCount('end');
    await transport.close();
    expect(stdin.listenerCount('end')).toBeLessThan(before);
    expect(stdin.listenerCount('close')).toBe(0);
  });
});
