/**
 * Behavioral proof for BUG: `agent_update` cannot remove/rename an
 * `mcpServers` key (backlog 1aba5335).
 *
 * Teeth: the pre-fix implementation shallow-merged `{...existing, ...patch}`,
 * so a `null`-valued or renamed key never removed the old one. The assertions
 * below (`not.toHaveProperty('agent')`, and the persisted `read()` re-check)
 * go RED under that shallow merge and GREEN under the delete-aware merge.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema.js';
import { runMigrationsOn } from '../db/migrate-runner.js';
import { AgentStore } from '../store/agent-store.js';
import {
  agentPatchSchema,
  agentUpdateInputSchema,
} from '@adhd/agent-engine-orchestrator';

const stdio = (command: string) => ({
  transport: 'stdio' as const,
  command,
});

describe('agent-store mcpServers patch semantics (1aba5335)', () => {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const store = new AgentStore(db as any);

  beforeAll(() => {
    runMigrationsOn(sqlite, db);
  });

  afterAll(() => {
    sqlite.close();
  });

  it('schema accepts a null-valued mcpServers key (the delete signal)', () => {
    const parsed = agentUpdateInputSchema.parse({
      name: 'x',
      patch: { mcpServers: { legacy: null } },
    });
    expect(parsed.patch.mcpServers).toEqual({ legacy: null });
    // and the bare patch schema alone
    expect(
      agentPatchSchema.parse({ mcpServers: { 'a-b': null } }).mcpServers
    ).toEqual({ 'a-b': null });
  });

  it('a null-valued key DELETES that key, leaving others untouched', () => {
    store.create({
      name: 'patch-delete',
      systemPrompt: 's',
      provider: { type: 'openai', model: 'gpt-4' },
      mcpServers: { agent: stdio('old-cmd'), keep: stdio('keep-cmd') },
      permissions: {},
    });

    const updated = store.update({
      name: 'patch-delete',
      patch: { mcpServers: { agent: null } },
    });

    // returned definition
    expect(updated.mcpServers).not.toHaveProperty('agent');
    expect(updated.mcpServers).toHaveProperty('keep');
    expect(updated.version).toBe(2);

    // persisted definition (proves the write, not just the return value)
    const read = store.read('patch-delete');
    expect(read.mcpServers).not.toHaveProperty('agent');
    expect(read.mcpServers?.['keep']).toEqual(stdio('keep-cmd'));
  });

  it('a rename (delete old key + add new key) resolves BOTH in one patch', () => {
    store.create({
      name: 'patch-rename',
      systemPrompt: 's',
      provider: { type: 'openai', model: 'gpt-4' },
      mcpServers: { agent: stdio('x') },
      permissions: {},
    });

    const updated = store.update({
      name: 'patch-rename',
      patch: {
        mcpServers: {
          agent: null,
          'agent-mcp': stdio('y'),
        },
      },
    });

    expect(updated.mcpServers).not.toHaveProperty('agent');
    expect(updated.mcpServers?.['agent-mcp']).toEqual(stdio('y'));

    const read = store.read('patch-rename');
    expect(read.mcpServers).not.toHaveProperty('agent');
    expect(read.mcpServers?.['agent-mcp']).toEqual(stdio('y'));
  });

  it('a non-null value upserts (creates or overwrites) that key', () => {
    store.create({
      name: 'patch-upsert',
      systemPrompt: 's',
      provider: { type: 'openai', model: 'gpt-4' },
      mcpServers: {},
      permissions: {},
    });

    store.update({
      name: 'patch-upsert',
      patch: { mcpServers: { fresh: stdio('a') } },
    });
    const updated = store.update({
      name: 'patch-upsert',
      patch: { mcpServers: { fresh: stdio('b') } },
    });

    expect(updated.mcpServers?.['fresh']).toEqual(stdio('b'));
  });
});
