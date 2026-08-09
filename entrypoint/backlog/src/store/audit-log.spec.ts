/**
 * audit-log.spec.ts — DEBT-BACKLOG-AUDIT-TRAIL-PARTIAL-001: proves
 * `auditTrail` can now reconstruct a full transition/claim history, not
 * just the LATEST status/claimant — the exact gap the item's own text
 * described ("history of every past status/claim change... was never
 * persisted").
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { createItemNode } from './crud.js';
import { transitionStatusNode } from './lifecycle.js';
import { claimItemNode, releaseClaimNode, renewClaimNode } from './claim.js';
import { auditTrail } from './query.js';

const REPO = 'PseudoSky/audit-log-test';

describe('audit-log — real, persisted transition/claim history (DEBT-BACKLOG-AUDIT-TRAIL-PARTIAL-001)', () => {
  let tmp: TmpStore;

  beforeEach(() => {
    tmp = openTmpStore('audit-log');
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it('multiple transitions are ALL individually recoverable, not just the current status', () => {
    const created = createItemNode(tmp.store, { family: 'BUG-AUDIT', title: 't', body: 'b', repo: REPO });
    const humanId = created.item.humanId;

    transitionStatusNode(tmp.store, REPO, humanId, 'IN_PROGRESS', { by: 'agent:a' });
    transitionStatusNode(tmp.store, REPO, humanId, 'BLOCKED', { by: 'agent:a' });
    transitionStatusNode(tmp.store, REPO, humanId, 'IN_PROGRESS', { by: 'agent:b' });
    transitionStatusNode(tmp.store, REPO, humanId, 'FIXED', {
      by: 'agent:b',
      citations: [{ file: 'src/x.ts', lines: '1-2' }],
    });

    const trail = auditTrail(tmp.store, REPO, humanId);
    const transitions = trail.history.filter((h) => h.kind === 'transition');
    // Before this fix, NONE of the intermediate transitions (OPEN->IN_PROGRESS,
    // IN_PROGRESS->BLOCKED, BLOCKED->IN_PROGRESS) would be recoverable at
    // all — only the current FIXED status persisted in `meta.status`.
    expect(transitions).toHaveLength(4);
    expect(transitions.map((t) => t.detail['to'])).toEqual(['IN_PROGRESS', 'BLOCKED', 'IN_PROGRESS', 'FIXED']);
    expect(transitions.map((t) => t.detail['from'])).toEqual(['OPEN', 'IN_PROGRESS', 'BLOCKED', 'IN_PROGRESS']);
    expect(transitions[3]?.detail['by']).toBe('agent:b');
  });

  it('a REJECTED transition (missing required citation) logs NOTHING — never a fake event for a change that never happened', () => {
    const created = createItemNode(tmp.store, { family: 'BUG-AUDIT-REJECT', title: 't', body: 'b', repo: REPO });
    expect(() => transitionStatusNode(tmp.store, REPO, created.item.humanId, 'FIXED', { by: 'agent:a' })).toThrow();

    const trail = auditTrail(tmp.store, REPO, created.item.humanId);
    expect(trail.history.filter((h) => h.kind === 'transition')).toHaveLength(0);
  });

  it('claim/renew/release are all recoverable; a REFUSED claim (held) and a no-op release log nothing', () => {
    const created = createItemNode(tmp.store, { family: 'BUG-AUDIT-CLAIM', title: 't', body: 'b', repo: REPO });
    const humanId = created.item.humanId;

    // no-op release on a never-claimed item — must log nothing.
    releaseClaimNode(tmp.store, created.item.nodeId, 'agent:a');

    const claimed = claimItemNode(tmp.store, created.item.nodeId, 'agent:a');
    expect(claimed.status).toBe('claimed');

    // Contended claim from a different claimant, within the stale window — refused, logs nothing.
    const held = claimItemNode(tmp.store, created.item.nodeId, 'agent:b');
    expect(held.status).toBe('held');

    renewClaimNode(tmp.store, created.item.nodeId, 'agent:a');
    releaseClaimNode(tmp.store, created.item.nodeId, 'agent:a');

    const trail = auditTrail(tmp.store, REPO, humanId);
    const claims = trail.history.filter((h) => h.kind === 'claim');
    expect(claims.map((c) => c.detail['status'])).toEqual(['claimed', 'renewed', 'released']);
    expect(claims.every((c) => c.detail['by'] === 'agent:a')).toBe(true);
  });

  it('transition and claim events are chronologically interleaved with notes/citations in one merged history', () => {
    const created = createItemNode(tmp.store, { family: 'BUG-AUDIT-MERGE', title: 't', body: 'b', repo: REPO });
    const humanId = created.item.humanId;

    claimItemNode(tmp.store, created.item.nodeId, 'agent:a');
    transitionStatusNode(tmp.store, REPO, humanId, 'IN_PROGRESS', { by: 'agent:a', note: 'starting work' });
    releaseClaimNode(tmp.store, created.item.nodeId, 'agent:a');

    const trail = auditTrail(tmp.store, REPO, humanId);
    const kinds = trail.history.map((h) => h.kind);
    // created + 2 claim events (claimed, released) + 1 transition + 1 note
    // (from the transition's own opts.note) — 5 entries total, every kind
    // represented (the note's `at` is stamped INSIDE the same transaction as
    // the transition, so its exact position relative to the transition
    // event is a real, non-brittle timing detail — not asserted here; only
    // that every kind is present and the WHOLE sequence is chronological).
    expect(kinds.filter((k) => k === 'claim')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'transition')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'note')).toHaveLength(1);
    expect(kinds[0]).toBe('created');
    // Every entry is chronologically non-decreasing.
    const timestamps = trail.history.map((h) => h.at);
    expect(timestamps).toEqual([...timestamps].sort());
  });
});
