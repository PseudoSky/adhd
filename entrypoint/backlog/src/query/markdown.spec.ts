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
