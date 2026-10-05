/**
 * agent-crud-projection.test.ts — acceptance: "MCP tools may not dump full
 * records of system prompts for agents — a full record must be EXPLICITLY
 * requested."
 *
 * Drives the REAL `agentRead` / `agentList` tool functions (not just the pure
 * helper) against a minimal in-memory `AgentStore`, so the projection is proven
 * at the tool boundary a consumer sees. The full-stack proof (real MCP client +
 * real SQLite store) lives in agent-mcp's
 * `agent-prompt-projection.e2e.test.ts`.
 *
 * Teeth: the default assertions fail if the projection is reverted to identity
 * (systemPrompt reappears in the default response).
 */
import { describe, expect, it } from 'vitest';

import type { AgentDefinition } from '@adhd/agent-base-types';

import {
  agentList,
  agentRead,
  agentUpdate,
  projectAgentRecord,
  type AgentCrudDeps,
  type AgentStore,
} from '../tools/agent-crud.js';
import {
  agentListInputSchema,
  agentReadInputSchema,
  agentUpdateInputSchema,
} from '../validation/index.js';

const PROMPT = 'S'.repeat(4096); // a deliberately multi-KB system prompt

function makeDefinition(name: string): AgentDefinition {
  return {
    name,
    description: `${name} description`,
    version: 1,
    provider: { type: 'claudecli' },
    systemPrompt: `${PROMPT}:${name}`,
    mcpServers: { fs: { transport: 'stdio', command: 'npx' } },
    permissions: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeDeps(defs: AgentDefinition[]): AgentCrudDeps {
  const store: AgentStore = {
    create: () => {
      throw new Error('not used');
    },
    read: (name) => {
      const found = defs.find((d) => d.name === name);
      if (!found) throw new Error(`missing ${name}`);
      return found;
    },
    update: (input) => {
      const existing = defs.find((d) => d.name === input.name);
      if (!existing) throw new Error(`missing ${input.name}`);
      return { ...existing, ...input.patch, version: existing.version + 1 };
    },
    delete: () => {
      throw new Error('not used');
    },
    list: () => defs,
  };
  return {
    agentStore: store,
    sessionStore: { list: () => [], close: () => undefined },
  };
}

describe('agent_* prompt projection', () => {
  describe('agent_read', () => {
    it('omits systemPrompt by default while keeping every other field (backward-compatible shape)', () => {
      const deps = makeDeps([makeDefinition('alpha')]);
      const out = agentRead(agentReadInputSchema.parse({ name: 'alpha' }), deps);

      expect(out).not.toHaveProperty('systemPrompt');
      // Non-prompt fields a consumer reads survive.
      expect(out['name']).toBe('alpha');
      expect(out['provider']).toEqual({ type: 'claudecli' });
      expect(out['mcpServers']).toEqual({ fs: { transport: 'stdio', command: 'npx' } });
      expect(out['version']).toBe(1);
      expect(out['createdAt']).toBe('2026-01-01T00:00:00.000Z');
      // Explicitly assert the multi-KB body is genuinely gone, not just absent
      // from the key check.
      expect(JSON.stringify(out)).not.toContain(PROMPT);
    });

    it('returns the full record with systemPrompt only when full:true', () => {
      const deps = makeDeps([makeDefinition('alpha')]);
      const out = agentRead(
        agentReadInputSchema.parse({ name: 'alpha', full: true }),
        deps
      );
      expect(out).toHaveProperty('systemPrompt', `${PROMPT}:alpha`);
    });

    it('returns systemPrompt when explicitly named in fields[]', () => {
      const deps = makeDeps([makeDefinition('alpha')]);
      const out = agentRead(
        agentReadInputSchema.parse({ name: 'alpha', fields: ['systemPrompt'] }),
        deps
      );
      expect(out).toEqual({ name: 'alpha', systemPrompt: `${PROMPT}:alpha` });
    });

    it('respects a fields[] projection that does not name systemPrompt', () => {
      const deps = makeDeps([makeDefinition('alpha')]);
      const out = agentRead(
        agentReadInputSchema.parse({ name: 'alpha', fields: ['version', 'provider'] }),
        deps
      );
      expect(out).toEqual({
        name: 'alpha',
        version: 1,
        provider: { type: 'claudecli' },
      });
      expect(out).not.toHaveProperty('systemPrompt');
    });
  });

  describe('agent_list', () => {
    it('omits systemPrompt from every record by default', () => {
      const deps = makeDeps([makeDefinition('alpha'), makeDefinition('beta')]);
      const out = agentList(agentListInputSchema.parse({}), deps);

      expect(out).toHaveLength(2);
      for (const record of out) {
        expect(record).not.toHaveProperty('systemPrompt');
        expect(record).toHaveProperty('name');
      }
      expect(JSON.stringify(out)).not.toContain(PROMPT);
    });

    it('includes systemPrompt for every record with full:true', () => {
      const deps = makeDeps([makeDefinition('alpha'), makeDefinition('beta')]);
      const out = agentList(agentListInputSchema.parse({ full: true }), deps);

      expect(out).toHaveLength(2);
      expect(out.map((r) => r['systemPrompt'])).toEqual([
        `${PROMPT}:alpha`,
        `${PROMPT}:beta`,
      ]);
    });
  });

  describe('agent_update', () => {
    it('omits systemPrompt by default but preserves openSessionsNotUpdated', () => {
      const deps = makeDeps([makeDefinition('alpha')]);
      const out = agentUpdate(
        agentUpdateInputSchema.parse({
          name: 'alpha',
          patch: { description: 'updated' },
        }),
        deps
      );
      expect(out).not.toHaveProperty('systemPrompt');
      expect(out['openSessionsNotUpdated']).toEqual([]);
      expect(out['description']).toBe('updated');
    });

    it('returns systemPrompt with full:true', () => {
      const deps = makeDeps([makeDefinition('alpha')]);
      const out = agentUpdate(
        agentUpdateInputSchema.parse({
          name: 'alpha',
          patch: { description: 'updated' },
          full: true,
        }),
        deps
      );
      expect(out['systemPrompt']).toBe(`${PROMPT}:alpha`);
    });
  });

  describe('validation', () => {
    it('rejects an unknown field name rather than silently dropping it', () => {
      expect(() =>
        agentReadInputSchema.parse({ name: 'alpha', fields: ['nope'] })
      ).toThrow();
    });

    it('accepts full:false as the explicit default', () => {
      const parsed = agentReadInputSchema.parse({ name: 'alpha', full: false });
      expect(parsed.full).toBe(false);
    });
  });

  describe('projectAgentRecord (pure)', () => {
    it('default removes systemPrompt; full:true restores it — the negative control', () => {
      const record = makeDefinition('alpha') as unknown as Record<string, unknown>;
      const projected = projectAgentRecord(record, {});
      const identity = projectAgentRecord(record, { full: true });

      expect(projected).not.toHaveProperty('systemPrompt');
      // The same input WITH the opt-in does have it, proving the omission is
      // the projection and not a missing source field.
      expect(identity).toHaveProperty('systemPrompt', `${PROMPT}:alpha`);
    });
  });
});
