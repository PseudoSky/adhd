import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 19354419 AC4: count the reads the hooks' bounded reader actually issues against disk.
const readCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const fh = await actual.open(...args);
      const read = fh.read.bind(fh) as (...a: unknown[]) => Promise<unknown>;
      (fh as unknown as { read: unknown }).read = (...a: unknown[]) => {
        readCalls.count += 1;
        return read(...a);
      };
      return fh;
    },
  };
});

import { HookRegistry } from '@adhd/agent-engine-orchestrator';
import type { ExecutionContext } from '@adhd/agent-base-types';

import { registerEolPreserve, type IEolPreserveOptions } from '../eol-hook.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'eol-hook-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ctx = (): ExecutionContext => ({ cwd: dir }) as unknown as ExecutionContext;

/** Drive one fs tool call through the hooks; `serverWrite` stands in for the server's disk write. */
async function runCall(
  toolName: string,
  toolInput: unknown,
  serverWrite: () => Promise<void>,
  isError = false,
  hooks = new HookRegistry(),
  options: IEolPreserveOptions = {}
): Promise<void> {
  registerEolPreserve(hooks, options);
  const executionContext = ctx();
  await hooks.emit('pre:tool_call', { executionContext, toolName, callId: 'c1', toolInput });
  await serverWrite();
  await hooks.emit('post:tool_call', {
    executionContext,
    toolName,
    callId: 'c1',
    toolInput,
    result: [],
    isError,
    estResultTokens: 0,
  });
}

describe('8dd148cf AC4 eol hook (R3-EOL)', () => {
  it('8dd148cf AC4: a failed edit leaves the file bytes untouched', async () => {
    const f = join(dir, 'a.txt');
    await writeFile(f, 'x\r\ny\r\n');
    await runCall('fs__edit_file', { path: f }, async () => undefined, true);
    expect((await readFile(f)).toString('latin1')).toBe('x\r\ny\r\n');
  });

  it('8dd148cf AC4: a failed call does not rewrite even if the file is bare LF now', async () => {
    const f = join(dir, 'b.txt');
    await writeFile(f, 'x\r\ny\r\n');
    await runCall('fs__edit_file', { path: f }, () => writeFile(f, 'x\ny\n'), true);
    expect((await readFile(f)).toString('latin1')).toBe('x\ny\n');
  });

  it('8dd148cf AC4: hook errors are swallowed (fail-open): unreadable path, bad input, file removed', async () => {
    const f = join(dir, 'gone.txt');
    await writeFile(f, 'x\r\n');
    const { rm: rmFile } = await import('node:fs/promises');
    await expect(runCall('fs__write_file', { path: join(dir, 'nope', 'q') }, async () => undefined)).resolves.toBeUndefined();
    await expect(runCall('fs__write_file', null, async () => undefined)).resolves.toBeUndefined();
    await expect(runCall('fs__edit_file', { path: f }, () => rmFile(f))).resolves.toBeUndefined();
  });

  it('8dd148cf AC2: a successful edit on a CRLF file is restored to CRLF (unit)', async () => {
    const f = join(dir, 'c.txt');
    await writeFile(f, 'a\r\nb\r\nc\r\n');
    await runCall('fs__edit_file', { path: f }, () => writeFile(f, 'a\nB\nc\n'));
    expect((await readFile(f)).toString('latin1')).toBe('a\r\nB\r\nc\r\n');
  });

  it('8dd148cf AC2: relative paths resolve against the task cwd', async () => {
    const f = join(dir, 'rel.txt');
    await writeFile(f, 'a\r\nb\r\n');
    await runCall('fs__edit_file', { path: 'rel.txt' }, () => writeFile(f, 'a\nB\n'));
    expect((await readFile(f)).toString('latin1')).toBe('a\r\nB\r\n');
  });

  it('8dd148cf AC3: write_file over CRLF restores CRLF; new file and LF file stay LF', async () => {
    const crlf = join(dir, 'w.txt');
    const lf = join(dir, 'l.txt');
    const fresh = join(dir, 'new.txt');
    await writeFile(crlf, 'a\r\n');
    await writeFile(lf, 'a\n');
    await runCall('fs__write_file', { path: crlf }, () => writeFile(crlf, 'x\ny\n'));
    await runCall('fs__write_file', { path: lf }, () => writeFile(lf, 'x\ny\n'));
    await runCall('fs__write_file', { path: fresh }, () => writeFile(fresh, 'x\ny\n'));
    expect((await readFile(crlf)).toString('latin1')).toBe('x\r\ny\r\n');
    expect((await readFile(lf)).toString('latin1')).toBe('x\ny\n');
    expect((await readFile(fresh)).toString('latin1')).toBe('x\ny\n');
  });

  it('8dd148cf AC3: mixed-ending files and non-fs tools are never touched', async () => {
    const mixed = join(dir, 'm.txt');
    const other = join(dir, 'o.txt');
    await writeFile(mixed, 'a\r\nb\n');
    await writeFile(other, 'a\r\n');
    await runCall('fs__edit_file', { path: mixed }, () => writeFile(mixed, 'a\nb\nc\n'));
    await runCall('fs__read_text_file', { path: other }, () => writeFile(other, 'a\n'));
    expect((await readFile(mixed)).toString('latin1')).toBe('a\nb\nc\n');
    expect((await readFile(other)).toString('latin1')).toBe('a\n');
  });
});

const lsDir = async () => (await readdir(dir)).sort();

describe('19354419 eol hook hardening (R4-EOL)', () => {
  it('19354419 AC1: rewrite is temp-file + rename (new inode, no temp left) and preserves the file mode', async () => {
    const f = join(dir, 'mode.sh');
    await writeFile(f, 'a\r\nb\r\n');
    await chmod(f, 0o751);
    const before = await stat(f);
    await runCall('fs__edit_file', { path: f }, () => writeFile(f, 'a\nB\n'));
    const after = await stat(f);
    expect((await readFile(f)).toString('latin1')).toBe('a\r\nB\r\n');
    expect(after.mode & 0o7777).toBe(0o751);
    expect(after.ino).not.toBe(before.ino); // replaced via rename, not rewritten in place
    expect(await lsDir()).toEqual(['mode.sh']);
  });

  it('19354419 AC1: a read-only (0o444) CRLF file is restored and stays 0o444', async () => {
    const f = join(dir, 'ro.txt');
    await writeFile(f, 'a\r\n');
    await runCall('fs__write_file', { path: f }, async () => {
      await chmod(f, 0o644);
      await writeFile(f, 'x\ny\n');
      await chmod(f, 0o444);
    });
    expect((await readFile(f)).toString('latin1')).toBe('x\r\ny\r\n');
    expect((await stat(f)).mode & 0o7777).toBe(0o444);
  });

  it('19354419 AC2: a competing write between the hook read and its commit is not overwritten (latch)', async () => {
    const f = join(dir, 'race.txt');
    await writeFile(f, 'a\r\nb\r\n');
    const warn = vi.fn();
    let competing = false;
    await runCall('fs__edit_file', { path: f }, () => writeFile(f, 'a\nB\n'), false, new HookRegistry(), {
      warn,
      beforeCommit: async () => {
        // The latch: runs after the hook read the file and wrote its temp, before commit.
        await writeFile(f, 'a\nSOMEONE-ELSE\n');
        competing = true;
      },
    });
    expect(competing).toBe(true);
    expect((await readFile(f)).toString('latin1')).toBe('a\nSOMEONE-ELSE\n');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('race.txt');
    expect(await lsDir()).toEqual(['race.txt']); // temp cleaned up
  });

  it('19354419 AC2: a same-size competing write is also detected (content re-check)', async () => {
    const f = join(dir, 'same.txt');
    await writeFile(f, 'a\r\nb\r\n');
    const warn = vi.fn();
    await runCall('fs__edit_file', { path: f }, () => writeFile(f, 'a\nb\n'), false, new HookRegistry(), {
      warn,
      beforeCommit: () => writeFile(f, 'x\ny\n'),
    });
    expect((await readFile(f)).toString('latin1')).toBe('x\ny\n');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('19354419 AC2: with no competing write the commit happens and nothing is warned', async () => {
    const f = join(dir, 'calm.txt');
    await writeFile(f, 'a\r\n');
    const warn = vi.fn();
    await runCall('fs__edit_file', { path: f }, () => writeFile(f, 'a\nb\n'), false, new HookRegistry(), { warn });
    expect((await readFile(f)).toString('latin1')).toBe('a\r\nb\r\n');
    expect(warn).not.toHaveBeenCalled();
  });

  it('19354419 AC3: pending entries are bounded (oldest evicted) when post never arrives', async () => {
    const f = join(dir, 'leak.txt');
    await writeFile(f, 'a\r\n');
    const hooks = new HookRegistry();
    const handle = registerEolPreserve(hooks, { maxPending: 3, now: () => 0 });
    const executionContext = ctx();
    for (let i = 0; i < 10; i++) {
      await hooks.emit('pre:tool_call', { executionContext, toolName: 'fs__edit_file', callId: `leak${i}`, toolInput: { path: f } });
    }
    expect(handle.pending()).toBe(3);
    // The evicted (oldest) call no longer rewrites; a retained one still does.
    await writeFile(f, 'a\nb\n');
    const post = (callId: string) =>
      hooks.emit('post:tool_call', { executionContext, toolName: 'fs__edit_file', callId, toolInput: { path: f }, result: [], isError: false, estResultTokens: 0 });
    await post('leak0');
    expect((await readFile(f)).toString('latin1')).toBe('a\nb\n');
    await post('leak9');
    expect((await readFile(f)).toString('latin1')).toBe('a\r\nb\r\n');
    expect(handle.pending()).toBe(2);
  });

  it('19354419 AC3: pending entries expire after the TTL (injected clock)', async () => {
    const f = join(dir, 'ttl.txt');
    await writeFile(f, 'a\r\n');
    let t = 1_000;
    const hooks = new HookRegistry();
    const handle = registerEolPreserve(hooks, { ttlMs: 100, now: () => t });
    const executionContext = ctx();
    await hooks.emit('pre:tool_call', { executionContext, toolName: 'fs__write_file', callId: 't1', toolInput: { path: f } });
    expect(handle.pending()).toBe(1);
    t += 99;
    expect(handle.pending()).toBe(1);
    t += 1;
    expect(handle.pending()).toBe(0);
  });

  it('19354419 AC4: pre-hook reads nothing from a file over the size cap, and post never rewrites it', async () => {
    const f = join(dir, 'big.txt');
    await writeFile(f, 'aaaa\r\nbbbb\r\n'); // 12 bytes
    const hooks = new HookRegistry();
    const handle = registerEolPreserve(hooks, { maxBytes: 8 });
    const executionContext = ctx();
    readCalls.count = 0;
    await hooks.emit('pre:tool_call', { executionContext, toolName: 'fs__edit_file', callId: 'b1', toolInput: { path: f } });
    expect(readCalls.count).toBe(0);
    expect(handle.pending()).toBe(0);
    await writeFile(f, 'aaaa\nbbbb\n');
    await hooks.emit('post:tool_call', { executionContext, toolName: 'fs__edit_file', callId: 'b1', toolInput: { path: f }, result: [], isError: false, estResultTokens: 0 });
    expect((await readFile(f)).toString('latin1')).toBe('aaaa\nbbbb\n');
  });

  it('19354419 AC4: a file at exactly the cap is handled; one that grows past the cap by post time is left alone', async () => {
    const f = join(dir, 'edge.txt');
    await writeFile(f, 'ab\r\ncd\r\n'); // 8 bytes
    await runCall('fs__edit_file', { path: f }, () => writeFile(f, 'ab\ncd\n'), false, new HookRegistry(), { maxBytes: 8 });
    expect((await readFile(f)).toString('latin1')).toBe('ab\r\ncd\r\n');
    await writeFile(f, 'ab\r\ncd\r\n');
    await runCall('fs__edit_file', { path: f }, () => writeFile(f, 'abcdefgh\nijkl\n'), false, new HookRegistry(), { maxBytes: 8 });
    expect((await readFile(f)).toString('latin1')).toBe('abcdefgh\nijkl\n');
  });
});
