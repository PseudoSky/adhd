import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HookRegistry } from '@adhd/agent-engine-orchestrator';
import type { ExecutionContext } from '@adhd/agent-base-types';

import { registerEolPreserve } from '../eol-hook.js';

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
  hooks = new HookRegistry()
): Promise<void> {
  registerEolPreserve(hooks);
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
