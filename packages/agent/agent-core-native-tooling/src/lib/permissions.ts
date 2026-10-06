import type { PermissionAction, PermissionRuleMap } from '@adhd/agent-base-types';

/**
 * Memoized pattern→RegExp cache (dispatch-2026-10-04-9c4e, static-review bucket B).
 * The pattern set comes from agent definitions — small and static — so a
 * compiled RegExp is reused across calls instead of being rebuilt for every rule
 * on every `matchPermission` invocation.
 */
const TOOL_NAME_GLOB_CACHE = new Map<string, RegExp>();

/**
 * Compile a tool-name glob to an anchored RegExp. `*` matches any run of
 * characters; every other character is literal. Used ONLY against TOOL NAMES
 * (e.g. `agent-mcp.*`, `fs`, `shell`) — never command text (ADR-0008 D5).
 *
 * Compiled once per distinct pattern and cached: repeated calls with the same
 * pattern return the SAME RegExp instance, so matching never recompiles per rule
 * per call.
 */
export function compileToolNameGlob(pattern: string): RegExp {
  const cached = TOOL_NAME_GLOB_CACHE.get(pattern);
  if (cached) return cached;
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*');
  const compiled = new RegExp(`^${escaped}$`);
  TOOL_NAME_GLOB_CACHE.set(pattern, compiled);
  return compiled;
}

/**
 * Resolve the permission action for a native tool call (ADR-0008 D5; Q1 ratified).
 *
 * Semantics: **last-match-wins, with `deny` terminal**. Iterate the map in
 * insertion order; the last matching rule decides — EXCEPT that once any `deny`
 * rule matches, the result is `deny` regardless of later rules. An absent or empty
 * map defaults to `allow` (the base toolset must be usable without an answer).
 *
 * The matched resource is a **tool name** (e.g. `shell`, `fs`, `agent-mcp.task`);
 * this function never parses, matches, or segments command text, and command
 * text is never passed as the resource (the harness owns NO command semantics — D5).
 *
 * @example
 * matchPermission({ '*': 'ask', 'agent-mcp.*': 'allow', 'shell': 'deny' }, 'agent-mcp.task') // 'allow'
 * matchPermission({ 'shell': 'deny', '*': 'allow' }, 'shell') // 'deny' (deny is terminal)
 */
export function matchPermission(
  ruleMap: PermissionRuleMap | undefined | null,
  resource: string
): PermissionAction {
  if (!ruleMap) return 'allow';

  let matched: PermissionAction | undefined;
  let denied = false;

  for (const [pattern, action] of Object.entries(ruleMap)) {
    if (!compileToolNameGlob(pattern).test(resource)) continue;
    if (action === 'deny') denied = true;
    matched = action;
  }

  if (denied) return 'deny';
  return matched ?? 'allow';
}
