/**
 * docs-contract.spec.ts — keeps the HITL (03145a46) docs honest.
 *
 * The HITL fix (`57f53429`, merged `26252bfe`) made a sessioned dispatch task
 * suspend to `awaiting_input` and surfaced `awaitingInput { taskId, resumeToken }`
 * through `dispatch-cli status`. Two docs — `README.md` and `AGENTS.md` — and the
 * live-e2e header kept asserting the OLD blocker ("cannot observe awaiting_input",
 * "statusCore returns only MilestoneStatus", a dangling "KNOWN GAP" reference)
 * after the fix landed. This default-running, deterministic test fails if that
 * stale claim reappears, and fails if the "DAG agents must pre-exist /
 * `AGENT_NOT_FOUND`" behavior (`f1dbd0f2`) stops being documented.
 *
 * It asserts document STATE, not runtime behavior: the behavior itself is proven
 * by `hitl-suspension.spec.ts` (real `AgentMcpRunner` + `statusCore`),
 * `production-runner-no-auto-create.spec.ts`, and the live five-AC e2e's AC2.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// src/test/ -> package root
const PKG_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

function read(rel: string): string {
  return readFileSync(join(PKG_ROOT, rel), 'utf8');
}

/** Exact phrases the HITL fix obsoleted — their return is the regression. */
const STALE_HITL_PHRASES = [
  'Known blocker on AC2',
  'cannot observe `awaiting_input`',
  'carries no `awaiting_input`',
  'statusCore` returns only `MilestoneStatus`',
  'NOT asserted here',
] as const;

const DOCS: Record<string, string> = {
  'README.md': read('README.md'),
  'AGENTS.md': read('AGENTS.md'),
  'live-e2e header': read('src/test/integration/live-dispatch-five-acs.e2e.test.ts'),
};

describe('docs contract — HITL (03145a46) is reachable, not blocked', () => {
  for (const [name, text] of Object.entries(DOCS)) {
    it(`${name} no longer asserts the stale AC2 blocker`, () => {
      for (const stale of STALE_HITL_PHRASES) {
        expect(text, `${name} still contains the obsolete phrase: ${stale}`).not.toContain(stale);
      }
    });
  }

  it('README documents the awaitingInput{taskId,resumeToken} status contract + task_resume', () => {
    expect(DOCS['README.md']).toContain('awaitingInput: { taskId, resumeToken }');
    expect(DOCS['README.md']).toContain('task_resume');
  });

  it('AGENTS.md documents HITL as reachable (awaiting_input + resumeToken + task_resume)', () => {
    expect(DOCS['AGENTS.md']).toContain('awaiting_input');
    expect(DOCS['AGENTS.md']).toContain('resumeToken');
    expect(DOCS['AGENTS.md']).toContain('task_resume');
  });

  it('the live-e2e header asserts the status surface (no KNOWN GAP dangling reference)', () => {
    expect(DOCS['live-e2e header']).toContain('awaitingInput');
  });
});

describe('docs contract — DAG agents must pre-exist (f1dbd0f2)', () => {
  it('README documents the AGENT_NOT_FOUND no-auto-create behavior of --no-dry-run', () => {
    const readme = DOCS['README.md'];
    expect(readme).toContain('createAgentsIfMissing');
    expect(readme).toContain('AGENT_NOT_FOUND');
  });
});
