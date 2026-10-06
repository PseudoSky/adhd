/**
 * dispatch-default-mcp-servers.e2e.test.ts — backlog daafe2d3, live AC.
 *
 * DEFAULT-RUNNING, hermetic proof that a dispatch-created agent is born with
 * BOTH the memory-server and backlog `mcpServers` (`defaultDispatchMcpServers()`)
 * — read back from a REAL agent-mcp registry over stdio JSON-RPC, not asserted
 * on a mock. This is the live acceptance criterion for "dispatch agents get
 * memory + backlog"; the model-call half of daafe2d3 lives elsewhere and is the
 * only piece gated (a real model is a paid third-party service).
 *
 * No model call is made (only `agent_create` + `agent_read`), so nothing here
 * is env-gated. Hermetic: isolated `cwd` + fake `$HOME` + temp
 * `ADHD_AGENT_DATABASE_PATH`, so agent-mcp's `loadEnvHierarchy()` can never load
 * a repo-root `.env` and redirect the store.
 */
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DispatchUnit } from '@adhd/dispatch-base-spec';

import { defaultDispatchMcpServers, resolveDispatchMcpServers } from '../lib/core.js';
import {
  assertAgentMcpBuilt,
  cleanupScratch,
  makeRunner,
  mkFakeHome,
  mkScratch,
} from './helpers/agent-mcp-registry.js';

beforeAll(() => assertAgentMcpBuilt());
afterAll(() => cleanupScratch());

describe('daafe2d3 — dispatch-created agents get memory-server + backlog (real registry)', () => {
  it('agent_create via defaultDispatchMcpServers yields a definition carrying BOTH servers, read back from the store', async () => {
    const scratch = mkScratch('daafe2d3');
    const home = mkFakeHome(scratch);
    const dbPath = join(scratch, 'registry.db');

    const runner = makeRunner({
      dbPath,
      home,
      cwd: scratch,
      defaultMcpServers: defaultDispatchMcpServers({} as NodeJS.ProcessEnv),
    });
    try {
      // Minimal DispatchUnit shape — ensureAgent only reads these three fields.
      const unit = {
        agent_name: 'dispatch-default-mcp',
        provider: null,
        systemPrompt: 'You are a dispatched agent.',
      } as unknown as DispatchUnit;

      await runner.ensureAgent(unit);

      const def = await runner.callTool<{ mcpServers?: Record<string, unknown> }>(
        'agent_read',
        { name: 'dispatch-default-mcp' }
      );

      // The consumer-visible outcome: the CREATED definition really carries
      // both server entries (not merely that a mock was handed them).
      expect(def.mcpServers).toBeDefined();
      expect(Object.keys(def.mcpServers ?? {}).sort()).toEqual(['backlog', 'memory-server']);
      expect(def.mcpServers?.['memory-server']).toMatchObject({ transport: 'sse' });
      expect(def.mcpServers?.['backlog']).toMatchObject({
        transport: 'stdio',
        command: 'node',
      });
    } finally {
      await runner.close().catch(() => undefined);
    }
  }, 60_000);
});

describe('NAT-TOOL-9 — the dispatch host resolves the native toolset from ONE producer', () => {
  it('resolveDispatchMcpServers yields fs/shell/dispatch + memory/backlog, rooted at the dispatching cwd', () => {
    const map = resolveDispatchMcpServers({ cwd: '/P' });

    // Keys come only from the ONE catalog (fs/shell/agent-mcp) + the explicit half.
    expect(Object.keys(map).sort()).toEqual(
      ['agent-mcp', 'backlog', 'fs', 'memory-server', 'shell'].sort()
    );

    const fs = map['fs'] as unknown as { transport: string; command: string; args?: string[]; cwd?: string };
    expect(fs).toMatchObject({ transport: 'stdio', command: 'srt', cwd: '/P' });
    const fsArgs = fs.args ?? [];
    expect(fsArgs[fsArgs.length - 1], 'fs root is the dispatching cwd').toBe('/P');

    const shell = map['shell'] as unknown as { transport: string; command: string; cwd?: string };
    expect(shell).toMatchObject({ transport: 'stdio', command: 'srt', cwd: '/P' });

    expect(map['agent-mcp']).toMatchObject({ transport: 'stdio' });
    expect(map['memory-server']).toMatchObject({ transport: 'sse' });
    expect(map['backlog']).toMatchObject({ transport: 'stdio', command: 'node' });
  });

  it('the dispatch host resolves fs/shell through the ONE producer (no second producer)', () => {
    // The dispatch host authors no fs/shell config of its own — it delegates to
    // `@adhd/agent-core-native-tooling`'s single producer (D11 #1/#12). The
    // exhaustive source-level guard (and its revert-failing negative control)
    // lives in agent-mcp's `default-mcp-producer.guard.test.ts`.
    const source = resolveDispatchMcpServers.toString();
    expect(source, 'must delegate to the single native-tooling producer').toContain(
      'resolveNativeToolingMap'
    );
    expect(source).not.toContain('server-filesystem');
    expect(source).not.toContain('mcp-shell-server');
  });
});
