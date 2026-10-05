import { describe, expect, it } from 'vitest';

import type { DispatchUnit } from '@adhd/dispatch-base-spec';
import type {
  IMcpToolClient,
  McpCallToolResult,
} from '@adhd/dispatch-orchestrator';

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
  async connect(): Promise<void> {
    /* no-op */
  }
  async callTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<McpCallToolResult> {
    this.calls.push(params.name);
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
