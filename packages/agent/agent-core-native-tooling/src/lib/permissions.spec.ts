import { describe, it, expect } from 'vitest';
import type { PermissionRuleMap } from '@adhd/agent-base-types';
import { matchPermission } from './permissions.js';

describe('matchPermission — LAST-match-wins with `deny` terminal over TOOL NAMES (ADR-0008 D5; Q1 ratified)', () => {
  // Every resource below is a TOOL NAME (`agent-mcp.task`, `shell`, `fs`, ...),
  // never command text (ADR-0008 D5). The gate owns no command semantics.
  const map: PermissionRuleMap = { '*': 'ask', 'agent-mcp.*': 'allow', 'shell': 'deny' };

  it('AC3a: agent-mcp.task -> allow (the later `agent-mcp.*` rule wins)', () => {
    // Negative control: a most-restrictive-wins implementation would return 'ask'
    // (the `*` rule) — so this assertion turns RED under the rejected semantics.
    expect(matchPermission(map, 'agent-mcp.task')).toBe('allow');
  });

  it('AC3b: shell -> deny', () => {
    expect(matchPermission(map, 'shell')).toBe('deny');
  });

  it('AC3c: fs -> ask (no later rule matches; falls through to `*`)', () => {
    expect(matchPermission(map, 'fs')).toBe('ask');
  });

  it('`deny` is TERMINAL even when a LATER rule matches', () => {
    // Last-match-wins alone would return 'allow' here; terminal-deny must win.
    expect(matchPermission({ 'shell': 'deny', '*': 'allow' }, 'shell')).toBe('deny');
  });

  it('matches TOOL NAMES (e.g. `agent-mcp.*`), never command text', () => {
    const rules: PermissionRuleMap = { '*': 'ask', 'agent-mcp.*': 'allow' };
    expect(matchPermission(rules, 'agent-mcp.task')).toBe('allow');
    expect(matchPermission(rules, 'agent-mcp.agent')).toBe('allow');
    expect(matchPermission(rules, 'fs')).toBe('ask');
  });

  it('the matched resource is a TOOL NAME; command text is never the resource (D5)', () => {
    // 1) A command-text PATTERN is meaningless against a tool name: the `rm *`
    //    rule must NOT match the `shell` tool (it would only match the literal
    //    string `rm ...`, which is never a resource). RED if a command string
    //    ever leaked in as the resource.
    expect(matchPermission({ '*': 'allow', 'rm *': 'deny' }, 'shell')).toBe('allow');
    // 2) A raw command string is an OPAQUE resource: it is never parsed,
    //    segmented, or mapped onto the `shell` tool that would run it, so
    //    `shell`'s own rule does not apply and `*` decides. RED if command text
    //    were ever mapped to a tool.
    expect(matchPermission({ '*': 'ask', 'shell': 'allow' }, 'git status')).toBe('ask');
    expect(matchPermission({ '*': 'ask', 'shell': 'allow' }, 'rm -rf /')).toBe('ask');
  });

  it('a broad `deny` stays ABSOLUTE over a later, more specific allow (terminal deny)', () => {
    // Q1's terminal-deny invariant — once ANY deny matches, the later
    // `agent-mcp.*` allow cannot un-deny it.
    expect(matchPermission({ '*': 'deny', 'agent-mcp.*': 'allow' }, 'agent-mcp.task')).toBe('deny');
  });

  it('an absent or empty map defaults to allow (base toolset usable without an answer, D5)', () => {
    expect(matchPermission(undefined, 'anything')).toBe('allow');
    expect(matchPermission(null, 'anything')).toBe('allow');
    expect(matchPermission({}, 'anything')).toBe('allow');
  });
});
