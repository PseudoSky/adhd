import { describe, expect, it } from 'vitest';

import { Orchestrator } from '../engine/orchestrator.js';
import type {
  OrchestratorTaskStore,
  OrchestratorSessionStore,
} from '../engine/orchestrator.js';
import { PolicyEngine } from '../engine/policy.js';
import { nowIso } from '../utils/timestamps.js';
import { generateId } from '../utils/ids.js';
import type { LLMProvider, ProviderChatResponse, ToolDefinition } from '../providers/types.js';
import type { ExecutionContext, Message } from '../validation/index.js';
import type { McpClientRegistry } from '../clients/registry.js';
import type { EngineConfig, EngineLogger } from '../interfaces.js';

/**
 * 35768ae8 (R3-PAR-ENG) — same-turn tool calls run through a concurrency-limited
 * pool. Driven through the REAL engine `run()`; only the LLM provider and the MCP
 * client boundary are stubbed. Latch-based: no sleeps, no wall clock.
 *
 *  - 35768ae8 AC1: N=3 calls under limit>=3 are all in flight before any finishes.
 *  - 35768ae8 AC2: limit=2 over 5 calls peaks at exactly 2 in flight; result order == call order.
 *  - 35768ae8 AC3: one failing call does not cancel the others.
 */

const policy = { check: () => {} } as unknown as PolicyEngine;
const silentLogger: EngineLogger = { info() {}, warn() {}, error() {}, debug() {} } as EngineLogger;
const TOOL: ToolDefinition = { name: 'lat__work', description: 'latch tool', inputSchema: { type: 'object', properties: {} } };

const taskStore: OrchestratorTaskStore = {
  updateStatus: () => {},
  appendEvent: () => {},
  unregisterCancellation: () => {},
};
const sessionStore: OrchestratorSessionStore = { appendMessage: async () => {}, close: () => {} };

function makeCtx(): ExecutionContext {
  return {
    taskId: generateId(),
    sessionId: generateId(),
    agentName: 'test-agent',
    agentDefinition: {
      name: 'test-agent',
      version: 1,
      provider: { type: 'openai', model: 'gpt-4o-mini' },
      systemPrompt: 'x',
      mcpServers: {},
      permissions: {},
      createdAt: nowIso(),
      updatedAt: nowIso(),
    } as ExecutionContext['agentDefinition'],
    recursionDepth: 0,
    toolCallCount: 0,
  };
}

/** A deferred the test resolves by hand. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** One turn of `n` calls (ids c0..c{n-1}, argument `i`), then a completed turn. */
function provider(n: number): { p: LLMProvider; toolMessages: Array<{ id: string; content: unknown }> } {
  let call = 0;
  const toolMessages: Array<{ id: string; content: unknown }> = [];
  const p = {
    chat: async (req: { messages?: Array<Record<string, unknown>> }): Promise<ProviderChatResponse> => {
      const sessionId = generateId();
      if (call++ > 0) {
        for (const m of req.messages ?? []) {
          if (m['role'] !== 'tool') continue;
          for (const r of (m['toolResults'] as Array<{ toolCallId: string; result: unknown }>) ?? []) {
            toolMessages.push({ id: r.toolCallId, content: r.result });
          }
        }
        return {
          message: { id: generateId(), sessionId, role: 'assistant', content: 'done', createdAt: nowIso() },
          stopReason: 'completed',
        };
      }
      return {
        message: {
          id: generateId(),
          sessionId,
          role: 'assistant',
          content: '',
          toolCalls: Array.from({ length: n }, (_, i) => ({
            id: `c${i}`,
            server: 'lat',
            tool: 'work',
            arguments: { i },
          })),
          createdAt: nowIso(),
        },
        stopReason: 'tool_calls',
      };
    },
  } as unknown as LLMProvider;
  return { p, toolMessages };
}

async function runTurn(opts: {
  n: number;
  config?: Partial<EngineConfig>;
  callTool: (i: number) => Promise<unknown>;
}) {
  const ctx = makeCtx();
  const { p, toolMessages } = provider(opts.n);
  const registry = {
    listAllTools: async () => [{ ...TOOL }],
    closeAll: async () => {},
    getClient: async () => ({
      callTool: async (_t: string, args: { i: number }) => opts.callTool(args.i),
    }),
  } as unknown as McpClientRegistry;
  const user: Message = { id: generateId(), sessionId: ctx.sessionId, role: 'user', content: 'go', createdAt: nowIso() };
  const out = await new Orchestrator().run({
    executionContext: ctx,
    messages: [user],
    registry,
    provider: p,
    policy,
    taskStore,
    sessionStore,
    signal: new AbortController().signal,
    taskId: ctx.taskId,
    logger: silentLogger,
    config: { server: { contextLimit: 0, defaultMaxTokens: 8192 }, ...opts.config } as EngineConfig,
  });
  return { result: out.result, toolMessages };
}

/** Yields to the event loop a bounded number of times (no timers). */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise<void>((r) => setImmediate(r));
}

describe('35768ae8 R3-PAR-ENG bounded same-turn tool-call fan-out (real engine)', () => {
  it('35768ae8 AC1 R3-PAR-ENG — 3 calls under limit 3 are all started before any finishes', async () => {
    const started = new Set<number>();
    const release = deferred();
    const allStarted = deferred();
    const run = runTurn({
      n: 3,
      config: { toolCallConcurrency: 3 },
      callTool: async (i) => {
        started.add(i);
        if (started.size === 3) allStarted.resolve();
        await release.promise; // nobody finishes until all three have started
        return [{ type: 'text', text: `r${i}` }];
      },
    });
    await allStarted.promise; // hangs (test timeout) if the calls were serialized
    expect([...started].sort()).toEqual([0, 1, 2]);
    release.resolve();
    expect((await run).result).toBe('done');
  });

  it('35768ae8 AC1 R3-PAR-ENG — the default limit (8) also runs 3 calls concurrently', async () => {
    const started = new Set<number>();
    const release = deferred();
    const allStarted = deferred();
    const run = runTurn({
      n: 3,
      callTool: async (i) => {
        started.add(i);
        if (started.size === 3) allStarted.resolve();
        await release.promise;
        return [{ type: 'text', text: 'ok' }];
      },
    });
    await allStarted.promise;
    release.resolve();
    await run;
  });

  it('35768ae8 AC2 R3-PAR-ENG — limit 2 over 5 calls: peak in-flight is exactly 2, results in call order', async () => {
    let inFlight = 0;
    let peak = 0;
    const gates = Array.from({ length: 5 }, () => deferred());
    const startedIdx: number[] = [];
    const run = runTurn({
      n: 5,
      config: { toolCallConcurrency: 2 },
      callTool: async (i) => {
        startedIdx.push(i);
        inFlight++;
        peak = Math.max(peak, inFlight);
        await gates[i].promise;
        inFlight--;
        return [{ type: 'text', text: `r${i}` }];
      },
    });
    await settle();
    expect(startedIdx).toEqual([0, 1]); // call 2 is queued, not started
    gates[1].resolve(); // finish out of order: 1 before 0
    await settle();
    expect(startedIdx).toEqual([0, 1, 2]);
    gates[0].resolve();
    await settle();
    expect(startedIdx).toEqual([0, 1, 2, 3]);
    gates[4].resolve(); // pre-resolved gates are fine for calls not yet started
    gates[3].resolve();
    gates[2].resolve();
    const { toolMessages } = await run;
    expect(peak).toBe(2);
    expect(startedIdx.slice().sort()).toEqual([0, 1, 2, 3, 4]);
    expect(toolMessages.map((m) => m.id)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
  });

  it('35768ae8 AC3 R3-PAR-ENG — one failing call does not cancel the others', async () => {
    const started = new Set<number>();
    const failed = deferred();
    const allStarted = deferred();
    const { result, toolMessages } = await runTurn({
      n: 3,
      config: { toolCallConcurrency: 3 },
      callTool: async (i) => {
        started.add(i);
        if (started.size === 3) allStarted.resolve();
        await allStarted.promise;
        if (i === 1) {
          failed.resolve();
          throw new Error('boom');
        }
        await failed.promise; // siblings finish only AFTER the failure happened
        return [{ type: 'text', text: `ok${i}` }];
      },
    });
    expect(result).toBe('done');
    expect(toolMessages.map((m) => m.id)).toEqual(['c0', 'c1', 'c2']);
    const text = toolMessages.map((m) => JSON.stringify(m.content));
    expect(text[0]).toContain('ok0');
    expect(text[1]).toContain('boom');
    expect(text[2]).toContain('ok2');
  });
});
