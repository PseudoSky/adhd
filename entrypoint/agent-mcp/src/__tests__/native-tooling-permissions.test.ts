/**
 * NAT-TOOL-6 — unit teeth for the resolved permission map + the production
 * wiring (ADR-0008 D5/D6).
 *
 * These guard the two failure modes the review flagged: (1) `nativeTooling.*.permissions`
 * validated + persisted but never READ (a silent no-op), and (2) the wrong
 * rule-resolution semantics. The end-to-end behaviour (refusal, suspend, escalate,
 * sessioned-everything) is proven through the real task/tool path in
 * `integration/nat-tool-6-permission-gate.e2e.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import type { AgentDefinition, NativeToolingConfig } from '@adhd/agent-base-types';

import {
  DEFAULT_PERMISSION_RULES,
  defaultPermissionGate,
  evaluateNativePermission,
  resolvePermissionRules,
} from '../defaults.js';
import { toEngineConfig } from '../config.js';

function def(nativeTooling: NativeToolingConfig): AgentDefinition {
  return {
    name: 'a',
    version: 1,
    provider: { type: 'openai', model: 'm' },
    mcpServers: {},
    permissions: {},
    nativeTooling,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('resolvePermissionRules — defaults + per-member overlay (ADR-0008 D5)', () => {
  it('an absent nativeTooling resolves to the default `allow` map', () => {
    expect(resolvePermissionRules(undefined)).toEqual(DEFAULT_PERMISSION_RULES);
    expect(resolvePermissionRules(undefined)['*']).toBe('allow');
  });

  it('overlays the fs → shell → dispatch permissions maps (pure, never mutates input)', () => {
    const nativeTooling: NativeToolingConfig = {
      fs: { permissions: { 'fs.*': 'ask' } },
      shell: { permissions: { 'shell.*': 'deny' } },
      dispatch: { permissions: { 'agent-mcp.*': 'allow' } },
    };
    const snapshot = JSON.stringify(nativeTooling);
    const rules = resolvePermissionRules(nativeTooling);
    expect(rules['fs.*']).toBe('ask');
    expect(rules['shell.*']).toBe('deny');
    expect(rules['agent-mcp.*']).toBe('allow');
    expect(rules['*']).toBe('allow');
    expect(JSON.stringify(nativeTooling)).toBe(snapshot);
  });

  it('a custom McpServerConfig member carries no permissions and is ignored', () => {
    const rules = resolvePermissionRules({
      shell: { transport: 'stdio', command: 'x' },
    });
    expect(rules).toEqual(DEFAULT_PERMISSION_RULES);
  });
});

describe('evaluateNativePermission — tool-NAME resource, last-match-wins, `deny` terminal (Q1)', () => {
  it('matches the server-qualified tool name and denies on a `deny` rule', () => {
    expect(
      evaluateNativePermission(
        { shell: { permissions: { 'shell.*': 'deny' } } },
        'shell',
        'shell_execute'
      )
    ).toBe('deny');
  });

  it('last-match-wins: a later `allow` overrides an earlier `*` ask', () => {
    expect(
      evaluateNativePermission(
        { dispatch: { permissions: { '*': 'ask', 'agent-mcp.*': 'allow' } } },
        'agent-mcp',
        'task'
      )
    ).toBe('allow');
  });

  it('`deny` is TERMINAL: a later `allow` cannot un-deny an earlier broad deny', () => {
    expect(
      evaluateNativePermission(
        { dispatch: { permissions: { '*': 'deny', 'agent-mcp.*': 'allow' } } },
        'agent-mcp',
        'task'
      )
    ).toBe('deny');
  });

  it('command text is never the resource (a `shell` tool deny does not match an unrelated server)', () => {
    expect(
      evaluateNativePermission({ shell: { permissions: { 'shell.*': 'deny' } } }, 'fs', 'read_text_file')
    ).toBe('allow');
  });
});

describe('gate blast radius — the gate is consulted for EVERY tool call (FIX 3, ADR-0008 D5)', () => {
  it('a bare `*` rule denies a NON-native server (documented blast radius, not a bug)', () => {
    // The engine holds no server taxonomy and consults the gate for every tool
    // call; `resolvePermissionRules` merges any member's `permissions` into one
    // flat map with a `*` baseline. So `{ '*': 'deny' }` under one member denies
    // `backlog` too — the documented behavior, pinned here so a change is a
    // deliberate decision, not silent drift.
    expect(
      evaluateNativePermission(
        { dispatch: { permissions: { '*': 'deny' } } },
        'backlog',
        'create'
      )
    ).toBe('deny');
  });

  it('a server-qualified rule does NOT leak to another server', () => {
    // The advised form: scope by server-qualified name. A `shell.*` deny leaves
    // every other server at its default (`allow`).
    expect(
      evaluateNativePermission(
        { shell: { permissions: { 'shell.*': 'deny' } } },
        'backlog',
        'create'
      )
    ).toBe('allow');
  });
});

describe('defaultPermissionGate + production wiring (guard against a silent no-op)', () => {
  it('toEngineConfig() injects the permission gate — `nativeTooling.permissions` IS read in production', () => {
    const gate = toEngineConfig().permissionGate;
    expect(typeof gate).toBe('function');
    expect(
      gate?.({ server: 'shell', tool: 'shell_execute', agentDefinition: def({ shell: { permissions: { 'shell.*': 'deny' } } }) })
    ).toBe('deny');
    expect(gate?.({ server: 'shell', tool: 'shell_execute', agentDefinition: def({}) })).toBe('allow');
  });

  it('defaultPermissionGate resolves the calling agent\u2019s map at call time', () => {
    expect(
      defaultPermissionGate({
        server: 'agent-mcp',
        tool: 'task',
        agentDefinition: def({ dispatch: { permissions: { '*': 'deny', 'agent-mcp.*': 'allow' } } }),
      })
    ).toBe('deny');
  });
});

describe('DEFAULT_PERMISSION_RULES is a FROZEN shared baseline (B3, dispatch-2026-10-04-9c4e)', () => {
  it('is frozen — a consumer cannot mutate engine-wide defaults in place', () => {
    // Negative control: without Object.freeze this is not frozen and the
    // assignment below silently succeeds, turning both assertions RED.
    expect(Object.isFrozen(DEFAULT_PERMISSION_RULES)).toBe(true);
    expect(() => {
      (DEFAULT_PERMISSION_RULES as Record<string, string>)['*'] = 'deny';
    }).toThrow(TypeError);
    expect(DEFAULT_PERMISSION_RULES['*']).toBe('allow');
  });

  it('resolvePermissionRules returns a FRESH copy, so per-agent edits never touch the default', () => {
    const rules = resolvePermissionRules({ fs: { permissions: { 'fs.*': 'deny' } } });
    expect(rules).not.toBe(DEFAULT_PERMISSION_RULES);
    rules['*'] = 'deny';
    expect(DEFAULT_PERMISSION_RULES['*']).toBe('allow');
  });
});
