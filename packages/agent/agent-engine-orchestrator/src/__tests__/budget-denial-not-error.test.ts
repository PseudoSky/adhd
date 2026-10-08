import { describe, expect, it } from 'vitest';

import { HookRegistry } from '@adhd/agent-base-types';
import { createPlugin } from '@adhd/agent-plugin-budget';

import { Orchestrator } from '../engine/orchestrator.js';
import type {
  OrchestratorTaskStore,
  OrchestratorSessionStore,
} from '../engine/orchestrator.js';
import { PolicyEngine } from '../engine/policy.js';
import { ToolError } from '../validation/errors.js';
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
 * df7c3af9 — allowlist / policy denials are ordinary results, not faults.
 *
 * Ticket df7c3af9: the budget plugin's `errors` / `consecutiveErrors` caps bound
 * FAULTS. The adopted argv-allowlist shell server (`mcp-shell-server`) answers a
 * non-allowlisted command with an MCP `isError` result ("Command not allowed:
 * <cmd>"); the stdio/http client turns every MCP `isError` into a thrown
 * `ToolError('MCP_CLIENT_ERROR', …)`, which the engine used to report as a plain
 * `isError: true` post:tool_call — so five allowlist denials tripped the errors
 * cap and disabled every tool for the task.
 *
 * Driven through the REAL engine `run()` with the REAL `HookRegistry` and the REAL
 * budget plugin; only the LLM provider and the MCP client boundary are stubbed.
 *
 *  - df7c3af9 AC1: N allowlist denials never trip an `errors` / `consecutiveErrors` cap.
 *  - df7c3af9 AC2: genuine tool faults still count and still trip the cap.
 *  - df7c3af9 AC3: this file is the citing test (ticket id + AC id in every name).
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

/** The exact error text the stdio client raises for an MCP `isError` result. */
function mcpClientError(text: string): ToolError {
  return new ToolError(
    'MCP_CLIENT_ERROR',
    `Tool 'shell_execute' on server 'shell' returned an error: ${JSON.stringify([
      { type: 'text', text },
    ])}`
  );
}

/** Registry whose shell client rejects every call with the next scripted error. */
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

async function runWithBudget(
  caps: Array<{ field: string; maximum: number; mode: 'block' }>,
  errors: Array<Error | null>,
  toolTurns: number
): Promise<{ result: string; executed: string[] }> {
  const hooks = new HookRegistry();
  const plugin = await createPlugin({ db: null, config: { defaults: { caps } } });
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
    registry: makeRegistry(errors, executed),
    provider: scriptedProvider(toolTurns),
    policy,
    taskStore,
    sessionStore,
    signal: new AbortController().signal,
    taskId: ctx.taskId,
    hooks,
    logger: silentLogger,
  });
  return { result, executed };
}

const ERROR_CAPS = [
  { field: 'errors', maximum: 2, mode: 'block' as const },
  { field: 'consecutiveErrors', maximum: 2, mode: 'block' as const },
];

describe('df7c3af9 allowlist denials are not errors (real engine + real budget plugin)', () => {
  it('df7c3af9 AC1 — five shell allowlist denials never trip the errors / consecutiveErrors caps; every call still executes', async () => {
    const { result, executed } = await runWithBudget(
      ERROR_CAPS,
      [mcpClientError('Command not allowed: frobnicate')],
      5
    );
    expect(executed).toHaveLength(5);
    expect(result).toBe('done');
  });

  it('df7c3af9 AC2 — genuine tool faults still count: the same caps trip on the third fault', async () => {
    await expect(
      runWithBudget(ERROR_CAPS, [new Error('ECONNRESET: server crashed')], 5)
    ).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
  });

  it('df7c3af9 AC2 — an MCP isError result that is NOT an allowlist denial is a fault and counts', async () => {
    await expect(
      runWithBudget(ERROR_CAPS, [mcpClientError('Command timed out after 30s')], 5)
    ).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
  });
});
