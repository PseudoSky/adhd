/**
 * spec-set-s02t1.spec.ts — 7130d457 (the ticket states no numbered ACs; AC1
 * maps to its decided expectation): SPEC-SET.md S02.T1 describes what
 * `transition.ts` does — `reason` is optional from the closed enum, an unknown
 * value is invalid, a reasonless transition succeeds with the
 * `superseded-without-reason` warning (ADR-0007 additive form) — and no longer
 * promises a typed error. UNIT test over the doc and the exported constants.
 * Negative control (run once, restored): restoring "a reasonless transition is
 * a typed error" turns it red.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SUPERSEDE_REASONS, SUPERSEDED_WITHOUT_REASON_WARNING } from './transition.js';

const specSet = readFileSync(
  fileURLToPath(new URL('../../../../docs/plan/backlog-consolidation/SPEC-SET.md', import.meta.url)),
  'utf8'
);
const t1 = specSet.split('\n').find((l) => l.includes('**S02.T1'));

describe('7130d457 — SPEC-SET S02.T1 matches the shipped SUPERSEDED reason behaviour', () => {
  it('7130d457 AC1 — S02.T1 says optional reason, invalid_argument for unknown, warning for reasonless, ADR-0007/ADR-0006 D6', () => {
    expect(t1).toBeDefined();
    expect(t1).toContain('optional `reason`');
    expect(t1).toContain('invalid_argument');
    expect(t1).toContain(`warnings:["${SUPERSEDED_WITHOUT_REASON_WARNING}"]`);
    expect(t1).toContain('ADR-0007');
    expect(t1).toContain('ADR-0006 D6');
    expect(t1).not.toContain('typed error');
    for (const r of SUPERSEDE_REASONS) expect(t1).toContain(r);
  });
});
