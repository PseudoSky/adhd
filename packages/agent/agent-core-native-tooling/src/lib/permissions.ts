import type { PermissionAction, PermissionRuleMap } from '@adhd/agent-base-types';

/**
 * Compile a tool-name glob to an anchored RegExp. `*` matches any run of
 * characters; every other character is literal. Used ONLY against TOOL NAMES
 * (e.g. `agent-mcp.*`, `fs`, `shell`) — never command text (ADR-0008 D5).
 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*');
  return new RegExp(`^${escaped}$`);
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
    if (!globToRegExp(pattern).test(resource)) continue;
    if (action === 'deny') denied = true;
    matched = action;
  }

  if (denied) return 'deny';
  return matched ?? 'allow';
}
