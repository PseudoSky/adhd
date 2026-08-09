/**
 * client.spec.ts — real-component coverage of the CRUD/lifecycle/structure/
 * query operation surface (SPEC.md §5), against a real temp SQLite-backed
 * `GraphBacklogStore` (no mocks). DoD-specific proofs (CAS race, markdown
 * round-trip, live HTTP/MCP mounts, scope isolation, cycle detection,
 * citation gate) live in their own dedicated spec files per DESIGN.md §13.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as client from './client.js';
import type { BacklogCtx } from './client.js';
import { openTmpStore, type TmpStore } from './test/helpers/tmp-store.js';
import { buildBacklogEnv } from './env.js';

let tmp: TmpStore;
let ctx: BacklogCtx;

beforeEach(() => {
  tmp = openTmpStore('client-spec');
  ctx = { store: tmp.store, env: buildBacklogEnv({ scope: 'project', adhdRoot: tmp.dir }) };
});

afterEach(() => {
  tmp.cleanup();
});

const REPO = 'PseudoSky/backlog-test';

describe('createItem / getItem / listItems', () => {
  it('creates an item starting OPEN, allocates a humanId, and round-trips through getItem', async () => {
    const result = await client.createItem(ctx, {
      family: 'BUG-TEST',
      title: 'A real bug',
      body: 'It broke.',
      repo: REPO,
      priority: 'HIGH',
      tags: ['flaky'],
    });
    expect(result.created).toBe(true);
    expect(result.item.humanId).toBe('BUG-TEST-001');
    expect(result.item.status).toBe('OPEN');
    expect(result.item.priority).toBe('HIGH');
    expect(result.item.tags).toContain('flaky');

    const fetched = await client.getItem(ctx, REPO, result.item.humanId);
    expect(fetched).not.toBeNull();
    expect(fetched?.title).toBe('A real bug');
    expect(fetched?.body).toBe('It broke.');
  });

  it('allocates sequential humanIds within (repo, family)', async () => {
    const a = await client.createItem(ctx, { family: 'BUG-SEQ', title: 'first', body: 'x', repo: REPO });
    const b = await client.createItem(ctx, { family: 'BUG-SEQ', title: 'second', body: 'y', repo: REPO });
    expect(a.item.humanId).toBe('BUG-SEQ-001');
    expect(b.item.humanId).toBe('BUG-SEQ-002');
  });

  it('dedupe-scans by title (FTS) and refuses to create unless forced', async () => {
    const first = await client.createItem(ctx, {
      family: 'BUG-DUP',
      title: 'The database connection pool leaks under load',
      body: 'Repro steps here.',
      repo: REPO,
    });
    const attempt = await client.createItem(ctx, {
      family: 'BUG-DUP',
      title: 'database connection pool leaks under load',
      body: 'Same bug, different words.',
      repo: REPO,
    });
    expect(attempt.created).toBe(false);
    expect(attempt.duplicateCandidates.length).toBeGreaterThan(0);
    expect(attempt.duplicateCandidates[0]?.humanId).toBe(first.item.humanId);

    const forced = await client.createItem(ctx, {
      family: 'BUG-DUP',
      title: 'database connection pool leaks under load',
      body: 'Same bug, different words.',
      repo: REPO,
      force: true,
    });
    expect(forced.created).toBe(true);
    expect(forced.item.humanId).not.toBe(first.item.humanId);
  });

  it('does NOT flag a short generic new title as a duplicate of an unrelated long document that merely repeats a couple of its words (BUG-BACKLOG-DEDUPE-FTS-WEAK-MATCH-001)', async () => {
    // Regression guard for the exact live-reproduced false positive: a real,
    // very long, verbose ticket (here: about batch/live dispatch wiring) that
    // happens to repeat the words "live" and "batch" (and, incidentally,
    // "item"/"1") many times used to swallow the FTS bareword AND-query for
    // an entirely unrelated short title, "live batch proof item 1", and block
    // its creation outright.
    const longUnrelatedBody = Array.from(
      { length: 40 },
      (_, i) =>
        `This describes the live dispatch mount and batch action wiring in detail, item ${i} of 1, as proof of correctness. ` +
        `The live batch mount handles live batch requests through the batch plugin using --use batch live dispatch, see item 1 above for proof.`
    ).join(' ');
    await client.createItem(ctx, {
      family: 'BUG-APIGEN-CLI-OUTPUT',
      title: 'apigen-cli output mount flag wiring is inconsistent across hosts',
      body: longUnrelatedBody,
      repo: REPO,
    });

    const result = await client.createItem(ctx, {
      family: 'TEST-BATCH-LIVE-PROOF',
      title: 'live batch proof item 1',
      body: 'disposable test item, unrelated to CLI output wiring.',
      repo: REPO,
    });

    expect(result.created, `expected the short generic title to create cleanly, got duplicateCandidates=${JSON.stringify(result.duplicateCandidates.map((c) => c.humanId))}`).toBe(true);
    expect(result.duplicateCandidates).toEqual([]);
  });

  it('still flags a genuine near-duplicate short title as a duplicate candidate (BUG-BACKLOG-DEDUPE-FTS-WEAK-MATCH-001 — must not swing to zero detection)', async () => {
    // Same shape as the "dedupe-scans by title (FTS)" positive control above,
    // but phrased differently to prove the title-overlap fix doesn't
    // over-correct into never catching real duplicates: two short titles
    // describing the same real thing in mostly-the-same words must still be
    // caught, even with the new title-overlap gate in place.
    const first = await client.createItem(ctx, {
      family: 'BUG-DUP2',
      title: 'API rate limiter drops requests under high concurrency',
      body: 'Repro steps here.',
      repo: REPO,
    });
    const attempt = await client.createItem(ctx, {
      family: 'BUG-DUP2',
      title: 'rate limiter drops requests under high concurrency',
      body: 'Same bug, slightly different words, seen again independently.',
      repo: REPO,
    });
    expect(attempt.created).toBe(false);
    expect(attempt.duplicateCandidates.length).toBeGreaterThan(0);
    expect(attempt.duplicateCandidates[0]?.humanId).toBe(first.item.humanId);
  });

  it('createItem never crashes on a title containing FTS5-syntax-significant characters (BUG-BACKLOG-DEDUPE-FTS-SYNTAX-CRASH-001)', async () => {
    // Regression guard: `dedupeScan` used to pass `input.title` RAW to
    // `store.graph.searchNodes()`, which binds it directly as an FTS5 MATCH
    // query — real, unremarkable English titles ("off-by-one", "fix: the
    // thing") crashed `createItem` outright with a raw SqliteError instead
    // of running the dedupe scan.
    const titles = [
      'fix off-by-one error',
      'title: with a colon',
      'paren(thetical) note',
      'quote" inside title',
      // Found independently (not in the original report) while building the
      // MIGRATION.md §3.3 20-writer scale test — a title containing `#`
      // (e.g. this test's own "scale create #7"-shaped titles, or a real
      // "Fixes #123" reference) crashed the same way the original report's
      // characters did. Probing FTS5's actual grammar turned up a much
      // longer list of characters with the identical failure mode —
      // `sanitizeFtsQuery` was widened from a denylist to a Unicode-aware
      // allowlist (letters/numbers/underscore/whitespace only) rather than
      // patched character-by-character again.
      'issue #123 reference',
      'a.b{c}d~e[f]g@h!i$j%k&l=m<n>o?p/q\\r;s,t',
    ];
    for (const title of titles) {
      const result = await client.createItem(ctx, { family: 'BUG-FTS-SYNTAX', title, body: 'x', repo: REPO });
      expect(result.created, `createItem must not throw for title: ${JSON.stringify(title)}`).toBe(true);
    }
  });

  it('listItems({grep}) never crashes on a grep term containing FTS5-syntax-significant characters (BUG-BACKLOG-DEDUPE-FTS-SYNTAX-CRASH-001)', async () => {
    await client.createItem(ctx, { family: 'BUG-GREP-SYNTAX', title: 'fix off-by-one error', body: 'x', repo: REPO });
    const results = await client.listItems(ctx, { repo: REPO, grep: 'off-by-one' });
    expect(results.length).toBeGreaterThan(0);
  });

  it('two items with byte-identical title+body in the same repo never collapse into one node', async () => {
    // Regression guard for the content-hash collision deviation documented in
    // store/mapping.ts — without the uniqueness marker this would silently
    // return the SAME nodeId for both, losing the second item's identity.
    const a = await client.createItem(ctx, { family: 'BUG-COLLIDE', title: 'Same', body: 'Same', repo: REPO, force: true });
    const b = await client.createItem(ctx, { family: 'BUG-COLLIDE', title: 'Same', body: 'Same', repo: REPO, force: true });
    expect(a.item.nodeId).not.toBe(b.item.nodeId);
    expect(a.item.humanId).not.toBe(b.item.humanId);
  });

  it('listItems filters by status open/closed and excludes invalidated items', async () => {
    const open = await client.createItem(ctx, { family: 'BUG-LIST', title: 'open one', body: 'x', repo: REPO });
    const closed = await client.createItem(ctx, { family: 'BUG-LIST', title: 'closed one', body: 'x', repo: REPO });
    await client.transitionStatus(ctx, REPO, closed.item.humanId, 'FIXED', {
      by: 'implementer:1',
      citations: [{ file: 'a.ts' }],
    });

    const openItems = await client.listItems(ctx, { repo: REPO, family: 'BUG-LIST', status: 'open' });
    const closedItems = await client.listItems(ctx, { repo: REPO, family: 'BUG-LIST', status: 'closed' });
    expect(openItems.map((i) => i.humanId)).toEqual([open.item.humanId]);
    expect(closedItems.map((i) => i.humanId)).toEqual([closed.item.humanId]);

    await client.softDeleteItem(ctx, REPO, open.item.humanId, 'no longer relevant');
    const afterDelete = await client.listItems(ctx, { repo: REPO, family: 'BUG-LIST' });
    expect(afterDelete.map((i) => i.humanId)).not.toContain(open.item.humanId);
  });

  it('updateItem changes title/body/projectPath', async () => {
    const created = await client.createItem(ctx, { family: 'BUG-UPD', title: 'orig', body: 'orig body', repo: REPO });
    const updated = await client.updateItem(ctx, REPO, created.item.humanId, {
      title: 'new title',
      body: 'new body',
      projectPath: 'packages/foo',
    });
    expect(updated.title).toBe('new title');
    expect(updated.body).toBe('new body');
    expect(updated.projectPath).toBe('packages/foo');
  });

  it('updateItem re-indexes FTS content on a body edit — listItems({grep}) finds the NEW term (DEBT-BACKLOG-CONTENT-IMMUTABLE-001)', async () => {
    // Regression guard: `updateItemNode` used to patch ONLY `metadata.body`,
    // leaving the FTS-indexed `node.content` (set once at createItem time)
    // stale — a grep for a term introduced by a post-create body edit would
    // silently miss the item forever, until it was superseded.
    const rareTermBefore = 'zzflibbertigibbet';
    const rareTermAfter = 'wobblequartznine';
    const created = await client.createItem(ctx, {
      family: 'BUG-FTS',
      title: 'fts resync fixture',
      body: `mentions ${rareTermBefore} in the original body`,
      repo: REPO,
    });

    const beforeEdit = await client.listItems(ctx, { repo: REPO, grep: rareTermBefore });
    expect(beforeEdit.map((i) => i.humanId)).toContain(created.item.humanId);
    const beforeEditNewTerm = await client.listItems(ctx, { repo: REPO, grep: rareTermAfter });
    expect(beforeEditNewTerm.map((i) => i.humanId)).not.toContain(created.item.humanId);

    // Body-only edit (title untouched) — isolates the FTS gap to `content`,
    // since a title edit alone already updates `summary` (also FTS-indexed).
    await client.updateItem(ctx, REPO, created.item.humanId, {
      body: `mentions ${rareTermAfter} after the edit`,
    });

    const afterEdit = await client.listItems(ctx, { repo: REPO, grep: rareTermAfter });
    expect(afterEdit.map((i) => i.humanId), 'grep for the NEW body term must find the item post-edit').toContain(created.item.humanId);
  });
});

describe('claim / lifecycle', () => {
  it('startWork claims + transitions to IN_PROGRESS; resolveItem requires a citation to reach FIXED', async () => {
    const created = await client.createItem(ctx, { family: 'BUG-WORK', title: 't', body: 'b', repo: REPO });
    const started = await client.startWork(ctx, REPO, created.item.humanId, 'implementer:a');
    expect(started.status).toBe('IN_PROGRESS');
    expect(started.claimedBy).toBe('implementer:a');

    const resolved = await client.resolveItem(ctx, REPO, created.item.humanId, 'FIXED', {
      by: 'implementer:a',
      citations: [{ file: 'src/x.ts', lines: '1-2' }],
    });
    expect(resolved.status).toBe('FIXED');
    // §4.2 rule 4 — claim is cleared on any terminal transition.
    expect(resolved.claimedBy).toBeUndefined();
  });

  it('addCitation / appendNote accumulate without clobbering existing entries', async () => {
    const created = await client.createItem(ctx, { family: 'BUG-NOTE', title: 't', body: 'b', repo: REPO });
    await client.addCitation(ctx, REPO, created.item.humanId, { file: 'a.ts' });
    const withNote = await client.appendNote(ctx, REPO, created.item.humanId, 'human:pseudosky', 'investigating');
    const withSecondCitation = await client.addCitation(ctx, REPO, created.item.humanId, { file: 'b.ts' });
    expect(withNote.citations).toHaveLength(1);
    expect(withSecondCitation.citations).toHaveLength(2);
    expect(withSecondCitation.notes).toHaveLength(1);
    expect(withSecondCitation.notes[0]?.text).toBe('investigating');
  });

  it('claimItem: held by another non-stale claimant refuses; force overrides', async () => {
    const created = await client.createItem(ctx, { family: 'BUG-CLAIM', title: 't', body: 'b', repo: REPO });
    const first = await client.claimItem(ctx, REPO, created.item.humanId, 'agent:a');
    expect(first.status).toBe('claimed');

    const second = await client.claimItem(ctx, REPO, created.item.humanId, 'agent:b');
    expect(second.status).toBe('held');
    expect(second.heldBy).toBe('agent:a');

    const forced = await client.claimItem(ctx, REPO, created.item.humanId, 'agent:b', { force: true });
    expect(forced.status).toBe('reclaimed-stale');
    expect(forced.previousClaimant).toBe('agent:a');

    const released = await client.releaseClaim(ctx, REPO, created.item.humanId, 'agent:b');
    expect(released.status).toBe('released');
    const releaseAgain = await client.releaseClaim(ctx, REPO, created.item.humanId, 'agent:b');
    expect(releaseAgain.status).toBe('release-noop');
  });

  it('renewClaim always succeeds and bumps claimedAt for the current claimant', async () => {
    const created = await client.createItem(ctx, { family: 'BUG-RENEW', title: 't', body: 'b', repo: REPO });
    await client.claimItem(ctx, REPO, created.item.humanId, 'agent:a');
    const renewed = await client.renewClaim(ctx, REPO, created.item.humanId, 'agent:a');
    expect(renewed.status).toBe('renewed');
  });
});

describe('structure', () => {
  it('addDependency / removeDependency / blockers / readyItems', async () => {
    const blocker = await client.createItem(ctx, { family: 'BUG-DEP', title: 'blocker', body: 'b', repo: REPO });
    const blocked = await client.createItem(ctx, { family: 'BUG-DEP', title: 'blocked', body: 'b', repo: REPO });
    await client.addDependency(ctx, REPO, blocked.item.humanId, blocker.item.humanId);

    const blockers = await client.blockers(ctx, REPO, blocked.item.humanId);
    expect(blockers.map((i) => i.humanId)).toEqual([blocker.item.humanId]);

    let ready = await client.readyItems(ctx, { repo: REPO });
    expect(ready.map((i) => i.humanId)).not.toContain(blocked.item.humanId);
    expect(ready.map((i) => i.humanId)).toContain(blocker.item.humanId);

    await client.resolveItem(ctx, REPO, blocker.item.humanId, 'FIXED', { by: 'x', citations: [{ file: 'a.ts' }] });
    ready = await client.readyItems(ctx, { repo: REPO });
    expect(ready.map((i) => i.humanId)).toContain(blocked.item.humanId);

    await client.removeDependency(ctx, REPO, blocked.item.humanId, blocker.item.humanId);
    const blockersAfter = await client.blockers(ctx, REPO, blocked.item.humanId);
    expect(blockersAfter).toHaveLength(0);
  });

  it('supersedeItem mints a new item, links SUPERSEDES, and invalidates the old one', async () => {
    const old = await client.createItem(ctx, { family: 'BUG-SUP', title: 'old', body: 'b', repo: REPO });
    const replacement = await client.supersedeItem(
      ctx,
      REPO,
      old.item.humanId,
      { family: 'BUG-SUP', title: 'new', body: 'b2', repo: REPO },
      'rewritten with a better approach'
    );
    expect(replacement.humanId).not.toBe(old.item.humanId);
    expect(replacement.title).toBe('new');

    const oldNowGone = await client.getItem(ctx, REPO, old.item.humanId);
    expect(oldNowGone).toBeNull(); // superseded + invalidated -> excluded from live views

    const trail = await client.auditTrail(ctx, REPO, replacement.humanId);
    expect(trail.supersessionChain?.supersedes).toBe(old.item.humanId);
  });

  it('splitItem creates PART_OF children; mergeItems marks the dropped item DUPLICATE and links SAME_AS', async () => {
    const parent = await client.createItem(ctx, { family: 'BUG-SPLIT', title: 'parent', body: 'b', repo: REPO });
    const children = await client.splitItem(ctx, REPO, parent.item.humanId, [
      { family: 'BUG-SPLIT', title: 'child a', body: 'b', repo: REPO },
      { family: 'BUG-SPLIT', title: 'child b', body: 'b', repo: REPO },
    ]);
    expect(children).toHaveLength(2);
    const parentAfter = await client.getItem(ctx, REPO, parent.item.humanId);
    expect(parentAfter?.status).toBe('OPEN'); // parent left open

    const keep = await client.createItem(ctx, { family: 'BUG-MERGE', title: 'keep', body: 'b', repo: REPO });
    const drop = await client.createItem(ctx, { family: 'BUG-MERGE', title: 'drop', body: 'b', repo: REPO });
    const merged = await client.mergeItems(ctx, REPO, keep.item.humanId, drop.item.humanId, 'exact duplicate');
    expect(merged.humanId).toBe(keep.item.humanId);
    const dropGone = await client.getItem(ctx, REPO, drop.item.humanId);
    expect(dropGone).toBeNull();
  });

  it('setPriority updates priority; attachToPlan and assignItem write real edges', async () => {
    const item = await client.createItem(ctx, { family: 'BUG-META', title: 't', body: 'b', repo: REPO });
    const prioritized = await client.setPriority(ctx, REPO, item.item.humanId, 'CRITICAL');
    expect(prioritized.priority).toBe('CRITICAL');

    await client.attachToPlan(ctx, REPO, item.item.humanId, 'my-plan');
    const withPlan = await client.getItem(ctx, REPO, item.item.humanId);
    expect(withPlan?.plan).toBe('my-plan');

    const assigned = await client.assignItem(ctx, REPO, item.item.humanId, 'implementer:x', 'planner:y');
    expect(assigned.assignee).toBe('implementer:x');
  });

  it('linkRelated writes a RELATES_TO edge visible via dependencyGraph', async () => {
    const a = await client.createItem(ctx, { family: 'BUG-REL', title: 'a', body: 'b', repo: REPO });
    const b = await client.createItem(ctx, { family: 'BUG-REL', title: 'b', body: 'b', repo: REPO });
    await client.linkRelated(ctx, REPO, a.item.humanId, b.item.humanId);
    const graph = await client.dependencyGraph(ctx, { repo: REPO });
    expect(graph.edges).toContainEqual({ from: a.item.humanId, to: b.item.humanId, rel: 'RELATES_TO' });
  });
});

describe('query / report', () => {
  it('stats / spotlight report real counts', async () => {
    await client.createItem(ctx, { family: 'BUG-STATS', title: 'memory leak in the render loop', body: 'grows unbounded over time', repo: REPO, priority: 'CRITICAL' });
    await client.createItem(ctx, { family: 'BUG-STATS', title: 'typo in the changelog footer', body: 'cosmetic only', repo: REPO, priority: 'LOW' });
    const s = await client.stats(ctx, { repo: REPO });
    expect(s.byFamily['BUG-STATS']).toBe(2);
    expect(s.open).toBeGreaterThanOrEqual(2);

    const spot = await client.spotlight(ctx, { repo: REPO }, 5);
    expect(spot[0]?.priority).toBe('CRITICAL');
  });

  it('staleClaims surfaces claims older than maxAgeMin', async () => {
    const item = await client.createItem(ctx, { family: 'BUG-STALE', title: 't', body: 'b', repo: REPO });
    await client.claimItem(ctx, REPO, item.item.humanId, 'agent:a');
    const notStale = await client.staleClaims(ctx, 30, { repo: REPO });
    expect(notStale.map((i) => i.humanId)).not.toContain(item.item.humanId);
    const alwaysStale = await client.staleClaims(ctx, 0, { repo: REPO });
    expect(alwaysStale.map((i) => i.humanId)).toContain(item.item.humanId);
  });

  it('exportJson round-trips the same shape as listItems', async () => {
    await client.createItem(ctx, { family: 'BUG-EXPORT', title: 't', body: 'b', repo: REPO });
    const exported = await client.exportJson(ctx, { repo: REPO, family: 'BUG-EXPORT' });
    expect(exported).toHaveLength(1);
  });

  it('migrationStatus reports the live config value, not a hardcoded default (MIGRATION.md §4.4)', async () => {
    const notStarted = await client.migrationStatus(ctx);
    expect(notStarted.phase).toBe('not-started');
    expect(notStarted.toolIsAuthoritative).toBe(false);
    expect(notStarted.description).toContain('not-started');

    const prev = process.env['ADHD_BACKLOG_MIGRATION_PHASE'];
    try {
      process.env['ADHD_BACKLOG_MIGRATION_PHASE'] = 'phase-3';
      const phase3Ctx: BacklogCtx = { store: tmp.store, env: buildBacklogEnv({ scope: 'project', adhdRoot: tmp.dir }) };
      const authoritative = await client.migrationStatus(phase3Ctx);
      expect(authoritative.phase).toBe('phase-3');
      expect(authoritative.toolIsAuthoritative).toBe(true);
    } finally {
      if (prev === undefined) delete process.env['ADHD_BACKLOG_MIGRATION_PHASE'];
      else process.env['ADHD_BACKLOG_MIGRATION_PHASE'] = prev;
    }
  });
});

describe('introspection', () => {
  // Reads the REAL `package.json` at test time (never a hardcoded literal),
  // so this test can never silently drift from the real package.json the way
  // a copy-pasted version string would.
  const PKG_JSON_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  const REAL_PKG = JSON.parse(readFileSync(PKG_JSON_PATH, 'utf8')) as { name: string; version: string };

  it('version() reports the REAL, currently-checked-out package.json name/version — vitest/src layout (client.ts run in place, never built)', async () => {
    const info = await client.version(ctx);
    expect(info).toEqual({ name: REAL_PKG.name, version: REAL_PKG.version });
  });
});
