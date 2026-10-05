import { describe, it, expect } from 'vitest';
import { effectiveHitl } from '@adhd/agent-base-types';
import {
  agentDefinitionSchema,
  agentDefinitionStoredSchema,
  agentPatchSchema,
  AGENT_PROJECTABLE_FIELDS,
} from '../validation/agent.js';

const base = {
  name: 'native-tooling-agent',
  version: 1,
  provider: { type: 'anthropic' as const },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('nativeTooling zod validation (ADR-0008 D3; NAT-TOOL-1)', () => {
  it('AC1: accepts {fs:true, shell:{permissions:{"rm *":"deny"}}, hitl:false, askPolicy:{order,escalateTo}}', () => {
    const result = agentDefinitionSchema.safeParse({
      ...base,
      nativeTooling: {
        fs: true,
        shell: { permissions: { 'rm *': 'deny' } },
        hitl: false,
        askPolicy: { order: ['escalate', 'deny'], escalateTo: 'parent' },
      },
    });
    expect(result.success).toBe(true);
  });

  it('AC2: REJECTS {fs:{root:42}} (root must be a string)', () => {
    const result = agentDefinitionSchema.safeParse({
      ...base,
      nativeTooling: { fs: { root: 42 } },
    });
    expect(result.success).toBe(false);
  });

  it('AC2 negative-control: rejects malformed override values the union must not swallow', () => {
    expect(
      agentDefinitionSchema.safeParse({ ...base, nativeTooling: { fs: { root: true } } }).success
    ).toBe(false);
    expect(
      agentDefinitionSchema.safeParse({ ...base, nativeTooling: { hitl: 'yes' } }).success
    ).toBe(false);
    expect(
      agentDefinitionSchema.safeParse({
        ...base,
        nativeTooling: { shell: { permissions: { x: 'maybe' } } },
      }).success
    ).toBe(false);
  });

  it('AC3: nativeTooling survives a serialize -> store -> read round-trip', () => {
    const nativeTooling = {
      fs: { root: '/work', readOnly: true, permissions: { fs: 'ask' as const } },
      shell: { allowCommands: ['ls', 'git'], timeoutMs: 30_000 },
      dispatch: true,
      hitl: true,
    };
    const stored = agentDefinitionStoredSchema.parse({ ...base, nativeTooling });
    const read = agentDefinitionStoredSchema.parse(JSON.parse(JSON.stringify(stored)));
    expect(read.nativeTooling).toEqual(nativeTooling);
  });

  it('AC4: a definition whose MCP server has no `cwd` still validates', () => {
    const result = agentDefinitionSchema.safeParse({
      ...base,
      mcpServers: {
        fs: {
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/p'],
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a stdio MCP server carrying the optional `cwd` (ADR-0008 D9)', () => {
    const result = agentDefinitionSchema.safeParse({
      ...base,
      mcpServers: { s: { transport: 'stdio', command: 'x', cwd: '/p/a' } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data.mcpServers['s'] as { cwd?: string }).cwd).toBe('/p/a');
    }
  });

  it('AC5: accepts {hitl, askPolicy}; `allowHumanInput` is a legacy alias for hitl (hitl WINS)', () => {
    expect(
      agentDefinitionSchema.safeParse({
        ...base,
        nativeTooling: { hitl: true, askPolicy: { order: ['suspend'], escalateTo: 'parent' } },
      }).success
    ).toBe(true);
    expect(effectiveHitl({ allowHumanInput: true })).toBe(true);
    expect(effectiveHitl({ allowHumanInput: true, nativeTooling: { hitl: false } })).toBe(false);
    expect(effectiveHitl({ nativeTooling: { hitl: true }, allowHumanInput: false })).toBe(true);
    expect(effectiveHitl({})).toBeUndefined();
  });

  it('nativeTooling is both an update-patch field and a projectable field', () => {
    expect(agentPatchSchema.safeParse({ nativeTooling: { shell: false } }).success).toBe(true);
    expect(AGENT_PROJECTABLE_FIELDS).toContain('nativeTooling');
  });
});
