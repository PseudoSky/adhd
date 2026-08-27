/**
 * model.v2.spec.ts — teeth for the INTERFACE v2 type surface (`model.ts`).
 *
 * A type change alone is untestable, so every v2 contract that MUST hold is
 * backed by a runtime guard in `model.ts` and driven here. The test names cite
 * the spec clause (`docs/spec/backlog/INTERFACE_v2.md`) and the bug id each
 * guard defends against, because that is what a future reader needs in order to
 * know whether deleting an assertion is safe (it is not).
 *
 * Compile-time contracts that have no runtime form (assignability, key
 * exhaustiveness) are asserted with `satisfies` / conditional-type aliases at
 * the bottom of the file — `tsc` over `tsconfig.spec.json` is their runner.
 */
import { describe, expect, it } from 'vitest';
import {
  AmbiguousHumanIdError,
  assertAttribution,
  assertKnownFields,
  assertKnownFilterKeys,
  assertKnownPatchKeys,
  assertNoSilentlyDiscardedPatchKeys,
  assertOpenScopedStats,
  assertQueryLimit,
  BACKLOG_ADMIN_ACTIONS,
  BACKLOG_ERROR_CODES,
  BACKLOG_EXIT_CODE,
  BACKLOG_FILTER_KEYS,
  BACKLOG_GROUP_BY_AXES,
  BACKLOG_SORTS,
  BACKLOG_V2_TOOLS,
  BACKLOG_VIEWS,
  BacklogItemNotFoundError,
  BacklogValidationError,
  canonicalIdentityKey,
  CitationRequiredError,
  ClaimHeldError,
  DEFAULT_CARD_FIELDS,
  errorEnvelope,
  exitCodeForEnvelope,
  InvalidArgumentError,
  isBacklogErrorCode,
  isBacklogStatus,
  isBacklogView,
  isOutcomeError,
  isOutcomeOk,
  MAX_QUERY_LIMIT,
  normalizeGroupBy,
  normalizeRepoKey,
  okEnvelope,
  RagNotConfiguredError,
  resolveRepositoryNode,
  resolveStatusSelector,
  StoreBusyError,
  toOutcomeError,
  UnsupportedOperationError,
  UPDATE_PATCH_KEYS,
} from './model.js';
import type {
  CreateItemInput,
  IBacklogCard,
  IBacklogCreateInput,
  IBacklogFilter,
  IBacklogRelateInput,
  IBacklogStats,
  IBacklogUpdateInput,
  ICreateItemInputV2,
  ILinkRelatedResult,
  IOutcomeEnvelope,
  IRepositoryNode,
  IUpdatePatch,
  Priority,
} from './model.js';

// ---------------------------------------------------------------------------
// §7.1 / §7.2 / AC-6 — the outcome envelope.
// ---------------------------------------------------------------------------

describe('IOutcomeEnvelope (INTERFACE_v2 §7.1, AC-6)', () => {
  it('AC-6: item_not_found and internal are DISTINCT members of the closed union', () => {
    expect(BACKLOG_ERROR_CODES).toContain('item_not_found');
    expect(BACKLOG_ERROR_CODES).toContain('internal');
    // The collision AC-6 forbids is two names for one code, so the codes must
    // differ even though §7.2 maps BOTH to exit 1.
    expect('item_not_found').not.toBe('internal');
    expect(BACKLOG_EXIT_CODE.item_not_found).toBe(1);
    expect(BACKLOG_EXIT_CODE.internal).toBe(1);
  });

  it('carries every code the brief requires as a closed union', () => {
    for (const required of ['item_not_found', 'invalid_argument', 'not_found', 'internal', 'conflict', 'precondition_failed'] as const) {
      expect(isBacklogErrorCode(required)).toBe(true);
    }
    expect(isBacklogErrorCode('made_up_code')).toBe(false);
    expect(isBacklogErrorCode(undefined)).toBe(false);
    // Closed means closed: no duplicates, and every member has an exit code.
    expect(new Set(BACKLOG_ERROR_CODES).size).toBe(BACKLOG_ERROR_CODES.length);
    for (const code of BACKLOG_ERROR_CODES) expect(typeof BACKLOG_EXIT_CODE[code]).toBe('number');
  });

  it('§7.2: the four exit codes AC-6 drives are pinned (0/1/2/4)', () => {
    expect(exitCodeForEnvelope(okEnvelope({ humanId: 'BUG-001' }))).toBe(0);
    expect(exitCodeForEnvelope(errorEnvelope('item_not_found', 'x'))).toBe(1);
    expect(exitCodeForEnvelope(errorEnvelope('invalid_argument', 'x'))).toBe(2);
    expect(exitCodeForEnvelope(errorEnvelope('not_found', 'x'))).toBe(4);
    // AC-6: an EMPTY LIST is a success, not a not-found. Exit 0.
    expect(exitCodeForEnvelope(okEnvelope([] as IBacklogCard[]))).toBe(0);
  });

  it('isOutcomeOk / isOutcomeError narrow the two arms', () => {
    const good: IOutcomeEnvelope<number> = okEnvelope(7);
    const bad: IOutcomeEnvelope<number> = errorEnvelope('internal', 'boom');
    expect(isOutcomeOk(good)).toBe(true);
    expect(isOutcomeError(good)).toBe(false);
    expect(isOutcomeOk(bad)).toBe(false);
    expect(isOutcomeError(bad)).toBe(true);
    if (isOutcomeOk(good)) expect(good.data).toBe(7);
    if (isOutcomeError(bad)) expect(bad.error.code).toBe('internal');
  });

  it('isOutcomeError refuses a malformed half-envelope rather than calling it an error', () => {
    // A host branching on `!ok` would treat this as a usable error and read
    // `error.code` off undefined; the structural check is what stops that.
    const malformed = { ok: false, error: { code: 'nope', message: 'x' } } as unknown as IOutcomeEnvelope<number>;
    expect(isOutcomeError(malformed)).toBe(false);
    expect(isOutcomeOk(malformed)).toBe(false);
  });

  it('§7.1: store_busy is stamped retryable so an agent backs off instead of hot-looping', () => {
    const env = errorEnvelope('store_busy', 'locked');
    expect(env.error.details?.retryable).toBe(true);
    expect(errorEnvelope('internal', 'boom').error.details?.retryable).toBeUndefined();
  });

  it('okEnvelope only attaches warnings/meta when there are some (AC-24 / AC-25)', () => {
    expect(okEnvelope(1)).toEqual({ ok: true, data: 1 });
    const withMeta = okEnvelope([1, 2], { warnings: ['ambiguous repo'], meta: { total: 40, returned: 2, limit: 2 } });
    expect(withMeta.warnings).toEqual(['ambiguous repo']);
    expect(withMeta.meta).toEqual({ total: 40, returned: 2, limit: 2 });
  });
});

describe('toOutcomeError (INTERFACE_v2 §7.1, AC-6)', () => {
  it('maps a single-item miss to item_not_found — never to the internal catch-all', () => {
    const mapped = toOutcomeError(new BacklogItemNotFoundError('adhd', 'BUG-404', ['PseudoSky/adhd']));
    expect(mapped.code).toBe('item_not_found');
    expect(mapped.details?.foundInRepos).toEqual(['PseudoSky/adhd']);
    expect(BACKLOG_EXIT_CODE[mapped.code]).toBe(1);
  });

  it('maps an unrecognised throw to internal — a DIFFERENT code from item_not_found (AC-6)', () => {
    const mapped = toOutcomeError(new Error('kaboom'));
    expect(mapped.code).toBe('internal');
    expect(mapped.code).not.toBe(toOutcomeError(new BacklogItemNotFoundError('adhd', 'BUG-404')).code);
  });

  it('maps every v1 domain error onto a code, not onto internal', () => {
    expect(toOutcomeError(new AmbiguousHumanIdError('adhd', 'BUG-1', [1, 2])).code).toBe('ambiguous');
    expect(toOutcomeError(new CitationRequiredError('RESOLVED')).code).toBe('precondition_failed');
    expect(toOutcomeError(new ClaimHeldError('agent-a', '2026-08-21T00:00:00.000Z')).code).toBe('conflict');
    expect(toOutcomeError(new InvalidArgumentError('family', 'missing')).code).toBe('invalid_argument');
    expect(toOutcomeError(new BacklogValidationError('bad key', ['reppo'])).code).toBe('validation');
    expect(toOutcomeError(new UnsupportedOperationError('patch.repo', 'needs EPIC-A')).code).toBe('unsupported');
    expect(toOutcomeError(new RagNotConfiguredError('view:similar')).code).toBe('rag_not_configured');
  });

  it('classifies raw driver contention as retryable store_busy instead of burying it in internal', () => {
    const fromClass = toOutcomeError(new StoreBusyError('busy', 250));
    expect(fromClass.code).toBe('store_busy');
    expect(fromClass.details).toMatchObject({ retryable: true, retryAfterMs: 250 });
    const fromDriver = toOutcomeError(new Error('SQLITE_BUSY: database is locked'));
    expect(fromDriver.code).toBe('store_busy');
    expect(fromDriver.details?.retryable).toBe(true);
  });

  it('carries InvalidArgumentError.internalRef into error.details.internalRef, kept OUT of the user-facing message', () => {
    const withRef = toOutcomeError(new InvalidArgumentError('repo', 'backlog_update: "repo" is required.', 'EPIC-A / INTERFACE_v2 §7.5'));
    expect(withRef.message).not.toMatch(/EPIC-A|INTERFACE_v2/);
    expect(withRef.details?.internalRef).toBe('EPIC-A / INTERFACE_v2 §7.5');
    expect(withRef.details?.argument).toBe('repo');

    // Absent when the caller never passed one — `internalRef` is never
    // fabricated for an ordinary invalid_argument.
    const withoutRef = toOutcomeError(new InvalidArgumentError('humanId', 'backlog_update: "humanId" is required.'));
    expect(withoutRef.details?.internalRef).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §2 / §2.1 — status selection and the filter schema.
// ---------------------------------------------------------------------------

describe('resolveStatusSelector (INTERFACE_v2 §2 "one closedness knob")', () => {
  it('distinguishes the closedness word "open" from the explicit status "OPEN"', () => {
    expect(resolveStatusSelector('open')).toEqual({ mode: 'closedness', closedness: 'open' });
    expect(resolveStatusSelector('OPEN')).toEqual({ mode: 'explicit', statuses: ['OPEN'] });
    // The two vocabularies are case-disjoint, which is what makes one field safe.
    expect(isBacklogStatus('open')).toBe(false);
    expect(isBacklogStatus('OPEN')).toBe(true);
  });

  it('defaults to open (§2) when the caller says nothing', () => {
    expect(resolveStatusSelector(undefined)).toEqual({ mode: 'closedness', closedness: 'open' });
  });

  it('accepts an explicit multi-status list — v1 could not express it', () => {
    expect(resolveStatusSelector(['IN_PROGRESS', 'BLOCKED'])).toEqual({ mode: 'explicit', statuses: ['IN_PROGRESS', 'BLOCKED'] });
    expect(resolveStatusSelector('all')).toEqual({ mode: 'closedness', closedness: 'all' });
  });

  it('rejects an empty list and unknown statuses instead of silently matching everything', () => {
    expect(() => resolveStatusSelector([])).toThrow(InvalidArgumentError);
    expect(() => resolveStatusSelector(['NOT_A_STATUS' as never])).toThrow(/unknown status/);
    expect(() => resolveStatusSelector('opne' as never)).toThrow(InvalidArgumentError);
  });
});

describe('IBacklogFilter schema (INTERFACE_v2 §2.1, §7.8, AC-23)', () => {
  it('carries every field the v2 brief requires', () => {
    for (const key of ['repo', 'kind', 'family', 'status', 'priority', 'plan', 'assignee', 'author', 'reporter', 'tags', 'dateRange', 'dupeHitsMin', 'files'] as const) {
      expect(BACKLOG_FILTER_KEYS).toContain(key);
    }
  });

  it('accepts a fully-populated v2 filter (every declared key is in the closed schema)', () => {
    const filter: Required<IBacklogFilter> = {
      repo: 'adhd',
      projectPath: 'entrypoint/backlog',
      status: 'open',
      kind: 'BUG',
      family: 'BUG-BACKLOG',
      priority: 'CRITICAL',
      plan: 'backlog-interface-v2-dispatch',
      assignee: 'nix',
      claimedBy: 'contract-owner:a1',
      tags: ['v2'],
      grep: 'stats',
      importedFrom: 'BACKLOG.md',
      rootLevel: true,
      excludeArchived: true,
      author: 'researcher',
      reporter: 'researcher',
      project: 'adhd',
      packagePath: 'entrypoint/backlog',
      dateRange: { created: { since: '2026-08-01' }, updated: { since: '2026-08-20', until: '2026-08-21' } },
      dupeHitsMin: 2,
      files: ['entrypoint/backlog/src/model.ts'],
      hasAcceptanceCriteria: true,
      missingAcceptanceCriteria: false,
      missingCitation: true,
      semantic: 'stats over-count',
      anchor: 'BUG-023',
      humanId: 'BUG-023',
    };
    expect(() => assertKnownFilterKeys(filter as unknown as Record<string, unknown>)).not.toThrow();
    expect(Object.keys(filter).sort()).toEqual([...BACKLOG_FILTER_KEYS].sort());
  });

  it('AC-23: a top-level param nested inside --filter is a NAMED invalid_argument, never a silent no-op', () => {
    expect(() => assertKnownFilterKeys({ view: 'list' })).toThrow(InvalidArgumentError);
    expect(() => assertKnownFilterKeys({ view: 'list' })).toThrow(/"view".*top-level parameter/s);
    expect(() => assertKnownFilterKeys({ sort: 'relevance', repo: 'adhd' })).toThrow(/"sort"/);
  });

  it('§7.8: any other unknown key is a validation error naming it', () => {
    try {
      assertKnownFilterKeys({ reppo: 'adhd' });
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(BacklogValidationError);
      expect((err as BacklogValidationError).keys).toEqual(['reppo']);
      expect(toOutcomeError(err).code).toBe('validation');
      expect(BACKLOG_EXIT_CODE.validation).toBe(2);
    }
  });
});

// ---------------------------------------------------------------------------
// §2.2 / §2.3 / §2.4 — views, sorts, projection.
// ---------------------------------------------------------------------------

describe('views / sorts / projection (INTERFACE_v2 §2.2-§2.4)', () => {
  it('§2.2: the view union carries every view the brief names, and `order` replaced `topo`', () => {
    for (const view of ['list', 'grouped', 'graph', 'summary', 'order', 'stale', 'similar'] as const) {
      expect(BACKLOG_VIEWS).toContain(view);
    }
    expect(BACKLOG_VIEWS).not.toContain('topo' as never);
    // §2.2: spotlight collapses into list + default sort — no separate verb.
    expect(BACKLOG_VIEWS).not.toContain('spotlight' as never);
    expect(isBacklogView('order')).toBe(true);
    expect(isBacklogView('topo')).toBe(false);
  });

  it('§2.3 / FEAT-013: `demand` is a first-class sort', () => {
    expect(BACKLOG_SORTS).toContain('demand');
    expect(BACKLOG_SORTS).toContain('relevance');
  });

  it('AC-18: the default projection is the five-field terse card — no body, no vector', () => {
    expect([...DEFAULT_CARD_FIELDS]).toEqual(['humanId', 'kind', 'title', 'status', 'priority']);
    expect(DEFAULT_CARD_FIELDS).not.toContain('body');
    expect(DEFAULT_CARD_FIELDS).not.toContain('_vector');
  });

  it('AC-19: an unknown projection field is a validation error, never a silent omission', () => {
    expect(() => assertKnownFields(['humanId', 'title', 'body'])).not.toThrow();
    expect(() => assertKnownFields(['humanId', 'titel'])).toThrow(BacklogValidationError);
    expect(() => assertKnownFields(undefined)).not.toThrow();
  });

  it('BUG-BACKLOG-003: an over-MAX_LIMIT limit fails loudly instead of being silently capped', () => {
    expect(() => assertQueryLimit(undefined)).not.toThrow();
    expect(() => assertQueryLimit(MAX_QUERY_LIMIT)).not.toThrow();
    expect(() => assertQueryLimit(MAX_QUERY_LIMIT + 1)).toThrow(/will not silently cap/);
    expect(() => assertQueryLimit(0)).toThrow(BacklogValidationError);
    expect(() => assertQueryLimit(1.5)).toThrow(BacklogValidationError);
  });

  it('§2 groupBy: sugar and the two-axis form compile to one shape; a repeated axis is rejected', () => {
    expect(normalizeGroupBy('reporter')).toEqual({ primary: 'reporter' });
    expect(normalizeGroupBy({ primary: 'repo', secondary: 'author' })).toEqual({ primary: 'repo', secondary: 'author' });
    expect(normalizeGroupBy(undefined)).toBeUndefined();
    expect(() => normalizeGroupBy({ primary: 'repo', secondary: 'repo' })).toThrow(/repeats the primary axis/);
    expect(() => normalizeGroupBy('reporterr' as never)).toThrow(InvalidArgumentError);
    // FEAT-012's whole point: the dimensional axes are groupable.
    for (const axis of ['repo', 'author', 'reporter', 'project', 'packagePath', 'plan', 'assignee', 'file'] as const) {
      expect(BACKLOG_GROUP_BY_AXES).toContain(axis);
    }
  });
});

// ---------------------------------------------------------------------------
// BUG-023 — the stats scope guard. This is the file's sharpest tooth.
// ---------------------------------------------------------------------------

describe('IBacklogStats + assertOpenScopedStats (BUG-023, FEAT-010)', () => {
  /**
   * The live corpus shape that produced BUG-023: 33 CRITICAL items exist, 16
   * of them are open. v1 `computeStats` (store/query.ts:187-200) computes
   * `open`/`closed` correctly and then counts `byPriority` over ALL items
   * (line 198), so the field every triage query sorts by reported 33.
   */
  const OPEN = 16;
  const CLOSED = 17;
  const zeroPriorities = (): Record<Priority, number> => ({ CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 });

  function statsFixture(byPriority: Record<Priority, number>): IBacklogStats {
    return {
      total: OPEN + CLOSED,
      open: OPEN,
      closed: CLOSED,
      byStatus: { OPEN, RESOLVED: CLOSED },
      byPriority,
      byPriorityAllStatuses: { ...zeroPriorities(), CRITICAL: OPEN + CLOSED },
      byKind: { BUG: OPEN },
      byKindAllStatuses: { BUG: OPEN + CLOSED },
      byFamily: { 'BUG-BACKLOG': OPEN },
      byFamilyAllStatuses: { 'BUG-BACKLOG': OPEN + CLOSED },
      byRepo: { adhd: OPEN },
      byRepoAllStatuses: { adhd: OPEN + CLOSED },
      coverage: { itemsWithHistory: 12, itemsTotal: OPEN + CLOSED, auditWindowStart: '2026-07-01T00:00:00.000Z' },
    };
  }

  it('accepts correctly-scoped stats: byPriority counts ONLY the open set', () => {
    const fixed = statsFixture({ ...zeroPriorities(), CRITICAL: OPEN });
    expect(() => assertOpenScopedStats(fixed)).not.toThrow();
    // The consumer-visible outcome: the number a triage caller reads is 16, not 33.
    expect(fixed.byPriority.CRITICAL).toBe(16);
    expect(fixed.byPriorityAllStatuses.CRITICAL).toBe(33);
  });

  it('BUG-023: rejects stats whose byPriority was computed over ALL items (CRITICAL=33 while 16 are open)', () => {
    const buggy = statsFixture({ ...zeroPriorities(), CRITICAL: OPEN + CLOSED });
    expect(() => assertOpenScopedStats(buggy)).toThrow(InvalidArgumentError);
    expect(() => assertOpenScopedStats(buggy)).toThrow(/stats\.byPriority: sums to 33 but only 16 items are open/);
    expect(() => assertOpenScopedStats(buggy)).toThrow(/BUG-023/);
  });

  it('BUG-023: catches the same mistake on every open-scoped map, not just byPriority', () => {
    const buggyKind = statsFixture({ ...zeroPriorities(), CRITICAL: OPEN });
    buggyKind.byKind = { BUG: OPEN + CLOSED };
    expect(() => assertOpenScopedStats(buggyKind)).toThrow(/stats\.byKind/);
  });

  it('rejects a per-key open count that exceeds its own all-status count', () => {
    const bad = statsFixture({ ...zeroPriorities(), CRITICAL: 5 });
    bad.byPriorityAllStatuses = { ...zeroPriorities(), CRITICAL: 3 };
    expect(() => assertOpenScopedStats(bad)).toThrow(/exceeds the all-status count/);
  });

  it('rejects an open+closed !== total corpus and impossible coverage', () => {
    const bad = statsFixture({ ...zeroPriorities(), CRITICAL: OPEN });
    bad.total = 99;
    expect(() => assertOpenScopedStats(bad)).toThrow(/!== total/);
    const badCoverage = statsFixture({ ...zeroPriorities(), CRITICAL: OPEN });
    badCoverage.coverage = { itemsWithHistory: 999, itemsTotal: OPEN + CLOSED };
    expect(() => assertOpenScopedStats(badCoverage)).toThrow(/itemsWithHistory/);
  });

  it('DEBT-BACKLOG-AUDIT-TRAIL-PARTIAL-001: coverage is REQUIRED, so partial history can never be silent', () => {
    const stats = statsFixture({ ...zeroPriorities(), CRITICAL: OPEN });
    expect(stats.coverage.itemsWithHistory).toBeLessThan(stats.coverage.itemsTotal);
    expect(stats.coverage).toHaveProperty('auditWindowStart');
  });
});

// ---------------------------------------------------------------------------
// BUG-BACKLOG-UPDATE-ITEM-SILENT-DISCARD-001 — the strict patch.
// ---------------------------------------------------------------------------

describe('IUpdatePatch (BUG-BACKLOG-UPDATE-ITEM-SILENT-DISCARD-001, INTERFACE_v2 §4)', () => {
  /** Exactly what `updateItemNode` (store/crud.ts:375-410) writes today. */
  const APPLIED_BY_V1_UPDATE_ITEM_NODE = ['title', 'body', 'projectPath', 'importedFrom', 'tags'];

  it('names every key that used to be silently discarded', () => {
    for (const key of ['priority', 'status', 'plan', 'assignee', 'kind', 'humanId'] as const) {
      expect(UPDATE_PATCH_KEYS).toContain(key);
      expect(APPLIED_BY_V1_UPDATE_ITEM_NODE).not.toContain(key); // …which is the bug.
    }
  });

  it('the runtime key list is exactly the declared surface (no drift)', () => {
    const fullPatch: Required<IUpdatePatch> = {
      title: 't',
      body: 'b',
      tags: ['x'],
      projectPath: 'p',
      importedFrom: 'BACKLOG.md',
      priority: 'HIGH',
      status: 'IN_PROGRESS',
      plan: 'plan-slug',
      assignee: 'nix',
      kind: 'BUG',
      humanId: 'BUG-002',
      repo: 'adhd',
      files: ['a.ts'],
      author: 'researcher',
      reporter: 'researcher',
    };
    expect(Object.keys(fullPatch).sort()).toEqual([...UPDATE_PATCH_KEYS].sort());
    expect(() => assertKnownPatchKeys(fullPatch as unknown as Record<string, unknown>)).not.toThrow();
  });

  it('§7.8: an undeclared patch key is rejected BY NAME, never ignored', () => {
    expect(() => assertKnownPatchKeys({ titel: 'typo' })).toThrow(InvalidArgumentError);
    expect(() => assertKnownPatchKeys({ titel: 'typo' })).toThrow(/"titel"/);
    expect(toOutcomeError(new InvalidArgumentError('patch', 'x')).code).toBe('invalid_argument');
  });

  it('THE bug: a declared-but-unapplied key must fail, not return success', () => {
    // The exact live call that motivated the item: patch `priority`, and the
    // store writes title/body/projectPath/importedFrom/tags only.
    const patch = { title: 'new title', priority: 'CRITICAL' };
    expect(() => assertNoSilentlyDiscardedPatchKeys(patch, APPLIED_BY_V1_UPDATE_ITEM_NODE)).toThrow(InvalidArgumentError);
    expect(() => assertNoSilentlyDiscardedPatchKeys(patch, APPLIED_BY_V1_UPDATE_ITEM_NODE)).toThrow(/"priority".*never written/s);
    expect(() => assertNoSilentlyDiscardedPatchKeys(patch, APPLIED_BY_V1_UPDATE_ITEM_NODE)).toThrow(/BUG-BACKLOG-UPDATE-ITEM-SILENT-DISCARD-001/);
  });

  it('passes once the write path actually applies what it accepted', () => {
    const patch = { title: 'new title', priority: 'CRITICAL' };
    expect(() => assertNoSilentlyDiscardedPatchKeys(patch, ['title', 'priority'])).not.toThrow();
  });

  it('an explicitly-undefined key is not a discarded write', () => {
    expect(() => assertNoSilentlyDiscardedPatchKeys({ title: 't', priority: undefined }, ['title'])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// P1-core-write-verbs — priority reachability, cross-repo relate, the
// `IBacklogCreateInput.item` rename, and author/reporter on create.
// ---------------------------------------------------------------------------

describe('IBacklogUpdateInput.priority (partial fix of BUG-BACKLOG-UPDATE-ITEM-SILENT-DISCARD-001)', () => {
  it('is a top-level field, distinct from patch.priority (which updateItemNode rejects outright)', () => {
    const input: IBacklogUpdateInput = { humanId: 'BUG-1', repo: 'adhd', by: 'x', priority: 'CRITICAL' };
    expect(input.priority).toBe('CRITICAL');
    // `repo` is REQUIRED at the type level now (was `repo?`) — a caller
    // building this object without `repo` fails to compile, not just to run.
    expect(input.repo).toBe('adhd');
  });
});

describe('IBacklogRelateInput.sourceRepo/targetRepo (FEAT-BACKLOG-004 cross-repo relate)', () => {
  it('accepts two different repos for the two endpoints, defaulting to `repo` when omitted', () => {
    const sameRepo: IBacklogRelateInput = { sourceId: 'BUG-1', targetId: 'BUG-2', relation: 'related', action: 'add', repo: 'adhd', by: 'x' };
    expect(sameRepo.sourceRepo).toBeUndefined();
    expect(sameRepo.targetRepo).toBeUndefined();

    const crossRepo: IBacklogRelateInput = {
      sourceId: 'BUG-1',
      targetId: 'BUG-2',
      relation: 'dependency',
      action: 'add',
      repo: 'adhd',
      targetRepo: 'sox-ecosystem',
      by: 'x',
    };
    expect(crossRepo.targetRepo).toBe('sox-ecosystem');
  });
});

describe('IBacklogCreateInput.item (renamed from the confusing `input.input` double-nesting)', () => {
  it('the create payload lives under `item`, not `input`', () => {
    const req: IBacklogCreateInput = { item: { family: 'BUG-X', title: 't', body: 'b', repo: 'adhd' }, by: 'claude:1' };
    expect(req.item.title).toBe('t');
    expect('input' in req).toBe(false);
  });

  it('author/reporter round-trip on the item payload (TASK-004)', () => {
    const withRoles: ICreateItemInputV2 = { family: 'BUG-X', title: 't', body: 'b', repo: 'adhd', author: 'researcher:a1', reporter: 'researcher:b2' };
    expect(withRoles.author).toBe('researcher:a1');
    expect(withRoles.reporter).toBe('researcher:b2');
    // Also declared (and now actually persisted, store/crud.ts) on the base
    // `CreateItemInput` the store layer accepts — not JUST the v2 wrapper.
    const base: CreateItemInput = { family: 'BUG-X', title: 't', body: 'b', repo: 'adhd', author: 'researcher:a1' };
    expect(base.author).toBe('researcher:a1');
  });
});

// ---------------------------------------------------------------------------
// EPIC-A — repo alias reconciliation and identity canonicalisation.
// ---------------------------------------------------------------------------

describe('repo identity (GRAPH_MODEL_v2 §3, AC-7 / AC-24)', () => {
  const adhd: IRepositoryNode = { canonicalKey: 'adhd', aliases: ['PseudoSky/adhd', 'PseudoSky/adhd.git'] };
  const other: IRepositoryNode = { canonicalKey: 'acme/adhd', aliases: [] };
  const sox: IRepositoryNode = { canonicalKey: 'sox-ecosystem', aliases: [] };

  it('normalizeRepoKey strips .git and takes the bare segment', () => {
    expect(normalizeRepoKey('  PseudoSky/adhd.git ')).toBe('adhd');
    expect(normalizeRepoKey('adhd')).toBe('adhd');
    expect(normalizeRepoKey('git@github.com:PseudoSky/adhd.git')).toBe('adhd');
    expect(() => normalizeRepoKey('   ')).toThrow(InvalidArgumentError);
  });

  it('AC-7: items filed under BOTH `adhd` and `PseudoSky/adhd` reconcile to ONE repo node', () => {
    expect(resolveRepositoryNode([adhd, sox], 'adhd').node).toBe(adhd);
    expect(resolveRepositoryNode([adhd, sox], 'PseudoSky/adhd').node).toBe(adhd);
    expect(resolveRepositoryNode([adhd, sox], 'PseudoSky/adhd.git').node).toBe(adhd);
    // …and the reconciliation is not a wildcard: a genuinely different repo does not match.
    expect(resolveRepositoryNode([adhd, sox], 'sox-ecosystem').node).toBe(sox);
    expect(resolveRepositoryNode([adhd, sox], 'not-a-repo').node).toBeNull();
  });

  it('AC-24: a genuinely ambiguous bare name still resolves BUT carries a warning — never a silent narrow', () => {
    const res = resolveRepositoryNode([adhd, other], 'adhd');
    // An exact canonical-key hit is never ambiguous, so `adhd` wins outright.
    expect(res.node).toBe(adhd);
    expect(res.warning).toBeUndefined();

    const ambiguous = resolveRepositoryNode([adhd, other], 'adhd.git');
    expect(ambiguous.candidates).toHaveLength(2);
    expect(ambiguous.node).not.toBeNull();
    expect(ambiguous.warning).toMatch(/ambiguous/);
    expect(ambiguous.warning).toMatch(/acme\/adhd/);
    // Deterministic pick, so the warning is reproducible rather than order-dependent.
    expect(resolveRepositoryNode([other, adhd], 'adhd.git').node?.canonicalKey).toBe(ambiguous.node?.canonicalKey);
  });
});

describe('canonicalIdentityKey (GRAPH_MODEL_v2 §2.1.1, AC-14)', () => {
  it('AC-14: two runs of the same agent aggregate into ONE bucket', () => {
    expect(canonicalIdentityKey('researcher:x')).toBe('researcher');
    expect(canonicalIdentityKey('researcher:y')).toBe('researcher');
    expect(canonicalIdentityKey('researcher:x')).toBe(canonicalIdentityKey('researcher:y'));
  });

  it('does not merge genuinely different identities', () => {
    expect(canonicalIdentityKey('researcher')).toBe('researcher');
    expect(canonicalIdentityKey('reviewer:x')).not.toBe(canonicalIdentityKey('researcher:x'));
    // Case is preserved — lowercasing would merge distinct people.
    expect(canonicalIdentityKey('Nix')).toBe('Nix');
  });

  it('refuses an identity that is only a suffix', () => {
    expect(() => canonicalIdentityKey(':a1b2')).toThrow(InvalidArgumentError);
    expect(() => canonicalIdentityKey('  ')).toThrow(InvalidArgumentError);
  });
});

describe('assertAttribution (INTERFACE_v2 §7.5)', () => {
  it('an unattributed mutation is rejected, never silently stamped', () => {
    expect(assertAttribution(' nix ')).toBe('nix');
    expect(() => assertAttribution(undefined)).toThrow(InvalidArgumentError);
    expect(() => assertAttribution('')).toThrow(/must be attributed/);
  });
});

// ---------------------------------------------------------------------------
// BUG-025 — linkRelated must report its outcome.
// ---------------------------------------------------------------------------

describe('ILinkRelatedResult (BUG-025, INTERFACE_v2 §5 / backlog-001)', () => {
  /**
   * A stand-in for the fixed `linkRelatedNode`: today it returns
   * `Promise<void>` (store/structure.ts:57-61), which apigen renders as
   * `{"result": null}` for BOTH a successful write and a failure. This models
   * the v2 contract so the consumer-visible distinction can be asserted.
   */
  function fakeLinkRelated(edges: Set<string>, repo: string, a: string, b: string): IOutcomeEnvelope<ILinkRelatedResult> {
    const key = [a, b].sort().join('::');
    const alreadyLinked = edges.has(key);
    edges.add(key);
    return okEnvelope({ linked: true, repo, humanIdA: a, humanIdB: b, alreadyLinked });
  }

  it('a caller can tell a fresh link from a re-link — the distinction {"result": null} erased', () => {
    const edges = new Set<string>();
    const first = fakeLinkRelated(edges, 'adhd', 'BUG-1', 'BUG-2');
    const second = fakeLinkRelated(edges, 'adhd', 'BUG-1', 'BUG-2');
    expect(isOutcomeOk(first) && first.data.alreadyLinked).toBe(false);
    expect(isOutcomeOk(second) && second.data.alreadyLinked).toBe(true);
    // The serialized payloads DIFFER, which is exactly what `null` could not do.
    expect(JSON.stringify(first)).not.toEqual(JSON.stringify(second));
  });

  it('the payload identifies WHICH edge was written without the caller correlating its own request', () => {
    const env = fakeLinkRelated(new Set<string>(), 'adhd', 'BUG-1', 'BUG-2');
    expect(isOutcomeOk(env)).toBe(true);
    if (!isOutcomeOk(env)) throw new Error('unreachable');
    expect(env.data).toEqual({ linked: true, repo: 'adhd', humanIdA: 'BUG-1', humanIdB: 'BUG-2', alreadyLinked: false });
    expect(JSON.stringify(env.data)).not.toBe('null');
  });

  it('failure is the envelope error arm — there is no `linked: false` success to mistake for one', () => {
    const failure: IOutcomeEnvelope<ILinkRelatedResult> = errorEnvelope('item_not_found', 'backlog item not found: adhd::BUG-404');
    expect(isOutcomeError(failure)).toBe(true);
    expect(exitCodeForEnvelope(failure)).toBe(1);
    expect(JSON.stringify(failure)).not.toBe('{"result":null}');
  });
});

// ---------------------------------------------------------------------------
// AC-0 — the six-verb surface and the host carve-out.
// ---------------------------------------------------------------------------

describe('the 6-tool surface (INTERFACE_v2 AC-0, §6)', () => {
  it('is exactly six verbs', () => {
    expect([...BACKLOG_V2_TOOLS]).toEqual(['get', 'query', 'create', 'update', 'relate', 'admin']);
  });

  it('AC-0 negative assertion: install/install-skill/serve are NOT tools and NOT admin actions (§6 carve-out)', () => {
    for (const host of ['install', 'install-skill', 'serve'] as const) {
      expect(BACKLOG_V2_TOOLS).not.toContain(host as never);
    }
    expect(BACKLOG_ADMIN_ACTIONS).not.toContain('install' as never);
    expect(BACKLOG_ADMIN_ACTIONS).not.toContain('serve' as never);
    // `skill` (install-skill's *data* half) IS an admin action — BUG-BACKLOG-001
    // was exactly a shipped-but-invisible command.
    expect(BACKLOG_ADMIN_ACTIONS).toContain('skill');
    expect(BACKLOG_ADMIN_ACTIONS).toContain('version');
    expect(BACKLOG_ADMIN_ACTIONS).toContain('batch');
  });

  it('§6 growth rule: the action union stays under the ~25 split threshold', () => {
    expect(BACKLOG_ADMIN_ACTIONS.length).toBeLessThan(25);
  });

  it('§2.2: stats and stale-claims are READS, not admin actions', () => {
    expect(BACKLOG_ADMIN_ACTIONS).not.toContain('stats' as never);
    expect(BACKLOG_ADMIN_ACTIONS).not.toContain('stale_claims' as never);
    expect(BACKLOG_VIEWS).toContain('summary');
    expect(BACKLOG_VIEWS).toContain('stale');
  });
});

// ---------------------------------------------------------------------------
// Compile-time contracts. `tsc -p tsconfig.spec.json` is the runner for these:
// each one fails the BUILD rather than a test, which is the only way to assert
// a shape that has no runtime residue.
// ---------------------------------------------------------------------------

/**
 * AC-6: `{ ok: true, data: null }` — the shape AC-6 forbids for a not-found —
 * must NOT be assignable to an envelope of a real item type. If someone
 * loosens `IOutcomeSuccess<T>` to `data?: T`, this alias stops being `true`
 * and the build breaks.
 */
type _NullDataIsNotASuccess = { ok: true; data: null } extends IOutcomeEnvelope<IBacklogCard> ? 'AC-6 VIOLATED: ok:true/data:null is assignable' : true;
const _nullDataIsNotASuccess: _NullDataIsNotASuccess = true;
void _nullDataIsNotASuccess;

/**
 * §7.1: `data` is REQUIRED on the success arm. If it is ever loosened to
 * `data?: T`, every consumer silently regains the `{ ok: true }`-with-nothing
 * shape that BUG-025's `{"result": null}` was — so the loosening must fail the
 * build here rather than at a call site months later.
 */
type _SuccessDataIsRequired = undefined extends Extract<IOutcomeEnvelope<IBacklogCard>, { ok: true }>['data'] ? 'VIOLATED: success data is optional' : true;
const _successDataIsRequired: _SuccessDataIsRequired = true;
void _successDataIsRequired;

/** The failure arm must not carry `data` — a host that reads `env.data` after `ok:false` must not compile. */
type _FailureHasNoData = 'data' extends keyof Extract<IOutcomeEnvelope<IBacklogCard>, { ok: false }> ? 'VIOLATED: the error arm exposes data' : true;
const _failureHasNoData: _FailureHasNoData = true;
void _failureHasNoData;

/** BUG-025: `linked` is the literal `true`, so `{ linked: false }` cannot masquerade as a successful link. */
type _LinkedIsLiteralTrue = ILinkRelatedResult['linked'] extends true ? true : 'VIOLATED: linked is not the literal true';
const _linkedIsLiteralTrue: _LinkedIsLiteralTrue = true;
void _linkedIsLiteralTrue;

/** BUG-023: both scopes are REQUIRED on `IBacklogStats` — an implementer cannot ship one and default the other. */
type _BothStatScopesRequired = undefined extends IBacklogStats['byPriority']
  ? 'VIOLATED: byPriority is optional'
  : undefined extends IBacklogStats['byPriorityAllStatuses']
    ? 'VIOLATED: byPriorityAllStatuses is optional'
    : undefined extends IBacklogStats['coverage']
      ? 'VIOLATED: coverage is optional'
      : true;
const _bothStatScopesRequired: _BothStatScopesRequired = true;
void _bothStatScopesRequired;

/** v2 must be ADDITIVE: every v1 `UpdateItemInput` key survives in `IUpdatePatch`. */
type _PatchIsSupersetOfV1 = 'title' | 'body' | 'tags' | 'projectPath' | 'importedFrom' extends keyof IUpdatePatch ? true : 'VIOLATED: IUpdatePatch dropped a v1 key';
const _patchIsSupersetOfV1: _PatchIsSupersetOfV1 = true;
void _patchIsSupersetOfV1;

/** v2 must be ADDITIVE: every v1 `BacklogFilter` key survives in `IBacklogFilter`. */
type _FilterIsSupersetOfV1 =
  | 'repo'
  | 'projectPath'
  | 'status'
  | 'kind'
  | 'family'
  | 'priority'
  | 'plan'
  | 'assignee'
  | 'claimedBy'
  | 'tags'
  | 'grep'
  | 'importedFrom'
  | 'rootLevel'
  | 'excludeArchived' extends keyof IBacklogFilter
  ? true
  : 'VIOLATED: IBacklogFilter dropped a v1 key';
const _filterIsSupersetOfV1: _FilterIsSupersetOfV1 = true;
void _filterIsSupersetOfV1;
