/**
 * R10 S4 (P6a delegation descriptions, AC5 `thinking` mention).
 *
 * AC4: the delegation descriptions share ONE source (`delegation-text.ts`) and state the decision rule
 *   first: synchronous by default, background only for independent work, and a background result must be
 *   fetched with `result` before the answer depends on it. Driven as a host does: a real MCP `Client` over
 *   the real `createServer` (the host tool list: `task`, `tasks_batch`, `result`), plus a source-level check
 *   that the two in-process descriptors and the guide use the same constant (they are not observable
 *   through the host list).
 * AC5: `agent_create` / `agent_update` mention `thinking`, the README and AGENTS.md match, and the strict
 *   input schema really accepts the documented shape.
 *
 * Red -> green: replace the constant at any one site with literal text and the site-count / identity
 * assertions fail; delete the README/AGENTS mention and the docs assertions fail.
 *
 * guards: a delegation description (`task`, `tasks_batch`, `result`, the in-process descriptors, the usage guide) stops sharing
 *   the one DELEGATION_DECISION_RULE or stops leading with it, or the `thinking` docs and strict input schema drift apart.
 * tier: S (real createServer driven by an in-memory MCP Client; no process, no network)
 * cites: R10 S4 AC4, R10 S4 AC5 (this file names no backlog uid).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { HookRegistry, agentCreateInputSchema } from '@adhd/agent-engine-orchestrator';
import { SessionStore, TaskStore } from '@adhd/agent-store-runtime';
import { afterEach, describe, expect, it } from 'vitest';

import { DELEGATION_DECISION_RULE } from '../delegation-text.js';
import { createServer, type ServerDeps } from '../server.js';
import { AgentStore } from '../store/agent-store.js';
import { openDb, type ITestDb } from './pricing-fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(resolve(here, rel), 'utf8');

let dbs: ITestDb[] = [];
let closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers) await c();
  for (const d of dbs) d.sqlite.close();
  dbs = [];
  closers = [];
});

async function hostTools(): Promise<Map<string, { description?: string; inputSchema: unknown }>> {
  const o = openDb();
  dbs.push(o);
  const hooks = new HookRegistry();
  const server = createServer({
    agentStore: new AgentStore(o.db, hooks),
    sessionStore: new SessionStore(o.db, hooks),
    taskStore: new TaskStore(o.db),
    hooks,
    db: o.db,
  } as ServerDeps);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-host', version: '0.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  closers.push(() => client.close(), () => server.close());
  return new Map((await client.listTools()).tools.map((t) => [t.name, t]));
}

describe('R10 S4 AC4: the delegation descriptions share one decision rule and lead with it', () => {
  it('R10 S4 AC4: the rule states sync-default, background-only-for-independent-work and must-call-result', () => {
    expect(DELEGATION_DECISION_RULE).toMatch(/synchronous by default and return the finished result/);
    expect(DELEGATION_DECISION_RULE).toMatch(/background:true only when you have independent work/);
    expect(DELEGATION_DECISION_RULE).toMatch(/NOT delivered automatically/);
    expect(DELEGATION_DECISION_RULE).toMatch(/MUST call result \(with wait_ms\)/);
    expect(DELEGATION_DECISION_RULE).toMatch(/files you are editing yourself/);
    // Accurate for today: it must not promise delivery or tell the model to prefer background.
    expect(DELEGATION_DECISION_RULE).not.toMatch(/start workers with background|prefer background|automatically delivered/i);
  });

  it('R10 S4 AC4: task, tasks_batch and result in the host tool list LEAD with the identical rule', async () => {
    const tools = await hostTools();
    for (const name of ['task', 'tasks_batch', 'result']) {
      expect(tools.get(name)?.description?.startsWith(DELEGATION_DECISION_RULE), name).toBe(true);
    }
  });

  it('R10 S4 AC4: the old per-site background sentences are gone from every site', async () => {
    const tools = await hostTools();
    for (const name of ['task', 'tasks_batch', 'result']) {
      const d = tools.get(name)?.description ?? '';
      expect(d, name).not.toMatch(/Background pattern|do your own work|Default \(background omitted\)|Pairs with task/);
    }
    const src = read('../server.ts');
    expect(src).not.toMatch(/Background pattern|Default \(background omitted\)|Pairs with task/);
  });

  it('R10 S4 AC4: both in-process descriptors, the three host descriptions and the guide use the one constant (no literal copy)', () => {
    const src = read('../server.ts');
    // 3 in-process (task, tasks_batch, result: R10 W2) + 3 host + 1 guide interpolation = 7 uses, plus the import.
    expect(src.match(/DELEGATION_DECISION_RULE/g)?.length).toBe(8);
    const inProc = /name: 'task',\s*description:\s*`\$\{DELEGATION_DECISION_RULE\}/.test(src);
    const inProcBatch = /name: 'tasks_batch',\s*description:\s*`\$\{DELEGATION_DECISION_RULE\}/.test(src);
    const inProcResult = /name: 'result',\s*description:\s*`\$\{DELEGATION_DECISION_RULE\}/.test(src);
    expect(inProc && inProcBatch && inProcResult).toBe(true);
    // The rule's own sentences exist in exactly one file.
    expect(src).not.toContain('MUST call result');
    expect(read('../delegation-text.ts')).toContain('MUST call result');
  });

  it('R10 S4 AC4: the usage guide states the rule once and says background results are not delivered automatically', async () => {
    const o = openDb();
    dbs.push(o);
    const hooks = new HookRegistry();
    const server = createServer({
      agentStore: new AgentStore(o.db, hooks),
      sessionStore: new SessionStore(o.db, hooks),
      taskStore: new TaskStore(o.db),
      hooks,
      db: o.db,
    } as ServerDeps);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-host', version: '0.0.0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    closers.push(() => client.close(), () => server.close());
    const out = (await client.callTool({ name: 'guide', arguments: {} })) as { content: Array<{ text?: string }> };
    const raw = out.content.map((c) => c.text ?? '').join('\n');
    const text = raw.startsWith('"') ? (JSON.parse(raw) as string) : raw; // the guide is returned JSON-encoded
    expect(text.split(DELEGATION_DECISION_RULE).length - 1).toBe(1);
    expect(text).toMatch(/not delivered\s+automatically/i);
    expect(text).toMatch(/creates a real session row/i); // NAT-TOOL-10 AC4 contract kept
    expect(text).not.toMatch(/poll with/);
  });

  it('R10 S4 AC4: the input schemas (and therefore the sync default and payload) are unchanged', async () => {
    const tools = await hostTools();
    const sha = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');
    // Same pins as r3-par-c-parallel-guidance.test.ts: descriptions moved, schema bytes did not.
    expect(sha(tools.get('task')?.inputSchema)).toBe('5682476676ba467cbf51cb05495b8f19128853a365fd500a866bc71175a65c21');
    expect(sha(tools.get('tasks_batch')?.inputSchema)).toBe('937970895910b1a63d4f811f891086bd0155893ce341516f144cf856458532d2');
  });
});

describe('R10 S4 AC5: agent_create / agent_update mention `thinking` and the docs match', () => {
  it('R10 S4 AC5: both descriptions name thinking with the exact accepted values', async () => {
    const tools = await hostTools();
    for (const name of ['agent_create', 'agent_update']) {
      const d = tools.get(name)?.description ?? '';
      expect(d, name).toMatch(/thinking \(anthropic only: \{type: adaptive\|disabled, display\?: summarized\|omitted\}/);
    }
  });

  it('R10 S4 AC5: the strict input schema accepts exactly the documented shape and rejects the legacy one', () => {
    const base = { name: 'a', systemPrompt: 'p', mcpServers: {}, permissions: {} };
    const ok = (thinking: unknown) =>
      agentCreateInputSchema.safeParse({ ...base, provider: { type: 'anthropic', thinking } }).success;
    expect(ok({ type: 'adaptive' })).toBe(true);
    expect(ok({ type: 'adaptive', display: 'summarized' })).toBe(true);
    expect(ok({ type: 'adaptive', display: 'omitted' })).toBe(true);
    expect(ok({ type: 'disabled' })).toBe(true);
    expect(ok({ type: 'enabled', budget_tokens: 1024 })).toBe(false);
    expect(ok({ type: 'adaptive', display: 'verbose' })).toBe(false);
  });

  it('R10 S4 AC5: README.md and AGENTS.md document the same thinking field and the same notes/delegation rule', () => {
    for (const f of ['../../README.md', '../../AGENTS.md']) {
      const t = read(f);
      expect(t, f).toContain('`thinking` for `anthropic`: `{ type: adaptive|disabled, display?: summarized|omitted }`');
      expect(t, f).toContain('Model-visible tool-result notes');
      expect(t, f).toMatch(/no need to read it back to verify/);
      expect(t, f).toMatch(/\*\*must\*\* call\s+`result`/);
    }
  });
});
