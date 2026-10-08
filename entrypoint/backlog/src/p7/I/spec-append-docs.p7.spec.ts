/**
 * p7/I/spec-append-docs.p7.spec.ts — backlog item 518fbda9: SKILL.md documents
 * spec-append `mode` (amend|replace), the root-replace rule and the
 * ADHD_BACKLOG_UNSAFE_SPEC_APPEND switch. Pure unit test: reads one file.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SKILL = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'skill', 'SKILL.md');

/** The "Write modes" subsection, up to the next heading of the same or higher level. */
function writeModesSection(): string {
  const text = readFileSync(SKILL, 'utf8');
  const start = text.indexOf('### Write modes');
  if (start < 0) return '';
  const rest = text.slice(start + 1);
  const next = rest.search(/\n#{1,3} /);
  return next < 0 ? rest : rest.slice(0, next);
}

describe('SKILL.md spec-append docs (518fbda9)', () => {
  it('518fbda9 AC1 (P7-I-AC041): names amend and replace, the base_revision CAS and the fold/token semantics', () => {
    const sec = writeModesSection();
    expect(sec).not.toBe('');
    expect(sec).toContain('amend');
    expect(sec).toContain('replace');
    expect(sec).toContain('base_revision');
    expect(sec).toMatch(/fold/);
    expect(sec).toMatch(/sha256/);
    expect(sec).toMatch(/stores no\s+`mode` key/);
  });

  it('518fbda9 AC2 (P7-I-AC047): states the root-replace rule and the force/snapshot interaction', () => {
    const sec = writeModesSection();
    expect(sec).toContain('invalid_argument');
    expect(sec).toContain('76466bb0');
    expect(sec).toContain('ADHD_BACKLOG_UNSAFE_SPEC_APPEND');
    expect(sec).toContain('force');
    expect(sec).toContain('snapshot');
    expect(sec).toMatch(/still refused/);
  });

  it('518fbda9 AC3 (P7-I-AC048): the whole file carries every required anchor string', () => {
    const text = readFileSync(SKILL, 'utf8');
    for (const s of ['amend', 'replace', 'invalid_argument', 'ADHD_BACKLOG_UNSAFE_SPEC_APPEND']) {
      expect(text).toContain(s);
    }
  });
});
