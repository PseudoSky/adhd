/**
 * real-turn-telemetry.spec.ts — DEBT-DISPATCH-026.
 *
 * Proves `AgentMcpRunner.queryTurns()` + the rewritten `reconcileTurns()`
 * consume REAL per-turn usage data, not a synthesized aggregate.
 *
 * Real components throughout, mirroring the harness `agent-engine-orchestrator`'s
 * own `src/__tests__/usage-grain.test.ts` already established and proved out for
 * exactly this scenario (real `Orchestrator` + real `HookRegistry` + real
 * `UsagePlugin` + real in-memory `better-sqlite3`, only the LLM provider SDK
 * boundary mocked): a real task is driven through the real orchestration engine
 * with a scripted 2-model-call provider (a tool-call turn then a completion
 * turn), producing 2 real `MODEL_RESPONSE` `task_events` rows for one `taskId`.
 *
 * `usageQueryByGrain` — the REAL function this package's `queryTurns()` calls
 * over the wire in production — is imported directly from
 * `@adhd/agent-engine-orchestrator` and wired as the `usage_query` handler of a
 * `FakeMcpToolClient` (this package's own already-established external-boundary
 * convention, see `agent-runner.spec.ts`/`helpers/fake-mcp-client.ts`): only the
 * MCP stdio transport is faked, never the per-turn computation logic under test.
 *
 * This is a TEST-ONLY boundary crossing into `@adhd/agent-engine-orchestrator`
 * (added as a devDependency, `dispatch-orchestrator/package.json`) — the
 * PRODUCTION `AgentMcpRunner` still crosses to agent-mcp purely over the
 * documented MCP wire (`IMcpToolClient`), unchanged.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import * as schema from '@adhd/agent-store-runtime';
import { TaskStore, generateId, nowIso } from '@adhd/agent-store-runtime';
import type { AgentDefinition, ExecutionContext, Message } from '@adhd/agent-base-types';
import {
  Orchestrator,
  HookRegistry,
  UsagePlugin,
  PolicyEngine,
  usageQueryByGrain,
  type OrchestratorTaskStore,
  type OrchestratorSessionStore,
  type LLMProvider,
  type ProviderChatResponse,
  type Database as OrchestratorDb,
  type TaskUsageInput,
  type McpClientRegistry,
} from '@adhd/agent-engine-orchestrator';

import { AgentMcpRunner, usageToTurns } from '../lib/agent-runner.js';
import { reconcileTurns } from '../lib/orchestrator.js';
import { FakeMcpToolClient } from './helpers/fake-mcp-client.js';

// ---------------------------------------------------------------------------
// ── Harness (mirrors agent-engine-orchestrator's own
//    src/__tests__/usage-grain.test.ts CREATE_TABLES_SQL/makeTestDb/makeCtx/
//    runTask verbatim — this file's TEST-ONLY reach into that package's real
//    engine, not a reimplementation of usageQueryByGrain).
// ---------------------------------------------------------------------------

const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT,
    parent_task_id TEXT,
    is_ephemeral INTEGER DEFAULT 0 NOT NULL,
    recursion_depth INTEGER DEFAULT 0 NOT NULL,
    status TEXT DEFAULT 'pending' NOT NULL,
    prompt TEXT NOT NULL,
    result TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    cancelled_at TEXT,
    depends_on TEXT,
    on_upstream_failure TEXT,
    inputs TEXT,
    resume_token TEXT
);

CREATE TABLE IF NOT EXISTS task_events (
    id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT NOT NULL,
    type TEXT NOT NULL,
    payload TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_usage (
    task_id TEXT PRIMARY KEY NOT NULL,
    root_task_id TEXT,
    agent_name TEXT NOT NULL,
    provider_type TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER DEFAULT 0 NOT NULL,
    output_tokens INTEGER DEFAULT 0 NOT NULL,
    tool_call_count INTEGER DEFAULT 0 NOT NULL,
    model_calls INTEGER DEFAULT 0 NOT NULL,
    latency_ms INTEGER DEFAULT 0 NOT NULL,
    is_complete INTEGER DEFAULT 0 NOT NULL,
    stop_reason TEXT,
    max_tokens INTEGER,
    cache_read_input_tokens INTEGER,
    cache_creation_input_tokens INTEGER,
    uncached_input_tokens INTEGER,
    reasoning_tokens INTEGER,
    peak_context_tokens INTEGER,
    peak_context_at INTEGER,
    compute_ms INTEGER,
    est_tool_result_tokens INTEGER,
    est_cost_usd REAL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_usage_root_task_id ON task_usage (root_task_id);
`;

function makeTestDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(CREATE_TABLES_SQL);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sqlite, { schema }) as any;
  return { sqlite, db: db as OrchestratorDb };
}

function makeAgentDefinition(model: string): AgentDefinition {
  return {
    name: 'turn-telemetry-test-agent',
    version: 1,
    provider: { type: 'anthropic', model },
    systemPrompt: 'You are a test agent.',
    mcpServers: {},
    permissions: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

function makeCtx(taskId: string, sessionId: string, model: string): ExecutionContext {
  return {
    taskId,
    sessionId,
    agentName: 'turn-telemetry-test-agent',
    agentDefinition: makeAgentDefinition(model),
    recursionDepth: 0,
    toolCallCount: 0,
  };
}

function makeUserMessage(sessionId: string): Message {
  return {
    id: generateId(),
    sessionId,
    role: 'user',
    content: 'hello',
    createdAt: nowIso(),
  };
}

const policy = {
  check: () => {
    /* no-op: test stub — policy always permits */
  },
} as unknown as PolicyEngine;

const sessionStore: OrchestratorSessionStore = {
  appendMessage: async () => {
    /* no-op: test stub */
  },
  close: () => {
    /* no-op: test stub */
  },
};

function makeToolRegistry(toolResult: unknown): McpClientRegistry {
  return {
    listAllTools: async () => [
      { name: 'test-server__echo', description: '', inputSchema: { type: 'object', properties: {} } },
    ],
    getClient: async () => ({
      callTool: async () => toolResult,
    }),
    closeAll: async () => {
      /* no-op: test stub */
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as McpClientRegistry;
}

/** Runs the real Orchestrator with a real TaskStore + real UsagePlugin wired via a real HookRegistry. */
async function runTask(opts: {
  db: OrchestratorDb;
  ctx: ExecutionContext;
  provider: LLMProvider;
  registry: McpClientRegistry;
}): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const taskStore = new TaskStore(opts.db as any);
  taskStore.create({ sessionId: opts.ctx.sessionId, prompt: 'test prompt', id: opts.ctx.taskId });

  const hooks = new HookRegistry();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const usagePlugin = new UsagePlugin(opts.db as any);
  usagePlugin.install(hooks);

  await new Orchestrator().run({
    executionContext: opts.ctx,
    messages: [makeUserMessage(opts.ctx.sessionId)],
    registry: opts.registry,
    provider: opts.provider,
    policy,
    taskStore: taskStore as unknown as OrchestratorTaskStore,
    sessionStore,
    signal: new AbortController().signal,
    taskId: opts.ctx.taskId,
    hooks,
  });

  taskStore.updateStatus(opts.ctx.taskId, 'completed', {
    result: 'done',
    completedAt: nowIso(),
  });
}

/**
 * Scripted 2-model-call provider: a tool-call turn (500/50 tokens) then a
 * completion turn (1100/20 tokens) — mirrors
 * agent-engine-orchestrator's own `usage-grain.test.ts` grain:'turn' scenario
 * exactly, so this is a proven-real shape, not a novel one.
 */
function twoTurnProvider(sessionId: string): LLMProvider {
  const toolCallId = generateId();
  let callCount = 0;
  return {
    chat: async (): Promise<ProviderChatResponse> => {
      callCount++;
      if (callCount === 1) {
        return {
          message: {
            id: generateId(),
            sessionId,
            role: 'assistant',
            content: null,
            toolCalls: [{ id: toolCallId, server: 'test-server', tool: 'echo', arguments: {} }],
            createdAt: nowIso(),
          },
          stopReason: 'tool_calls',
          usage: { inputTokens: 500, outputTokens: 50, uncachedInputTokens: 500 },
        };
      }
      return {
        message: {
          id: generateId(),
          sessionId,
          role: 'assistant',
          content: 'done',
          createdAt: nowIso(),
        },
        stopReason: 'completed',
        usage: { inputTokens: 1100, outputTokens: 20, uncachedInputTokens: 1100 },
      };
    },
  };
}

describe('DEBT-DISPATCH-026 — reconcileTurns() consumes real per-turn usage_query rows', () => {
  let sqlite: InstanceType<typeof Database> | undefined;

  afterEach(() => {
    sqlite?.close();
    sqlite = undefined;
  });

  it("a real 2-model-call task's reconciled Turn[] token values deep-equal an independent usageQueryByGrain(db, {task_id, grain:'turn'}) call for the same real task_events-backed task, and yields exactly 2 turns (not 1)", async () => {
    const { db, sqlite: rawDb } = makeTestDb();
    sqlite = rawDb;

    const sessionId = generateId();
    const taskId = generateId();
    const ctx = makeCtx(taskId, sessionId, 'claude_sonnet_4_6');

    await runTask({
      db,
      ctx,
      provider: twoTurnProvider(sessionId),
      registry: makeToolRegistry('a modest tool result'),
    });

    // The seam under test: a FakeMcpToolClient whose `usage_query` handler is
    // LITERALLY `usageQueryByGrain` — the real function — called directly, so
    // the per-turn computation logic is 100% real; only the MCP stdio
    // transport itself is faked (this package's own established convention,
    // see agent-runner.spec.ts).
    const fakeClient = new FakeMcpToolClient({
      usage_query: (args) => usageQueryByGrain(db, args as TaskUsageInput),
    });
    const runner = new AgentMcpRunner({
      command: 'unused-in-test',
      clientFactory: () => fakeClient,
    });

    const realRows = await runner.queryTurns(taskId);
    const reconciled = reconcileTurns(realRows);

    // (2) INDEPENDENT oracle: a SECOND, separate usageQueryByGrain call,
    // never going through AgentMcpRunner/reconcileTurns at all.
    const oracle = usageQueryByGrain(db, { task_id: taskId, grain: 'turn' });

    // Proves dispatch_log[].turns[]-shaped output's token values equal
    // usageQueryByGrain's real turn-grain rows for the same task.
    const reconciledPairs = reconciled
      .map((t) => [t.input_tokens, t.output_tokens] as [number, number])
      .sort((a, b) => a[0] - b[0]);
    const oraclePairs = oracle.rows
      .map((r) => [r.input_tokens, r.output_tokens] as [number, number])
      .sort((a, b) => a[0] - b[0]);
    expect(reconciledPairs).toEqual(oraclePairs);
    expect(reconciledPairs).toEqual([
      [500, 50],
      [1100, 20],
    ]);

    // THE assertion that distinguishes real per-turn data from the old
    // single-row synthesis: 2 real rows flowed through, not 1.
    expect(reconciled).toHaveLength(2);
    expect(realRows).toHaveLength(2);

    // Turn identity is real (call_index/created_at from the real rows), not
    // synthesized — every reconciled turn represents exactly 1 real model call.
    expect(reconciled.every((t) => t.model_calls === 1)).toBe(true);
    expect(reconciled.map((t) => t.turn).sort()).toEqual([1, 2]);
  });

  it('NEGATIVE CONTROL: simulating the OLD usageToTurns-based synthesis inline collapses the same 2-real-call scenario into exactly 1 turn — proving this test has teeth', async () => {
    const { db, sqlite: rawDb } = makeTestDb();
    sqlite = rawDb;

    const sessionId = generateId();
    const taskId = generateId();
    const ctx = makeCtx(taskId, sessionId, 'claude_sonnet_4_6');

    await runTask({
      db,
      ctx,
      provider: twoTurnProvider(sessionId),
      registry: makeToolRegistry('a modest tool result'),
    });

    // The REAL oracle still reports 2 real turns for this task — the data
    // was never actually lost.
    const oracle = usageQueryByGrain(db, { task_id: taskId, grain: 'turn' });
    expect(oracle.rows).toHaveLength(2);

    // Reproduce the OLD collapse-to-aggregate path this package replaced:
    // `poll()`'s `DispatchUsageReport.direct` (a single summed aggregate)
    // fed through `usageToTurns()` (agent-runner.ts, deliberately left
    // in place per DEBT-DISPATCH-026's own spec) then the OLD
    // `reconcileTurns(synthesized, clock)` shape (1 turn per synthesized
    // entry — usageToTurns() ALWAYS returns exactly 1 entry regardless of
    // real model-call count). This is NOT a reimplementation under test —
    // it's the literal OLD call graph this package's diff removed from
    // orchestrator.ts's dispatchUnit(), reconstructed here only to prove
    // the new test would have caught the bug.
    const oldAggregateReport = {
      direct: {
        inputTokens: oracle.rows.reduce((s, r) => s + r.input_tokens, 0),
        outputTokens: oracle.rows.reduce((s, r) => s + r.output_tokens, 0),
        modelCalls: oracle.rows.length,
        toolCallCount: 0,
        latencyMs: 0,
      },
      subtree: {
        inputTokens: oracle.rows.reduce((s, r) => s + r.input_tokens, 0),
        outputTokens: oracle.rows.reduce((s, r) => s + r.output_tokens, 0),
        modelCalls: oracle.rows.length,
        toolCallCount: 0,
        latencyMs: 0,
      },
      taskCount: 1,
    };
    const oldSynthesized = usageToTurns(oldAggregateReport);
    const oldClock = () => '2026-01-01T00:00:00.000Z';
    const oldReconciled = oldSynthesized.map((s, i) => ({
      turn: i + 1,
      input_tokens: s.input_tokens,
      output_tokens: s.output_tokens,
      t: oldClock(),
      model_calls: s.model_calls,
    }));

    // THE red assertion: the OLD path collapses 2 real model calls into
    // exactly 1 synthesized turn — this is the exact bug DEBT-DISPATCH-026
    // fixes. Asserting `length === 2` against the OLD path's output fails.
    expect(oldReconciled).toHaveLength(1);
    expect(oldReconciled).not.toHaveLength(2);
  });
});
