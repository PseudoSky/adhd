/**
 * Behavioral proof for 1b947d91 AC1/AC2/AC3: AGENT_NOT_FOUND must be
 * actionable — it lists registered agent names (sorted, capped, names only).
 *
 * b3999dfa AC5: the tool-description proof drives both `agent` descriptors through the real server (tools/list
 * and the in-process registry a dispatched agent sees), and a failing roster lookup cannot mask AGENT_NOT_FOUND.
 *
 * Teeth: against the pre-fix message (`Agent 'x' not found`) every assertion
 * on the roster text goes RED; the system-prompt assertion guards the
 * names-only contract.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { HookRegistry, ToolError } from '@adhd/agent-engine-orchestrator';
import type { Orchestrator, McpClientRegistry } from '@adhd/agent-engine-orchestrator';
import { SessionStore, TaskStore } from '@adhd/agent-store-runtime';
import { createServer, type ServerDeps } from '../server.js';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema.js';
import { runMigrationsOn } from '../db/migrate-runner.js';
import {
  AgentStore,
  AGENT_NOT_FOUND_NAME_CAP,
} from '../store/agent-store.js';
import { openDb } from './pricing-fixtures.js';
import { agentCreateInputSchema } from '@adhd/agent-engine-orchestrator';

describe('1b947d91 AC1/AC3: AGENT_NOT_FOUND lists registered names', () => {
  let sqlite: Database.Database;
  let store: AgentStore;

  const seed = (name: string, systemPrompt = `${name} prompt`) =>
    store.create(
      agentCreateInputSchema.parse({
        name,
        provider: { type: 'claudecli' },
        systemPrompt,
      })
    );

  beforeEach(() => {
    sqlite = new Database(':memory:');
    const db = drizzle(sqlite, { schema });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store = new AgentStore(db as any);
    runMigrationsOn(sqlite, db);
  });
  afterEach(() => sqlite.close());

  const msgOf = (name: string): string => {
    try {
      store.read(name);
    } catch (e) {
      return (e as Error).message;
    }
    throw new Error('expected AGENT_NOT_FOUND');
  };

  it('lists registered names sorted, without leaking system prompts', () => {
    seed('zeta');
    seed('alpha', 'TOP-SECRET-PROMPT');
    seed('mid');
    const m = msgOf('nope');
    expect(m).toContain("Agent 'nope' not found");
    expect(m).toContain('Registered agents: alpha, mid, zeta.');
    expect(m).not.toContain('TOP-SECRET-PROMPT');
  });

  it('caps the roster and reports "+N more"', () => {
    const total = AGENT_NOT_FOUND_NAME_CAP + 5;
    const pad = (i: number) => `agent-${String(i).padStart(3, '0')}`;
    for (let i = 0; i < total; i++) seed(pad(i));
    const m = msgOf('nope');
    expect(m).toContain(pad(0));
    expect(m).toContain(pad(AGENT_NOT_FOUND_NAME_CAP - 1));
    expect(m).not.toContain(pad(AGENT_NOT_FOUND_NAME_CAP));
    expect(m).toContain('(+5 more');
  });

  it('says so when no agents exist', () => {
    expect(msgOf('nope')).toContain('No agents are registered');
  });

  it("b3999dfa AC5: a failing roster lookup cannot mask the AGENT_NOT_FOUND ToolError", () => {
    vi.spyOn(store as unknown as { describeRegisteredNames(): string }, 'describeRegisteredNames').mockImplementation(() => {
      throw new Error('roster query exploded');
    });
    let caught: unknown;
    try {
      store.read('nope');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ToolError);
    expect((caught as ToolError).code).toBe('AGENT_NOT_FOUND');
    expect((caught as ToolError).message).toContain("Agent 'nope' not found");
    expect((caught as ToolError).message).toContain('agent_list');
  });
});

describe('1b947d91 AC2 / b3999dfa AC5: agent tool description', () => {
  const ROSTER_HINT = /AGENT_NOT_FOUND error lists the registered agent names \(sorted, capped at 20\)/;

  async function connect(deps: Partial<ServerDeps>, o = openDb()): Promise<{ client: Client; o: ReturnType<typeof openDb> }> {
    const hooks = new HookRegistry();
    const server = createServer({
      agentStore: new AgentStore(o.db, hooks),
      sessionStore: new SessionStore(o.db, hooks),
      taskStore: new TaskStore(o.db),
      hooks,
      db: o.db,
      ...deps,
    } as ServerDeps);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-host', version: '0.0.0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    cleanups.push(() => client.close(), () => server.close(), async () => o.sqlite.close());
    return { client, o };
  }
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  it('b3999dfa AC5: tools/list (the host-visible descriptor) tells callers how to find valid names', async () => {
    const { client } = await connect({});
    const agent = (await client.listTools()).tools.find((t) => t.name === 'agent');
    expect(agent?.description).toMatch(ROSTER_HINT);
    expect(agent?.description).toContain('agent_list');
  });

  it('b3999dfa AC5: the in-process descriptor a dispatched agent lists through its registry carries the same hint', async () => {
    // A one-shot `task` runs synchronously; the stub orchestrator stands in for the model loop and lists the tools
    // the agent would see via the self-referential `agent-mcp` server (served by the in-process descriptors).
    let seen: Array<{ name: string; description?: string }> = [];
    const orchestrator = {
      run: async ({ registry }: { registry: McpClientRegistry }) => {
        seen = await registry.listAllTools();
      },
    } as unknown as Orchestrator;
    const o = openDb();
    const hooks = new HookRegistry();
    const agentStore = new AgentStore(o.db, hooks);
    agentStore.create(
      agentCreateInputSchema.parse({
        name: 'dispatched',
        provider: { type: 'claudecli' },
        systemPrompt: 'p',
        mcpServers: { 'agent-mcp': { transport: 'stdio', command: 'unused' } },
        // No native fs/shell servers: the unit lane spawns no subprocess (ADR-0009).
        nativeTooling: { fs: false, shell: false, hitl: false },
      })
    );
    const { client } = await connect({ orchestrator, agentStore }, o);
    await client.callTool({ name: 'task', arguments: { agent_name: 'dispatched', prompt: 'hi' } });
    const agentTools = seen.filter((t) => /(^|__)agent$/.test(t.name));
    expect(agentTools.map((t) => t.name)).toHaveLength(1);
    expect(agentTools[0].description).toMatch(ROSTER_HINT);
    expect(agentTools[0].description).toContain('agent_list');
  });
});
