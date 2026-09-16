/**
 * update.ts — `update` (SPEC.md §4, §6.3.3, §9 AC-14).
 *
 * `updateIssue(uid, patch)` per §4: **body change → `supersede`** (a fresh
 * `issue` node + a hand-composed `SUPERSEDES` edge, §4c — the only content
 * path; never `touch` a body, since `touch` cannot change `content`,
 * compile-time pinned on `IWriteNodeTxInput`); **everything else (`title`,
 * `assignee`) → `touch`**; **`kind`/`priority`/`author` → `touch` + their
 * respective `n:1` catalog edge rewrite** (hand-composed invalidate-old +
 * upsert-new, same `tx`, mirroring `move.ts`'s own `owns_component`
 * invalidate-then-write sequencing exactly). `status` is a compile-time
 * absent field (§6.3.3) and, for an untyped (CLI/HTTP/MCP JSON) caller that
 * sends one anyway, a runtime-rejected one (§9 AC-14) — this file and
 * `transition.ts` are deliberately one agent's slice for exactly this
 * reason: the DEBT-010 bundling bug this design fixes was two evidence
 * fields landing on the wrong verb, and only an agent that owns BOTH verbs
 * can guarantee the boundary is drawn (and stays drawn) in one place.
 *
 * **The supersede CAS.** `GraphBackend.supersede()` has no `AND
 * is_superseded = 0` guard on its own `UPDATE` (§4c's "`updateIssue`'s body
 * path: supersede needs a CAS the library doesn't give it") — two concurrent
 * body edits of the same `uid` would both pass and silently fork two
 * superseding nodes. This file runs the guarded sequence §4c's own
 * pseudocode specifies: `UPDATE node SET is_superseded = 1 WHERE rowid = ?
 * AND is_superseded = 0` (zero rows affected ⇒ `StaleSupersedeError`), then
 * a hand-composed node INSERT via {@link writeNodeTx} (`skipDedupe: true`,
 * per the foundation's own unconditional guarantee) and a hand-composed
 * `SUPERSEDES` (uppercase) edge INSERT — **never** through {@link
 * writeEdgeTx}, because `SUPERSEDES` is the content-mutation rel §3 states
 * is distinct from the catalog's lowercase `supersedes` issue relation and
 * is deliberately NOT a row in `EDGE_KIND_TABLE` (`resolveEdgeKindTx` would
 * throw `CatalogNotFoundError('edge_kind', 'SUPERSEDES')` if asked to
 * resolve it) — it is hand-composed exactly like `writeEdgeInternal`'s own
 * upsert shape, per §4c's own worked pseudocode.
 *
 * **Identity-chain carry-forward (a SPEC gap this file resolves, see the
 * package's own write-verb report for the full citation).** SPEC.md §6.3.2's
 * `create+supersedes` composition text describes `title`/`kind`/`priority`/
 * `author`/`assignee` being "applied via a following touch/edge-write
 * against the SAME new node" but is silent on what happens to the fields it
 * does NOT mention — `owns_component` (project/component placement) and
 * `has_status` — when a supersede mints a new node. `card.ts` (the read
 * layer) resolves every one of `has_kind`/`has_status`/`has_priority`/
 * `authored_by`/`owns_component` off the SPECIFIC node it is given, never by
 * walking a `SUPERSEDES` chain — so a new node with none of these edges
 * would be structurally unqueryable by project/component/kind/status the
 * instant it exists, and would violate the graph invariant `move.ts`/
 * `claim.ts` already assert elsewhere ("every live issue owns exactly one
 * live `owns_component` edge"). This file therefore re-points EVERY one of
 * these edges from the OLD node onto the NEW node on every supersede —
 * `owns_component`/`has_status` always carry forward verbatim (neither is
 * ever caller-overridable via `update`); `has_kind`/`has_priority`/
 * `authored_by` carry forward UNLESS this SAME call also gives an explicit
 * override, in which case the new edge points at the override target
 * instead. A non-supersede call (no `body`) only ever rewires `has_kind`/
 * `has_priority`/`authored_by`, and only for a field explicitly given —
 * `owns_component`/`has_status` are untouched, since the node itself never
 * changed identity.
 *
 * **An already-superseded `uid` is rejected (a second SPEC gap resolved the
 * same way).** SPEC.md does not say what happens when `update` (or
 * `transition`) is asked to mutate a `uid` a PRIOR `update` already
 * superseded — `getNodeByUidTx`'s own contract states it does not filter on
 * `is_superseded` at all ("callers that need this check it themselves").
 * Mutating a stale identity would silently diverge from whatever `uid` a
 * caller actually queries going forward, so this file treats it as the
 * identical shape of problem the CAS above already names —
 * `StaleSupersedeError(uid)`, "re-get and retry [against the current uid]"
 * — rather than inventing a new error class for what is structurally the
 * same "this uid's content already moved on under you" condition.
 *
 * **`project_policy.allowedKinds`/`requiredFields` (a third SPEC gap,
 * §2's own text).** §2 states `project_kind`/`project_field_requirement`
 * are "enforced by the SAME write-layer step... used by `createIssue`/
 * `update`/`transition`" — but `create-issue.ts`'s own `enforceAllowedSet`/
 * `enforceRequiredFields` are unexported (this package's established
 * per-file-duplication convention for small tx-scoped helpers, exactly like
 * `resolveIssueProjectTx` below), so this file carries its own copies rather
 * than silently omitting the check §2 names it for. §2 is silent on how
 * `requiredFields` composes with `update`'s PARTIAL-patch shape specifically
 * (its own worked example is `createIssue`'s always-fully-resolved input,
 * where every one of `component`/`kind`/`status`/`priority` is resolved on
 * every call, defaulted or not); resolving that gap the same way this file
 * resolves the two above — least-surprising, narrowest reading — this file
 * checks `requiredFields` only against the fields THIS call actually
 * touches (`kind`/`priority`/`author`/`assignee`, via `...input` spread with
 * the catalog-resolved friendly name substituted for `kind`/`priority`/
 * `author`, mirroring `create-issue.ts`'s own substitution shape exactly),
 * never a full re-validation of every field already committed at creation
 * time — a field this call does not touch keeps whatever value it already
 * had, which was already validated when IT was set.
 */

import type { AdapterTransaction } from '@adhd/sox-store-adapter';
import {
  type IResolvedProjectRow,
  mintOrResolveCatalogTx,
  nextPriorityRankTx,
  resolveEdgeKindTx,
  resolveProjectPolicy,
} from './catalog.js';
import { writeAudit } from './audit.js';
import {
  BacklogValidationError,
  InvalidArgumentError,
  IssueNotFoundError,
  StaleSupersedeError,
} from './errors.js';
import {
  type IWriteStoreHandle,
  executeWriteTransaction,
  getNodeByRowidTx,
  getNodeByUidTx,
  invalidateEdgeTx,
  nowISO,
  writeEdgeTx,
  writeNodeTx,
  resolveLiveIssueTx,
} from './tx.js';

export interface IUpdateIssueInput {
  /** The `issue` uid to update (§6.3, an "Issue verb"). */
  uid: string;
  /** The acting agent/human identity (§6.3's opening rule). REQUIRED. */
  by: string;
  /** → `touch` (metadata/name only). */
  title?: string;
  /** → `supersede` (§3/§4: "body change → supersede... never touch a body"). Mints a fresh `uid` — see {@link IUpdateIssueOutcome.uid}. */
  body?: string;
  /** catalog name or uid; → `touch` + `has_kind` edge rewrite (hand-composed invalidate-old + upsert-new, same tx, §4c). An unresolved NAME mints; a uid-shaped ref that does not resolve throws `CatalogNotFoundError('kind', ref)` (§6.1 — minting never applies to a uid). */
  kind?: string;
  /** catalog name or uid; → `touch` + `has_priority` edge rewrite. An unresolved NAME mints (rank = one past the current max); a uid-shaped ref that does not resolve throws `CatalogNotFoundError('priority', ref)`. */
  priority?: string;
  /** Plain metadata scalar (§6.2) — no edge. */
  assignee?: string;
  /** catalog agent name/uid; → `touch` + `authored_by` edge rewrite. An unresolved NAME mints; a uid-shaped ref that does not resolve throws `CatalogNotFoundError('agent', ref)`. */
  author?: string;
  /**
   * §4b: waits for the fire-and-forget on-write embedding observer before
   * returning when `true`. **Not implemented in this slice** — identical gap
   * to `create-issue.ts`'s own `awaitEmbed` doc comment: the embedding
   * observer only fires from inside `GraphBackend.writeNode`/`writeNodeInTx`,
   * a hook this hand-composed write layer structurally never calls. Accepted
   * for input-shape parity only; has no effect.
   */
  awaitEmbed?: boolean;
}

export type IUpdateIssueChangedField = 'title' | 'body' | 'kind' | 'priority' | 'assignee' | 'author';

export interface IUpdateIssueOutcome {
  /**
   * The resulting CURRENT issue's uid — the SAME `input.uid` when `body` was
   * not given (a pure touch/edge-rewrite on the existing node), or the FRESH
   * uid the supersede minted when it was (§6.3.2's `create+supersedes`
   * composition reads exactly this field as "the NEW node the supersede
   * primitive minted" — `IUpdateIssueOutcome` carries no separate
   * `supersededUid`, so `input.uid` is that composition's own record of what
   * was superseded).
   */
  uid: string;
  /**
   * Every key present in the input with a defined value, and ONLY those keys
   * (`assertNoSilentlyDiscardedPatchKeys`, carried forward per §6.3.3 as a
   * general correctness rule, not machinery scoped to any particular patch
   * shape). Empty is unreachable here — a zero-field patch throws
   * `InvalidArgumentError` before this outcome is ever constructed.
   */
  changed: IUpdateIssueChangedField[];
}

function assertNonBlank(field: string, value: string | undefined): asserts value is string {
  // `typeof value !== 'string'` (rather than `=== undefined`) also catches an
  // explicit `null` — reachable from an untyped CLI/HTTP/MCP JSON caller even
  // though `IUpdateIssueInput`'s TS type only declares `string | undefined` —
  // as a clean `InvalidArgumentError` instead of an unhandled
  // `TypeError: Cannot read properties of null (reading 'trim')`.
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidArgumentError(field, 'is required');
  }
}

interface IRawEdgeSrcRow {
  src: number;
}

interface IRawEdgeDstRow {
  dst: number;
}

interface IResolvedEdgeTarget {
  rowid: number;
  uid: string;
  kind: string;
  /** The catalog row's own `name` — carried alongside the edge-rewrite identity so `enforceRequiredFields` can validate against the RESOLVED friendly name, never a possibly-uid-shaped raw ref (mirrors `create-issue.ts`'s identical substitution). */
  name: string;
}

/**
 * Two-hop `owns_component`/`owns_project` walk — the SAME graph-invariant
 * pattern `transition.ts`'s `resolveIssueProjectTx` (and `claim.ts`'s/
 * `move.ts`'s equivalents) already define locally; this file carries its own
 * copy per this package's established per-file-duplication convention for
 * these small tx-scoped helpers (see `transition.ts`'s own doc comment on
 * its identical function).
 */
async function resolveIssueProjectTx(tx: AdapterTransaction, issueRowid: number): Promise<IResolvedProjectRow> {
  const componentEdge = await tx.executeGet<IRawEdgeSrcRow>(
    'SELECT src FROM edge WHERE dst = ? AND rel = ? AND t_invalid IS NULL',
    [issueRowid, 'owns_component'],
  );
  if (!componentEdge) {
    throw new Error(
      `update: issue rowid=${issueRowid} has no live "owns_component" edge — graph invariant violation ` +
        '(every live issue must own exactly one live parent component).',
    );
  }
  const projectEdge = await tx.executeGet<IRawEdgeSrcRow>(
    'SELECT src FROM edge WHERE dst = ? AND rel = ? AND t_invalid IS NULL',
    [componentEdge.src, 'owns_project'],
  );
  if (!projectEdge) {
    throw new Error(
      `update: component rowid=${componentEdge.src} has no live "owns_project" edge — graph invariant violation ` +
        '(every live component must be owned by exactly one live project).',
    );
  }
  const projectRow = await getNodeByRowidTx(tx, projectEdge.src);
  if (!projectRow || projectRow.kind !== 'project' || projectRow.tInvalid !== null) {
    throw new Error(
      `update: resolved project rowid=${projectEdge.src} is missing, invalidated, or not a "project" node — ` +
        'graph invariant violation.',
    );
  }
  return {
    rowid: projectRow.rowid,
    uid: projectRow.uid,
    name: projectRow.name ?? '',
    metadata: projectRow.metadata,
  };
}

/** `project_kind` (§2) — mirrors `create-issue.ts`'s own `enforceAllowedSet`, duplicated per this file's own established convention (see {@link resolveIssueProjectTx}'s doc comment). */
function enforceAllowedKind(allowed: readonly string[], value: string): void {
  if (allowed.length > 0 && !allowed.includes(value)) {
    throw new InvalidArgumentError('kind', `"${value}" is not in this project's allowed kind set`);
  }
}

/**
 * `project_field_requirement` (§2) — unlike `create-issue.ts`'s own
 * `enforceRequiredFields` (which checks EVERY declared required field,
 * because `createIssue`'s input always resolves every one of them, defaulted
 * or not), this variant checks a required field ONLY when `resolvedValues`
 * carries an OWN key for it (`field in resolvedValues`, not merely
 * `!== undefined`) — the field must be a KEY this specific `update` call
 * actually touches for its absence to matter; a field this call never
 * mentions is not this call's concern (see this file's own doc comment on
 * the `update`-vs-`createIssue` composition gap this resolves). A field the
 * call DOES touch but resolves to blank/`null` still throws, identically to
 * `create-issue.ts`'s own check.
 */
function enforceRequiredFields(required: readonly string[], resolvedValues: Record<string, unknown>): void {
  for (const field of required) {
    if (!(field in resolvedValues)) continue;
    const value = resolvedValues[field];
    if (value === undefined || value === null || (typeof value === 'string' && value.trim().length === 0)) {
      throw new InvalidArgumentError(field, 'is required by this project\'s field policy');
    }
  }
}

/**
 * Hand-composed mirror of `GraphBackend.touch(nodeId, meta)`
 * (`@adhd/sox-graph-store` dist/index.js:1482-1524), issued against `tx`
 * instead of the bare adapter (§4c — `touch` runs against `this.adapter` and
 * would autocommit outside this file's own `immediate` transaction). Only
 * the two columns this verb ever needs are conditionally included — `name`
 * and the WHOLESALE-replace `meta` JSON blob (never a merge, exactly as the
 * library's own `touch` behaves for the `metadata` field) — mirroring the
 * library's own "only include a column when its field is given" shape, not
 * a name+meta-coupled write.
 */
async function touchNodeTx(
  tx: AdapterTransaction,
  rowid: number,
  patch: { name?: string; metadata?: Record<string, unknown> },
  at: string,
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    params.push(patch.name);
  }
  if (patch.metadata !== undefined) {
    sets.push('meta = ?');
    params.push(JSON.stringify(patch.metadata));
  }
  // No early return on an empty `sets` here: `touchNodeTx` is also the ONLY
  // touch path for a kind/priority/author-ONLY patch (no title/assignee
  // given) — SPEC.md §6.3.3 states `kind`/`priority`/`author` are each
  // "touch + edge rewrite", so `t_updated` must still advance even when
  // `patch.name`/`patch.metadata` are both undefined (the edge-rewrite alone
  // carries the semantic change; this call is what stamps it as a touch).
  sets.push('t_updated = ?');
  params.push(at);
  const result = await tx.executeRun(`UPDATE node SET ${sets.join(', ')} WHERE rowid = ?`, [...params, rowid]);
  if (result.rowsAffected !== 1) {
    throw new Error(`update: touch UPDATE affected ${result.rowsAffected} rows for rowid=${rowid}, expected exactly 1.`);
  }
}

/**
 * Re-point an issue's `n:1` OUTGOING catalog edge (`has_status`/`has_kind`/
 * `has_priority`/`authored_by`) from `oldSrcRowid` onto `newSrcRowid`. A
 * no-op (returns `undefined`, nothing invalidated or written) when the node
 * kept its own identity (`newSrcRowid === oldSrcRowid`, i.e. no supersede
 * happened this call) AND no explicit `override` was given — the common
 * case for a field this call never touches. Otherwise resolves the CURRENT
 * live target (if any — `has_priority`/`has_kind`/`authored_by` may
 * genuinely have none, since minting one is optional at creation), prefers
 * `override` when given, invalidates the OLD edge (if one existed) and
 * writes the new one onto `newSrcRowid`, hand-composed exactly like
 * `move.ts`'s own invalidate-then-write sequencing (§4c).
 *
 * `params.required` (used ONLY for `has_status`): unlike `has_priority`/
 * `has_kind`/`authored_by` — each genuinely optional at creation
 * (`create-issue.ts`'s own doc comment: "+ has_priority when resolved") —
 * `has_status` is written UNCONDITIONALLY by `create-issue.ts` and its
 * absence is treated as a loud graph-invariant violation everywhere else
 * this edge is read (`transition.ts`'s own `currentStatusEdge` check: "every
 * live issue must carry exactly one live status"). A silent no-op here on a
 * supersede would leave the freshly-minted node with NO `has_status` edge at
 * all — structurally unqueryable by status, and a mismatch with the loud
 * `Error` convention `rewireOwnsComponentTx` already uses for its own
 * (never-optional) `owns_component` edge. So `required: true` throws instead
 * of returning silently when no existing edge and no override were found.
 */
async function rewireOutgoingEdgeTx(
  tx: AdapterTransaction,
  handle: IWriteStoreHandle,
  params: {
    rel: string;
    oldSrcRowid: number;
    newSrcRowid: number;
    newSrcUid: string;
    override?: IResolvedEdgeTarget;
    reason: string;
    at: string;
    required?: boolean;
  },
): Promise<void> {
  const identityChanged = params.newSrcRowid !== params.oldSrcRowid;
  if (!identityChanged && !params.override) return;

  const existing = await tx.executeGet<IRawEdgeDstRow>(
    'SELECT dst FROM edge WHERE src = ? AND rel = ? AND t_invalid IS NULL',
    [params.oldSrcRowid, params.rel],
  );

  let target: IResolvedEdgeTarget | undefined = params.override;
  if (!target && existing) {
    const row = await getNodeByRowidTx(tx, existing.dst);
    if (row && row.tInvalid === null) target = { rowid: row.rowid, uid: row.uid, kind: row.kind, name: row.name ?? '' };
  }
  if (!target) {
    if (params.required) {
      throw new Error(
        `update: issue rowid=${params.oldSrcRowid} has no live "${params.rel}" edge — graph invariant violation ` +
          `(every live issue must carry exactly one live ${params.rel}).`,
      );
    }
    return; // no existing edge and no override — e.g. priority never set, still not being set
  }

  if (existing) {
    await invalidateEdgeTx(tx, { srcRowid: params.oldSrcRowid, dstRowid: existing.dst, rel: params.rel, reason: params.reason, at: params.at });
  }
  const rule = await resolveEdgeKindTx(tx, params.rel);
  await writeEdgeTx(tx, {
    at: params.at,
    srcRowid: params.newSrcRowid, srcUid: params.newSrcUid, srcKind: 'issue',
    dstRowid: target.rowid, dstUid: target.uid, dstKind: target.kind,
    rel: params.rel, rule, typePolicy: handle.typePolicy,
  });
}

/**
 * Re-point the INCOMING `owns_component` edge (`component → issue`, §3) from
 * the OLD issue rowid onto the NEW one — a no-op when no supersede happened
 * this call (the issue never changed identity, so its placement edge is
 * already correct). `owns_component` is never caller-overridable via
 * `update` (project/component reparenting is `move`'s job alone, §6.3.6), so
 * this always carries forward the SAME component, never a different one.
 * Throws a plain `Error` (never a `BacklogWriteError` subclass) on a missing
 * edge — a genuine graph invariant violation, mirroring `move.ts`'s/
 * `claim.ts`'s identical convention for the identical shape of defect.
 */
async function rewireOwnsComponentTx(
  tx: AdapterTransaction,
  handle: IWriteStoreHandle,
  params: { oldIssueRowid: number; newIssueRowid: number; newIssueUid: string; at: string },
): Promise<void> {
  if (params.oldIssueRowid === params.newIssueRowid) return;

  const existing = await tx.executeGet<IRawEdgeSrcRow>(
    'SELECT src FROM edge WHERE dst = ? AND rel = ? AND t_invalid IS NULL',
    [params.oldIssueRowid, 'owns_component'],
  );
  if (!existing) {
    throw new Error(
      `update: issue rowid=${params.oldIssueRowid} has no live "owns_component" edge — graph invariant violation ` +
        '(every live issue must own exactly one live parent component).',
    );
  }
  const componentRow = await getNodeByRowidTx(tx, existing.src);
  if (!componentRow || componentRow.kind !== 'component' || componentRow.tInvalid !== null) {
    throw new Error(
      `update: resolved component rowid=${existing.src} is missing, invalidated, or not a "component" node — ` +
        'graph invariant violation.',
    );
  }

  await invalidateEdgeTx(tx, {
    srcRowid: existing.src, dstRowid: params.oldIssueRowid, rel: 'owns_component',
    reason: 'superseded — placement carried forward to the new node', at: params.at,
  });
  const rule = await resolveEdgeKindTx(tx, 'owns_component');
  await writeEdgeTx(tx, {
    at: params.at,
    srcRowid: existing.src, srcUid: componentRow.uid, srcKind: 'component',
    dstRowid: params.newIssueRowid, dstUid: params.newIssueUid, dstKind: 'issue',
    rel: 'owns_component', rule, typePolicy: handle.typePolicy,
  });
}

/**
 * `assertNoSilentlyDiscardedPatchKeys` (§6.3.3, "carried forward verbatim").
 * Every key of `IUpdateIssueInput`'s six patch fields present with a defined
 * value MUST appear in `changed`. This function builds `changed` from the
 * SAME six checks the caller runs before ever opening a transaction, so this
 * assertion is a guard against future drift (a field added to the patch
 * shape without a matching `changed` entry), never a real branch expected to
 * fire today.
 */
function computeChangedFields(input: IUpdateIssueInput): IUpdateIssueChangedField[] {
  const changed: IUpdateIssueChangedField[] = [];
  if (input.title !== undefined) changed.push('title');
  if (input.body !== undefined) changed.push('body');
  if (input.kind !== undefined) changed.push('kind');
  if (input.priority !== undefined) changed.push('priority');
  if (input.assignee !== undefined) changed.push('assignee');
  if (input.author !== undefined) changed.push('author');
  return changed;
}

function assertNoSilentlyDiscardedPatchKeys(input: IUpdateIssueInput, changed: readonly IUpdateIssueChangedField[]): void {
  const patchKeys: IUpdateIssueChangedField[] = ['title', 'body', 'kind', 'priority', 'assignee', 'author'];
  for (const key of patchKeys) {
    if (input[key] !== undefined && !changed.includes(key)) {
      throw new Error(`update: patch key "${key}" was given but not recorded in \`changed\` — assertNoSilentlyDiscardedPatchKeys invariant violated (SPEC.md §6.3.3).`);
    }
  }
}

/**
 * Update an issue (§4, §6.3.3). One `immediate` transaction.
 *
 * Errors: `InvalidArgumentError` (`uid`/`by` missing/blank; blank `title`/
 * `body` when given; no fields at all in the patch — a zero-field call is a
 * client error, not a silent no-op success, since the caller almost
 * certainly meant a different verb), `BacklogValidationError('status', ...)`
 * (an untyped caller sent a `status` field — §9 AC-14, this is the ONE
 * runtime rejection this whole file exists to guarantee, and it names
 * `transition` in its message), `IssueNotFoundError` (no live `issue` node
 * carries `uid`, including an already-superseded one — this file's own doc
 * comment on why that is a deliberate divergence, reusing
 * `StaleSupersedeError` rather than `IssueNotFoundError` for that specific
 * case since the identity itself still exists, just not at THIS uid
 * anymore), `CatalogNotFoundError('kind'|'priority'|'agent', ref)`
 * (uid-shaped ref only — an unresolved NAME instead auto-mints, §6.1),
 * `InvalidArgumentError('kind', ...)` (§2 `project_kind` — a resolved
 * `kind` name outside this project's non-empty `allowedKinds` set) / a
 * project-declared `requiredFields` entry left blank by this call (§2 —
 * see this file's own doc comment on the composition gap this resolves),
 * `StaleSupersedeError(uid)` (body-change path only — the supersede CAS
 * lost a race to a concurrent edit of the same `uid`, OR `uid` was already
 * superseded before this call ever started; the patch was not applied,
 * re-`get` and retry, never a silent partial apply),
 * `WriteContentionError`/`WriteIOError` (§4c — an exhausted driver-level
 * retry on the underlying `immediate` transaction).
 */
export async function update(handle: IWriteStoreHandle, input: IUpdateIssueInput): Promise<IUpdateIssueOutcome> {
  assertNonBlank('uid', input.uid);
  assertNonBlank('by', input.by);

  // §9 AC-14: `IUpdateIssueInput`'s TS type has no `status` field at all
  // (compile-time rejection for a typed caller), but an untyped CLI/HTTP/MCP
  // JSON caller can still send one — checked against the raw input object,
  // never silently applied as a status change.
  const rawInput = input as unknown as Record<string, unknown>;
  if (rawInput['status'] !== undefined) {
    throw new BacklogValidationError('status', 'status changes are not an `update` field — call `transition(uid, toStatus, ...)` instead');
  }

  if (input.title !== undefined) assertNonBlank('title', input.title);
  if (input.body !== undefined) assertNonBlank('body', input.body);

  const changed = computeChangedFields(input);
  if (changed.length === 0) {
    throw new InvalidArgumentError('patch', 'update requires at least one of title/body/kind/priority/assignee/author');
  }
  assertNoSilentlyDiscardedPatchKeys(input, changed);

  return executeWriteTransaction(handle, async (tx: AdapterTransaction) => {
    const now = nowISO();

    const issueRow = await resolveLiveIssueTx(tx, input.uid);

    // §2's project_kind/project_field_requirement — resolved fresh against
    // THIS transaction's own snapshot, mirroring `transition.ts`'s identical
    // discipline for its own project/policy resolve.
    const project = await resolveIssueProjectTx(tx, issueRow.rowid);
    const policy = resolveProjectPolicy(project);

    let kindOverride: IResolvedEdgeTarget | undefined;
    if (input.kind !== undefined) {
      const row = await mintOrResolveCatalogTx(tx, { catalogKind: 'kind', ref: input.kind, at: now });
      enforceAllowedKind(policy.allowedKinds, row.name);
      kindOverride = { rowid: row.rowid, uid: row.uid, kind: 'kind', name: row.name };
    }

    let priorityOverride: IResolvedEdgeTarget | undefined;
    if (input.priority !== undefined) {
      const row = await mintOrResolveCatalogTx(tx, {
        catalogKind: 'priority',
        ref: input.priority,
        at: now,
        mintMetadata: async (mintTx) => ({ rank: await nextPriorityRankTx(mintTx) }),
      });
      priorityOverride = { rowid: row.rowid, uid: row.uid, kind: 'priority', name: row.name };
    }

    let authorOverride: IResolvedEdgeTarget | undefined;
    if (input.author !== undefined) {
      const row = await mintOrResolveCatalogTx(tx, { catalogKind: 'agent', ref: input.author, at: now });
      authorOverride = { rowid: row.rowid, uid: row.uid, kind: 'agent', name: row.name };
    }

    // §2's `requiredFields` — checked against only the fields THIS call
    // touches (see this file's own doc comment on the composition gap this
    // resolves), with the catalog-resolved friendly name substituted for
    // `kind`/`priority`/`author` exactly as `create-issue.ts` substitutes
    // `component`/`kind`/`status`/`priority` over its own `...input` spread.
    // Only the KEYS this call actually gives get an entry — see
    // `enforceRequiredFields`'s own doc comment above: `...input` alone
    // already omits any field this call didn't set (an absent optional field
    // has no own key on a real caller-constructed object), and `kind`/
    // `priority`/`author` are added here ONLY when this call resolved a
    // fresh catalog row for them, never unconditionally (which would wrongly
    // make an untouched field's absence "this call's concern").
    const requiredFieldValues: Record<string, unknown> = { ...input };
    if (kindOverride) requiredFieldValues.kind = kindOverride.name;
    if (priorityOverride) requiredFieldValues.priority = priorityOverride.name;
    if (authorOverride) requiredFieldValues.author = authorOverride.name;
    enforceRequiredFields(policy.requiredFields, requiredFieldValues);

    let currentRowid = issueRow.rowid;
    let currentUid = issueRow.uid;
    let bodyChanged = false;

    if (input.body !== undefined) {
      const cas = await tx.executeRun('UPDATE node SET is_superseded = 1 WHERE rowid = ? AND is_superseded = 0', [issueRow.rowid]);
      if (cas.rowsAffected !== 1) {
        throw new StaleSupersedeError(input.uid);
      }

      const newTitle = input.title ?? issueRow.name ?? undefined;
      const newMetadata: Record<string, unknown> = { ...(issueRow.metadata ?? {}) };
      if (input.assignee !== undefined) newMetadata.assignee = input.assignee;

      const newNode = await writeNodeTx(tx, { kind: 'issue', name: newTitle, content: input.body, metadata: newMetadata, at: now });

      // The content-mutation `SUPERSEDES` (uppercase) edge — §3/§4c: hand-composed,
      // NEVER via `writeEdgeTx` (it is deliberately not a row in `EDGE_KIND_TABLE`,
      // §3's own note distinguishing it from the lowercase catalog `supersedes` rel).
      // Mirrors `writeEdgeInternal`'s own upsert shape exactly (§4c's worked example).
      await tx.executeRun(
        `INSERT INTO edge (src, dst, rel, weight, origin, meta, t_created, t_valid)
         VALUES (?, ?, 'SUPERSEDES', 1.0, 'user_asserted', NULL, ?, ?)
         ON CONFLICT(src, dst, rel) DO UPDATE SET
           meta = excluded.meta, weight = excluded.weight,
           t_invalid = NULL, t_valid = excluded.t_valid`,
        [newNode.rowid, issueRow.rowid, now, now],
      );

      // Stamp `t_updated` on the FRESHLY-MINTED node too. §3's "never touch a
      // body" is a statement about MECHANISM only (`touchNodeTx` has no
      // `content` param, so an in-place body edit is structurally impossible
      // — that's why body changes supersede instead of touch). It says
      // nothing about `t_updated`: the query layer's `updatedAt` filter
      // (SPEC.md §6.5 rule 4, `tUpdatedAfter/tUpdatedBefore`) exists to
      // surface "this issue was modified as of now", and a body edit is the
      // most substantive modification `update` can make. Without this call
      // `writeNodeTx`'s INSERT leaves the new row's `t_updated` NULL (it has
      // no such column in its own INSERT list — see `tx.ts`), so the new
      // node would be permanently invisible to `WHERE t_updated > X` even
      // though it was just written — the exact class of bug the sibling
      // touch-only branch below was fixed for.
      await touchNodeTx(tx, newNode.rowid, {}, now);

      currentRowid = newNode.rowid;
      currentUid = newNode.uid;
      bodyChanged = true;
    } else {
      // No body given — this branch is reached only when `changed.length > 0`
      // (enforced above), so at least one of title/kind/priority/assignee/
      // author is present. ALL five are "touch" per SPEC.md §6.3.3 (kind/
      // priority/author additionally get their edge rewired below), so
      // `touchNodeTx` always runs here — even when title/assignee are BOTH
      // absent (a kind/priority/author-only patch) — to advance `t_updated`.
      const newMetadata = input.assignee !== undefined ? { ...(issueRow.metadata ?? {}), assignee: input.assignee } : undefined;
      await touchNodeTx(tx, issueRow.rowid, { name: input.title, metadata: newMetadata }, now);
    }

    // Identity-chain edges — see this file's own doc comment ("Identity-chain
    // carry-forward") for why ALL of these are re-pointed on every supersede,
    // not just the ones this specific call happens to override.
    await rewireOwnsComponentTx(tx, handle, { oldIssueRowid: issueRow.rowid, newIssueRowid: currentRowid, newIssueUid: currentUid, at: now });

    await rewireOutgoingEdgeTx(tx, handle, {
      rel: 'has_status', oldSrcRowid: issueRow.rowid, newSrcRowid: currentRowid, newSrcUid: currentUid,
      reason: 'superseded — status carried forward to the new node (update never changes status)', at: now,
      required: true,
    });

    await rewireOutgoingEdgeTx(tx, handle, {
      rel: 'has_kind', oldSrcRowid: issueRow.rowid, newSrcRowid: currentRowid, newSrcUid: currentUid,
      override: kindOverride, reason: 'kind changed via update', at: now,
    });

    await rewireOutgoingEdgeTx(tx, handle, {
      rel: 'has_priority', oldSrcRowid: issueRow.rowid, newSrcRowid: currentRowid, newSrcUid: currentUid,
      override: priorityOverride, reason: 'priority changed via update', at: now,
    });

    await rewireOutgoingEdgeTx(tx, handle, {
      rel: 'authored_by', oldSrcRowid: issueRow.rowid, newSrcRowid: currentRowid, newSrcUid: currentUid,
      override: authorOverride, reason: 'author changed via update', at: now,
    });

    await writeAudit({
      tx,
      typePolicy: handle.typePolicy,
      subjectRowid: currentRowid,
      subjectUid: currentUid,
      subjectKind: 'issue',
      actor: input.by,
      action: 'updated',
      from: bodyChanged ? issueRow.uid : undefined,
      to: bodyChanged ? currentUid : undefined,
      note: `fields changed: ${changed.join(', ')}`,
      at: now,
    });

    return { uid: currentUid, changed };
  });
}
