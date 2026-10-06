import { describe, it, expect } from 'vitest';
import { effectiveHitl } from '@adhd/agent-base-types';
import {
  agentDefinitionSchema,
  agentDefinitionStoredSchema,
  agentPatchSchema,
  AGENT_PROJECTABLE_FIELDS,
} from '../validation/agent.js';
import {
  shellBuiltinOverridesSchema,
  fsRootHintSchema,
  shellAllowPatternSchema,
} from '../validation/native-tooling.js';

const base = {
  name: 'native-tooling-agent',
  version: 1,
  provider: { type: 'anthropic' as const },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('nativeTooling zod validation (ADR-0008 D3; NAT-TOOL-1)', () => {
  it('AC1: accepts {fs:true, shell:{permissions:{"shell":"ask"}}, hitl:false, askPolicy:{order,escalateTo}}', () => {
    // ADR-0008 D5: the thin gate owns NO per-command permissions. Shell
    // overrides carry the adopted server's argv allowlist (allowCommands) plus
    // TOOL-NAME rules — never a command pattern like `rm *` (retired).
    const result = agentDefinitionSchema.safeParse({
      ...base,
      nativeTooling: {
        fs: true,
        shell: { permissions: { shell: 'ask' } },
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
      fs: { root: 'work', readOnly: true, permissions: { fs: 'ask' as const } },
      shell: {
        allowCommands: ['ls', 'git'],
        allowPatterns: ['ls.*', 'git'],
        timeoutMs: 30_000,
      },
      dispatch: true,
      hitl: true,
    };
    const stored = agentDefinitionStoredSchema.parse({ ...base, nativeTooling });
    const read = agentDefinitionStoredSchema.parse(JSON.parse(JSON.stringify(stored)));
    expect(read.nativeTooling).toEqual(nativeTooling);
  });

  it('AC1: accepts the shell `allowPatterns` passthrough; a non-array is rejected', () => {
    // The adopted server's `ALLOW_PATTERNS` (regex fullmatch over command NAMES)
    // is config plumbing only (ADR-0008 D5) — the schema accepts it as a string[].
    expect(
      shellBuiltinOverridesSchema.safeParse({ allowPatterns: ['ls.*', 'git'] }).success
    ).toBe(true);
    expect(
      shellBuiltinOverridesSchema.safeParse({ allowCommands: ['ls'], allowPatterns: ['ls.*'] })
        .success
    ).toBe(true);
    // Teeth: the leaf is a string[], not a string — a scalar must be rejected.
    expect(shellBuiltinOverridesSchema.safeParse({ allowPatterns: 'ls.*' }).success).toBe(false);
    // And the agent-definition boundary accepts it too, end to end.
    expect(
      agentDefinitionSchema.safeParse({
        ...base,
        nativeTooling: { shell: { allowPatterns: ['ls.*'] } },
      }).success
    ).toBe(true);
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

  it('B2: REJECTS the retired `shell.denyCommands` (removed from the type + schema)', () => {
    // The adopted shell server is allow-list only (ADR-0008 D5); `denyCommands`
    // was a silent no-op and has been removed. The strictObject now rejects it —
    // a re-added field would make these parses succeed, turning the test RED.
    expect(shellBuiltinOverridesSchema.safeParse({ denyCommands: ['rm'] }).success).toBe(false);
    expect(
      agentDefinitionSchema.safeParse({
        ...base,
        nativeTooling: { shell: { denyCommands: ['rm'] } },
      }).success
    ).toBe(false);
    // Teeth: the same strictObject still ACCEPTS the supported allowCommands.
    expect(shellBuiltinOverridesSchema.safeParse({ allowCommands: ['ls'] }).success).toBe(true);
  });
});

/**
 * The portable-hint zod boundary (#6): the exported `fsRootHintSchema` is now
 * covered directly AND through the agent-definition boundary, for BOTH `fs.root(s)`
 * and `shell.root` (the ONE contract, #3).
 */
describe('fsRootHintSchema — portable-hint boundary (#3/#6)', () => {
  it('rejects an absolute fs.root and fs.roots at the agent-definition boundary', () => {
    expect(
      agentDefinitionSchema.safeParse({ ...base, nativeTooling: { fs: { root: '/abs' } } }).success
    ).toBe(false);
    expect(
      agentDefinitionSchema.safeParse({ ...base, nativeTooling: { fs: { roots: ['/abs'] } } }).success
    ).toBe(false);
    // Teeth: the SAME shape with a portable hint is accepted — proving the
    // rejection is driven by absoluteness, not by the shape being unknown.
    expect(
      agentDefinitionSchema.safeParse({ ...base, nativeTooling: { fs: { roots: ['a', 'b'] } } }).success
    ).toBe(true);
  });

  it('accepts a relative hint AND an alias hint; rejects a non-string', () => {
    expect(fsRootHintSchema.safeParse('work/sub').success).toBe(true);
    expect(fsRootHintSchema.safeParse('project').success).toBe(true); // a named alias
    expect(fsRootHintSchema.safeParse('/abs').success).toBe(false);
    expect(fsRootHintSchema.safeParse(42).success).toBe(false);
    expect(fsRootHintSchema.safeParse(true).success).toBe(false);
  });

  it('#3: shell.root obeys the SAME portable-hint contract as fs.root', () => {
    // Absolute shell.root is rejected at the boundary …
    expect(
      agentDefinitionSchema.safeParse({ ...base, nativeTooling: { shell: { root: '/abs' } } }).success
    ).toBe(false);
    // … while a relative subpath and an alias are accepted.
    expect(
      agentDefinitionSchema.safeParse({ ...base, nativeTooling: { shell: { root: 'work' } } }).success
    ).toBe(true);
    expect(
      agentDefinitionSchema.safeParse({ ...base, nativeTooling: { shell: { root: 'project' } } }).success
    ).toBe(true);
    // Direct schema check (no union fallthrough can mask the leaf).
    expect(shellBuiltinOverridesSchema.safeParse({ root: '/abs' }).success).toBe(false);
  });

  it('#9: a comma-bearing allowPatterns entry is rejected (CSV join would corrupt it)', () => {
    // Teeth: a comma-free pattern with the SAME prefix is accepted, so the
    // rejection is the comma, not the pattern.
    expect(shellAllowPatternSchema.safeParse('ls.*').success).toBe(true);
    expect(shellAllowPatternSchema.safeParse('ls.*,git').success).toBe(false);
    expect(
      shellBuiltinOverridesSchema.safeParse({ allowPatterns: ['ls.*,git'] }).success
    ).toBe(false);
    expect(
      agentDefinitionSchema.safeParse({
        ...base,
        nativeTooling: { shell: { allowPatterns: ['a,b'] } },
      }).success
    ).toBe(false);
    // A comma-free list is still accepted end to end.
    expect(
      agentDefinitionSchema.safeParse({
        ...base,
        nativeTooling: { shell: { allowPatterns: ['ls.*', 'git'] } },
      }).success
    ).toBe(true);
  });
});
