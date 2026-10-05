import { describe, expect, it } from 'vitest';

import type { DispatchUnit } from '@adhd/dispatch-base-spec';
import type {
  IMcpToolClient,
  McpCallToolResult,
} from '@adhd/dispatch-orchestrator';

import { DEFAULT_POLL } from '@adhd/dispatch-orchestrator';

import { buildProductionAgentMcpRunner } from '../lib/core.js';

/**
 * backlog f1dbd0f2 — the PRODUCTION dispatch host must not silently (re)create
 * a DAG-named agent that is missing (e.g. a persona imported then
 * `agent_delete`d). `buildProductionAgentMcpRunner()` therefore defaults to
 * `createAgentsIfMissing:false`; `calibrate` is the one caller that opts back
 * in (it mints a synthetic null-task agent).
 *
 * The `clientFactory` seam injects a fake MCP client (the external boundary)
 * so no subprocess spawns — the real `AgentMcpRunner` request/response path is
 * still exercised.
 */

class RecordingClient implements IMcpToolClient {
  readonly calls: string[] = [];
  readonly timeouts: Array<number | undefined> = [];
  async connect(): Promise<void> {
    /* no-op */
  }
  async callTool(
    params: {
      name: string;
      arguments?: Record<string, unknown>;
    },
    options?: { timeout?: number }
  ): Promise<McpCallToolResult> {
    this.calls.push(params.name);
    this.timeouts.push(options?.timeout);
    if (params.name === 'agent_read') {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `[AGENT_NOT_FOUND] Agent '${String(params.arguments?.['name'])}' not found`,
          },
        ],
      };
    }
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
  }
  async close(): Promise<void> {
    /* no-op */
  }
}

function unit(agentName: string): DispatchUnit {
  // ensureAgent only reads agent_name / provider / systemPrompt.
  return {
    agent_name: agentName,
    provider: null,
    systemPrompt: null,
  } as unknown as DispatchUnit;
}

describe('production runner no-auto-create (f1dbd0f2)', () => {
  it('buildProductionAgentMcpRunner defaults to no-auto-create: a missing agent fails AGENT_NOT_FOUND, no create', async () => {
    const client = new RecordingClient();
    const runner = buildProductionAgentMcpRunner(process.env, {
      clientFactory: () => client,
    });

    await expect(runner.ensureAgent(unit('deleted-persona'))).rejects.toMatchObject({
      code: 'AGENT_NOT_FOUND',
    });
    expect(client.calls).toEqual(['agent_read']);
  });

  it('calibrate-style opt-in (createAgentsIfMissing:true) still creates the agent (AC3)', async () => {
    const client = new RecordingClient();
    const runner = buildProductionAgentMcpRunner(process.env, {
      clientFactory: () => client,
      createAgentsIfMissing: true,
    });

    await runner.ensureAgent(unit('dispatch-cli-calibration-sonnet'));
    expect(client.calls).toEqual(['agent_read', 'agent_create']);
  });
});

describe('production runner MCP request timeout (removes the 60s-vs-poll mismatch)', () => {
  it('defaults the per-call timeout to the orchestrator poll budget (DEFAULT_POLL.timeoutMs)', async () => {
    const client = new RecordingClient();
    const runner = buildProductionAgentMcpRunner(process.env, {
      clientFactory: () => client,
    });

    // agent_read misses -> agent_create; both calls carry the timeout.
    await runner.ensureAgent(unit('missing')).catch(() => {
      /* AGENT_NOT_FOUND expected */
    });

    // NEGATIVE-CONTROL: dropping `requestTimeoutMs` from
    // buildProductionAgentMcpRunner makes these see `undefined` (the SDK's 60s
    // default) -> red.
    expect(client.timeouts.length).toBeGreaterThan(0);
    for (const t of client.timeouts) {
      expect(t).toBe(DEFAULT_POLL.timeoutMs);
    }
  });

  it('honors the ADHD_DISPATCH_AGENT_MCP_REQUEST_TIMEOUT_MS override', async () => {
    const client = new RecordingClient();
    const runner = buildProductionAgentMcpRunner(
      { ...process.env, ADHD_DISPATCH_AGENT_MCP_REQUEST_TIMEOUT_MS: '4321' },
      { clientFactory: () => client }
    );

    await runner.ensureAgent(unit('missing')).catch(() => {
      /* AGENT_NOT_FOUND expected */
    });

    expect(client.timeouts[0]).toBe(4321);
  });
});
