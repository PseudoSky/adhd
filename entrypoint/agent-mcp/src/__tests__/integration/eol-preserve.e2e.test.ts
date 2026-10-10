/**
 * eol-preserve.e2e.test.ts — backlog 8dd148cf (R3-EOL).
 *
 * Runs by default in the e2e lane (no env gate): the adopted fs server is a pinned
 * LOCAL dependency launched with `node`, no network. Drives the REAL
 * `@modelcontextprotocol/server-filesystem` over real MCP stdio and the REAL
 * `registerEolPreserve` hooks through a real `HookRegistry`, asserting bytes on disk.
 *
 * The "without the hook" cases are the built-in negative control: they prove the
 * adopted server really converts CRLF -> LF, so the "with the hook" assertions fail
 * if the hook is disabled.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ExecutionContext } from '@adhd/agent-base-types';
import { resolveFsServerLaunch } from '@adhd/agent-core-native-tooling';
import { HookRegistry, StdioMcpClient } from '@adhd/agent-engine-orchestrator';

import { registerEolPreserve } from '../../eol-hook.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../..', import.meta.url));

/** 8dd148cf AC2 negative control switch: set EOL_E2E_DISABLE_HOOK=1 to run with the hook off. */
const HOOK_ON = process.env['EOL_E2E_DISABLE_HOOK'] !== '1';

describe('8dd148cf R3-EOL real fs server + real hooks', () => {
  let root = '';
  let client: StdioMcpClient;
  let callSeq = 0;

  beforeAll(async () => {
    const scratch = join(REPO_ROOT, 'tmp', 'agent-mcp');
    await mkdir(scratch, { recursive: true });
    root = await mkdtemp(join(scratch, 'eol-'));
    const launch = resolveFsServerLaunch();
    client = new StdioMcpClient('fs', {
      transport: 'stdio',
      command: launch.command,
      args: [...launch.args, root],
    });
    await client.connect();
  });

  afterAll(async () => {
    await client?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  /** One tool call through the real server, bracketed by the pre/post hooks as the engine does. */
  async function call(
    tool: 'edit_file' | 'write_file',
    args: Record<string, unknown>,
    withHook: boolean
  ): Promise<void> {
    const hooks = new HookRegistry();
    if (withHook) registerEolPreserve(hooks);
    const executionContext = { cwd: root } as unknown as ExecutionContext;
    const callId = `c${++callSeq}`;
    const toolName = `fs__${tool}`;
    await hooks.emit('pre:tool_call', { executionContext, toolName, callId, toolInput: args });
    let isError = false;
    let result: unknown;
    try {
      result = await client.callTool(tool, args);
    } catch (e) {
      isError = true;
      result = String(e);
    }
    await hooks.emit('post:tool_call', {
      executionContext,
      toolName,
      callId,
      toolInput: args,
      result,
      isError,
      estResultTokens: 0,
    });
  }

  const bytes = async (f: string) => (await readFile(f)).toString('latin1');
  const bareLf = (s: string) => (s.match(/(?<!\r)\n/g) ?? []).length;

  it('control: without the hook the adopted server converts CRLF to LF (proves the bug and the test teeth)', async () => {
    const f = join(root, 'control.txt');
    await writeFile(f, 'one\r\ntwo\r\nthree\r\n');
    await call('edit_file', { path: f, edits: [{ oldText: 'two', newText: 'TWO' }] }, false);
    expect(await bytes(f)).toBe('one\nTWO\nthree\n');
  });

  it('8dd148cf AC2: edit_file on a CRLF file leaves 0 bare LF and changes only the targeted line', async () => {
    const f = join(root, 'ac2.txt');
    await writeFile(f, 'one\r\ntwo\r\nthree\r\n');
    await call('edit_file', { path: f, edits: [{ oldText: 'two', newText: 'TWO' }] }, HOOK_ON);
    const after = await bytes(f);
    expect(bareLf(after)).toBe(0);
    expect(after).toBe('one\r\nTWO\r\nthree\r\n');
  });

  it('8dd148cf AC2: a multi-line replacement keeps CRLF', async () => {
    const f = join(root, 'ac2-multi.txt');
    await writeFile(f, 'a\r\nb\r\nc\r\n');
    await call(
      'edit_file',
      { path: f, edits: [{ oldText: 'a\nb', newText: 'x\ny\nz' }] },
      HOOK_ON
    );
    const after = await bytes(f);
    expect(bareLf(after)).toBe(0);
    expect(after).toBe('x\r\ny\r\nz\r\nc\r\n');
  });

  it('8dd148cf AC3: write_file over a CRLF file with LF content ends CRLF; new and LF files stay LF', async () => {
    const crlf = join(root, 'ac3-crlf.txt');
    const lf = join(root, 'ac3-lf.txt');
    const fresh = join(root, 'ac3-new.txt');
    await writeFile(crlf, 'old\r\n');
    await writeFile(lf, 'old\n');
    await call('write_file', { path: crlf, content: 'x\ny\n' }, HOOK_ON);
    await call('write_file', { path: lf, content: 'x\ny\n' }, HOOK_ON);
    await call('write_file', { path: fresh, content: 'x\ny\n' }, HOOK_ON);
    expect(await bytes(crlf)).toBe('x\r\ny\r\n');
    expect(await bytes(lf)).toBe('x\ny\n');
    expect(await bytes(fresh)).toBe('x\ny\n');
  });

  it('8dd148cf AC4: an edit with no match fails and leaves the CRLF bytes untouched', async () => {
    const f = join(root, 'ac4.txt');
    await writeFile(f, 'one\r\ntwo\r\n');
    await call('edit_file', { path: f, edits: [{ oldText: 'absent', newText: 'x' }] }, true);
    expect(await bytes(f)).toBe('one\r\ntwo\r\n');
  });
});
