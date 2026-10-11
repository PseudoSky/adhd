/**
 * 61358b6f AC8 / AC9 (engine half) — the shell exit status the exit shim appends
 * as a `[exit status: N]` stderr line is recovered structurally by BOTH engine
 * loops (native tool loop + claudecli bridge), without changing `isError` or the
 * model-visible text.
 *
 * Driven through the REAL `Orchestrator.run()` with the REAL `HookRegistry`; only
 * the LLM provider and the MCP client boundary are scripted (the external
 * boundary). Spawn-free unit lane; the real-server proof of the trailer itself is
 * `agent-core-native-tooling/src/lib/shell-exit-status.e2e.test.ts`.
 *
 * Teeth: with the `parseShellExitStatus` call removed from either loop the
 * matching "exitStatus is recorded" case goes red (negative control run when this
 * file was authored).
 */
import { describe, expect, it, vi } from 'vitest';

import type { AgentDefinition } from '@adhd/agent-base-types';
import type { EngineLogger } from '../interfaces.js';
import type { ProviderChatRequest } from '../providers/types.js';
import { Orchestrator } from '../engine/orchestrator.js';
import { PolicyEngine } from '../engine/policy.js';
import { HookRegistry } from '../engine/hooks.js';
import {
  SHELL_EXECUTE_TOOL,
  SHELL_EXIT_SENTINEL_RE,
  parseShellExitStatus,
} from '../engine/shell-exit-status.js';

vi.mock('child_process', () => ({ spawn: vi.fn() }));

const silent: EngineLogger = { info() {}, warn() {}, error() {}, debug() {} };
const nowIso = () => new Date().toISOString();

type Mode = 'native' | 'bridged';
type Part = { type: string; text: string };

interface Observed {
  post: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  modelSaw: unknown[];
}

/** Drive ONE call of `server__tool` whose client returns `clientResult` (or throws). */
async function drive(
  mode: Mode,
  call: { server: string; tool: string },
  clientResult: unknown | Error
): Promise<Observed> {
  const post: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const hooks = new HookRegistry();
  hooks.register('post:tool_call' as never, (async (p: Record<string, unknown>) => {
    post.push(p);
  }) as never);

  const tool = { name: `${call.server}__${call.tool}`, description: 'd', inputSchema: { type: 'object', properties: {} } };
  const registry = {
    listAllTools: async () => [tool],
    closeAll: async () => {},
    getClient: async () => ({
      callTool: async () => {
        if (clientResult instanceof Error) throw clientResult;
        return clientResult;
      },
    }),
  };
  const modelSaw: unknown[] = [];
  let turn = 0;
  const provider = {
    chat: async (req: ProviderChatRequest) => {
      turn++;
      if (mode === 'bridged') {
        if (!req.executeTool) throw new Error('bridge executeTool missing');
        modelSaw.push(await req.executeTool(call.server, call.tool, {}));
        return { message: { id: 'm', sessionId: 's', role: 'assistant', content: 'done', createdAt: nowIso() }, stopReason: 'completed' as const };
      }
      if (turn > 1) return { message: { id: `m${turn}`, sessionId: 's', role: 'assistant', content: 'done', createdAt: nowIso() }, stopReason: 'completed' as const };
      return {
        message: { id: `m${turn}`, sessionId: 's', role: 'assistant', content: '', createdAt: nowIso(), toolCalls: [{ id: `c${turn}`, server: call.server, tool: call.tool, arguments: {} }] },
        stopReason: 'tool_calls' as const,
      };
    },
  };
  const def = { name: 'a', version: 1, provider: { type: 'openai', model: 'x' }, systemPrompt: 's', mcpServers: {}, permissions: {}, maxToolLoops: 5, createdAt: nowIso(), updatedAt: nowIso() } as unknown as AgentDefinition;
  const ctx = { taskId: 't', sessionId: 's', agentName: 'a', agentDefinition: def, recursionDepth: 0, toolCallCount: 0 };
  const sessionStore = {
    appendMessage: async (_s: string, m: { role: string; toolResults?: Array<{ result: unknown }> }) => {
      if (m.role === 'tool') for (const r of m.toolResults ?? []) modelSaw.push(r);
    },
    close() {},
  };
  const taskStore = {
    updateStatus() {},
    appendEvent: (e: { type: string; payload: Record<string, unknown> }) => {
      if (e.type === 'TOOL_RESULT') events.push(e.payload);
    },
    unregisterCancellation() {},
  };
  await new Orchestrator().run({
    executionContext: ctx,
    messages: [{ id: 'u', sessionId: 's', role: 'user', content: 'hi', createdAt: nowIso() }],
    registry,
    provider,
    policy: new PolicyEngine({ serverMaxDepth: 5, serverMaxToolLoops: 5 }),
    taskStore,
    sessionStore,
    signal: new AbortController().signal,
    taskId: 't',
    hooks,
    logger: silent,
    config: {
      server: { contextLimit: 0, defaultMaxTokens: 1024 }, queue: { concurrency: 1 }, sse: { baseUrl: 'http://x' }, plugins: { entries: [] },
      getProviderConfig: () => ({}), subprocessEnv: () => ({}), resolveEnvName: () => undefined, isEnvNameAllowed: () => true,
    },
  } as never);
  return { post, events, modelSaw };
}

const SHELL = { server: 'shell', tool: SHELL_EXECUTE_TOOL };
const failing: Part[] = [
  { type: 'text', text: 'ls: /nope: No such file or directory\n[exit status: 1]\n' },
];
const modelText = (o: Observed) => JSON.stringify(o.modelSaw);

for (const mode of ['native', 'bridged'] as const) {
  describe(`61358b6f AC8 engine records exitStatus (${mode} loop)`, () => {
    it('a shell_execute result carrying the trailer yields exitStatus on post:tool_call and TOOL_RESULT; isError stays false', async () => {
      const o = await drive(mode, SHELL, failing);
      expect(o.post).toHaveLength(1);
      expect(o.post[0]['exitStatus']).toBe(1);
      expect(o.post[0]['isError']).toBe(false);
      expect(o.events).toHaveLength(1);
      expect(o.events[0]['exitStatus']).toBe(1);
      expect(o.events[0]['isError']).toBe(false);
    });

    it('records the exact status number', async () => {
      const o = await drive(mode, SHELL, [{ type: 'text', text: '[exit status: 127]' }]);
      expect(o.post[0]['exitStatus']).toBe(127);
      expect(o.events[0]['exitStatus']).toBe(127);
    });

    it('the model-visible text is unchanged: the trailer is still in what the model sees', async () => {
      const o = await drive(mode, SHELL, failing);
      expect(modelText(o)).toContain('[exit status: 1]');
      expect(modelText(o)).toContain('No such file or directory');
    });

    it('a zero-exit result carries no exitStatus', async () => {
      const o = await drive(mode, SHELL, [{ type: 'text', text: 'hi' }]);
      expect('exitStatus' in o.post[0]).toBe(false);
      expect('exitStatus' in o.events[0]).toBe(false);
    });

    it('a non-shell tool whose output happens to contain the trailer carries no exitStatus', async () => {
      const o = await drive(mode, { server: 'fs', tool: 'read_text_file' }, failing);
      expect('exitStatus' in o.post[0]).toBe(false);
      expect('exitStatus' in o.events[0]).toBe(false);
    });

    it('a sentinel echoed mid-output (not in the final line of the last part) is ignored', async () => {
      const o = await drive(mode, SHELL, [{ type: 'text', text: '[exit status: 9]\nstill running fine\n' }]);
      expect('exitStatus' in o.post[0]).toBe(false);
    });

    it('a thrown client error (isError path, e.g. an allowlist denial) carries no exitStatus', async () => {
      const o = await drive(mode, SHELL, new Error('Command not allowed: rm [exit status: 1]'));
      expect(o.post[0]['isError']).toBe(true);
      expect('exitStatus' in o.post[0]).toBe(false);
      expect('exitStatus' in o.events[0]).toBe(false);
    });
  });
}

describe('61358b6f parseShellExitStatus (pure)', () => {
  it('reads only the LAST text part and ignores non-text parts', () => {
    expect(parseShellExitStatus(SHELL_EXECUTE_TOOL, [
      { type: 'text', text: 'out' },
      { type: 'text', text: 'err\n[exit status: 2]\n' },
      { type: 'image', data: 'x' },
    ])).toBe(2);
    expect(parseShellExitStatus(SHELL_EXECUTE_TOOL, [
      { type: 'text', text: '[exit status: 2]\n' },
      { type: 'text', text: 'later part wins' },
    ])).toBeUndefined();
  });

  it('is undefined for other tools, empty content and non-array results', () => {
    expect(parseShellExitStatus('read_text_file', failing)).toBeUndefined();
    expect(parseShellExitStatus(SHELL_EXECUTE_TOOL, [])).toBeUndefined();
    expect(parseShellExitStatus(SHELL_EXECUTE_TOOL, { ok: true })).toBeUndefined();
    expect(parseShellExitStatus(SHELL_EXECUTE_TOOL, undefined)).toBeUndefined();
  });

  it('sentinel corpus', () => {
    for (const s of ['[exit status: 1]', 'x\n[exit status: 255]\n', '[exit status: 0]']) expect(SHELL_EXIT_SENTINEL_RE.test(s), s).toBe(true);
    for (const s of ['[exit status: -1]', '[exit status: ]', '[exit status: 1000]', 'text [exit status: 1]', '[exit status: 1] more', '[exit  status: 1]']) {
      expect(SHELL_EXIT_SENTINEL_RE.test(s), s).toBe(false);
    }
  });
});
