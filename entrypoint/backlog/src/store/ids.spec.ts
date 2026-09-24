/**
 * ids.spec.ts — BUG-BACKLOG-COMPUTENEXTHUMANID-GRAPH-ONLY-SCAN-001 part 2
 * (markdown-history seed) against a real temp `GraphBacklogStore` and real
 * on-disk `BACKLOG.md`/`CHANGELOG.md` files (no mocks). See `store/ids.ts`'s
 * `scanMaxOrdinalFromMarkdown` doc comment for the full rationale.
 *
 * `id-uniqueness.spec.ts` covers BUG-BACKLOG-HUMANID-FAMILY-CASE-001 and the
 * pre-existing graph-only-scan/uniqueness fixes; this file is deliberately
 * narrower and covers ONLY the markdown-seed addition.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openTmpStore, freshTmpDir, type TmpStore } from '../test/helpers/tmp-store.js';
import { createItemNode } from './crud.js';
import { scanMaxOrdinalFromMarkdown } from './ids.js';

const REPO = 'PseudoSky/adhd-ids-markdown-seed-test';

let tmp: TmpStore;
let markdownRoot: string;

beforeEach(async () => {
  tmp = await openTmpStore('ids-markdown-seed');
  markdownRoot = freshTmpDir('ids-markdown-seed-md');
});

afterEach(async () => {
  await tmp.cleanup();
  rmSync(markdownRoot, { recursive: true, force: true });
});

function writeBacklogMd(dir: string, content: string): void {
  writeFileSync(join(dir, 'BACKLOG.md'), content);
}

function writeChangelogMd(dir: string, content: string): void {
  writeFileSync(join(dir, 'CHANGELOG.md'), content);
}

describe('scanMaxOrdinalFromMarkdown — pure extraction', () => {
  it('finds the max ordinal for a family from a BACKLOG.md "##"/"###" id header', () => {
    writeBacklogMd(
      markdownRoot,
      [
        '## BUG-042 — some bug',
        '',
        '**Status:** OPEN',
        '',
        '## BUG-007 — an older bug',
        '',
        '**Status:** RESOLVED',
        '',
      ].join('\n')
    );
    expect(scanMaxOrdinalFromMarkdown(REPO, 'BUG', markdownRoot)).toBe(42);
  });

  it('finds the max ordinal for a family from CHANGELOG.md inline-prose id mentions', () => {
    writeChangelogMd(
      markdownRoot,
      [
        '## Unreleased',
        '',
        '### Fixed — something (BUG-CHLOG-013) (2026-08-01)',
        '',
        'Body text mentioning BUG-CHLOG-005 as a related, older issue.',
        '',
      ].join('\n')
    );
    expect(scanMaxOrdinalFromMarkdown(REPO, 'BUG-CHLOG', markdownRoot)).toBe(13);
  });

  it('takes the MAX across BOTH BACKLOG.md and CHANGELOG.md when both mention the same family', () => {
    writeBacklogMd(markdownRoot, '## BUG-BOTH-005 — open item\n\n**Status:** OPEN\n');
    writeChangelogMd(markdownRoot, '### Fixed — done (BUG-BOTH-019) (2026-08-01)\n');
    expect(scanMaxOrdinalFromMarkdown(REPO, 'BUG-BOTH', markdownRoot)).toBe(19);
  });

  it('is CASE-INSENSITIVE on the requested family — "bug" and "BUG" find the same real (upper-case) headers', () => {
    writeBacklogMd(markdownRoot, '## BUG-CI-009 — item\n\n**Status:** OPEN\n');
    expect(scanMaxOrdinalFromMarkdown(REPO, 'bug-ci', markdownRoot)).toBe(9);
    expect(scanMaxOrdinalFromMarkdown(REPO, 'BUG-CI', markdownRoot)).toBe(9);
  });

  it('returns 0 when no markdown file mentions the family at all', () => {
    writeBacklogMd(markdownRoot, '## FEAT-999 — unrelated family\n\n**Status:** OPEN\n');
    expect(scanMaxOrdinalFromMarkdown(REPO, 'BUG-NOTHING-HERE', markdownRoot)).toBe(0);
  });

  it('returns 0 when reposRoot has no BACKLOG.md/CHANGELOG.md at all', () => {
    expect(scanMaxOrdinalFromMarkdown(REPO, 'BUG', markdownRoot)).toBe(0);
  });

  it('walks nested subdirectories (a per-package BACKLOG.md), not just the root', () => {
    const nested = join(markdownRoot, 'entrypoint', 'some-pkg');
    mkdirSync(nested, { recursive: true });
    writeBacklogMd(nested, '## BUG-NESTED-021 — nested item\n\n**Status:** OPEN\n');
    expect(scanMaxOrdinalFromMarkdown(REPO, 'BUG-NESTED', markdownRoot)).toBe(21);
  });

  it('skips node_modules (never scans dependency trees for id-shaped headers)', () => {
    const insideNodeModules = join(markdownRoot, 'node_modules', 'some-dep');
    mkdirSync(insideNodeModules, { recursive: true });
    writeBacklogMd(insideNodeModules, '## BUG-SKIP-088 — should never be seen\n\n**Status:** OPEN\n');
    expect(scanMaxOrdinalFromMarkdown(REPO, 'BUG-SKIP', markdownRoot)).toBe(0);
  });
});

describe('fix (Fix 2): nextOrdinal cold-path seed honors the markdown ceiling ONLY when markdownRoot is explicitly supplied', () => {
  it('a fresh family with NO graph rows and a BACKLOG.md "## BUG-042" entry mints BUG-043 next, not BUG-001', async () => {
    writeBacklogMd(markdownRoot, '## BUG-042 — a pre-existing, markdown-only item\n\n**Status:** OPEN\n');

    // No graph rows for family 'BUG' exist yet in this fresh store — this IS
    // the cold path (`nextOrdinal`'s counter-row-does-not-exist branch).
    const result = await createItemNode(
      tmp.store,
      { family: 'BUG', title: 'first graph-side item for this family', body: 'b', repo: REPO },
      { markdownRoot }
    );

    // The failing condition this proves against: `result.item.humanId ===
    // 'BUG-001'` — the cold-path seed ignoring markdown history entirely and
    // re-minting an id `BACKLOG.md` already published.
    expect(result.item.humanId).toBe('BUG-043');
  });

  it('NEGATIVE CONTROL: the SAME scenario WITHOUT markdownRoot (opts omitted) mints BUG-001 — proving the markdown ceiling is opt-in, not silently always-on', async () => {
    writeBacklogMd(markdownRoot, '## BUG-042 — a pre-existing, markdown-only item\n\n**Status:** OPEN\n');

    const result = await createItemNode(tmp.store, {
      family: 'BUG',
      title: 'first graph-side item for this family, no markdownRoot supplied',
      body: 'b',
      repo: REPO,
    });

    // Proves the "explicitly opts in" contract has teeth: omitting
    // `markdownRoot` must NOT accidentally pick up the same ceiling via some
    // other default (e.g. `process.cwd()`), or this control could never go
    // red and the story above would prove nothing.
    expect(result.item.humanId).toBe('BUG-001');
  });

  it('a family that ALREADY has a counter row ignores markdownRoot entirely (only the COLD path seeds from markdown)', async () => {
    // Establish a live counter row for this family the ordinary way, with NO
    // markdown ceiling in play.
    const first = await createItemNode(tmp.store, { family: 'BUG-HOTPATH', title: 'seed', body: 'b', repo: REPO });
    expect(first.item.humanId).toBe('BUG-HOTPATH-001');

    // Now a markdown ceiling appears (e.g. a stale/unrelated file) far ABOVE
    // the counter's current position — since the counter row already exists,
    // this must be irrelevant: the hot path never re-consults the scan/seed.
    writeBacklogMd(markdownRoot, '## BUG-HOTPATH-999 — irrelevant once the counter row exists\n\n**Status:** OPEN\n');

    const second = await createItemNode(
      tmp.store,
      { family: 'BUG-HOTPATH', title: 'second', body: 'b', repo: REPO },
      { markdownRoot }
    );
    expect(second.item.humanId).toBe('BUG-HOTPATH-002');
  });
});
