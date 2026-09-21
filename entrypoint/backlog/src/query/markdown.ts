/**
 * markdown.ts — `query`'s `format:'markdown'` rendering (SPEC.md §6.5's
 * `format?: 'json' | 'markdown'`, DATA_MODEL.md §8's projection rule).
 *
 * This is a pure, generated VIEW over the exact same `IIssueCard[]` a
 * `format:'json'` caller already receives for the same view/filter/fields —
 * never a second query path, only a second serialization of the identical
 * page (SPEC.md §6.5: "renders this same page ... never a second code path").
 * `query.ts`'s `queryIssuesWithMeta` computes the normal JSON-shaped result
 * first, THEN calls {@link renderIssueCardsMarkdown} over its `items` when
 * `format:'markdown'` was requested — this module has no store access and no
 * filter/pagination logic of its own.
 *
 * Renders DATA_MODEL.md §8's two stated rules exactly:
 *  - "headers render the issue **title** (a readable label, not an identity
 *    map) — `uid`s are not rendered inline."
 *  - "Citations render as `[target sha:…]` — the `sha` is part of the
 *    citation, visible and independently verifiable."
 *
 * Only rendered for the fields actually present on each card (§6.5's `fields`
 * projection is honoured identically here — a caller who asked for the
 * five-field default card gets a terse markdown block; a caller who asked for
 * `body`/`citations` gets them rendered too), so this can never fabricate
 * data the caller did not request.
 */
import type { IIssueCard } from './types.js';

function renderCitationLines(card: IIssueCard): string[] {
  if (!card.citations || card.citations.length === 0) return [];
  const lines = ['', 'Citations:'];
  for (const citation of card.citations) {
    const target = citation.lines
      ? `${citation.file}:${citation.lines}`
      : citation.file;
    lines.push(`- [${target} sha:${citation.sha}]`);
  }
  return lines;
}

function renderMetaLine(card: IIssueCard): string | undefined {
  const parts: string[] = [];
  if (card.kind !== undefined) parts.push(`kind: ${card.kind}`);
  if (card.status !== undefined) parts.push(`status: ${card.status}`);
  if (card.priority !== undefined) parts.push(`priority: ${card.priority}`);
  if (card.assignee !== undefined) parts.push(`assignee: ${card.assignee}`);
  if (card.project !== undefined) parts.push(`project: ${card.project}`);
  if (card.component !== undefined) parts.push(`component: ${card.component}`);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** Renders one `IIssueCard` as a markdown section — title header, never the `uid` (DATA_MODEL.md §8). */
export function renderOneIssueCardMarkdown(card: IIssueCard): string {
  const lines: string[] = [`## ${card.title ?? '(untitled)'}`];
  const meta = renderMetaLine(card);
  if (meta !== undefined) lines.push(meta);
  if (card.body !== undefined && card.body.length > 0) {
    lines.push('', card.body);
  }
  lines.push(...renderCitationLines(card));
  return lines.join('\n');
}

/**
 * Renders a full page of issue cards as markdown (`query`'s `format:'markdown'`
 * result) — one `##` section per card, separated by a blank line. An empty
 * page renders a stated "no results" line rather than an empty string, so a
 * caller piping this straight to a file never gets a silently blank document.
 */
export function renderIssueCardsMarkdown(items: readonly IIssueCard[]): string {
  if (items.length === 0) return '_No matching issues._\n';
  return `${items.map(renderOneIssueCardMarkdown).join('\n\n')}\n`;
}
