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

import { ScriptedProvider } from './scripted-provider.js';

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

/**
 * 19354419 AC5 — an MCP result with `isError: true` (a returned error, NOT a thrown
 * transport exception) must reach the engine's `post:tool_call` as `isError: true`, and
 * the hook must leave the CRLF bytes alone. Driven through the REAL orchestrator, a REAL
 * stdio fs server and the REAL eol hooks; only the LLM is scripted.
 */
describe('19354419 AC5 isError MCP result through the real engine', () => {
  async function runEngineEdit(
    edit: { oldText: string; newText: string }
  ): Promise<{ file: string; seen: Array<{ tool: string; isError: boolean }>; bytes: string }> {
    const { buildHarness, createSessionAndAgent, enqueueTaskWithProvider, drainQueue } = await import('./harness.js');
    const scratch = join(REPO_ROOT, 'tmp', 'agent-mcp');
    await mkdir(scratch, { recursive: true });
    const dir = await mkdtemp(join(scratch, 'eol-ac5-'));
    const file = join(dir, 'f.txt');
    await writeFile(file, 'one\r\ntwo\r\nthree\r\n');
    const provider = new ScriptedProvider([
      {
        type: 'tool_calls',
        toolCalls: [{ id: 'ac5-call', server: 'fs', tool: 'edit_file', arguments: { path: file, edits: [edit] } }],
      },
      { type: 'completed', content: 'done' },
    ]);
    const harness = await buildHarness({ defaultProvider: provider, skipOrphanScan: true });
    try {
      registerEolPreserve(harness.hooks);
      const seen: Array<{ tool: string; isError: boolean }> = [];
      harness.hooks.register('post:tool_call', (p: { toolName: string; isError: boolean }) => {
        seen.push({ tool: p.toolName, isError: p.isError });
      });
      const launch = resolveFsServerLaunch();
      const { sessionId } = await createSessionAndAgent(harness, provider, {
        mcpServers: { fs: { transport: 'stdio', command: launch.command, args: [...launch.args, dir] } },
      });
      const out = await enqueueTaskWithProvider(harness, sessionId, 'edit the file', provider);
      await drainQueue(harness.queue, 30_000);
      const task = harness.taskStore.read(out.task_id);
      expect(task.status, `task error: ${String(task.error)}`).toBe('completed');
      return { file, seen, bytes: (await readFile(file)).toString('latin1') };
    } finally {
      await harness.teardown();
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('19354419 AC5: a no-match edit (server returns isError:true) => post:tool_call.isError is true and the CRLF bytes are untouched', async () => {
    const r = await runEngineEdit({ oldText: 'absent', newText: 'x' });
    expect(r.seen).toEqual([{ tool: 'fs__edit_file', isError: true }]);
    expect(r.bytes).toBe('one\r\ntwo\r\nthree\r\n');
  }, 60_000);

  it('19354419 AC5 control: a matching edit => post:tool_call.isError is false and CRLF is restored', async () => {
    const r = await runEngineEdit({ oldText: 'two', newText: 'TWO' });
    expect(r.seen).toEqual([{ tool: 'fs__edit_file', isError: false }]);
    expect(r.bytes).toBe('one\r\nTWO\r\nthree\r\n');
  }, 60_000);
});
