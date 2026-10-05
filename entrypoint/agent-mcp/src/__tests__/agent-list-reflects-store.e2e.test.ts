/**
 * agent-list-reflects-store.e2e.test.ts — backlog d31d2655 + b6a02237.
 *
 * The reported failure: `agent_list` advertised a roster that did not reconcile
 * with the operational store on disk (2 rows reported against a table holding
 * 48; a "phantom" agent with no backing row). The fix is that the tool reflects
 * the store exactly. This proves it through the REAL consumer seam — a real MCP
 * client over stdio JSON-RPC talking to the REAL built agent-mcp entry, against
 * a REAL seeded operational DB — never a direct import of the server's
 * functions (CLAUDE.md §7 "drive the real tools, never a bypass").
 *
 * Assertions:
 *   - `agent_list` returns EXACTLY the seeded store rows (count + names), with
 *     no hardcoded cap and no silent drop. Teeth: a 2-row hardcode / a
 *     filter-dropping implementation would fail.
 *   - `agent_read` for a name with NO backing row is AGENT_NOT_FOUND — the
 *     "phantom agent" cannot be advertised: every listed name resolves to a
 *     store row, and every non-row is not found.
 *   - The advertised tool list includes the new `agent_verify_mcp` (proves it
 *     is genuinely mounted, not only implemented).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyLockingPragmas } from '@adhd/agent-core-env';
import { agentCreateInputSchema } from '@adhd/agent-engine-orchestrator';

import { runMigrationsOn } from '../db/migrate-runner.js';
import { AgentStore } from '../store/agent-store.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const DIST_ENTRY = path.join(PACKAGE_ROOT, 'dist', 'src', 'index.js');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const TMP_ROOT = path.join(REPO_ROOT, 'tmp', 'agent-mcp');

const SEEDED_NAMES = [
  'alpha-agent',
  'beta-agent',
  'gamma-agent',
  'delta-agent',
  'epsilon-agent',
];

let tmpDir: string;
let fakeHome: string;
let dbPath: string;
let client: Client;

/**
 * Child env: strip every ambient `ADHD_AGENT_*` key (so a runner's pinned
 * config can never reach the real `~/.adhd` store), then pin the operational DB
 * to our seeded temp file and force stdio transport.
 */
function buildChildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('ADHD_AGENT_')) continue;
    if (value !== undefined) env[key] = value;
  }
  env.HOME = fakeHome;
  env.ADHD_AGENT_DATABASE_PATH = dbPath;
  env.ADHD_AGENT_TRANSPORT = 'stdio';
  env.ADHD_AGENT_SSE_ENABLED = 'false';
  return env;
}

function seedOperationalStore(file: string): void {
  const sqlite = new Database(file);
  applyLockingPragmas(sqlite, { busyTimeoutMs: 5_000 });
  const db = drizzle(sqlite);
  runMigrationsOn(sqlite, db);
  const store = new AgentStore(db);
  for (const name of SEEDED_NAMES) {
    store.create(
      agentCreateInputSchema.parse({
        name,
        provider: { type: 'claudecli' },
        systemPrompt: `${name} prompt`,
      })
    );
  }
  sqlite.close();
}

describe('agent_list reflects the operational store (d31d2655, b6a02237)', () => {
  beforeAll(async () => {
    expect(
      fs.existsSync(DIST_ENTRY),
      `expected built entry at ${DIST_ENTRY} — run "npx nx build agent-mcp" first`
    ).toBe(true);

    fs.mkdirSync(TMP_ROOT, { recursive: true });
    tmpDir = fs.mkdtempSync(path.join(TMP_ROOT, 'agent-list-e2e-'));
    fakeHome = path.join(tmpDir, 'home');
    fs.mkdirSync(fakeHome, { recursive: true });
    dbPath = path.join(tmpDir, 'agents.db');

    seedOperationalStore(dbPath);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST_ENTRY],
      env: buildChildEnv(),
    });
    client = new Client(
      { name: 'agent-list-e2e', version: '1.0.0' },
      { capabilities: {} }
    );
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    try {
      await client?.close();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function parseText(result: Awaited<ReturnType<Client['callTool']>>): unknown {
    const text = result.content?.[0]?.text ?? '';
    return JSON.parse(text);
  }

  it('advertises agent_list, agent_read, and the new agent_verify_mcp', async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain('agent_list');
    expect(names).toContain('agent_read');
    expect(names).toContain('agent_verify_mcp');
  });

  it('returns EXACTLY the store rows — count and names, no cap and no silent drop', async () => {
    const result = await client.callTool({ name: 'agent_list', arguments: {} });
    expect(result.isError).toBeFalsy();

    const agents = parseText(result) as Array<{ name: string }>;
    expect(agents).toHaveLength(SEEDED_NAMES.length);
    expect(agents.map((a) => a.name).sort()).toEqual([...SEEDED_NAMES].sort());
  });

  it('every listed agent resolves to a store row; a non-row is AGENT_NOT_FOUND (no phantom)', async () => {
    const listed = parseText(
      await client.callTool({ name: 'agent_list', arguments: {} })
    ) as Array<{ name: string }>;

    for (const agent of listed) {
      const read = await client.callTool({
        name: 'agent_read',
        arguments: { name: agent.name },
      });
      expect(read.isError).toBeFalsy();
    }

    const phantom = await client.callTool({
      name: 'agent_read',
      arguments: { name: 'sox-typescript-impl' },
    });
    expect(phantom.isError).toBe(true);
    expect(phantom.content?.[0]?.text ?? '').toContain('AGENT_NOT_FOUND');
  });
});
