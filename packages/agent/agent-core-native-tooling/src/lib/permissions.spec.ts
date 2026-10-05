import { describe, it, expect } from 'vitest';
import type { PermissionRuleMap } from '@adhd/agent-base-types';
import { matchPermission } from './permissions.js';

describe('matchPermission — LAST-match-wins with `deny` terminal (ADR-0008 D5; Q1 ratified)', () => {
  const map: PermissionRuleMap = { '*': 'ask', 'git *': 'allow', 'rm *': 'deny' };

  it('AC3a: git status -> allow (the later `git *` rule wins)', () => {
    // Negative control: a most-restrictive-wins implementation would return 'ask'
    // (the `*` rule) — so this assertion turns RED under the rejected semantics.
    expect(matchPermission(map, 'git status')).toBe('allow');
  });

  it('AC3b: rm -rf / -> deny', () => {
    expect(matchPermission(map, 'rm -rf /')).toBe('deny');
  });

  it('AC3c: ls -> ask (no later rule matches; falls through to `*`)', () => {
    expect(matchPermission(map, 'ls')).toBe('ask');
  });

  it('`deny` is TERMINAL even when a LATER rule matches', () => {
    // Last-match-wins alone would return 'allow' here; terminal-deny must win.
    expect(matchPermission({ 'rm *': 'deny', '*': 'allow' }, 'rm foo')).toBe('deny');
  });

  it('matches TOOL NAMES (e.g. `agent-mcp.*`), never command text', () => {
    const rules: PermissionRuleMap = { '*': 'ask', 'agent-mcp.*': 'allow' };
    expect(matchPermission(rules, 'agent-mcp.task')).toBe('allow');
    expect(matchPermission(rules, 'agent-mcp.agent')).toBe('allow');
    expect(matchPermission(rules, 'fs')).toBe('ask');
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
