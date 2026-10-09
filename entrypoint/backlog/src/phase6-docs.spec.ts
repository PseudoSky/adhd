/**
 * phase6-docs.spec.ts — the documented surface matches the shipped one.
 *
 * - 050ea18f A-AC4 (S02.H45): `SPEC.md` no longer states "exactly one component"
 *   (the 1:1 placement sentence is replaced by the n:m + primary-owner rule).
 * - Every mounted verb is documented in `skill/SKILL.md` and `README.md` (a verb
 *   added to `BACKLOG_VERBS` without docs fails here).
 * - The S02/S11 additions each appear in the docs that own them.
 *
 * Reads source text only.
 *
 * Negative control (run once, restored): re-adding "exactly one component per
 * issue" to SPEC.md, or dropping `timeline` from SKILL.md, turns the matching
 * row red.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BACKLOG_VERBS } from './vocabulary.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');
const spec = read('SPEC.md');
const dataModel = read('DATA_MODEL.md');
// 4d24f105 AC10.1: the skill is split into a quick reference (SKILL.md) and the
// long-form REFERENCE.md; every documented-surface check reads the pair.
const skill = `${read('skill/SKILL.md')}\n${read('skill/REFERENCE.md')}`;
const readme = read('README.md');

describe('050ea18f A-AC4 — SPEC.md states the n:m rule', () => {
  it('050ea18f A-AC4 SPEC.md no longer says "exactly one component"', () => {
    expect(spec).not.toMatch(/exactly one component/i);
  });
  it('050ea18f A-AC4 SPEC.md and DATA_MODEL.md state the n:m + primary-owner rule', () => {
    expect(spec).toMatch(/n:m, one primary owner/);
    expect(spec).toMatch(/`in_component`/);
    expect(dataModel).toMatch(/in_component\s+issue\s+→ component\s+\(n:m\)/);
  });
});

describe('phase-6 docs — every mounted verb and every addition is documented', () => {
  it.each([...BACKLOG_VERBS])('verb %s is documented in SKILL.md', (verb) => {
    expect(skill).toContain(verb);
  });
  it('the verb count is stated as the mounted count', () => {
    const n = BACKLOG_VERBS.length;
    expect(skill).toContain(`${n} verbs (plus \`batch\`)`);
    expect(readme).toContain(`${n} verbs plus \`batch\``);
  });
  it('S02 and S11 additions appear in SKILL.md', () => {
    for (const needle of [
      'primaryOwner',
      'memberships',
      'unverified-with-reason',
      'supersededBy',
      'superseded-without-reason',
      'actor_mismatch',
      'orphanedParent',
      'registry-orphans',
      'sessionId',
      'view":"reservations"',
      'timeline',
      'specRevisionFragment',
      'byCitationPath',
    ]) {
      expect(skill, needle).toContain(needle);
    }
  });
  it('S02 and S11 additions appear in DATA_MODEL.md and the SPEC appendix', () => {
    for (const needle of ['op_event', 'reservation', 'supersede_reason', 'unverified_reason', 'in_session']) {
      expect(dataModel, needle).toContain(needle);
    }
    for (const needle of ['timeline', 'reservations', 'byCitationPath', 'orphaned-parents', 'superseded-without-reason']) {
      expect(spec, needle).toContain(needle);
    }
  });
});
