/**
 * client.ts — THE apigen extraction surface (DESIGN.md §5), collapsed to the
 * SIX verbs of INTERFACE_v2 (`get`, `query`, `create`, `update`, `relate`,
 * `admin` — `BACKLOG_V2_TOOLS`, model.ts).
 *
 * **The exported surface of this file IS the mounted surface.**
 * `server.ts`'s `extractClientOperations()` extracts `dist/client.d.ts` — the
 * whole file, with no allow-list (`server.ts:349-380`) — so every exported
 * function here becomes a command on the CLI, a tool in MCP `tools/list`, a
 * Fastify route, and a path in the OpenAPI document. That is why the v1
 * operation bodies moved to `./ops-v1.ts` in INTERFACE_v2 C-01: not because
 * they were wrong, but because being exported FROM THIS FILE is what mounts
 * them. Adding a seventh exported function here silently widens the tool
 * surface an agent must hold in its head (INTERFACE_v2 §0.1) and breaks AC-0's
 * six-verb assertion. Export from `./ops-v1.ts` (internal) or re-export from
 * `./index.ts` (library-only) instead — never from here.
 *
 * Same rules as before, still: plain, JSDoc'd async functions ONLY, no
 * business logic inline. `ctx: BacklogCtx` is the sole non-serializable
 * parameter, excluded from the generated JSON Schema by the `ctx-name-only`
 * invariant (the FIRST parameter named exactly `ctx`). Every other
 * parameter/return type is plain and JSON-serializable.
 *
 * Every verb returns the §7.1 outcome envelope `{ ok, data?, error?,
 * warnings? }` and never throws for a caller error — `errorEnvelope` is the
 * failure arm, so a transport maps an outcome to its own status/exit code
 * (`exitCodeForEnvelope`) without a try/catch of its own.
 */
import type { Environment } from '@adhd/environment';
import type { BacklogConfig } from './env.js';
import type { GraphBacklogStore } from './store/graph-backlog-store.js';
import type {
  BacklogItem,
  IBacklogAdminInput,
  IBacklogCard,
  IBacklogCreateInput,
  IBacklogRelateInput,
  IBacklogUpdateInput,
  ICreateItemInputV2,
  ICreateOutcome,
  IDuplicateCandidate,
  IEdgeOutcome,
  IOutcomeEnvelope,
  ISplitItemResult,
  ISupersedeResult,
  IUpdateOutcome,
  UpdateItemInput,
} from './model.js';
import {
  DuplicateCandidateError,
  InvalidArgumentError,
  assertKnownUpdateKeys,
  canonicalIdentityKey,
  errorEnvelope,
  okEnvelope,
  toOutcomeError,
} from './model.js';
import type { IBacklogGetOptions } from './v2/get.js';
import { backlogGet } from './v2/get.js';
import type { IBacklogQueryOptions, IBacklogQueryResult } from './v2/query.js';
import { backlogQuery } from './v2/query.js';
import type { IAdminResult, IAdminRuntime } from './v2/admin.js';
import { backlogAdmin } from './v2/admin.js';
import {
  addCitation as addCitationOp,
  addDependency as addDependencyOp,
  appendNote as appendNoteOp,
  assignItem as assignItemOp,
  attachToPlan as attachToPlanOp,
  claimItem as claimItemOp,
  createItem as createItemOp,
  getItem as getItemOp,
  linkRelated as linkRelatedOp,
  releaseClaim as releaseClaimOp,
  removeDependency as removeDependencyOp,
  renewClaim as renewClaimOp,
  setPriority as setPriorityOp,
  softDeleteItem as softDeleteItemOp,
  splitItem as splitItemOp,
  supersedeItem as supersedeItemOp,
  transitionStatus as transitionStatusOp,
  updateItem as updateItemOp,
} from './ops-v1.js';

/** The one type apigen special-cases via the `ctx-name-only` invariant. */
export interface BacklogCtx {
  store: GraphBacklogStore;
  env: Environment<BacklogConfig>;
  /**
   * Test-isolation escape hatch ONLY — mirrors `BuildBacklogEnvOptions.adhdRoot`
   * (the same value passed to `buildBacklogEnv({ adhdRoot })` when constructing
   * `env`). NEVER set this in production code (`server.ts`/`cli.ts` never do).
   * `setMigrationPhase` threads it through to `writeMigrationPhase` so a
   * temp-rooted test `ctx` can never write to the real machine-global
   * `~/.adhd` — omitting this on a real ctx write is exactly the bug
   * `migration-admin.spec.ts`'s negative control caught (a test run wrote
   * `phase-4` to the real `~/.adhd/backlog/production/config.yaml` before
   * this field existed; reverted, see CHANGELOG).
   */
  adhdRoot?: string;
}

/**
 * The version payload. Re-exported as a TYPE from its real home
 * (`./ops-v1.ts`) so existing importers of `BacklogCtx`'s neighbour keep
 * resolving — a type export is erased in `client.d.ts`'s eyes as far as
 * `extract()` is concerned (it only mounts `kind: 'action'` function
 * declarations), so this does NOT widen the six-verb mount surface. The
 * `cli.v2.spec.ts` operation-count assertion is what proves that claim
 * rather than this comment asserting it.
 */
export type { BacklogVersionInfo } from './ops-v1.js';

// ============================================================================
// Shared internals (NOT exported — see this file's header).
// ============================================================================

/**
 * Runs `body` and wraps it in the §7.1 envelope, mapping ANY throw through
 * `toOutcomeError` so a store-level `BacklogItemNotFoundError`/`ClaimHeldError`/
 * `SQLITE_BUSY` surfaces as its typed code rather than as `internal`. Mirrors
 * `v2/admin.ts`'s own `envelope()` helper exactly.
 */
async function envelope<T>(body: () => Promise<T>): Promise<IOutcomeEnvelope<T>> {
  try {
    return okEnvelope(await body());
  } catch (err) {
    const mapped = toOutcomeError(err);
    return errorEnvelope(mapped.code, mapped.message, mapped.details);
  }
}

/**
 * INTERFACE_v2 §7.5 — `by` is REQUIRED on every mutation and is never
 * defaulted to a placeholder. A blank/whitespace-only value is rejected with
 * the same `invalid_argument` an absent one gets: an audit trail attributing
 * a write to `""` is worse than a refused write.
 */
function assertAttribution(by: unknown): string {
  if (typeof by !== 'string' || by.trim() === '') {
    throw new InvalidArgumentError(
      'by',
      'backlog: "by" is required on every mutation and must be a non-empty string (INTERFACE_v2 §7.5). On the CLI it resolves from --by / the identity chain; on MCP/REST it is a mandatory per-call parameter.'
    );
  }
  return by;
}

/** Every create variant needs a repo, and `item.repo` is the only place it can come from. */
function requireCreateRepo(input: IBacklogCreateInput): string {
  const repo = input?.item?.repo;
  if (typeof repo !== 'string' || repo.trim() === '') {
    throw new InvalidArgumentError('item.repo', 'backlog_create: "item.repo" is required — a humanId is only unique within a repo.');
  }
  return repo;
}

/**
 * TASK-004 — `author` defaults to `canonicalIdentityKey(by)` and `reporter`
 * defaults to the (now-resolved) `author` when either is absent, per
 * `ICreateItemInputV2.author`'s documented contract. `by` is only ever in
 * scope here (the caller of `createItemOp`/`splitItemOp`/`supersedeItemOp`),
 * never inside `createItemNode` itself, so the default MUST be computed at
 * this layer.
 */
function withAuthorDefaults<T extends ICreateItemInputV2>(item: T, by: string): T {
  const author = item.author ?? canonicalIdentityKey(by);
  const reporter = item.reporter ?? author;
  return { ...item, author, reporter };
}

/** v1 `CreateItemResult.duplicateCandidates` (full items) → the §3 candidate shape (card + reason). */
function toDuplicateCandidates(items: readonly BacklogItem[]): IDuplicateCandidate[] {
  return items.map((it) => ({
    item: {
      humanId: it.humanId,
      kind: it.kind,
      title: it.title,
      status: it.status,
      ...(it.priority !== undefined ? { priority: it.priority } : {}),
    } as IBacklogCard,
    reason: 'dedupe-scan match (FTS + symbol/path/errorText metadata)',
  }));
}

// ============================================================================
// §1 — backlog_get
// ============================================================================

/**
 * INTERFACE_v2 §1 — one item, depth chosen by `fields`. Absorbs v1's
 * `get-item` + `audit-trail` + `blockers` (3 → 1): `fields` is the single
 * progressive-disclosure vocabulary, so a caller no longer has to know which
 * of three commands it wanted before it has looked.
 *
 * @param ctx open store + env
 * @param input `{ humanId, repo?, fields?, includeDeleted? }`
 * @returns `{ ok: true, data: card }`, or the error arm with `item_not_found`
 *   (exit 1, distinct from a generic unknown-command `not_found`),
 *   `ambiguous`, `soft_deleted`, `validation` or `invalid_argument`
 */
export async function get(ctx: BacklogCtx, input: IBacklogGetOptions): Promise<IOutcomeEnvelope<IBacklogCard>> {
  return backlogGet(ctx.store, input);
}

// ============================================================================
// §2 — backlog_query
// ============================================================================

/**
 * INTERFACE_v2 §2 — the query layer, and the design centre of the surface.
 * Absorbs `list-items`, `spotlight`, `ready-items`, `topo-order`,
 * `dependency-graph`, `stats` and `stale-claims` behind one `view` knob
 * (`view:list` with the default sort IS today's spotlight ordering — AC-5).
 *
 * An empty result is `{ ok: true, data: { view, items: [] } }` — a list is
 * never "not found" (§7.2).
 *
 * @param ctx open store + env
 * @param input `{ view?, filter?, fields?, sort?, limit?, offset?, groupBy?, text?, … }`
 * @returns `{ ok: true, data, meta: { total, returned } }` for pageable views,
 *   or the error arm with `validation` / `invalid_argument` /
 *   `rag_not_configured` / `store_busy`
 */
export async function query(ctx: BacklogCtx, input: IBacklogQueryOptions): Promise<IOutcomeEnvelope<IBacklogQueryResult>> {
  return backlogQuery(ctx.store, input);
}

// ============================================================================
// §3 — backlog_create
// ============================================================================

/**
 * INTERFACE_v2 §3 — instantiation plus filing-time interception. One verb for
 * `create-item`, `split-item` and `supersede-item`, because all three MINT and
 * therefore all three must run the same dedupe gate (the variant that skipped
 * it is BUG-BACKLOG-CREATE-ITEM-SILENT-DEDUP-DROP-001).
 *
 * `duplicateAction` (default `"abort"`) is the interception knob: `abort`
 * refuses the write and returns the candidates as the `duplicate_candidate`
 * error arm (exit 1 — `BACKLOG_EXIT_CODE`), `file` is the confirmed re-file
 * that bypasses the gate deliberately. The outcome ALWAYS carries a required
 * `created` boolean, so a variant can never report a write it did not make.
 *
 * @param ctx open store + env
 * @param input `{ item, by, duplicateAction?, splitFrom?, children?, supersedes?, reason? }`
 * @returns `{ ok: true, data: { created, humanId?, item?, … } }`, or the error
 *   arm with `duplicate_candidate` / `invalid_argument` / `item_not_found`
 */
export async function create(
  ctx: BacklogCtx,
  input: IBacklogCreateInput
): Promise<IOutcomeEnvelope<ICreateOutcome | ISplitItemResult | ISupersedeResult>> {
  return envelope(async () => {
    const by = assertAttribution(input?.by);
    const repo = requireCreateRepo(input);
    const action = input.duplicateAction ?? 'abort';
    if (action === 'comment') {
      // §3's third interception mode converts the draft into a note on the
      // canonical item and increments its dupe counter. The counter is
      // FEAT-013 state that does not exist on the node yet (C-04 lands it
      // with `sort:"demand"`), and writing the note WITHOUT the increment
      // would report a `dupeHits` this store cannot actually carry — a
      // fabricated outcome field is worse than a typed refusal.
      throw new InvalidArgumentError(
        'duplicateAction',
        'backlog_create: duplicateAction "comment" needs the FEAT-013 dupe counter, which is not in this build (INTERFACE_v2 §3, plan C-04). Use "abort" to see the candidates, or "file" to re-file deliberately.'
      );
    }

    // §5a / GRAPH_MODEL §5.1 — split: N children, each PART_OF the parent.
    if (input.splitFrom !== undefined) {
      const children = input.children ?? [];
      if (children.length === 0) {
        throw new InvalidArgumentError('children', 'backlog_create: "splitFrom" requires a non-empty "children" array.');
      }
      const created = await splitItemOp(ctx, repo, input.splitFrom, children.map((child) => withAuthorDefaults(child, by)));
      const result: ISplitItemResult = {
        parentHumanId: input.splitFrom,
        created: created as unknown as ISplitItemResult['created'],
        suppressed: [],
      };
      return result;
    }

    // §3 — supersede: mint the replacement, link SUPERSEDES, invalidate the old.
    if (input.supersedes !== undefined) {
      const reason = input.reason ?? `superseded by a replacement filed by ${by}`;
      const item = await supersedeItemOp(ctx, repo, input.supersedes, withAuthorDefaults(input.item, by), reason);
      const result: ISupersedeResult = {
        supersededHumanId: input.supersedes,
        created: true,
        humanId: item.humanId,
        item: item as unknown as ISupersedeResult['item'],
      };
      return result;
    }

    const res = await createItemOp(ctx, { ...withAuthorDefaults(input.item, by), ...(action === 'file' ? { force: true } : {}) });
    if (!res.created) {
      // Interception fired: NOTHING was written. `DuplicateCandidateError`
      // carries the candidates through `toOutcomeError`'s normal mapping, so
      // this takes the same path every other typed failure does (error arm,
      // code `duplicate_candidate`, exit 1 per `BACKLOG_EXIT_CODE`) instead
      // of a bespoke return shape only this branch understands.
      throw new DuplicateCandidateError(input.item.title, toDuplicateCandidates(res.duplicateCandidates));
    }
    const outcome: ICreateOutcome = {
      created: true,
      humanId: res.item.humanId,
      item: res.item as unknown as ICreateOutcome['item'],
      ...(res.repoWarning !== undefined ? { repoWarning: res.repoWarning } : {}),
    };
    return outcome;
  });
}

// ============================================================================
// §4 — backlog_update
// ============================================================================

/**
 * INTERFACE_v2 §4 — ALL mutations of an existing item behind one verb: the
 * field patch, the status transition (with its §5a.2 evidence gate), the
 * claim lease, assignment, notes, citations and soft delete. Absorbs the
 * twelve v1 mutation commands.
 *
 * The outcome's `changed` array is the contract that makes a silent discard
 * visible (BUG-BACKLOG-UPDATE-ITEM-SILENT-DISCARD-001): a key the caller
 * passed that never reaches `changed` is a defect, not a no-op. An empty
 * `changed` is a genuine no-op and says so out loud.
 *
 * @param ctx open store + env
 * @param input `{ humanId, repo, by, patch?, status?, claim?, assignedTo?, addNote?, addCitation?, softDeleteReason?, … }`
 * @returns `{ ok: true, data: { humanId, changed, newStatus?, claimState?, noteId? } }`,
 *   or the error arm with `item_not_found` / `conflict` (claim held) /
 *   `precondition_failed` (missing citation/reason) / `invalid_argument`
 */
export async function update(ctx: BacklogCtx, input: IBacklogUpdateInput): Promise<IOutcomeEnvelope<IUpdateOutcome>> {
  return envelope(async () => {
    const by = assertAttribution(input?.by);
    const humanId = input?.humanId;
    if (typeof humanId !== 'string' || humanId.trim() === '') {
      throw new InvalidArgumentError('humanId', 'backlog_update: "humanId" is required.');
    }
    const repo = input.repo;
    if (typeof repo !== 'string' || repo.trim() === '') {
      // §7.5 keeps `repo` explicit — a humanId alone is not globally unique,
      // and picking one silently is exactly the "read never silently
      // narrows" violation §7.1 forbids.
      throw new InvalidArgumentError('repo', 'backlog_update: "repo" is required — a humanId is only unique within a repo.', 'EPIC-A / INTERFACE_v2 §7.5');
    }
    // DEBT-010 — closed top-level key set: an unknown key (a `citations` typo,
    // etc.) fails loud rather than being silently absorbed.
    assertKnownUpdateKeys(input as unknown as Record<string, unknown>);

    // DEBT-010 — `statusEvidence` is transition evidence; without `status` it
    // has nothing to attach to. The old top-level `citations`/`reason` were
    // silently dropped in exactly this case — fail loud instead.
    if (input.statusEvidence !== undefined && input.status === undefined) {
      throw new InvalidArgumentError(
        'statusEvidence',
        'backlog_update: "statusEvidence" (citations/reason) requires "status" — evidence attaches to a status transition.',
      );
    }

    const outcome: IUpdateOutcome = { humanId, changed: [] };

    if (input.patch !== undefined && Object.keys(input.patch).length > 0) {
      const patch = input.patch as UpdateItemInput;
      const before = await getItemOp(ctx, repo, humanId);
      await updateItemOp(ctx, repo, humanId, patch);
      for (const key of Object.keys(patch) as Array<keyof UpdateItemInput>) {
        // Only report a field as changed when it ACTUALLY differs from what
        // the store already held — "changed" that includes an unchanged key
        // is as misleading as one that omits a changed key.
        const prev = before ? (before as unknown as Record<string, unknown>)[key] : undefined;
        const next = (patch as unknown as Record<string, unknown>)[key];
        if (JSON.stringify(prev) !== JSON.stringify(next)) {
          outcome.changed.push(key as IUpdateOutcome['changed'][number]);
        }
      }
    }

    if (input.assignedTo !== undefined) {
      await assignItemOp(ctx, repo, humanId, input.assignedTo, by);
      outcome.changed.push('assignee');
    }

    if (input.claim !== undefined) {
      if (input.claim === 'claim') {
        const res = await claimItemOp(ctx, repo, humanId, by, input.claimOpts ?? {});
        outcome.claimState = res.status;
      } else if (input.claim === 'renew') {
        const res = await renewClaimOp(ctx, repo, humanId, by);
        outcome.claimState = res.status;
      } else {
        const res = await releaseClaimOp(ctx, repo, humanId, by);
        outcome.claimState = res.status;
      }
      outcome.changed.push('claim');
    }

    if (input.addCitation !== undefined) {
      await addCitationOp(ctx, repo, humanId, input.addCitation);
      outcome.changed.push('citation');
    }

    if (input.addNote !== undefined) {
      const item = await appendNoteOp(ctx, repo, humanId, by, input.addNote);
      outcome.noteId = Math.max(0, (item.notes?.length ?? 1) - 1);
      outcome.changed.push('note');
    }

    if (input.status !== undefined) {
      // The §5a.2 evidence gate lives in `transitionStatusNode`'s own
      // validation (`requiresCitation`/`requiresReason`, model.ts) — passed
      // through rather than re-implemented, so the CLI, MCP and a direct
      // in-process caller are all gated by the SAME code.
      await transitionStatusOp(ctx, repo, humanId, input.status, {
        by,
        ...(input.statusEvidence?.citations !== undefined ? { citations: input.statusEvidence.citations } : {}),
        ...(input.statusEvidence?.reason !== undefined ? { reason: input.statusEvidence.reason } : {}),
      });
      outcome.newStatus = input.status;
      outcome.changed.push('status');
    }

    if (input.softDeleteReason !== undefined) {
      await softDeleteItemOp(ctx, repo, humanId, input.softDeleteReason);
      outcome.changed.push('softDeleted');
    }

    if (input.priority !== undefined) {
      // Partial fix of BUG-BACKLOG-UPDATE-ITEM-SILENT-DISCARD-001: priority
      // was previously UNREACHABLE through the six-verb surface —
      // `patch.priority` always threw (`updateItemNode`'s explicit rejection,
      // store/crud.ts), and nothing else called the store's `setPriority`
      // primitive. This is that missing call.
      await setPriorityOp(ctx, repo, humanId, input.priority);
      outcome.changed.push('priority');
    }

    if (outcome.changed.length === 0) {
      // A call that asked for nothing is a caller error, not a successful
      // no-op: it is indistinguishable from a patch whose keys were all
      // silently dropped, which is the exact failure `changed` exists to
      // expose.
      throw new InvalidArgumentError(
        'patch',
        'backlog_update: nothing to do — pass at least one of patch / status / statusEvidence / priority / claim / assignedTo / addNote / addCitation / softDeleteReason.'
      );
    }
    return outcome;
  });
}

// ============================================================================
// §5 — backlog_relate
// ============================================================================

/**
 * INTERFACE_v2 §5 — graph edges, with the written edge REPORTED rather than
 * assumed. This verb exists in this shape because of backlog-001/BUG-025:
 * `linkRelatedNode` returns `void`, which apigen renders as `{"result":null}`
 * — the same payload for a successful link and for a failure, so the write
 * was unverifiable through its real seam. `IEdgeOutcome.noop` additionally
 * distinguishes a fresh write from an idempotent re-assert.
 *
 * @param ctx open store + env
 * @param input `{ sourceId, targetId, relation: 'dependency'|'related'|'plan', action: 'add'|'remove', repo, sourceRepo?, targetRepo?, by }`
 * @returns `{ ok: true, data: { from, to, rel, action, noop } }`, or the error
 *   arm with `item_not_found` / `precondition_failed` (dependency cycle) /
 *   `invalid_argument`
 */
export async function relate(ctx: BacklogCtx, input: IBacklogRelateInput): Promise<IOutcomeEnvelope<IEdgeOutcome>> {
  return envelope(async () => {
    assertAttribution(input?.by);
    const { sourceId, targetId, relation, action } = input ?? ({} as IBacklogRelateInput);
    const repo = input?.repo;
    if (typeof repo !== 'string' || repo.trim() === '') {
      throw new InvalidArgumentError('repo', 'backlog_relate: "repo" is required.', 'EPIC-A / INTERFACE_v2 §7.5');
    }
    if (typeof sourceId !== 'string' || typeof targetId !== 'string' || sourceId === '' || targetId === '') {
      throw new InvalidArgumentError('sourceId', 'backlog_relate: both "sourceId" and "targetId" are required.');
    }
    if (action !== 'add' && action !== 'remove') {
      throw new InvalidArgumentError('action', `backlog_relate: "action" must be "add" or "remove" (got ${JSON.stringify(action)}).`);
    }
    // FEAT-BACKLOG-004: `sourceRepo`/`targetRepo` let the two endpoints live
    // in two different repos — a single `repo` alone can never resolve a
    // cross-repo pair. Both default to `repo` so the common single-repo call
    // is unaffected.
    const sourceRepo = input?.sourceRepo ?? repo;
    const targetRepo = input?.targetRepo ?? repo;

    switch (relation) {
      case 'dependency': {
        if (action === 'add') {
          const res = await addDependencyOp(ctx, sourceRepo, sourceId, targetId, targetRepo);
          return { from: sourceId, to: targetId, rel: 'DEPENDS_ON', action, noop: res.alreadyExisted } satisfies IEdgeOutcome;
        }
        const res = await removeDependencyOp(ctx, sourceRepo, sourceId, targetId, targetRepo);
        return { from: sourceId, to: targetId, rel: 'DEPENDS_ON', action, noop: !res.alreadyExisted } satisfies IEdgeOutcome;
      }
      case 'related': {
        if (action === 'remove') {
          // There is no `unlinkRelated` primitive in the store today, and
          // reporting `action:"remove"` for an edge that is still present
          // would be a fabricated outcome — the exact class of lie the
          // outcome contract exists to prevent.
          throw new InvalidArgumentError(
            'action',
            'backlog_relate: removing a "related" edge has no store primitive in this build (RELATES_TO is add-only). Removing a "dependency" edge is supported.'
          );
        }
        const res = await linkRelatedOp(ctx, sourceRepo, sourceId, targetId, targetRepo);
        return { from: sourceId, to: targetId, rel: 'RELATES_TO', action, noop: res.alreadyLinked } satisfies IEdgeOutcome;
      }
      case 'plan': {
        if (action === 'remove') {
          throw new InvalidArgumentError(
            'action',
            'backlog_relate: detaching from a plan has no store primitive in this build (MEMBER_OF is add-only).'
          );
        }
        const res = await attachToPlanOp(ctx, sourceRepo, sourceId, targetId, targetRepo);
        return { from: sourceId, to: targetId, rel: 'MEMBER_OF', action, noop: res.alreadyExisted } satisfies IEdgeOutcome;
      }
      default:
        throw new InvalidArgumentError(
          'relation',
          `backlog_relate: "relation" must be one of dependency, related, plan (got ${JSON.stringify(relation)}).`
        );
    }
  });
}

// ============================================================================
// §6 — backlog_admin
// ============================================================================

/**
 * INTERFACE_v2 §6 — the single bulk / maintenance / system verb: archive,
 * export, import, render, merge, migration phase, version, batch, doctor,
 * prune, repo reconciliation, and the EPIC-G RAG actions.
 *
 * `stats` and `stale-claims` are deliberately NOT admin actions — they are
 * reads, and they live at `query --view summary` / `query --view stale`.
 * `install`/`install-skill`/`serve` are deliberately NOT here either: they are
 * HOST commands (§6 carve-out) that must never open the store, and
 * `backlog_admin({action:"skill"})` refuses with `unsupported` saying so.
 *
 * @param ctx open store + env
 * @param input `{ action, params?, by? }`
 * @returns `{ ok: true, data: { action, … } }` (a tagged union — the `action`
 *   is echoed so a caller never has to infer which field to read), or the
 *   error arm with `not_found` (unknown action) / `unsupported` /
 *   `rag_not_configured` / `invalid_argument`
 */
export async function admin(ctx: BacklogCtx, input: IBacklogAdminInput): Promise<IOutcomeEnvelope<IAdminResult>> {
  return backlogAdmin(ctx, input, {} as IAdminRuntime);
}
