/**
 * query-scoping.spec.ts — BUG-023 (CRITICAL) + BUG-BACKLOG-003 (HIGH),
 * against a REAL temp SQLite-backed `GraphBacklogStore` (no mocks, real
 * `createItemNode`/`transitionStatusNode` writes, real `computeStats`/
 * `listItems`/`listItemsPage` reads).
 *
 * BUG-023: `computeStats`'s `byPriority`/`byKind`/`byFamily` used to be
 * computed over ALL items (open AND closed) while `open`/`closed` were
 * computed separately from the SAME array — the one field every triage
 * query sorts by silently counted RESOLVED/FIXED/VERIFIED rows too (measured
 * live: `byPriority.CRITICAL` reported 33 while only 16 CRITICAL items were
 * actually open). Fixed in `store/query.ts`'s `computeStats`/`countByPriority`;
 * this file seeds a real, DELIBERATELY ASYMMETRIC mix of OPEN and RESOLVED
 * items at every priority (so a scope-conflating bug cannot pass by
 * coincidence) and asserts the open-scoped and all-status maps are both
 * correct AND provably distinct.
 *
 * BUG-BACKLOG-003: `limit`/`offset` used to be applied at the SQL layer (or,
 * on the grep path, applied twice) BEFORE the open/closed post-filter ever
 * ran — a filtered page could silently under-return, and a raw page drawn
 * from an un-ordered SQL result could reorder/duplicate rows across calls.
 * Fixed in `store/query.ts`'s `fetchFilteredNodes`/`stableNodeOrder`/
 * `paginate`; this file (a) seeds >200 real items and proves paging the
 * FULL unfiltered set recovers every item exactly once in the same order,
 * and (b) reproduces the exact confirmed live-evidence shape — a contiguous
 * run of closed items spanning a raw page boundary — and proves a
 * status-filtered page no longer drops the open items on the far side of it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import type { Priority } from '../model.js';
import { createItemNode } from './crud.js';
import { transitionStatusNode } from './lifecycle.js';
import { computeStats, listItems, listItemsPage } from './query.js';

const REPO_STATS = 'PseudoSky/query-scoping-stats';
const REPO_PAGE = 'PseudoSky/query-scoping-page';

let tmp: TmpStore;

beforeEach(async () => {
  tmp = await openTmpStore('query-scoping-spec');
});

afterEach(async () => {
  await tmp.cleanup();
});

/** Transitions a freshly-created item straight to RESOLVED — the terminal-done path, which requires >=1 citation (SPEC.md §4.2 rule 3). */
async function resolveItem(repo: string, humanId: string): Promise<void> {
  await transitionStatusNode(tmp.store, repo, humanId, 'RESOLVED', { by: 'tester', citations: [{ file: 'test.ts' }] });
}

describe('computeStats — BUG-023 open-scoped priority/kind/family', () => {
  const PRIORITIES: Priority[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
  // Deliberately ASYMMETRIC open vs. closed counts per priority: if open and
  // closed counts were ever equal, an implementation that accidentally
  // scopes `byPriority` to ALL items could still pass by coincidence (open
  // === all-status numerically). Asymmetry makes that impossible.
  const OPEN_COUNT: Record<Priority, number> = { CRITICAL: 2, HIGH: 3, MEDIUM: 1, LOW: 4 };
  const CLOSED_COUNT: Record<Priority, number> = { CRITICAL: 5, HIGH: 1, MEDIUM: 2, LOW: 0 };

  async function seed(): Promise<void> {
    for (const priority of PRIORITIES) {
      for (let i = 0; i < OPEN_COUNT[priority]; i++) {
        await createItemNode(tmp.store, { family: 'BUG-SCOPE', title: `open ${priority} ${i}`, body: 'b', repo: REPO_STATS, priority });
      }
      for (let i = 0; i < CLOSED_COUNT[priority]; i++) {
        const created = await createItemNode(tmp.store, { family: 'BUG-SCOPE', title: `closed ${priority} ${i}`, body: 'b', repo: REPO_STATS, priority });
        await resolveItem(REPO_STATS, created.item.humanId);
      }
    }
  }

  it(
    'byPriority/byKind/byFamily are OPEN-scoped; byPriorityAllStatuses/byKindAllStatuses/byFamilyAllStatuses count every status',
    async () => {
      await seed();
      const stats = await computeStats(tmp.store, { repo: REPO_STATS });

      for (const priority of PRIORITIES) {
        expect(stats.byPriority[priority]).toBe(OPEN_COUNT[priority]);
        expect(stats.byPriorityAllStatuses[priority]).toBe(OPEN_COUNT[priority] + CLOSED_COUNT[priority]);
      }
      // The exact BUG-023 symptom, inverted: wherever closed items of a
      // priority exist, the open-scoped and all-status numbers must DIFFER.
      expect(stats.byPriority.CRITICAL).not.toBe(stats.byPriorityAllStatuses.CRITICAL);
      expect(stats.byPriority.HIGH).not.toBe(stats.byPriorityAllStatuses.HIGH);
      expect(stats.byPriority.MEDIUM).not.toBe(stats.byPriorityAllStatuses.MEDIUM);
      // LOW has zero closed items — the one priority where scopes legitimately coincide.
      expect(stats.byPriority.LOW).toBe(stats.byPriorityAllStatuses.LOW);

      const totalOpen = Object.values(OPEN_COUNT).reduce((a, b) => a + b, 0);
      const totalClosed = Object.values(CLOSED_COUNT).reduce((a, b) => a + b, 0);
      expect(stats.open).toBe(totalOpen);
      expect(stats.closed).toBe(totalClosed);
      expect(stats.total).toBe(totalOpen + totalClosed);

      expect(stats.byKind.BUG).toBe(totalOpen);
      expect(stats.byKindAllStatuses.BUG).toBe(totalOpen + totalClosed);
      expect(stats.byFamily['BUG-SCOPE']).toBe(totalOpen);
      expect(stats.byFamilyAllStatuses['BUG-SCOPE']).toBe(totalOpen + totalClosed);

      // coverage is REQUIRED (DEBT-BACKLOG-AUDIT-TRAIL-PARTIAL-001) — never silent about partial history.
      expect(stats.coverage.itemsTotal).toBe(totalOpen + totalClosed);
      expect(stats.coverage.itemsWithHistory).toBeGreaterThan(0); // every RESOLVED transition wrote a real audit event

      // BUG-024 (LOW, CONFIRMED): a repo-scoped computeStats call used to
      // hardcode byRepo/byRepoAllStatuses to `{}` instead of returning the
      // single-key breakdown the scope makes trivial. Every item above was
      // seeded with repo: REPO_STATS, so a correct scoped call reports
      // exactly one key with the real open/all-status counts — never `{}`.
      expect(stats.byRepo).toEqual({ [REPO_STATS]: totalOpen });
      expect(stats.byRepoAllStatuses).toEqual({ [REPO_STATS]: totalOpen + totalClosed });
    },
    30_000,
  );

  it(
    'FEAT-010: coverage + timeToResolution are derived from the REAL persisted transition log',
    async () => {
      const created = await createItemNode(tmp.store, { family: 'BUG-HIST', title: 't', body: 'b', repo: REPO_STATS });
      await resolveItem(REPO_STATS, created.item.humanId);

      const stats = await computeStats(tmp.store, { repo: REPO_STATS });
      expect(stats.coverage.itemsWithHistory).toBeGreaterThanOrEqual(1);
      expect(stats.coverage.itemsTotal).toBeGreaterThanOrEqual(1);
      expect(stats.coverage.auditWindowStart).toBeDefined();
      expect(stats.window?.since).toBeDefined();
      expect(stats.timeToResolution).toBeDefined();
      expect(stats.timeToResolution?.sampleSize).toBeGreaterThanOrEqual(1);
      expect(stats.timeToResolution?.medianMs).not.toBeNull();
      expect(stats.timeToResolution?.medianMs).toBeGreaterThanOrEqual(0);
    },
    30_000,
  );
});

describe('listItems/listItemsPage — BUG-BACKLOG-003 pagination composition', () => {
  const TOTAL = 220;
  const PAGE_LIMIT = 30;

  async function seedSequential(repo: string, family: string, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await createItemNode(tmp.store, { family, title: `item ${i}`, body: 'b', repo });
    }
  }

  it(
    'paging the FULL unfiltered set recovers every item EXACTLY ONCE, in the same order as the unpaged result',
    async () => {
      await seedSequential(REPO_PAGE, 'BUG-PAGE', TOTAL);
      const ground = await listItems(tmp.store, { repo: REPO_PAGE });
      expect(ground.length).toBe(TOTAL);

      const collected: string[] = [];
      let offset = 0;
      for (;;) {
        const { items, meta } = await listItemsPage(tmp.store, { repo: REPO_PAGE, limit: PAGE_LIMIT, offset });
        expect(meta.total).toBe(TOTAL);
        expect(meta.limit).toBe(PAGE_LIMIT);
        expect(meta.offset).toBe(offset);
        expect(meta.returned).toBe(items.length);
        collected.push(...items.map((it) => it.humanId));
        offset += PAGE_LIMIT;
        if (items.length < PAGE_LIMIT) break;
      }

      // Exactly once each, same order as the unpaged ground truth — no gaps,
      // no reordering, no duplicates across the page boundaries.
      expect(collected).toEqual(ground.map((it) => it.humanId));
      expect(new Set(collected).size).toBe(TOTAL);
    },
    30_000,
  );

  it(
    'BUG-BACKLOG-003: a status-filtered page recovers ALL open items across a contiguous run of closed items spanning a raw page boundary (the confirmed live-evidence shape)',
    async () => {
      // Mirrors the confirmed repro exactly: 5 open, 20 closed (a contiguous
      // run bigger than one page), 5 open. A caller paging {status:'open',
      // limit:10} across raw offsets 0/10/20 used to silently lose the
      // trailing 5 open items — the whole middle raw page (offset 10) landed
      // entirely on closed rows and returned zero, which a caller applying
      // the standard "stop on a short/empty page" convention read as "done".
      const openHumanIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        const created = await createItemNode(tmp.store, { family: 'BUG-CONTIG', title: `open-a-${i}`, body: 'b', repo: REPO_PAGE });
        openHumanIds.push(created.item.humanId);
      }
      for (let i = 0; i < 20; i++) {
        const created = await createItemNode(tmp.store, { family: 'BUG-CONTIG', title: `closed-${i}`, body: 'b', repo: REPO_PAGE });
        await resolveItem(REPO_PAGE, created.item.humanId);
      }
      for (let i = 0; i < 5; i++) {
        const created = await createItemNode(tmp.store, { family: 'BUG-CONTIG', title: `open-b-${i}`, body: 'b', repo: REPO_PAGE });
        openHumanIds.push(created.item.humanId);
      }
      expect(openHumanIds).toHaveLength(10);

      const recoveredOpen = new Set<string>();
      for (const offset of [0, 10, 20]) {
        const page = await listItems(tmp.store, { repo: REPO_PAGE, status: 'open', limit: 10, offset });
        for (const it of page) recoveredOpen.add(it.humanId);
      }

      expect(recoveredOpen.size).toBe(10);
      for (const humanId of openHumanIds) expect(recoveredOpen.has(humanId)).toBe(true);
    },
    30_000,
  );
});
