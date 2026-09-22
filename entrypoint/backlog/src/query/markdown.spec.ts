/**
 * markdown.spec.ts — `markdown.ts`'s pure rendering rules (DATA_MODEL.md §8),
 * unit-tested directly over hand-built `IIssueCard`s (no store needed — this
 * module has no store access of its own; the wiring that feeds it real cards
 * from a real store is `markdown-format.spec.ts`).
 */
import { describe, expect, it } from 'vitest';
import type { IIssueCard } from './types.js';
import {
  renderIssueCardsMarkdown,
  renderOneIssueCardMarkdown,
} from './markdown.js';

describe('renderOneIssueCardMarkdown', () => {
  it('renders the title as a "## " header, never the uid (DATA_MODEL.md §8)', () => {
    const card: IIssueCard = {
      uid: '11111111-1111-1111-1111-111111111111',
      title: 'Fix the flaky retry loop',
    };
    const text = renderOneIssueCardMarkdown(card);
    expect(text).toContain('## Fix the flaky retry loop');
    expect(text).not.toContain(card.uid);
  });

  it('a citation renders as `[target sha:...]` (DATA_MODEL.md §8) — file:lines when lines are given', () => {
    const card: IIssueCard = {
      uid: 'x',
      title: 'With a citation',
      citations: [
        {
          uid: 'c1',
          file: 'src/retry.ts',
          lines: '10-20',
          sha: 'abc123',
          at: '2026-01-01T00:00:00.000Z',
        },
      ],
    };
    const text = renderOneIssueCardMarkdown(card);
    expect(text).toContain('[src/retry.ts:10-20 sha:abc123]');
  });

  it('a citation with no `lines` renders just the file, not a trailing colon', () => {
    const card: IIssueCard = {
      uid: 'x',
      title: 'No line range',
      citations: [
        { uid: 'c1', file: 'src/retry.ts', sha: 'abc123', at: '2026-01-01T00:00:00.000Z' },
      ],
    };
    const text = renderOneIssueCardMarkdown(card);
    expect(text).toContain('[src/retry.ts sha:abc123]');
  });

  it('renders the item-level `gitContext` ONCE at the head of the `Citations:` block, before the citation lines (repo AGENTS.md disclosure format)', () => {
    const text = renderOneIssueCardMarkdown({
      uid: 'x',
      title: 'Disclosed',
      gitContext: 'feat/backlog-hard-replacement @ 4bf902fc',
      citations: [
        { uid: 'c1', file: 'src/retry.ts', lines: '10-20', sha: 'abc123', at: '2026-01-01T00:00:00.000Z' },
        { uid: 'c2', file: 'src/other.ts', sha: 'def456', at: '2026-01-01T00:00:00.000Z' },
      ],
    });
    // The head element is the git context, bracketed on the `Citations:` line.
    expect(text).toContain('Citations: [feat/backlog-hard-replacement @ 4bf902fc]');
    // ...and it appears exactly ONCE, never repeated per citation.
    expect(text.match(/feat\/backlog-hard-replacement @ 4bf902fc/g)).toHaveLength(1);
    // ...and the citation lines follow it, in order.
    const lines = text.split('\n');
    const headerIdx = lines.findIndex((l) => l.startsWith('Citations:'));
    expect(lines[headerIdx]).toBe(
      'Citations: [feat/backlog-hard-replacement @ 4bf902fc]'
    );
    expect(lines[headerIdx + 1]).toBe('- [src/retry.ts:10-20 sha:abc123]');
    expect(lines[headerIdx + 2]).toBe('- [src/other.ts sha:def456]');
  });

  it('a gitContext-only item renders a `Citations: [ctx]` block with no citation lines (never a bare header)', () => {
    const text = renderOneIssueCardMarkdown({
      uid: 'x',
      title: 't',
      gitContext: 'main @ deadbeef',
    });
    expect(text).toContain('Citations: [main @ deadbeef]');
    expect(text).not.toMatch(/^- \[/m);
  });

  it('a card with citations but NO gitContext renders the ORIGINAL bare `Citations:` header (no regression)', () => {
    const text = renderOneIssueCardMarkdown({
      uid: 'x',
      title: 't',
      citations: [
        { uid: 'c1', file: 'src/retry.ts', sha: 'abc123', at: '2026-01-01T00:00:00.000Z' },
      ],
    });
    expect(text).toContain('\nCitations:\n- [src/retry.ts sha:abc123]');
    expect(text).not.toContain('Citations: [');
  });

  it('a card with NEITHER gitContext nor citations renders no `Citations:` block at all', () => {
    const text = renderOneIssueCardMarkdown({ uid: 'x', title: 't' });
    expect(text).not.toContain('Citations');
  });

  it('an empty-string gitContext is treated as absent (no `Citations: []` block)', () => {
    const text = renderOneIssueCardMarkdown({
      uid: 'x',
      title: 't',
      gitContext: '',
    });
    expect(text).not.toContain('Citations');
  });

  it('an untitled card falls back to a stated placeholder, never a blank header', () => {
    const text = renderOneIssueCardMarkdown({ uid: 'x' });
    expect(text).toContain('## (untitled)');
  });

  it('kind/status/priority/assignee render as one meta line when present, omitted when absent', () => {
    const withMeta = renderOneIssueCardMarkdown({
      uid: 'x',
      title: 't',
      kind: 'bug',
      status: 'open',
      priority: 'p1',
      assignee: 'claude:1',
    });
    expect(withMeta).toContain('kind: bug · status: open · priority: p1 · assignee: claude:1');

    const withoutMeta = renderOneIssueCardMarkdown({ uid: 'x', title: 't' });
    expect(withoutMeta).not.toContain('kind:');
  });

  it('a present body renders as its own paragraph', () => {
    const text = renderOneIssueCardMarkdown({
      uid: 'x',
      title: 't',
      body: 'The body text.',
    });
    expect(text).toContain('The body text.');
  });
});

describe('renderIssueCardsMarkdown', () => {
  it('renders multiple cards separated by a blank line', () => {
    const text = renderIssueCardsMarkdown([
      { uid: 'a', title: 'First' },
      { uid: 'b', title: 'Second' },
    ]);
    expect(text).toContain('## First');
    expect(text).toContain('## Second');
    expect(text).toContain('## First\n\n## Second');
  });

  it('an empty page renders a stated "no matching issues" line, never a blank string', () => {
    const text = renderIssueCardsMarkdown([]);
    expect(text.trim().length).toBeGreaterThan(0);
    expect(text).toContain('No matching issues');
  });
});
