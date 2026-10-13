import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreToolCallPayload } from '@adhd/agent-base-types';
import type { ToolDefinition } from '@adhd/agent-engine-orchestrator';
import { createPlugin } from '../index.js';
import { HookRegistry, makeLogDir, readRecords } from '../test/harness.js';
import type { Recorded } from '../test/harness.js';
import { runThroughEngine } from '../test/provider-wire.js';
import type { Adapter, IScriptedCall } from '../test/provider-wire.js';

/**
 * a2a9c6db AC1: `agent.tool.queued_ms`, `agent.tool.group_index` and `tool_barrier_waits_total` carry the
 * ENGINE-FINAL values, proven by a real engine run (no preset payload).
 *
 * Real: the tracing plugin, `HookRegistry`, `Orchestrator.run()` with its concurrency limiter and group
 * planner, the real `AnthropicProvider` / `OpenAIProvider` (DeepSeek and every OpenAI-compatible endpoint)
 * over the `wire.fetch` seam, the `@adhd/sox-telemetry` file sink. Scripted: the model's replies and the MCP
 * tool results. The clock the limiter reads (`performance.now`) is a test-controlled counter that a latched
 * barrier tool advances, so the wait is exact and nothing sleeps or reads the wall clock.
 *
 * claudecli: its tool calls come through the engine's bridge (`executeTool`), which has no ordered plan, so
 * the engine reports no schedule for them: the trace must carry no `queued_ms` / `group_index` (never a 0).
 */

const schema = { type: 'object', properties: { path: { type: 'string' } } };
const TOOLS: ToolDefinition[] = [
  { name: 'fs__read_text_file', description: 'read', inputSchema: schema, annotations: { readOnlyHint: true } },
  { name: 'fs__list_directory', description: 'list', inputSchema: schema, annotations: { readOnlyHint: true } },
  { name: 'fs__edit_file', description: 'edit', inputSchema: schema, annotations: { readOnlyHint: false } },
];
const text = (s: string) => [{ type: 'text', text: s }];

let log: ReturnType<typeof makeLogDir>;
beforeEach(() => {
  log = makeLogDir();
});
afterEach(() => {
  vi.restoreAllMocks();
  log.dispose();
});

function spanRecords(dir: string): Recorded[] {
  return readdirSync(dir)
    .filter((n) => n.endsWith('.jsonl') && !n.includes('metrics-snapshot'))
    .sort()
    .flatMap((n) => readRecords(join(dir, n)));
}

/** Install the real tracing plugin on a fresh registry. */
async function traced() {
  const hooks = new HookRegistry();
  const plugin = createPlugin({ db: null, config: { service: 'tool-queue', logDir: log.dir } });
  await plugin.install(hooks);
  return { hooks, plugin };
}

/** A clock the limiter reads: starts at 0 and only moves when the test (inside a tool) advances it. */
function controlledClock() {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  return { advance: (ms: number) => (now += ms) };
}

const finishOf = (recs: Recorded[], callId: string): Recorded | undefined =>
  recs.find((r) => r.event === 'agent.tool_call.finish' && r['agent.tool.call_id'] === callId);
const startOf = (recs: Recorded[], callId: string): Recorded | undefined =>
  recs.find((r) => r.event === 'agent.tool_call.start' && r['agent.tool.call_id'] === callId);

const ADAPTERS: readonly Adapter[] = ['anthropic', 'openai'];

describe.each(ADAPTERS)('a2a9c6db AC1 [%s]: engine-final queued_ms / group_index reach the trace from a real run', (adapter) => {
  it(`a2a9c6db AC1 [${adapter}]: a read queued behind an edit barrier records its exact wait on the finish record and counts one barrier wait`, async () => {
    const clock = controlledClock();
    const { hooks, plugin } = await traced();
    const gate = (() => {
      let resolve!: () => void;
      return { promise: new Promise<void>((r) => (resolve = r)), resolve };
    })();
    const editStarted = (() => {
      let resolve!: () => void;
      return { promise: new Promise<void>((r) => (resolve = r)), resolve };
    })();
    const calls: IScriptedCall[] = [
      { id: 'call_edit', name: 'fs__edit_file', input: { path: 'a' } },
      { id: 'call_read', name: 'fs__read_text_file', input: { path: 'a' } },
    ];
    const running = runThroughEngine({
      adapter,
      calls,
      tools: TOOLS,
      hooks,
      callTool: async (tool) => {
        if (tool === 'edit_file') {
          editStarted.resolve();
          await gate.promise;
          clock.advance(250); // the barrier holds the read for exactly 250ms of the limiter's clock
        }
        return text(`ok:${tool}`);
      },
    });
    await editStarted.promise;
    gate.resolve();
    await running;
    await plugin.dispose();
    const recs = spanRecords(log.dir);

    const edit = finishOf(recs, 'call_edit');
    const read = finishOf(recs, 'call_read');
    expect([edit?.['agent.tool.group_index'], read?.['agent.tool.group_index']]).toEqual([0, 1]);
    expect([edit?.['agent.tool.queued_ms'], read?.['agent.tool.queued_ms']]).toEqual([0, 250]);
    expect(plugin.counters().tool_barrier_waits_total).toBe(1);
    // the start record opens the span before the engine knows either figure, so it carries neither
    for (const id of ['call_edit', 'call_read']) {
      const start = startOf(recs, id);
      expect(start, id).toBeDefined();
      expect(['agent.tool.group_index', 'agent.tool.queued_ms'].filter((k) => k in (start ?? {})), id).toEqual([]);
    }
  });

  it(`a2a9c6db AC1 [${adapter}]: group_index is the group the call actually ran in, not the planned one (a permission-denied call leaves the plan)`, async () => {
    controlledClock();
    const { hooks, plugin } = await traced();
    const planned = new Map<string, number | undefined>();
    hooks.register('pre:tool_call', (p: PreToolCallPayload) => {
      planned.set(p.callId, p.groupIndex); // the value a handler sees synchronously at emit time
    });
    // [read (denied), edit (barrier), list]: planned groups 0, 1, 2. With the read refused the edit runs in 0, the list in 1.
    const calls: IScriptedCall[] = [
      { id: 'call_read', name: 'fs__read_text_file', input: { path: 'a' } },
      { id: 'call_edit', name: 'fs__edit_file', input: { path: 'a' } },
      { id: 'call_list', name: 'fs__list_directory', input: { path: '.' } },
    ];
    await runThroughEngine({
      adapter,
      calls,
      tools: TOOLS,
      hooks,
      gate: ({ tool }) => (tool === 'read_text_file' ? 'deny' : 'allow'),
      callTool: async (tool) => text(`ok:${tool}`),
    });
    await plugin.dispose();
    const recs = spanRecords(log.dir);

    expect(planned.get('call_edit')).toBe(1);
    expect(planned.get('call_list')).toBe(2);
    expect(finishOf(recs, 'call_edit')?.['agent.tool.group_index']).toBe(0);
    expect(finishOf(recs, 'call_list')?.['agent.tool.group_index']).toBe(1);
  });
});

describe('a2a9c6db AC1 [claudecli]: a bridged call has no engine schedule, so the trace carries no queued_ms / group_index', () => {
  it('a2a9c6db AC1 [claudecli]: bridged calls record neither figure (absent, never 0) and count no barrier wait', async () => {
    controlledClock();
    const { hooks, plugin } = await traced();
    const calls: IScriptedCall[] = [
      { id: 'b1', name: 'fs__edit_file', input: { path: 'a' } },
      { id: 'b2', name: 'fs__read_text_file', input: { path: 'a' } },
    ];
    let n = 0;
    const out = await runThroughEngine({
      adapter: 'claudecli',
      calls,
      tools: TOOLS,
      hooks,
      callTool: async (tool) => text(`ok:${tool}:${++n}`),
    });
    await plugin.dispose();
    expect(out.bridged).toHaveLength(2);
    const recs = spanRecords(log.dir);
    const finishes = recs.filter((r) => r.event === 'agent.tool_call.finish');
    expect(finishes).toHaveLength(2);
    for (const f of finishes) {
      expect(['agent.tool.group_index', 'agent.tool.queued_ms'].filter((k) => k in f), String(f['agent.tool.call_id'])).toEqual([]);
    }
    expect(plugin.counters().tool_barrier_waits_total).toBe(0);
  });
});
