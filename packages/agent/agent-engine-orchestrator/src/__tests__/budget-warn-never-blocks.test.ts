import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import { HookRegistry } from '@adhd/agent-base-types';
import { createPlugin } from '@adhd/agent-plugin-budget';

import { Orchestrator } from '../engine/orchestrator.js';
import type {
  OrchestratorTaskStore,
  OrchestratorSessionStore,
} from '../engine/orchestrator.js';
import { PolicyEngine } from '../engine/policy.js';
import { nowIso } from '../utils/timestamps.js';
import { generateId } from '../utils/ids.js';
import type {
  LLMProvider,
  ProviderChatResponse,
  ToolDefinition,
} from '../providers/types.js';
import type { ExecutionContext, Message } from '../validation/index.js';
import type { McpClientRegistry } from '../clients/registry.js';
import type { EngineLogger } from '../interfaces.js';

/**
 * 9ed453c1 BUDGET-B1 — a tripped `warning`-mode budget never alters a tool call.
 *
 * Production symptom: a global windowed `inputTokens` cap in `warning` mode
 * soft-blocked a tool call ("inputTokens limit is 500000, current value is
 * 4201334"). Driven through the REAL engine `run()`, the REAL `HookRegistry`, the
 * REAL budget plugin and REAL better-sqlite3 `task_usage` rows; only the LLM
 * provider and the MCP client boundary are stubbed.
 *
 *  - AC-W1: warning → every scripted tool call executes, the run completes, and
 *    exactly one `budget:warning` is emitted for the (budget, task).
 *  - AC-W3: soft-block → the legacy behaviour: tool calls are skipped.
 *  - AC-W4: block → the run fails with BUDGET_EXCEEDED.
 */

const policy = { check: () => {} } as unknown as PolicyEngine;
const silentLogger: EngineLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const SHELL_TOOL: ToolDefinition = {
  name: 'shell__shell_execute',
  description: 'run an allowlisted argv',
  inputSchema: { type: 'object', properties: {} },
};

function makeCtx(): ExecutionContext {
  return {
    taskId: generateId(),
    sessionId: generateId(),
    agentName: 'test-agent',
    agentDefinition: {
      name: 'test-agent',
      version: 1,
      provider: { type: 'openai', model: 'gpt-4o-mini' },
      systemPrompt: 'You are helpful.',
      mcpServers: {},
      permissions: {},
      createdAt: nowIso(),
      updatedAt: nowIso(),
    } as ExecutionContext['agentDefinition'],
    recursionDepth: 0,
    toolCallCount: 0,
  };
}

/** Registry whose shell client answers each call (scripted errors, null = success). */
function makeRegistry(errors: Array<Error | null>, executed: string[]): McpClientRegistry {
  let n = 0;
  return {
    listAllTools: async () => [{ ...SHELL_TOOL }],
    closeAll: async () => {},
    getClient: async () => ({
      callTool: async (tool: string) => {
        executed.push(tool);
        const err = errors[Math.min(n, errors.length - 1)];
        n++;
        if (err) throw err;
        return [{ type: 'text', text: 'ran' }];
      },
    }),
  } as unknown as McpClientRegistry;
}

/** `toolTurns` shell tool-call turns, then one completed turn. */
function scriptedProvider(toolTurns: number): LLMProvider {
  let call = 0;
  return {
    chat: async (): Promise<ProviderChatResponse> => {
      const sessionId = generateId();
      if (call++ >= toolTurns) {
        return {
          message: {
            id: generateId(),
            sessionId,
            role: 'assistant',
            content: 'done',
            createdAt: nowIso(),
          },
          stopReason: 'completed',
        };
      }
      return {
        message: {
          id: generateId(),
          sessionId,
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: generateId(), server: 'shell', tool: 'shell_execute', arguments: {} },
          ],
          createdAt: nowIso(),
        },
        stopReason: 'tool_calls',
      };
    },
  };
}

const taskStore: OrchestratorTaskStore = {
  updateStatus: () => {},
  appendEvent: () => {},
  unregisterCancellation: () => {},
};
const sessionStore: OrchestratorSessionStore = {
  appendMessage: async () => {},
  close: () => {},
};


/** Real task_usage/tasks tables (the subset the budget queries touch) with one prior 24h row. */
function realDbWithPriorUsage(input: number, output: number) {
  const sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, session_id TEXT)`);
  sqlite.exec(`CREATE TABLE task_usage (
    task_id TEXT PRIMARY KEY, agent_name TEXT,
    input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
    model_calls INTEGER DEFAULT 0, peak_context_tokens INTEGER,
    cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER,
    uncached_input_tokens INTEGER, created_at TEXT)`);
  sqlite
    .prepare(`INSERT INTO tasks (id, session_id) VALUES ('prior', 'prior-sess')`)
    .run();
  sqlite
    .prepare(
      `INSERT INTO task_usage (task_id, agent_name, input_tokens, output_tokens, model_calls, created_at)
       VALUES ('prior', 'other-agent', ?, ?, 1, ?)`
    )
    .run(input, output, new Date().toISOString());
  return drizzle(sqlite);
}

async function runWithMode(
  mode: string,
  toolTurns: number
): Promise<{ result: string; executed: string[]; warnings: string[] }> {
  const hooks = new HookRegistry();
  const warnings: string[] = [];
  hooks.register('budget:warning', (p) => {
    warnings.push(p.message ?? '');
  });
  const plugin = await createPlugin({
    // 600k input history trips the 500k cap; the 4.2M figure in the production
    // error was input+output history, so output must not be what trips it here.
    db: realDbWithPriorUsage(600_000, 0),
    config: {
      defaults: {
        scope: 'global',
        mode,
        caps: [
          { field: 'inputTokens', maximum: 500_000, window: 'PT24H', scope: 'global' },
        ],
      },
    },
  });
  await plugin.install(hooks);
  const ctx = makeCtx();
  const executed: string[] = [];
  const user: Message = {
    id: generateId(),
    sessionId: ctx.sessionId,
    role: 'user',
    content: 'hello',
    createdAt: nowIso(),
  };
  const { result } = await new Orchestrator().run({
    executionContext: ctx,
    messages: [user],
    registry: makeRegistry([null], executed),
    provider: scriptedProvider(toolTurns),
    policy,
    taskStore,
    sessionStore,
    signal: new AbortController().signal,
    taskId: ctx.taskId,
    hooks,
    logger: silentLogger,
  });
  return { result, executed, warnings };
}

describe('9ed453c1 BUDGET-B1 warn never blocks (real engine + real budget plugin + real sqlite)', () => {
  it('9ed453c1 BUDGET-B1 AC-W1 — a tripped warning-mode global cap does not stop any tool call; one budget:warning for the task', async () => {
    const { result, executed, warnings } = await runWithMode('warning', 3);
    expect(executed).toHaveLength(3);
    expect(result).toBe('done');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('WARN');
    expect(warnings[0]).toContain('Warning only; execution continues.');
  });

  it('9ed453c1 BUDGET-B1 AC-W3 — soft-block reproduces the legacy skip: no tool call executes, the run still completes', async () => {
    const { result, executed } = await runWithMode('soft-block', 3);
    expect(executed).toHaveLength(0);
    expect(result).toBe('done');
  });

  it('9ed453c1 BUDGET-B1 AC-W4 — block fails the run with BUDGET_EXCEEDED', async () => {
    await expect(runWithMode('block', 3)).rejects.toMatchObject({
      code: 'BUDGET_EXCEEDED',
    });
  });
});
