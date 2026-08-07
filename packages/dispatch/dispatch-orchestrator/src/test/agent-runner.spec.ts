import { describe, expect, it } from 'vitest';
import {
  AgentMcpRunner,
  AgentMcpToolError,
  usageToTurns,
  type DispatchUsageReport,
} from '../lib/agent-runner.js';
import {
  FakeMcpToolClient,
  mcpError,
  type FakeToolHandler,
} from './helpers/fake-mcp-client.js';
import { makeUnit } from './helpers/fixtures.js';

// ---------------------------------------------------------------------------
// usageToTurns — (a) mapping with teeth
// ---------------------------------------------------------------------------

describe('usageToTurns', () => {
  it('maps TaskUsageReport.direct into a single synthesized turn with snake_case fields', () => {
    // direct and subtree deliberately differ so a direct/subtree mix-up fails this assertion.
    const report: DispatchUsageReport = {
      direct: {
        inputTokens: 120,
        outputTokens: 45,
        modelCalls: 3,
        toolCallCount: 2,
        latencyMs: 900,
      },
      subtree: {
        inputTokens: 500,
        outputTokens: 200,
        modelCalls: 9,
        toolCallCount: 6,
        latencyMs: 4000,
      },
      taskCount: 3,
    };

    expect(usageToTurns(report)).toEqual([
      { input_tokens: 120, output_tokens: 45, model_calls: 3 },
    ]);
  });

  it('returns exactly one entry regardless of how many model calls were made', () => {
    const report: DispatchUsageReport = {
      direct: {
        inputTokens: 1,
        outputTokens: 1,
        modelCalls: 17,
        toolCallCount: 0,
        latencyMs: 1,
      },
      subtree: {
        inputTokens: 1,
        outputTokens: 1,
        modelCalls: 17,
        toolCallCount: 0,
        latencyMs: 1,
      },
      taskCount: 1,
    };
    expect(usageToTurns(report)).toHaveLength(1);
  });

  it('returns [] when report is undefined (task recorded zero model calls)', () => {
    expect(usageToTurns(undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AgentMcpRunner — (c) injected fake MCP client, call sequence + arguments
// ---------------------------------------------------------------------------

function makeRunner(handlers: Record<string, FakeToolHandler>) {
  const client = new FakeMcpToolClient(handlers);
  const runner = new AgentMcpRunner({
    command: 'unused-in-test',
    clientFactory: () => client,
  });
  return { client, runner };
}

describe('AgentMcpRunner', () => {
  describe('ensureAgent', () => {
    it('does nothing beyond agent_read when the agent already exists', async () => {
      const { client, runner } = makeRunner({
        agent_read: (args) => ({
          name: args?.['name'],
          provider: { type: 'claudecli' },
          mcpServers: {},
          permissions: {},
          version: 1,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }),
      });

      await runner.ensureAgent(
        makeUnit({ agent_name: 'workflow-researcher' })
      );

      expect(client.calls).toEqual([
        { name: 'agent_read', arguments: { name: 'workflow-researcher' } },
      ]);
    });

    it('creates the agent with mcpServers: {} and the right name/provider when agent_read misses', async () => {
      const { client, runner } = makeRunner({
        agent_read: () =>
          mcpError('AGENT_NOT_FOUND', "Agent 'workflow-researcher' not found"),
        agent_create: (args) => ({
          ...args,
          version: 1,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }),
      });

      const unit = makeUnit({
        agent_name: 'workflow-researcher',
        systemPrompt: 'STABLE PREAMBLE BODY',
        prompt: 'COMPILED PROMPT BODY',
      });
      await runner.ensureAgent(unit);

      expect(client.calls.map((c) => c.name)).toEqual([
        'agent_read',
        'agent_create',
      ]);
      // NEGATIVE-CONTROL: change the mcpServers: {} literal in
      // AgentMcpRunner.ensureAgent()'s agent_create call to mcpServers: null
      // — this assertion goes red.
      expect(client.calls[1]?.arguments).toEqual({
        name: 'workflow-researcher',
        provider: { type: 'claudecli' },
        systemPrompt: 'STABLE PREAMBLE BODY',
        mcpServers: {},
      });
    });

    // DEBT-DISPATCH-012: ensureAgent's agent_create must bake unit.systemPrompt
    // (the stable, milestone-independent preamble) — never unit.prompt (the
    // per-fire compiled task body) — into the agent's systemPrompt. Distinct
    // 'SHORT'/'LONG...' values below make any accidental swap or fallback to
    // `unit.prompt` immediately visible.
    it('bakes unit.systemPrompt — never unit.prompt — into agent_create systemPrompt (DEBT-DISPATCH-012)', async () => {
      const { client, runner } = makeRunner({
        agent_read: () =>
          mcpError('AGENT_NOT_FOUND', "Agent 'workflow-researcher' not found"),
        agent_create: (args) => ({
          ...args,
          version: 1,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }),
      });

      const unit = makeUnit({
        agent_name: 'workflow-researcher',
        systemPrompt: 'SHORT',
        prompt: 'LONG milestone body...',
      });
      await runner.ensureAgent(unit);

      const createCall = client.calls[1];
      expect(createCall?.name).toBe('agent_create');
      // NEGATIVE-CONTROL: reverting agent-runner.ts's `ensureAgent` to
      // `systemPrompt: unit.prompt ?? undefined` makes this assertion see
      // 'LONG milestone body...' instead of 'SHORT' and fail.
      expect(createCall?.arguments?.['systemPrompt']).toBe('SHORT');
    });

    it('rethrows non-AGENT_NOT_FOUND errors from agent_read and never calls agent_create', async () => {
      const { client, runner } = makeRunner({
        agent_read: () => mcpError('VALIDATION_ERROR', 'boom'),
      });

      await expect(runner.ensureAgent(makeUnit())).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
      expect(client.calls.map((c) => c.name)).toEqual(['agent_read']);
    });
  });

  describe('fire', () => {
    it('calls task in ephemeral mode with exactly {agent_name, prompt} and maps task_id -> taskId', async () => {
      const { client, runner } = makeRunner({
        task: () => ({
          task_id: 'wire-task-abc',
          status: 'completed',
          result: 'done',
        }),
      });

      const unit = makeUnit({
        agent_name: 'workflow-researcher',
        prompt: 'THE PROMPT',
      });
      const { taskId } = await runner.fire(unit);

      expect(taskId).toBe('wire-task-abc');
      expect(client.calls).toEqual([
        {
          name: 'task',
          arguments: { agent_name: 'workflow-researcher', prompt: 'THE PROMPT' },
        },
      ]);
    });

    it('throws without calling the client when unit.prompt is null', async () => {
      const { client, runner } = makeRunner({});

      await expect(runner.fire(makeUnit({ prompt: null }))).rejects.toThrow(
        /no compiled prompt/
      );
      expect(client.calls).toEqual([]);
    });
  });

  describe('poll', () => {
    it('calls result with {task_id} and returns {status, usage}', async () => {
      const usage: DispatchUsageReport = {
        direct: {
          inputTokens: 10,
          outputTokens: 5,
          modelCalls: 1,
          toolCallCount: 0,
          latencyMs: 100,
        },
        subtree: {
          inputTokens: 10,
          outputTokens: 5,
          modelCalls: 1,
          toolCallCount: 0,
          latencyMs: 100,
        },
        taskCount: 1,
      };
      const { client, runner } = makeRunner({
        result: (args) => ({
          id: args?.['task_id'],
          status: 'completed',
          usage,
        }),
      });

      const out = await runner.poll('task-xyz');

      expect(out).toEqual({ status: 'completed', usage });
      expect(client.calls).toEqual([
        { name: 'result', arguments: { task_id: 'task-xyz' } },
      ]);
    });

    it('returns usage: undefined when the wire response omits it (zero model calls)', async () => {
      const { runner } = makeRunner({ result: () => ({ status: 'running' }) });

      const out = await runner.poll('task-xyz');

      expect(out).toEqual({ status: 'running', usage: undefined });
    });
  });

  describe('cancel', () => {
    it('calls task_cancel with {task_id}', async () => {
      const { client, runner } = makeRunner({
        task_cancel: () => ({ success: true }),
      });

      await runner.cancel('task-xyz');

      expect(client.calls).toEqual([
        { name: 'task_cancel', arguments: { task_id: 'task-xyz' } },
      ]);
    });

    it('propagates tool errors (e.g. TASK_NOT_CANCELLABLE) as AgentMcpToolError', async () => {
      const { runner } = makeRunner({
        task_cancel: () =>
          mcpError(
            'TASK_NOT_CANCELLABLE',
            "Task 'task-xyz' has status 'completed' and cannot be cancelled"
          ),
      });

      await expect(runner.cancel('task-xyz')).rejects.toBeInstanceOf(
        AgentMcpToolError
      );
      await expect(runner.cancel('task-xyz')).rejects.toMatchObject({
        code: 'TASK_NOT_CANCELLABLE',
      });
    });
  });

  describe('client lifecycle', () => {
    it('connects the underlying client at most once across multiple calls', async () => {
      const { client, runner } = makeRunner({
        agent_read: () => ({ name: 'a' }),
      });

      await runner.ensureAgent(makeUnit());
      await runner.ensureAgent(makeUnit());

      expect(client.connectCallCount).toBe(1);
    });

    it('close() closes the underlying client', async () => {
      const { client, runner } = makeRunner({
        agent_read: () => ({ name: 'a' }),
      });

      await runner.ensureAgent(makeUnit());
      await runner.close();

      expect(client.closeCallCount).toBe(1);
    });
  });
});
