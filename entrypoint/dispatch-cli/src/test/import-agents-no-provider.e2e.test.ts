/**
 * import-agents-no-provider.e2e.test.ts — dispatch-cli import-agents implicit
 * claudecli provider defect (cited `import-agents-claudecli`), end-to-end.
 *
 *   import-agents-claudecli AC1 — a persona imported WITHOUT a provider override is
 *     created through the REAL agent_create with NO `provider` key; a task run with
 *     no session/global binding fails closed with NO_PROVIDER_SELECTED (the wire
 *     message `No provider was selected … There is no implicit default provider.`) (never a
 *     silent claudecli); once a session binding is set, the same agent RUNS.
 *   import-agents-claudecli AC4 (negative control) — restoring the implicit
 *     `{type:'claudecli'}` default in providerFor makes this test RED (the agent
 *     carries a provider, so the unbound task no longer fails closed).
 *
 * REAL: the built agent-mcp over stdio JSON-RPC, real SQLite registry, real
 * importClaudeAgents. The ONLY fake is the external boundary: a local HTTP server
 * standing in for api.anthropic.com (no paid call). Nothing is env-gated.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { importClaudeAgents } from '../lib/import-agents.js';
import {
  assertAgentMcpBuilt,
  cleanupScratch,
  makeRunner,
  mkFakeHome,
  mkScratch,
} from './helpers/agent-mcp-registry.js';

beforeAll(() => assertAgentMcpBuilt());
afterAll(() => cleanupScratch());

const SSE_FRAMES = [
  ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'pong' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }],
  ['message_stop', { type: 'message_stop' }],
] as const;

async function startMockAnthropic(): Promise<{ url: string; hits: () => number; close: () => Promise<void> }> {
  let hits = 0;
  const server = http.createServer((req, res) => {
    req.on('data', () => undefined);
    req.on('end', () => {
      hits++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [event, data] of SSE_FRAMES) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    hits: () => hits,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('import-agents-claudecli — imported personas are un-welded from any provider', () => {
  it('AC1: no provider key stored; unbound task -> NO_PROVIDER_SELECTED; with a session binding it runs', async () => {
    const mock = await startMockAnthropic();
    const scratch = mkScratch('import-no-provider');
    const home = mkFakeHome(scratch);
    const personaDir = join(scratch, 'personas');
    mkdirSync(personaDir, { recursive: true });
    writeFileSync(
      join(personaDir, 'unwelded-persona.md'),
      '---\nname: unwelded-persona\ndescription: "Imported, provider-less"\nmodel: sonnet\n---\n\nBe brief.\n',
      'utf8'
    );

    const runner = makeRunner({
      dbPath: join(scratch, 'registry.db'),
      home,
      cwd: scratch,
      extraEnv: {
        ADHD_AGENT_ANTHROPIC_SECRET: 'sk-ant-api-e2e', // pragma: allowlist secret — fake; the mock server never validates it
        ANTHROPIC_BASE_URL: mock.url,
      },
    });
    try {
      const result = await importClaudeAgents(personaDir, runner);
      expect(result.errors).toEqual([]);
      expect(result.created).toEqual(['unwelded-persona']);
      expect(result.warnings.some((w) => w.includes('"sonnet"'))).toBe(true);

      const def = await runner.callTool<Record<string, unknown>>('agent_read', {
        name: 'unwelded-persona',
        fullDefinition: true,
      });
      expect(def).not.toHaveProperty('provider');

      const { session_id } = await runner.callTool<{ session_id: string }>('agent', {
        name: 'unwelded-persona',
      });

      // No session/global binding: fail closed BEFORE any model call.
      await expect(
        runner.callTool('task', { session_id, prompt: 'ping' })
      ).rejects.toThrow(/No provider was selected.*no implicit default provider/s);
      expect(mock.hits()).toBe(0);

      // With a session binding the very same agent runs.
      await runner.callTool('session_update', {
        session_id,
        provider: 'anthropic',
        model: 'claude_sonnet_4_6',
      });
      const out = await runner.callTool<{ status: string; result?: string }>('task', {
        session_id,
        prompt: 'ping',
      });
      expect(out.status).toBe('completed');
      expect(out.result).toBe('pong');
      expect(mock.hits()).toBe(1);
    } finally {
      await runner.close().catch(() => undefined);
      await mock.close();
    }
  }, 90_000);
});
