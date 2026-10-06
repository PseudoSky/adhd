/**
 * 7ed25125 D-AC1 — a DAG node declaring lane L with a tool grant that lacks L's
 * required tools fails validation with a typed error; the SAME node with the
 * grant added passes (the negative control).
 */
import { describe, it, expect } from 'vitest';
import { validateDagJson } from '../lib/validate.js';
import { grantCovers, unsatisfiedLaneGroups, LANE_NAMES } from '../lib/lanes.js';

function dagWith(milestone: Record<string, unknown>): Record<string, unknown> {
  return {
    description: 'd',
    problem: 'p',
    approach: 'a',
    executor: 'e',
    schema_version: 5,
    plan_kind: 'greenfield',
    phases: ['p'],
    terminal: 'a',
    dispatch_log: [],
    optimization: {},
    providers: {},
    effort_max_tokens: {},
    milestones: {
      a: { description: 'a', depends_on: [], authored_by: 't', phase: 'p', read_only: [], ...milestone },
    },
    operations: [],
  };
}

describe('7ed25125 D-AC1 lane / tool-grant validation', () => {
  it('7ed25125 D-AC1: a research lane with a file-only grant fails with the typed lane_tool_grant_unsatisfied error', () => {
    const r = validateDagJson(dagWith({ lane: 'research', tool_grant: ['Read', 'Write'] }));
    expect(r.valid).toBe(false);
    const e = r.errors.find((x) => x.code === 'lane_tool_grant_unsatisfied');
    expect(e).toBeDefined();
    expect(e?.path).toBe('milestones.a.tool_grant');
    expect(e?.message).toContain('WebSearch');
  });

  it('7ed25125 D-AC1 NEGATIVE CONTROL: the same node with the grant added passes', () => {
    const r = validateDagJson(dagWith({ lane: 'research', tool_grant: ['Read', 'Write', 'WebSearch'] }));
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it('7ed25125 D-AC1: a lane with no tool_grant cannot be proven and is refused (lane_tool_grant_missing)', () => {
    const r = validateDagJson(dagWith({ lane: 'execution' }));
    expect(r.errors.map((e) => e.code)).toContain('lane_tool_grant_missing');
  });

  it('7ed25125 D-AC1: an unknown lane is refused (unknown_lane); a milestone with no lane is unaffected', () => {
    expect(validateDagJson(dagWith({ lane: 'wizardry', tool_grant: [] })).errors.map((e) => e.code)).toContain('unknown_lane');
    expect(validateDagJson(dagWith({})).valid).toBe(true);
    expect(validateDagJson(dagWith({ tool_grant: ['Bash'] })).valid).toBe(true);
  });

  it('7ed25125 D-AC1: a malformed tool_grant is a typed error', () => {
    const r = validateDagJson(dagWith({ lane: 'execution', tool_grant: 'Bash' }));
    expect(r.errors.map((e) => e.code)).toContain('invalid_tool_grant');
  });

  it('7ed25125 D-AC1: every built-in lane is satisfiable, and a wildcard grant covers the backlog lane', () => {
    for (const lane of LANE_NAMES) {
      expect(unsatisfiedLaneGroups(lane, ['Read', 'Write', 'WebSearch', 'Bash', 'mcp__backlog__backlog_get'])).toEqual([]);
    }
    expect(grantCovers(['mcp__backlog__*'], 'mcp__backlog__backlog_get')).toBe(true);
    expect(grantCovers(['Bash'], 'Read')).toBe(false);
    expect(unsatisfiedLaneGroups('file-ops', ['Read'])).toEqual([['Write', 'WriteFile', 'Edit', 'EditFile']]);
  });
});
