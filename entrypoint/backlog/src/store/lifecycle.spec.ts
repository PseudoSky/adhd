/**
 * lifecycle.spec.ts — SPEC.md §7 DoD clause 6: the status-vocabulary teeth
 * gate. `transitionStatus(..., 'FIXED', { by, note })` with NO citations must
 * reject; `transitionStatus(..., 'WONTFIX', { by })` with no reason must
 * reject.
 *
 * NEGATIVE CONTROL (performed manually during implementation, per SPEC.md §7
 * clause 6 — not part of the automated suite, since permanently disabling
 * our own citation gate would be nonsensical to ship): commenting out the
 * `requiresCitation(status) && citations.length === 0` throw in
 * `transitionStatusNode` and re-running this test turns it red (the
 * transition silently succeeds with zero citations) — confirming the
 * assertion has teeth. Restored immediately after confirming red.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { createItemNode } from './crud.js';
import { addCitationNode, transitionStatusNode } from './lifecycle.js';
import { CitationRequiredError, ReasonRequiredError } from '../model.js';

const REPO = 'PseudoSky/lifecycle-test';

describe('transitionStatusNode — status-vocabulary teeth gate', () => {
  let tmp: TmpStore;

  beforeEach(() => {
    tmp = openTmpStore('lifecycle-spec');
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it('rejects a transition into FIXED with zero citations', () => {
    const created = createItemNode(tmp.store, { family: 'BUG-GATE', title: 't', body: 'b', repo: REPO });
    expect(() => transitionStatusNode(tmp.store, REPO, created.item.humanId, 'FIXED', { by: 'implementer:x', note: 'done' })).toThrow(
      CitationRequiredError
    );
    // The item must remain unchanged — a rejected transition is not a partial write.
    const stillOpen = tmp.store.graph.getNode(created.item.nodeId);
    expect((stillOpen?.metadata as { status?: string } | undefined)?.status).toBe('OPEN');
  });

  it('rejects a transition into MITIGATED with zero citations', () => {
    const created = createItemNode(tmp.store, { family: 'BUG-GATE', title: 't', body: 'b', repo: REPO });
    expect(() => transitionStatusNode(tmp.store, REPO, created.item.humanId, 'MITIGATED', { by: 'implementer:x' })).toThrow(
      CitationRequiredError
    );
  });

  it('rejects a transition into WONTFIX with no reason', () => {
    const created = createItemNode(tmp.store, { family: 'BUG-GATE', title: 't', body: 'b', repo: REPO });
    expect(() => transitionStatusNode(tmp.store, REPO, created.item.humanId, 'WONTFIX', { by: 'implementer:x' })).toThrow(ReasonRequiredError);
  });

  it('accepts a transition into FIXED WITH a citation, and clears any prior claim', () => {
    const created = createItemNode(tmp.store, { family: 'BUG-GATE', title: 't', body: 'b', repo: REPO });
    const result = transitionStatusNode(tmp.store, REPO, created.item.humanId, 'FIXED', {
      by: 'implementer:x',
      citations: [{ file: 'src/x.ts', lines: '1-2', context: 'test' }],
    });
    expect(result.status).toBe('FIXED');
    expect(result.citations).toHaveLength(1);
  });

  it('a citation already attached via addCitation satisfies the gate without an inline one', () => {
    const created = createItemNode(tmp.store, { family: 'BUG-GATE', title: 't', body: 'b', repo: REPO });
    addCitationNode(tmp.store, REPO, created.item.humanId, { file: 'src/x.ts' });
    // No `citations` passed inline this time — the gate must see the one already attached.
    const result = transitionStatusNode(tmp.store, REPO, created.item.humanId, 'FIXED', { by: 'implementer:x' });
    expect(result.status).toBe('FIXED');
    expect(result.citations).toHaveLength(1);
  });

  it('a non-terminal transition (e.g. BLOCKED) never requires evidence', () => {
    const created = createItemNode(tmp.store, { family: 'BUG-GATE', title: 't', body: 'b', repo: REPO });
    const result = transitionStatusNode(tmp.store, REPO, created.item.humanId, 'BLOCKED', { by: 'x' });
    expect(result.status).toBe('BLOCKED');
  });
});
