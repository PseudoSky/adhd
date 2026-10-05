/**
 * calc-server.fixture.test.ts — the teeth for backlog 305a63d4.
 *
 * `live-dag.e2e.test.ts` and `live-budget.e2e.test.ts` both wire a real stdio
 * MCP server at `<integration>/fixtures/calc-server.mjs` (the worker agent's
 * `calc` server, asserted to expose `calc__calculate`). That path was DANGLING
 * and undetected because both suites are gated behind a paid model — a live run
 * would fail at MCP connect.
 *
 * This test runs by DEFAULT and fails if the fix is reverted: it asserts the
 * referenced fixture exists, spawns it as a genuine stdio MCP server through
 * the real SDK client, and proves it lists `calculate`, evaluates the
 * arithmetic the DAG actually sends, honours `CALC_LOG`, and turns a malformed
 * expression into a tool error rather than a crash.
 *
 * No model, no network, fully deterministic — the only component under test is
 * the fixture itself, driven the way agent-mcp drives it.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';

/** Exactly the path the two gated suites resolve:
 *  `path.resolve(dirname(live-*.e2e.test.ts), "fixtures/calc-server.mjs")`. */
const CALC_SERVER = join(
  dirname(fileURLToPath(import.meta.url)), // src/__tests__
  'integration',
  'fixtures',
  'calc-server.mjs'
);

const cleanupDirs: string[] = [];

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** The text blocks of a CallToolResult, narrowed away from the SDK union. */
function textOf(result: unknown): string[] {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.filter((c) => c.type === 'text').map((c) => String(c.text ?? ''));
}

describe('305a63d4 — the gated live suites\u2019 calc fixture is real and reachable', () => {
  it('exists at the exact path live-dag/live-budget reference', () => {
    expect(existsSync(CALC_SERVER), `${CALC_SERVER} must exist`).toBe(true);
  });

  it('is a real stdio MCP server exposing `calculate`, evaluates arithmetic, logs to CALC_LOG, and errors on garbage', async () => {
    const logDir = mkdtempSync(join(tmpdir(), 'calc-fixture-'));
    cleanupDirs.push(logDir);
    const logPath = join(logDir, 'calc.log');

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CALC_SERVER],
      env: { ...process.env, CALC_LOG: logPath } as Record<string, string>,
    });
    const client = new Client({ name: 'calc-fixture-test', version: '1.0.0' });

    try {
      await client.connect(transport);

      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('calculate');

      // The worker receives a SINGLE operation ("12 * 12"); the coordinator
      // multiplies the returned results with one chained call — both shapes.
      const single = textOf(
        await client.callTool({ name: 'calculate', arguments: { expression: '12 * 12' } })
      );
      expect(single).toContain('144');

      const chained = textOf(
        await client.callTool({ name: 'calculate', arguments: { expression: '2 + 3 * 4' } })
      );
      expect(chained).toContain('14');

      // CALC_LOG is honoured (appendFileSync is synchronous, so it is present
      // the moment the call returns) — the suites' log wiring depends on it.
      const logged = readFileSync(logPath, 'utf8');
      expect(logged).toContain('calculate 12 * 12 = 144');
      expect(logged).toContain('calculate 2 + 3 * 4 = 14');

      // A malformed expression is a tool error, never a crashed server.
      const bad = await client.callTool({
        name: 'calculate',
        arguments: { expression: '12 * * 12' },
      });
      expect((bad as { isError?: boolean }).isError).toBe(true);
    } finally {
      await client.close();
    }
  }, 30_000);
});
