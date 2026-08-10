/**
 * required-field-validation.spec.ts — completeness audit of business-rule
 * validation on top of correctly-extracted schemas (BUG-APIGEN-CORE-CLIENT-001
 * fixed TS-required-vs-optional reaching the JSON Schema `required` array;
 * this file proves the SEPARATE, complementary layer: fields TypeScript's
 * type system cannot express as "required" on its own — non-empty strings,
 * and a conditional min-1-citation rule — are still enforced by hand-written
 * store-level checks, with teeth.
 *
 * Covers:
 *  - `CreateItemInput.title`/`body`/`repo` non-empty (mirrors the existing
 *    `family` guard, BUG-BACKLOG-HUMANID-COLLISION-001).
 *  - `Citation.file` non-empty on every write path that accepts a
 *    caller-supplied citation (inline `transitionStatus` and standalone
 *    `addCitation`).
 *  - The terminal-status citations gate correctly treats an explicit empty
 *    array (`citations: []`) the same as "no citations", never as "satisfied
 *    because the property is present".
 *  - `TransitionOpts.reason` (terminal-dismissed) rejects a whitespace-only
 *    string, not just `undefined`/`""`.
 *  - `softDeleteItem`/`supersedeItem`/`mergeItems`'s plain `reason: string`
 *    parameter rejects empty/whitespace-only values the same way.
 *
 * NEGATIVE CONTROL for the citations-array-length assertion (performed
 * manually, per this repo's "assertions must have teeth" verification
 * standard — CLAUDE.md §7): temporarily changing line 65 of lifecycle.ts's
 * `transitionStatusNode` from `citations.length === 0` to
 * `citations === undefined` (i.e. reintroducing the "presence, not length"
 * bug this suite is designed to catch) turns
 * "rejects an explicit empty citations array on a terminal-done transition"
 * red (the transition silently succeeds with an empty array). Restored
 * immediately after confirming red.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTmpStore, type TmpStore } from '../test/helpers/tmp-store.js';
import { createItemNode, softDeleteItemNode } from './crud.js';
import { addCitationNode, transitionStatusNode } from './lifecycle.js';
import { mergeItemsNode, supersedeItemNode } from './structure.js';
import { InvalidArgumentError, CitationRequiredError, ReasonRequiredError } from '../model.js';

const REPO = 'PseudoSky/required-field-validation-test';

describe('CreateItemInput.title/body/repo — non-empty guard (mirrors the existing family guard)', () => {
  let tmp: TmpStore;

  beforeEach(async () => {
    tmp = await openTmpStore('required-field-validation-spec-create');
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it('rejects an empty-string title', async () => {
    await expect(createItemNode(tmp.store, { family: 'BUG-RFV', title: '', body: 'b', repo: REPO })).rejects.toThrow(InvalidArgumentError);
  });

  it('rejects a whitespace-only title', async () => {
    await expect(createItemNode(tmp.store, { family: 'BUG-RFV', title: '   ', body: 'b', repo: REPO })).rejects.toThrow(InvalidArgumentError);
  });

  it('rejects an empty-string body', async () => {
    await expect(createItemNode(tmp.store, { family: 'BUG-RFV', title: 't', body: '', repo: REPO })).rejects.toThrow(InvalidArgumentError);
  });

  it('rejects a whitespace-only body', async () => {
    await expect(createItemNode(tmp.store, { family: 'BUG-RFV', title: 't', body: '  \n  ', repo: REPO })).rejects.toThrow(InvalidArgumentError);
  });

  it('rejects an empty-string repo', async () => {
    await expect(createItemNode(tmp.store, { family: 'BUG-RFV', title: 't', body: 'b', repo: '' })).rejects.toThrow(InvalidArgumentError);
  });

  it('rejects a whitespace-only repo', async () => {
    await expect(createItemNode(tmp.store, { family: 'BUG-RFV', title: 't', body: 'b', repo: '   ' })).rejects.toThrow(InvalidArgumentError);
  });

  it('a normal, valid title/body/repo still creates successfully — unaffected by the guard', async () => {
    const result = await createItemNode(tmp.store, { family: 'BUG-RFV', title: 'A real title', body: 'A real body', repo: REPO });
    expect(result.created).toBe(true);
    expect(result.item.title).toBe('A real title');
    expect(result.item.body).toBe('A real body');
    expect(result.item.repo).toBe(REPO);
  });
});

describe('Citation.file — non-empty guard on every citation write path', () => {
  let tmp: TmpStore;

  beforeEach(async () => {
    tmp = await openTmpStore('required-field-validation-spec-citation');
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it('addCitation rejects a citation with an empty-string file', async () => {
    const created = await createItemNode(tmp.store, { family: 'BUG-RFV', title: 't', body: 'b', repo: REPO });
    await expect(addCitationNode(tmp.store, REPO, created.item.humanId, { file: '' })).rejects.toThrow(InvalidArgumentError);
  });

  it('addCitation rejects a citation with a whitespace-only file', async () => {
    const created = await createItemNode(tmp.store, { family: 'BUG-RFV', title: 't', body: 'b', repo: REPO });
    await expect(addCitationNode(tmp.store, REPO, created.item.humanId, { file: '   ' })).rejects.toThrow(InvalidArgumentError);
  });

  it('addCitation with an empty file never persists a partial write', async () => {
    const created = await createItemNode(tmp.store, { family: 'BUG-RFV', title: 't', body: 'b', repo: REPO });
    await expect(addCitationNode(tmp.store, REPO, created.item.humanId, { file: '' })).rejects.toThrow();
    const node = await tmp.store.graph.getNode(created.item.nodeId);
    expect((node?.metadata as { citations?: unknown[] } | undefined)?.citations).toHaveLength(0);
  });

  it('transitionStatus rejects an inline terminal-status citation with an empty file', async () => {
    const created = await createItemNode(tmp.store, { family: 'BUG-RFV', title: 't', body: 'b', repo: REPO });
    await expect(transitionStatusNode(tmp.store, REPO, created.item.humanId, 'FIXED', {
        by: 'implementer:x',
        citations: [{ file: '' }],
      })).rejects.toThrow(InvalidArgumentError);
    // Rejected inline citation must not partially write the status either.
    const node = await tmp.store.graph.getNode(created.item.nodeId);
    expect((node?.metadata as { status?: string } | undefined)?.status).toBe('OPEN');
  });

  it('a well-formed citation (non-empty file) is accepted, as before', async () => {
    const created = await createItemNode(tmp.store, { family: 'BUG-RFV', title: 't', body: 'b', repo: REPO });
    const updated = await addCitationNode(tmp.store, REPO, created.item.humanId, { file: 'src/x.ts', lines: '1-2' });
    expect(updated.citations).toHaveLength(1);
    expect(updated.citations[0]?.file).toBe('src/x.ts');
  });
});

describe('terminal-status citations gate — an explicit empty array is NOT satisfied', () => {
  let tmp: TmpStore;

  beforeEach(async () => {
    tmp = await openTmpStore('required-field-validation-spec-empty-citations');
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it('rejects a transition into FIXED with an explicit empty citations array (not just an absent one)', async () => {
    const created = await createItemNode(tmp.store, { family: 'BUG-RFV', title: 't', body: 'b', repo: REPO });
    await expect(transitionStatusNode(tmp.store, REPO, created.item.humanId, 'FIXED', { by: 'implementer:x', citations: [] })).rejects.toThrow(CitationRequiredError);
  });

  it('rejects a transition into MITIGATED with an explicit empty citations array', async () => {
    const created = await createItemNode(tmp.store, { family: 'BUG-RFV', title: 't', body: 'b', repo: REPO });
    await expect(transitionStatusNode(tmp.store, REPO, created.item.humanId, 'MITIGATED', { by: 'implementer:x', citations: [] })).rejects.toThrow(CitationRequiredError);
  });
});

describe('TransitionOpts.reason (terminal-dismissed) — rejects whitespace-only, not just absent', () => {
  let tmp: TmpStore;

  beforeEach(async () => {
    tmp = await openTmpStore('required-field-validation-spec-reason');
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it('rejects a transition into WONTFIX with a whitespace-only reason', async () => {
    const created = await createItemNode(tmp.store, { family: 'BUG-RFV', title: 't', body: 'b', repo: REPO });
    await expect(transitionStatusNode(tmp.store, REPO, created.item.humanId, 'WONTFIX', { by: 'implementer:x', reason: '   ' })).rejects.toThrow(ReasonRequiredError);
  });

  it('a real, non-empty reason is accepted, as before', async () => {
    const created = await createItemNode(tmp.store, { family: 'BUG-RFV', title: 't', body: 'b', repo: REPO });
    const result = await transitionStatusNode(tmp.store, REPO, created.item.humanId, 'WONTFIX', {
      by: 'implementer:x',
      reason: 'no longer relevant',
    });
    expect(result.status).toBe('WONTFIX');
  });
});

describe('softDeleteItem/supersedeItem/mergeItems — reason non-empty guard', () => {
  let tmp: TmpStore;

  beforeEach(async () => {
    tmp = await openTmpStore('required-field-validation-spec-plain-reason');
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it('softDeleteItem rejects an empty-string reason', async () => {
    const created = await createItemNode(tmp.store, { family: 'BUG-RFV', title: 't', body: 'b', repo: REPO });
    await expect(softDeleteItemNode(tmp.store, REPO, created.item.humanId, '')).rejects.toThrow(InvalidArgumentError);
  });

  it('softDeleteItem rejects a whitespace-only reason', async () => {
    const created = await createItemNode(tmp.store, { family: 'BUG-RFV', title: 't', body: 'b', repo: REPO });
    await expect(softDeleteItemNode(tmp.store, REPO, created.item.humanId, '   ')).rejects.toThrow(InvalidArgumentError);
  });

  it('softDeleteItem accepts a real reason, as before', async () => {
    const created = await createItemNode(tmp.store, { family: 'BUG-RFV', title: 't', body: 'b', repo: REPO });
    await expect(softDeleteItemNode(tmp.store, REPO, created.item.humanId, 'no longer relevant')).resolves.not.toThrow();
  });

  it('supersedeItem rejects an empty-string reason', async () => {
    const created = await createItemNode(tmp.store, { family: 'BUG-RFV', title: 'old', body: 'b', repo: REPO });
    await expect(supersedeItemNode(tmp.store, REPO, created.item.humanId, { family: 'BUG-RFV', title: 'new', body: 'b2', repo: REPO }, '')).rejects.toThrow(InvalidArgumentError);
  });

  it('supersedeItem rejects a whitespace-only reason', async () => {
    const created = await createItemNode(tmp.store, { family: 'BUG-RFV', title: 'old', body: 'b', repo: REPO });
    await expect(supersedeItemNode(tmp.store, REPO, created.item.humanId, { family: 'BUG-RFV', title: 'new', body: 'b2', repo: REPO }, '  ')).rejects.toThrow(InvalidArgumentError);
  });

  it('supersedeItem accepts a real reason, as before', async () => {
    const created = await createItemNode(tmp.store, { family: 'BUG-RFV', title: 'old', body: 'b', repo: REPO });
    const replacement = await supersedeItemNode(
      tmp.store,
      REPO,
      created.item.humanId,
      { family: 'BUG-RFV', title: 'new', body: 'b2', repo: REPO },
      'replaced by a better fix'
    );
    expect(replacement.title).toBe('new');
  });

  it('mergeItems rejects an empty-string reason', async () => {
    const keep = await createItemNode(tmp.store, { family: 'BUG-RFV', title: 'keep', body: 'b', repo: REPO });
    const drop = await createItemNode(tmp.store, { family: 'BUG-RFV', title: 'drop', body: 'b', repo: REPO });
    await expect(mergeItemsNode(tmp.store, REPO, keep.item.humanId, drop.item.humanId, '')).rejects.toThrow(InvalidArgumentError);
  });

  it('mergeItems rejects a whitespace-only reason', async () => {
    const keep = await createItemNode(tmp.store, { family: 'BUG-RFV', title: 'keep', body: 'b', repo: REPO });
    const drop = await createItemNode(tmp.store, { family: 'BUG-RFV', title: 'drop', body: 'b', repo: REPO });
    await expect(mergeItemsNode(tmp.store, REPO, keep.item.humanId, drop.item.humanId, '   ')).rejects.toThrow(InvalidArgumentError);
  });

  it('mergeItems accepts a real reason, as before', async () => {
    const keep = await createItemNode(tmp.store, { family: 'BUG-RFV', title: 'keep', body: 'b', repo: REPO });
    const drop = await createItemNode(tmp.store, { family: 'BUG-RFV', title: 'drop', body: 'b', repo: REPO });
    const merged = await mergeItemsNode(tmp.store, REPO, keep.item.humanId, drop.item.humanId, 'exact duplicate');
    expect(merged.humanId).toBe(keep.item.humanId);
  });
});
