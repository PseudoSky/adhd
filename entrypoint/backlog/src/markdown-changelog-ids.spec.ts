/**
 * markdown-changelog-ids.spec.ts — `parseChangelogIds` (P4). Real
 * CHANGELOG.md-shaped text, including this repo's own actual style
 * (parenthesized ids inside `###` prose headings, inline in body prose).
 */
import { describe, expect, it } from 'vitest';
import { parseChangelogIds } from './markdown.js';

describe('parseChangelogIds', () => {
  it('extracts ids parenthesized inside a ### heading, in appearance order, deduplicated', () => {
    const text = `
### Fixed — apigen-core-client schema extraction for nested interfaces never computed \`required\` array (BUG-APIGEN-CORE-CLIENT-001) (2026-07-28)

Some prose mentioning BUG-APIGEN-CORE-CLIENT-001 again, and a NEW one: BUG-BACKLOG-HUMANID-COLLISION-001.

### Added — Batch/bulk fan-out operations (FEAT-APIGEN-BULK-OPS-001) (2026-07-28)

More text.
`;
    expect(parseChangelogIds(text)).toEqual(['BUG-APIGEN-CORE-CLIENT-001', 'BUG-BACKLOG-HUMANID-COLLISION-001', 'FEAT-APIGEN-BULK-OPS-001']);
  });

  it('extracts multiple ids listed together in one heading', () => {
    const text = `### Added — schema-driven examples (FEAT-APIGEN-EXAMPLES-001, DEBT-APIGEN-DOCS-002) (2026-07-31)`;
    expect(parseChangelogIds(text)).toEqual(['FEAT-APIGEN-EXAMPLES-001', 'DEBT-APIGEN-DOCS-002']);
  });

  it('ignores tokens that are not id-shaped (no trailing 3+ digit numeric suffix)', () => {
    const text = `See SPEC.md and CLAUDE.md for the GPT-4 comparison and the v0.2.0 release notes. AC-12 is not an id either.`;
    expect(parseChangelogIds(text)).toEqual([]);
  });

  it('requires at least 3 trailing digits — a 2-digit suffix like BUG-42 is not treated as a real humanId', () => {
    // Real backlog humanIds always mint zero-padded to 3 digits
    // (`computeNextHumanId`'s `${family}-NNN`); a bare "BUG-42" in prose is
    // very likely referencing something else (an issue number, a PR, …).
    const text = `Closes BUG-42, references PR-7, but BUG-APIGEN-VARIANT-007 is a real id.`;
    expect(parseChangelogIds(text)).toEqual(['BUG-APIGEN-VARIANT-007']);
  });

  it('an empty/id-free changelog returns an empty array', () => {
    expect(parseChangelogIds('')).toEqual([]);
    expect(parseChangelogIds('Nothing to see here, just plain prose.')).toEqual([]);
  });

  it('real-shaped root CHANGELOG.md excerpt — multi-hyphen families, multiple ids per line', () => {
    const text = `**Related open issue:** \`BUG-BACKLOG-HUMANID-COLLISION-001\` — at least 4 collisions on "undefined-001" exist in production. See also DEBT-BACKLOG-HUMANID-NOT-UNIQUE-001 and DEBT-BACKLOG-COMPUTENEXTHUMANID-GRAPH-ONLY-SCAN-001.`;
    expect(parseChangelogIds(text)).toEqual([
      'BUG-BACKLOG-HUMANID-COLLISION-001',
      'DEBT-BACKLOG-HUMANID-NOT-UNIQUE-001',
      'DEBT-BACKLOG-COMPUTENEXTHUMANID-GRAPH-ONLY-SCAN-001',
    ]);
  });
});
