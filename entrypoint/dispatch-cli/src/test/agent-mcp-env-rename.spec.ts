/**
 * agent-mcp-env-rename.spec.ts — backlog 64e7ebe7 (silent rename of the
 * `ADHD_DISPATCH_AGENT_MCP_*` env vars to `ADHD_AGENT_MCP_*`).
 *
 *   64e7ebe7 AC1 — `ADHD_AGENT_MCP_REQUEST_TIMEOUT_MS` is read first; the legacy
 *                  `ADHD_DISPATCH_AGENT_MCP_REQUEST_TIMEOUT_MS` is a FALLBACK.
 *   64e7ebe7 AC2 — any legacy name emits exactly ONE deprecation warning on
 *                  STDERR (never stdout) naming the new var; none when only the
 *                  new names are set. (Negative control: dropping
 *                  `warnLegacyAgentMcpEnv` turns the AC2 cases RED.)
 *
 * The `clientFactory` seam injects the fake MCP client (the external boundary);
 * the real runner request path still runs and the timeout is observed on the wire.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DispatchUnit } from '@adhd/dispatch-base-spec';
import type { IMcpToolClient, McpCallToolResult } from '@adhd/dispatch-orchestrator';

import { buildProductionAgentMcpRunner } from '../lib/core.js';

class TimeoutClient implements IMcpToolClient {
  readonly timeouts: Array<number | undefined> = [];
  async connect(): Promise<void> {
    /* no-op */
  }
  async callTool(
    _params: { name: string; arguments?: Record<string, unknown> },
    options?: { timeout?: number }
  ): Promise<McpCallToolResult> {
    this.timeouts.push(options?.timeout);
    return {
      isError: true,
      content: [{ type: 'text', text: '[AGENT_NOT_FOUND] not found' }],
    };
  }
  async close(): Promise<void> {
    /* no-op */
  }
}

const UNIT = { agent_name: 'x', provider: null, systemPrompt: null } as unknown as DispatchUnit;

/** Build a runner from ONLY the given env (no ambient leakage) and return the observed timeout. */
async function observedTimeout(env: Record<string, string>): Promise<number | undefined> {
  const client = new TimeoutClient();
  const runner = buildProductionAgentMcpRunner(env, { clientFactory: () => client });
  await runner.ensureAgent(UNIT).catch(() => undefined);
  return client.timeouts[0];
}

const LEGACY_TIMEOUT = 'ADHD_DISPATCH_AGENT_MCP_REQUEST_TIMEOUT_MS';
const NEW_TIMEOUT = 'ADHD_AGENT_MCP_REQUEST_TIMEOUT_MS';

afterEach(() => vi.restoreAllMocks());

describe('64e7ebe7 AC1 — request-timeout env rename', () => {
  it('reads the canonical ADHD_AGENT_MCP_REQUEST_TIMEOUT_MS', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await observedTimeout({ [NEW_TIMEOUT]: '1111' })).toBe(1111);
  });

  it('falls back to the legacy name when the canonical one is absent', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await observedTimeout({ [LEGACY_TIMEOUT]: '2222' })).toBe(2222);
  });

  it('canonical wins when both are set', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await observedTimeout({ [NEW_TIMEOUT]: '1111', [LEGACY_TIMEOUT]: '2222' })).toBe(1111);
  });
});

describe('64e7ebe7 AC2 — legacy names warn once on stderr, never stdout', () => {
  function spies() {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const warnings = () =>
      err.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('DEPRECATED'));
    return { out, warnings };
  }

  it('legacy timeout name -> exactly one stderr warning naming the new var, nothing on stdout', async () => {
    const { out, warnings } = spies();
    await observedTimeout({ [LEGACY_TIMEOUT]: '2222' });
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain(LEGACY_TIMEOUT);
    expect(warnings()[0]).toContain(NEW_TIMEOUT);
    expect(out).not.toHaveBeenCalled();
  });

  it('several legacy names together still produce exactly ONE warning naming every new var', async () => {
    const { out, warnings } = spies();
    await observedTimeout({
      ADHD_DISPATCH_AGENT_MCP_COMMAND: 'node',
      ADHD_DISPATCH_AGENT_MCP_ARGS: '/x.js',
      [LEGACY_TIMEOUT]: '2222',
    });
    expect(warnings()).toHaveLength(1);
    for (const n of ['ADHD_AGENT_MCP_COMMAND', 'ADHD_AGENT_MCP_ARGS', NEW_TIMEOUT]) {
      expect(warnings()[0]).toContain(n);
    }
    expect(out).not.toHaveBeenCalled();
  });

  it('only canonical names set -> no warning', async () => {
    const { warnings } = spies();
    await observedTimeout({
      ADHD_AGENT_MCP_COMMAND: 'node',
      ADHD_AGENT_MCP_ARGS: '/x.js',
      [NEW_TIMEOUT]: '1111',
    });
    expect(warnings()).toHaveLength(0);
  });
});
