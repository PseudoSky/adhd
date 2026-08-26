/**
 * v2/get.ts — INTERFACE_v2 §1, `backlog_get`: one item, deep context on demand.
 *
 * This is a COMPOSITION layer, not a second store. Every read it performs is
 * delegated to an existing `../store/*` operation (`findItemNode`,
 * `findHumanIdInAnyRepo`, `buildNotFoundError`, `auditTrail`, `blockers`,
 * `queryAuditEvents`); the only genuinely new primitive here is
 * `findSoftDeletedItemNodes` — the `(repo, humanId) → nodeId` resolution that
 * does NOT go through the live-only `queryNodes` filter, which INTERFACE_v2 §1
 * names as the *entire* remaining gap behind
 * BUG-BACKLOG-AUDIT-TRAIL-SOFTDELETE-001.
 *
 * Three contracts here are load-bearing and must not be softened:
 *
 * 1. **AC-6 (§10.2).** A missing single item is
 *    `{ ok:false, error:{ code:"item_not_found" } }` — exit 1. NEVER
 *    `ok:true, data:null` (indistinguishable from "found, but empty"), and
 *    never the generic `not_found` (exit 4, which means "unknown command" and
 *    is what a scripter greps for to detect a typo'd verb). `item_not_found`
 *    and `internal` are different codes precisely so the collision AC-6 calls
 *    impossible stays impossible.
 * 2. **§0.2 / AC-18 projection discipline.** The default response is the terse
 *    card (`DEFAULT_GET_FIELDS`) — 36 items were 90KB of bodies because the
 *    read tool's own default returned everything. Bodies, notes, citations,
 *    the audit trail, the rollup and the embedding blob are each opt-in by
 *    name via `fields`.
 * 3. **§7 "never accept-and-ignore an input key."** An unrecognized top-level
 *    key, an unknown projection field, or a field that has no single-item
 *    meaning is a TYPED error naming the offending key — never a silent
 *    no-op that hands back a success response missing exactly what was asked
 *    for (the read-side twin of
 *    BUG-BACKLOG-UPDATE-ITEM-SILENT-DISCARD-001).
 */
import type { NodeRecord } from '@adhd/sox-graph-store';
import type {
  AuditTrailEntry,
  BacklogItem,
  BacklogStatus,
  IBacklogCard,
  IBacklogField,
  IBacklogGetInput,
  IItemRollup,
  IOutcomeEnvelope,
} from '../model.js';
import {
  BacklogItemNotFoundError,
  BacklogValidationError,
  DEFAULT_GET_FIELDS,
  InvalidArgumentError,
  RagNotConfiguredError,
  assertKnownFields,
  errorEnvelope,
  isTerminalStatus,
  okEnvelope,
  toOutcomeError,
} from '../model.js';
import type { GraphBacklogStore } from '../store/graph-backlog-store.js';
import { queryAuditEvents } from '../store/audit-log.js';
import { BACKLOG_ITEM_TAG, isLiveBacklogItemNode, toBacklogItem, type BacklogNodeMeta } from '../store/mapping.js';
import { listRelatedNode } from '../store/structure.js';
import {
  auditTrail as auditTrailOp,
  blockers as blockersOp,
  buildNotFoundError,
  findByRenamedFromId,
  findHumanIdInAnyRepo,
  findItemNode,
} from '../store/query.js';

// ----------------------------------------------------------------------------
// Input surface.
// ----------------------------------------------------------------------------

/**
 * INTERFACE_v2 §1 — `backlog_get`'s input.
 *
 * Extends the contract's `IBacklogGetInput` (`{ humanId, repo?, fields? }`)
 * with the one knob the §1 outcome list forces into existence. §1 lists
 * `soft_deleted` as a real outcome AND §8 requires that "`backlog_get` fields
 * reach soft-deleted history" (BUG-BACKLOG-AUDIT-TRAIL-SOFTDELETE-001) — both
 * cannot hold at once unless reaching a deleted item is something the caller
 * asks for explicitly. So: the default refuses with `soft_deleted` (a deleted
 * item is never quietly served as if live), and `includeDeleted: true` serves
 * it with a `warnings` entry saying so. The alternative — silently returning a
 * deleted item whenever `fields` happens to include `audit_trail` — makes the
 * response's liveness depend on an unrelated projection choice, which is
 * exactly the kind of implicit behaviour §7 forbids.
 */
export interface IBacklogGetOptions extends IBacklogGetInput {
  /**
   * §1 / BUG-BACKLOG-AUDIT-TRAIL-SOFTDELETE-001 — serve a soft-deleted item
   * (with its history) instead of failing `soft_deleted`. The response always
   * carries a `warnings` entry naming the deletion, so a caller can never
   * mistake a tombstone for a live item.
   */
  includeDeleted?: boolean;
}

/**
 * INTERFACE_v2 §7 — the CLOSED set of top-level keys `backlog_get` accepts.
 * Anything else is a typed error naming the key (see `assertKnownGetKeys`).
 */
export const BACKLOG_GET_INPUT_KEYS = ['humanId', 'repo', 'fields', 'includeDeleted'] as const;

// Compile-time exhaustiveness: adding a property to `IBacklogGetOptions`
// without adding it to `BACKLOG_GET_INPUT_KEYS` fails the build rather than
// silently becoming a rejected key at runtime. Mirrors `BACKLOG_FILTER_KEYS`'
// own guard in model.ts.
type UncoveredGetKey = Exclude<keyof IBacklogGetOptions, (typeof BACKLOG_GET_INPUT_KEYS)[number]>;
const _GET_KEY_COVERAGE: UncoveredGetKey extends never ? true : never = true;
void _GET_KEY_COVERAGE;

/**
 * §2.1a / AC-23's trap, applied to `backlog_get`: the most common agent error
 * is reaching for `backlog_query`'s grammar on the wrong tool. Those keys get
 * a targeted `invalid_argument` naming them and pointing at `backlog_query`,
 * rather than the generic "unknown key" a typo gets.
 */
const QUERY_ONLY_KEYS: readonly string[] = [
  'filter',
  'view',
  'sort',
  'direction',
  'groupBy',
  'group_by',
  'limit',
  'offset',
  'humanIds',
  'overlapBy',
  'text',
  'format',
];

/**
 * §2.4 — fields that exist in the ONE projection vocabulary but have no
 * meaning for a SINGLE-item read: `items` is `view:"grouped"`'s per-bucket
 * list and `_score` is the matcher score a ranked query assigns. Accepting
 * either and returning nothing would be precisely the silent omission AC-19
 * outlaws, so they are rejected by name.
 */
const QUERY_ONLY_FIELDS: readonly IBacklogField[] = ['items', '_score'];

/** Pseudo-fields resolved by this module (everything else is a plain item field). */
const PSEUDO_FIELD_SET: ReadonlySet<string> = new Set<string>([
  'body',
  'audit_trail',
  'blockers',
  'citations',
  'closedAt',
  'notes',
  'rollup',
  'related',
  '_vector',
]);

// ----------------------------------------------------------------------------
// The operation.
// ----------------------------------------------------------------------------

/**
 * INTERFACE_v2 §1 — `backlog_get({ humanId, repo?, fields? })`.
 *
 * Collapses v1's `get-item` + `audit-trail` + `blockers` (3 → 1): one entry
 * point for "what is this item", with depth chosen by `fields` instead of by
 * knowing which of three commands to call before you have looked.
 *
 * `fields` is ADDITIVE to the default card, per §1's outcome sentence
 * ("found → card (+ requested fields)") and forced by `IBacklogCard`, whose
 * `humanId`/`kind`/`title`/`status` are non-optional — the identity spine is
 * always present, and everything named in `fields` is added on top.
 *
 * `repo` is optional here even though §7.5 keeps it explicit on the wire:
 * omitting it resolves the humanId across every repo and fails `ambiguous`
 * (never picks one) if more than one repo carries it — a read never silently
 * narrows (§7.1).
 *
 * @param store an open backlog graph store
 * @param input `{ humanId, repo?, fields?, includeDeleted? }` — any other key is a typed error
 * @returns the §7.1 outcome envelope: `ok:true` + the card, or `ok:false` with
 *   `item_not_found` / `ambiguous` / `soft_deleted` / `validation` /
 *   `invalid_argument` / `rag_not_configured` / `internal`
 */
export async function backlogGet(store: GraphBacklogStore, input: IBacklogGetOptions): Promise<IOutcomeEnvelope<IBacklogCard>> {
  try {
    assertKnownGetKeys(input as unknown as Record<string, unknown>);
    assertGetHumanId(input.humanId);
    assertKnownFields(input.fields);
    assertGetApplicableFields(input.fields);

    const target = await resolveGetTarget(store, input.humanId, input.repo);
    const warnings: string[] = [];

    if (target.redirectedFrom !== undefined) {
      // FEAT-BACKLOG-006 — the redirect is never silent: a caller that typed
      // (or copy-pasted, from an old citation) a retired id gets the current
      // item back, but also learns its lookup didn't match what it asked for.
      warnings.push(
        `${target.redirectedFrom.repo}::${target.redirectedFrom.humanId} was renamed — redirected to ${target.item.repo}::${target.item.humanId}.`
      );
    }

    if (target.deletedAt !== undefined) {
      if (input.includeDeleted !== true) {
        // §1 — the `soft_deleted` outcome. The message names the remedy so an
        // agent does not have to guess at a flag it cannot see.
        return errorEnvelope(
          'soft_deleted',
          `backlog item ${target.item.repo}::${target.item.humanId} is soft-deleted (at ${target.deletedAt}) — ` +
            `pass includeDeleted:true to read it (and its audit history) anyway.`,
          { humanId: target.item.humanId, repo: target.item.repo, deletedAt: target.deletedAt }
        );
      }
      warnings.push(
        `${target.item.repo}::${target.item.humanId} is SOFT-DELETED (at ${target.deletedAt}) — this is a tombstone, not a live item.`
      );
    }

    const card = await buildCard(store, target, resolveFields(input.fields));
    return warnings.length > 0 ? okEnvelope(card, { warnings }) : okEnvelope(card);
  } catch (err) {
    // `AmbiguousLookupError` is local to this op (see its doc comment for why
    // the contract's `AmbiguousHumanIdError` message would be factually wrong
    // here), so `toOutcomeError` cannot know it — mapped explicitly rather
    // than left to fall through to `internal`, which would be a lie.
    if (err instanceof AmbiguousLookupError) {
      return errorEnvelope('ambiguous', err.message, { nodeIds: err.nodeIds, repos: err.repos });
    }
    // Everything else goes through `toOutcomeError` — the single place the
    // `item_not_found` / `internal` distinction AC-6 demands is made. Never
    // re-derived here.
    return { ok: false, error: toOutcomeError(err) };
  }
}

// ----------------------------------------------------------------------------
// Input validation (§7 — never accept-and-ignore).
// ----------------------------------------------------------------------------

/** @throws {InvalidArgumentError} for `backlog_query`-only keys; {@link BacklogValidationError} for anything else unknown */
function assertKnownGetKeys(input: Record<string, unknown>): void {
  const keys = Object.keys(input ?? {});
  const known = new Set<string>(BACKLOG_GET_INPUT_KEYS);
  const unknown = keys.filter((k) => !known.has(k));
  if (unknown.length === 0) return;

  const misdirected = unknown.filter((k) => QUERY_ONLY_KEYS.includes(k));
  if (misdirected.length > 0) {
    throw new InvalidArgumentError(
      misdirected.join(','),
      `backlog_get: ${misdirected.map((k) => `"${k}"`).join(', ')} ${misdirected.length === 1 ? 'is a' : 'are'} ` +
        `backlog_query parameter${misdirected.length === 1 ? '' : 's'}, not a backlog_get one — backlog_get addresses ONE item by humanId. ` +
        `Use backlog_query for filtered/ranked reads.`
    );
  }
  throw new BacklogValidationError(
    `backlog_get: unknown parameter(s) ${unknown.map((k) => `"${k}"`).join(', ')} — accepted: ${BACKLOG_GET_INPUT_KEYS.join(', ')}`,
    unknown
  );
}

/** @throws {InvalidArgumentError} when `humanId` is absent or blank — an unaddressed get is not a get */
function assertGetHumanId(humanId: unknown): asserts humanId is string {
  if (typeof humanId !== 'string' || humanId.trim().length === 0) {
    throw new InvalidArgumentError(
      'humanId',
      `backlog_get requires a non-empty "humanId" — received humanId=${JSON.stringify(humanId)}.`
    );
  }
}

/**
 * AC-19/AC-20 — a *known* field that cannot mean anything for a single-item
 * read must still fail loudly. `_vector` is different: it is a genuine
 * per-item property that simply has no backend in this build, so it gets
 * AC-12's `rag_not_configured` rather than a validation error.
 *
 * @throws {BacklogValidationError} for `items`/`_score`
 * @throws {RagNotConfiguredError} for `_vector`
 */
function assertGetApplicableFields(fields: readonly IBacklogField[] | undefined): void {
  if (!fields) return;
  const inapplicable = fields.filter((f) => QUERY_ONLY_FIELDS.includes(f));
  if (inapplicable.length > 0) {
    throw new BacklogValidationError(
      `backlog_get: field(s) ${inapplicable.map((f) => `"${f}"`).join(', ')} have no meaning for a single-item read ` +
        `("items" is view:"grouped"'s per-bucket list; "_score" is a ranked-query matcher score) — ` +
        `they would be silently absent from the response, so they are rejected instead.`,
      [...inapplicable]
    );
  }
  if (fields.includes('_vector')) throw new RagNotConfiguredError('_vector');
}

/** §1 — the projection is the default card PLUS whatever the caller named. */
function resolveFields(requested: readonly IBacklogField[] | undefined): Set<IBacklogField> {
  return new Set<IBacklogField>([...DEFAULT_GET_FIELDS, ...(requested ?? [])]);
}

// ----------------------------------------------------------------------------
// Resolution — including the one new primitive (soft-deleted reachability).
// ----------------------------------------------------------------------------

interface IGetTarget {
  node: NodeRecord;
  item: BacklogItem;
  /** ISO invalidation timestamp when this node is a soft-delete tombstone; absent for live items. */
  deletedAt?: string;
  /**
   * FEAT-BACKLOG-006 — set when the lookup resolved via `findByRenamedFromId`
   * rather than the requested `(repo, humanId)` directly: the identity the
   * caller actually asked for, which no longer names this node. `backlogGet`
   * surfaces this as a `warnings` entry so a redirect is never silent.
   */
  redirectedFrom?: { repo: string; humanId: string };
}

/**
 * BUG-BACKLOG-AUDIT-TRAIL-SOFTDELETE-001 — the entire fix, per INTERFACE_v2 §1.
 *
 * `getNode(id)` already reads `t_invalid` rows unconditionally
 * (`@adhd/sox-graph-store` dist/index.js:1329-1332 — a bare
 * `SELECT * FROM node WHERE rowid = ?`), and `auditTrail` already routes
 * through it. The ONLY thing that made a soft-deleted item unreachable is
 * that every `(repo, humanId) → nodeId` resolution goes through
 * `queryNodes`, whose `buildNodeFilterClause(filter, liveOnly = true, …)`
 * hard-codes `t_invalid IS NULL` (dist/index.js:645-651, 1333-1334) and
 * exposes no opt-out on `NodeFilter`. So this resolves the id with one raw
 * `json_extract` predicate — the same expression the store's own metadata
 * filter emits (dist/index.js:742-744) — and then hands off to the existing
 * `getNode`, rather than building a parallel non-live query path.
 *
 * Deliberately DELETED-ONLY: live resolution keeps going through
 * `findItemNode`, so its `AmbiguousHumanIdError` collision guard
 * (BUG-BACKLOG-HUMANID-COLLISION-001) is never bypassed.
 */
async function findSoftDeletedItemNodes(store: GraphBacklogStore, humanId: string, repo?: string): Promise<NodeRecord[]> {
  const sql =
    `SELECT rowid AS rowid FROM node WHERE json_extract(meta, '$.humanId') = ? AND t_invalid IS NOT NULL` +
    (repo === undefined ? '' : ' AND namespace = ?');
  const args: unknown[] = repo === undefined ? [humanId] : [humanId, repo];
  const { rows } = await store.adapter.executeAll<{ rowid: number }>(sql, args);

  const found: NodeRecord[] = [];
  for (const row of rows) {
    const node = await store.graph.getNode(row.rowid);
    // The raw predicate cannot express "is a backlog item" (tags are a JSON
    // column) — re-apply the tag/supersession test `isLiveBacklogItemNode`
    // applies, minus its liveness half, which is the whole point here.
    if (node && node.tags.includes(BACKLOG_ITEM_TAG) && !node.isSuperseded) found.push(node);
  }
  return found;
}

function nodeRepoOf(node: NodeRecord): string {
  return (node.metadata as Partial<BacklogNodeMeta> | undefined)?.repo ?? node.namespace ?? '';
}

/**
 * Live first (via the existing `findItemNode`/`findHumanIdInAnyRepo`), then
 * the soft-deleted tombstone. Ambiguity is ALWAYS an error, never a silent
 * pick (§7.1).
 *
 * @throws {BacklogItemNotFoundError} nothing carries this humanId, live or deleted
 * @throws {AmbiguousLookupError} more than one repo (or more than one tombstone) carries it
 */
async function resolveGetTarget(store: GraphBacklogStore, humanId: string, repo?: string): Promise<IGetTarget> {
  if (repo !== undefined) {
    // `findItemNode` throws AmbiguousHumanIdError (-> `ambiguous`) when >1
    // LIVE node shares the key — that guard is inherited, not re-implemented.
    const live = await findItemNode(store, repo, humanId);
    if (live) return { node: live, item: toBacklogItem(live) };

    const deleted = await findSoftDeletedItemNodes(store, humanId, repo);
    if (deleted.length > 1) throw ambiguousLookupError(humanId, deleted);
    const tombstone = deleted[0];
    if (tombstone) return { node: tombstone, item: toBacklogItem(tombstone), deletedAt: tombstone.tInvalid };

    // FEAT-BACKLOG-006 — before giving up, check whether `(repo, humanId)`
    // is a RETIRED identity: this repo's own citations, or a caller's stale
    // notes, may still name the id the item carried before a rename
    // (`structure.ts:renameHumanIdNode`) or a rename-on-migration
    // (`repo-migration.ts:migrateRepoItemNode`). Live-only — a renamed id
    // pointing at a now soft-deleted node is not a case worth chasing.
    const renamed = await findByRenamedFromId(store, repo, humanId);
    if (renamed.length > 1) throw ambiguousLookupError(humanId, renamed);
    const redirect = renamed[0];
    if (redirect) return { node: redirect, item: toBacklogItem(redirect), redirectedFrom: { repo, humanId } };

    // Carries the "did you mean repo X?" hint (BUG-BACKLOG-REPO-LOOKUP-UX-001)
    // and maps to `item_not_found` via `toOutcomeError`.
    throw await buildNotFoundError(store, repo, humanId);
  }

  const liveAnywhere = await findHumanIdInAnyRepo(store, humanId);
  if (liveAnywhere.length > 1) throw ambiguousLookupError(humanId, liveAnywhere);
  const live = liveAnywhere[0];
  if (live) return { node: live, item: toBacklogItem(live) };

  const deleted = await findSoftDeletedItemNodes(store, humanId);
  if (deleted.length > 1) throw ambiguousLookupError(humanId, deleted);
  const tombstone = deleted[0];
  if (tombstone) return { node: tombstone, item: toBacklogItem(tombstone), deletedAt: tombstone.tInvalid };

  // FEAT-BACKLOG-006 — same redirect, repo-unscoped: an old id can be found
  // even when the caller didn't (or couldn't) name the repo it used to live
  // under.
  const renamedAnywhere = await findByRenamedFromId(store, undefined, humanId);
  if (renamedAnywhere.length > 1) throw ambiguousLookupError(humanId, renamedAnywhere);
  const redirectAnywhere = renamedAnywhere[0];
  if (redirectAnywhere) {
    return {
      node: redirectAnywhere,
      item: toBacklogItem(redirectAnywhere),
      redirectedFrom: { repo: '(any repo)', humanId },
    };
  }

  // The contract's own error type, so `toOutcomeError` maps it to
  // `item_not_found` (AC-6) with no local special-casing. The repo slot reads
  // "(any repo)" because the caller deliberately did not scope the lookup.
  throw new BacklogItemNotFoundError('(any repo)', humanId);
}

/**
 * §7.1 — "a read never silently narrows; ambiguity is either a warning or the
 * `ambiguous` error, never quiet." `AmbiguousHumanIdError`'s message asserts
 * the matches share a `(repo, humanId)` KEY, which is false for the
 * repo-omitted case (they share only the humanId), so this carries an honest
 * message while mapping to the same `ambiguous` code.
 */
class AmbiguousLookupError extends Error {
  constructor(
    public readonly humanId: string,
    public readonly nodeIds: number[],
    public readonly repos: string[]
  ) {
    super(
      `backlog_get: ambiguous lookup — "${humanId}" exists in ${repos.length} repos (${repos.map((r) => `"${r}"`).join(', ')}; ` +
        `nodeIds: ${nodeIds.join(', ')}). Refusing to silently pick one — pass an explicit repo.`
    );
    this.name = 'AmbiguousLookupError';
  }
}

function ambiguousLookupError(humanId: string, nodes: readonly NodeRecord[]): AmbiguousLookupError {
  return new AmbiguousLookupError(
    humanId,
    nodes.map((n) => n.id),
    [...new Set(nodes.map(nodeRepoOf))]
  );
}

// ----------------------------------------------------------------------------
// Projection.
// ----------------------------------------------------------------------------

/** Reads a v2-only dimensional/demand field straight off node metadata (FEAT-012/FEAT-013/§5a.3 write these; absent until those epics have touched the item). */
function v2Meta(node: NodeRecord): Partial<{ author: string; reporter: string; dupeHits: number; files: string[] }> {
  return (node.metadata ?? {}) as Partial<{ author: string; reporter: string; dupeHits: number; files: string[] }>;
}

async function buildCard(store: GraphBacklogStore, target: IGetTarget, fields: Set<IBacklogField>): Promise<IBacklogCard> {
  const { item, node } = target;
  // The identity spine — non-optional on `IBacklogCard`, so it is present on
  // every response regardless of projection (§1: "card (+ requested fields)").
  const card: IBacklogCard = { humanId: item.humanId, kind: item.kind, title: item.title, status: item.status };
  const meta = v2Meta(node);

  const setIfDefined = <K extends keyof IBacklogCard>(key: K, value: IBacklogCard[K] | undefined): void => {
    if (value !== undefined) card[key] = value;
  };

  for (const field of fields) {
    if (PSEUDO_FIELD_SET.has(field)) continue; // handled below (each costs real work)
    switch (field) {
      case 'humanId':
      case 'kind':
      case 'title':
      case 'status':
        break; // already on the spine
      case 'priority':
        setIfDefined('priority', item.priority);
        break;
      case 'repo':
        setIfDefined('repo', item.repo);
        break;
      case 'family':
        setIfDefined('family', item.family);
        break;
      case 'projectPath':
        setIfDefined('projectPath', item.projectPath);
        break;
      case 'plan':
        setIfDefined('plan', item.plan);
        break;
      case 'assignee':
        setIfDefined('assignee', item.assignee);
        break;
      case 'claimedBy':
        setIfDefined('claimedBy', item.claimedBy);
        break;
      case 'claimedAt':
        setIfDefined('claimedAt', item.claimedAt);
        break;
      case 'tags':
        setIfDefined('tags', item.tags);
        break;
      case 'createdAt':
        setIfDefined('createdAt', item.createdAt);
        break;
      case 'updatedAt':
        setIfDefined('updatedAt', item.updatedAt);
        break;
      case 'importedFrom':
        setIfDefined('importedFrom', item.importedFrom);
        break;
      // FEAT-012/FEAT-013/§5a.3 — persisted by the EPIC-A/dimensional writers.
      // Absent (not zero, not "") until an item actually carries one, exactly
      // like `priority` on an unprioritised item.
      case 'author':
        setIfDefined('author', meta.author);
        break;
      case 'reporter':
        setIfDefined('reporter', meta.reporter);
        break;
      case 'dupeHits':
        setIfDefined('dupeHits', meta.dupeHits);
        break;
      case 'files':
        setIfDefined('files', meta.files);
        break;
      case 'citationCount':
        // FEAT-009 — in-memory derivation (item.citations), zero extra reads.
        card.citationCount = item.citations.length;
        break;
      default:
        // Unreachable: `assertKnownFields` + `assertGetApplicableFields`
        // already rejected everything outside the vocabulary, and every
        // pseudo-field is skipped above. Kept so a NEW entry in
        // `BACKLOG_FIELDS` fails loudly here instead of vanishing.
        throw new BacklogValidationError(`backlog_get: field "${field}" is in the vocabulary but has no projection rule`, [field]);
    }
  }

  if (fields.has('body')) card.body = item.body;
  if (fields.has('citations')) card.citations = item.citations;
  if (fields.has('notes')) card.notes = item.notes;
  if (fields.has('audit_trail')) card.audit_trail = await auditHistory(store, target);
  // FEAT-BACKLOG-010 — the first terminal transition's timestamp, read off
  // the persisted audit log.
  if (fields.has('closedAt')) card.closedAt = await firstTerminalTransitionAt(store, node.id);
  if (fields.has('blockers')) card.blockers = await blockerHumanIds(store, target);
  if (fields.has('rollup')) card.rollup = await computeRollup(store, target);
  if (fields.has('related')) card.related = await relatedHumanIds(store, target);

  // DEBT-BACKLOG-GET-001 — every pseudo-field the caller COULD have named
  // but didn't, so "body omitted by projection" is distinguishable from
  // "body actually is empty" without a second round trip. Absent (never an
  // empty array) once every pseudo-field has been requested.
  const omittedFields = [...PSEUDO_FIELD_SET].filter((f) => !fields.has(f as IBacklogField)) as IBacklogField[];
  if (omittedFields.length > 0) card.omittedFields = omittedFields;

  return card;
}

// ----------------------------------------------------------------------------
// Pseudo-field derivations. Live items delegate to the existing store ops; the
// soft-deleted tombstone path exists ONLY because those ops resolve
// live-only — see the DEBT note on each.
// ----------------------------------------------------------------------------

/**
 * `fields: ["audit_trail"]` — §1's history depth.
 *
 * Live items delegate wholesale to `store/query.ts`'s `auditTrail`, so there
 * is one assembler (created entry + citations + notes + the persisted
 * `queryAuditEvents` log + supersession chain).
 *
 * A tombstone cannot use it: `auditTrail` resolves via `findItemNode`, which
 * is live-only, so it would throw not-found for exactly the item
 * BUG-BACKLOG-AUDIT-TRAIL-SOFTDELETE-001 says must stay reachable. The
 * fallback below re-assembles from the SAME two sources `auditTrail` uses
 * (durable metadata + `queryAuditEvents`) against the already-resolved node.
 * Folding the resolution into `auditTrail` itself would delete this branch —
 * filed as debt rather than reaching into a file this change does not own.
 */
async function auditHistory(store: GraphBacklogStore, target: IGetTarget): Promise<AuditTrailEntry[]> {
  if (target.deletedAt === undefined) {
    return (await auditTrailOp(store, target.item.repo, target.item.humanId)).history;
  }
  const { item, node } = target;
  const history: AuditTrailEntry[] = [{ at: item.createdAt, kind: 'created', detail: { title: item.title, repo: item.repo } }];
  for (const citation of item.citations) history.push({ at: item.updatedAt, kind: 'citation', detail: { ...citation } });
  for (const note of item.notes) history.push({ at: note.at, kind: 'note', detail: { by: note.by, text: note.text } });
  history.push(...(await queryAuditEvents(store, node.id)));
  history.sort((a, b) => a.at.localeCompare(b.at));
  return history;
}

/**
 * FEAT-BACKLOG-010 — the ISO timestamp of the item's FIRST transition into a
 * terminal status, reconstructed from the persisted audit log (the
 * bi-temporal store already has the data — this is a read, never a guess).
 * `undefined` for an item that has never reached a terminal status. Mirrors
 * `v2/query.ts`'s same-named helper so `backlog_get` and `backlog_query`
 * agree on one definition of "closed".
 */
async function firstTerminalTransitionAt(store: GraphBacklogStore, nodeId: number): Promise<string | undefined> {
  const events = await queryAuditEvents(store, nodeId);
  const first = events.find((e) => {
    if (e.kind !== 'transition') return false;
    const to = (e.detail as { to?: BacklogStatus }).to;
    return to !== undefined && isTerminalStatus(to);
  });
  return first?.at;
}/**
 * `fields: ["blockers"]` — the non-terminal `DEPENDS_ON` targets, as humanIds.
 * Absorbs v1's `blockers` command (§1's 3 → 1).
 *
 * Same live/tombstone split as `auditHistory`, and for the same reason:
 * `store/query.ts`'s `blockers` resolves live-only and would return `[]` for a
 * tombstone — a silently WRONG empty answer, which is worse than the extra
 * branch.
 */
async function blockerHumanIds(store: GraphBacklogStore, target: IGetTarget): Promise<string[]> {
  if (target.deletedAt === undefined) {
    return (await blockersOp(store, target.item.repo, target.item.humanId)).map((b) => b.humanId);
  }
  const edges = await store.graph.getEdges({ src: target.node.id, rel: 'DEPENDS_ON' });
  const out: string[] = [];
  for (const edge of edges) {
    const dep = await store.graph.getNode(edge.dst);
    if (!dep || dep.tInvalid) continue;
    const depItem = toBacklogItem(dep);
    if (!isTerminalStatus(depItem.status)) out.push(depItem.humanId);
  }
  return out;
}

/**
 * `fields: ["related"]` — BUG-025 read side: the humanIds of every OTHER
 * live item linked to this one via a live `RELATES_TO` edge, in either
 * direction. `linkRelated` writes the edge in ONE direction only, so
 * `store/structure.ts`'s `listRelatedNode` (the same primitive `relate`'s
 * own read affordance would use) already checks both — this just delegates.
 *
 * Same live/tombstone split as `auditHistory`/`blockerHumanIds`:
 * `listRelatedNode` resolves via `requireItemNode`, which is live-only.
 */
async function relatedHumanIds(store: GraphBacklogStore, target: IGetTarget): Promise<string[]> {
  if (target.deletedAt === undefined) {
    return listRelatedNode(store, target.item.repo, target.item.humanId);
  }
  const [outgoing, incoming] = await Promise.all([
    store.graph.getEdges({ src: target.node.id, rel: 'RELATES_TO' }),
    store.graph.getEdges({ dst: target.node.id, rel: 'RELATES_TO' }),
  ]);
  const otherNodeIds = new Set<number>();
  for (const edge of outgoing) otherNodeIds.add(edge.dst);
  for (const edge of incoming) otherNodeIds.add(edge.src);

  const related: string[] = [];
  for (const otherId of otherNodeIds) {
    const other = await store.graph.getNode(otherId);
    if (!other || other.tInvalid || !isLiveBacklogItemNode(other)) continue;
    const otherHumanId = toBacklogItem(other).humanId;
    if (otherHumanId) related.push(otherHumanId);
  }
  return related.sort();
}

/**
 * `fields: ["rollup"]` — INTERFACE_v2 §5a.1's TWO-AXIS derivation, computed on
 * read and never materialised (materialising is what recreates the drift the
 * ADR-0011 split-brain already cost us; closing a child must change the
 * parent's rollup with zero writes to the parent).
 *
 * Children are the `child PART_OF parent` edges `splitItemNode` writes
 * (`store/structure.ts:239`), so the traversal is by `dst`. `selfVerified` is
 * the §5a.2 evidence gate's read-side twin: does THIS item carry its own
 * closing evidence (terminal AND ≥1 citation)? The two axes are independent
 * on purpose — "children all closed, parent never transitioned" and "parent
 * closed, children still open" are different, and both are real.
 */
async function computeRollup(store: GraphBacklogStore, target: IGetTarget): Promise<IItemRollup> {
  const edges = await store.graph.getEdges({ dst: target.node.id, rel: 'PART_OF' });
  let childrenTotal = 0;
  let childrenClosed = 0;
  const childrenOpen: string[] = [];
  for (const edge of edges) {
    const child = await store.graph.getNode(edge.src);
    if (!child || child.tInvalid || !child.tags.includes(BACKLOG_ITEM_TAG) || child.isSuperseded) continue;
    const childItem = toBacklogItem(child);
    childrenTotal += 1;
    if (isTerminalStatus(childItem.status)) childrenClosed += 1;
    else childrenOpen.push(childItem.humanId);
  }
  return {
    childrenTotal,
    childrenClosed,
    childrenOpen,
    selfVerified: isTerminalStatus(target.item.status) && target.item.citations.length > 0,
  };
}
