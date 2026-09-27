/**
 * attestation.ts — `attest` / `recheck` (C3, DESIGN §2 Primitive 2).
 *
 * An attestation is a FIRST-CLASS, SEPARATE record keyed to an issue — never
 * written into the issue. The record carries `{subject, claim, anchor, check}`
 * plus an append-only `checks[]` history, and the subject's `uid` never
 * changes: `attest` writes a new `attestation` node and an `attests` edge,
 * and touches nothing else. `recheck` APPENDS a new check to the existing
 * record (never overwrites the history).
 *
 * **Anchors are content-addressed.** An anchor is `locator + digest`; the
 * locator grammar is closed (`path:`/`url:`/`query:`/`registry:`), and a
 * `path:` anchor is resolved by the cheap-first ladder in `anchor-check.ts`.
 * Every check records its own `method`, so `unverified` / `stale` / `unknown`
 * are explicit states with a `reason`, never a silently absent field.
 *
 * **Identity never churns.** `attests` is (like every other non-excluded rel)
 * swept onto the successor node by `update`'s body-edit `carryForwardResidualEdgesTx`,
 * so an attestation filed against `uid A` still resolves to the logical item
 * after a body edit mints `uid B`; `subject.id` is normalised forward through
 * the `SUPERSEDES` chain on read (`resolveLogicalIssueId`). No stable-uid
 * column is added (DESIGN §2 Primitive 1).
 *
 * Both verbs run in ONE `executeWriteTransaction` (ADR-0001/ADR-0012: the
 * store's own `BEGIN IMMEDIATE` is the atomicity primitive — no temp file, no
 * rename, no flock). The git-anchor check runs BEFORE the transaction opens
 * (it shells to `git`), so no write lock is ever held across it — mirroring
 * the citation-sha pre-resolve discipline in `create-issue.ts`/`transition.ts`.
 */

import type { AdapterTransaction } from '@adhd/sox-store-adapter';
import { resolveEdgeKindTx } from './catalog.js';
import { writeAudit } from './audit.js';
import { checkAnchor, parseAnchor } from './anchor-check.js';
import type {
  AttestationCheckState,
  IAttestCheck,
  IAttestationAnchor,
} from './anchor-check.js';
import {
  AnchorLocatorInvalidError,
  AttestationNotFoundError,
  CatalogNotFoundError,
  InvalidArgumentError,
  assertNotBareRoleLiteral,
} from './errors.js';
import { readRevision } from './revision.js';
import {
  type IWriteStoreHandle,
  executeWriteTransaction,
  nowISO,
  resolveLiveIssueTx,
  resolveUidPrefixTx,
  writeEdgeTx,
  writeNodeTx,
} from './tx.js';

export type { AttestationCheckState, IAttestCheck, IAttestationAnchor };

/**
 * An issue revision reference: the numeric monotonic counter, or — for C10's
 * `SPEC`-node annotations — an opaque `sha256:<hex>` token. Additive only: an
 * `issue` subject with a numeric revision is byte-for-byte unchanged.
 */
export type AttestRevisionRef = number | string;

/** The claim an attestation asserts. `kind` is open vocabulary (e.g. `'published-artifact'`, `'live-system'`); `body` is free text. */
export interface IAttestClaim {
  kind: string;
  body?: string;
}

export interface IAttestInput {
  /** The LOGICAL subject: chain-head `uid` + the content `revision` observed. */
  subject: { id: string; revision: AttestRevisionRef };
  claim: IAttestClaim;
  anchor: IAttestationAnchor;
  by: string;
}

export interface IAttestOutcome {
  attestationUid: string;
  subject: { id: string; revision: AttestRevisionRef };
  check: IAttestCheck;
}

export interface IRecheckInput {
  attestationUid: string;
  by: string;
}

export interface IRecheckOutcome {
  attestationUid: string;
  checks: IAttestCheck[];
}

/** A read-only executor — satisfied structurally by both `AdapterTransaction` and the bare `StoreAdapter`. */
interface IReadOneExecutor {
  executeGet<T = Record<string, unknown>>(
    sql: string,
    args?: unknown[]
  ): Promise<T | null>;
  executeAll<T = Record<string, unknown>>(
    sql: string,
    args?: unknown[]
  ): Promise<{ rows: T[] }>;
}

function assertNonBlank(
  field: string,
  value: string | undefined
): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidArgumentError(field, 'is required');
  }
}

function assertRevisionPresent(
  value: unknown
): asserts value is AttestRevisionRef {
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
    throw new InvalidArgumentError(
      'subject.revision',
      'must be a finite number or a non-empty string'
    );
  }
  if (typeof value === 'string' && value.trim().length > 0) return;
  throw new InvalidArgumentError(
    'subject.revision',
    'must be a finite number or a non-empty string'
  );
}

/**
 * Two-hop `owns_component`/`owns_project` walk to the subject issue's project
 * root — the SAME graph-invariant pattern `claim.ts`/`transition.ts`/`move.ts`
 * each carry locally (per this package's established per-file convention for
 * these small tx-scoped helpers). Returns the project's `metadata.path`, or
 * `undefined` for a path-less project (which `anchor-check.ts` reports as
 * `unknown`, never a silent success).
 */
async function resolveIssueProjectPath(
  exec: IReadOneExecutor,
  issueRowid: number
): Promise<string | undefined> {
  const componentEdge = await exec.executeGet<{ src: number }>(
    'SELECT src FROM edge WHERE dst = ? AND rel = ? AND t_invalid IS NULL',
    [issueRowid, 'owns_component']
  );
  if (!componentEdge) {
    throw new Error(
      `attestation: issue rowid=${issueRowid} has no live "owns_component" edge — graph invariant violation ` +
        '(every live issue must own exactly one live parent component).'
    );
  }
  const projectEdge = await exec.executeGet<{ src: number }>(
    'SELECT src FROM edge WHERE dst = ? AND rel = ? AND t_invalid IS NULL',
    [componentEdge.src, 'owns_project']
  );
  if (!projectEdge) {
    throw new Error(
      `attestation: component rowid=${componentEdge.src} has no live "owns_project" edge — graph invariant violation ` +
        '(every live component must be owned by exactly one live project).'
    );
  }
  const projectRow = await exec.executeGet<{
    kind: string;
    t_invalid: string | null;
    meta: string | null;
  }>('SELECT kind, t_invalid, meta FROM node WHERE rowid = ?', [
    projectEdge.src,
  ]);
  if (
    projectRow?.kind !== 'project' ||
    projectRow.t_invalid !== null
  ) {
    throw new Error(
      `attestation: resolved project rowid=${projectEdge.src} is missing, invalidated, or not a "project" node — ` +
        'graph invariant violation.'
    );
  }
  const meta = parseMeta(projectRow.meta);
  const path = meta?.['path'];
  return typeof path === 'string' && path.length > 0 ? path : undefined;
}

function parseMeta(meta: string | null): Record<string, unknown> | undefined {
  if (meta === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(meta);
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve an attestation uid (exact or unique prefix) to its live node, mapping a miss to {@link AttestationNotFoundError}. */
async function resolveAttestationNode(
  exec: IReadOneExecutor,
  uid: string
): Promise<{
  rowid: number;
  uid: string;
  metadata: Record<string, unknown> | undefined;
}> {
  try {
    const row = await resolveUidPrefixTx(exec, uid, {
      expectedKind: 'attestation',
    });
    return { rowid: row.rowid, uid: row.uid, metadata: row.metadata };
  } catch (err) {
    if (err instanceof CatalogNotFoundError) {
      throw new AttestationNotFoundError(uid);
    }
    throw err;
  }
}

/** The live source-issue rowid of an attestation, read from its `attests` edge (carry-forward keeps this on the current head). */
async function resolveAttestedIssueRowid(
  exec: IReadOneExecutor,
  attestationRowid: number
): Promise<number | undefined> {
  const edge = await exec.executeGet<{ src: number }>(
    'SELECT src FROM edge WHERE dst = ? AND rel = ? AND t_invalid IS NULL',
    [attestationRowid, 'attests']
  );
  return edge?.src;
}

function readAnchor(
  metadata: Record<string, unknown> | undefined
): IAttestationAnchor | undefined {
  const raw = metadata?.['anchor'];
  if (raw === null || typeof raw !== 'object') return undefined;
  const anchor = raw as Record<string, unknown>;
  const locator = anchor['locator'];
  const digest = anchor['digest'];
  if (typeof locator !== 'string' || typeof digest !== 'string') {
    return undefined;
  }
  return { locator, digest };
}

function readChecks(metadata: Record<string, unknown> | undefined): IAttestCheck[] {
  const raw = metadata?.['checks'];
  return Array.isArray(raw) ? (raw as IAttestCheck[]) : [];
}

function claimKind(metadata: Record<string, unknown> | undefined): string {
  const raw = metadata?.['claim'];
  if (raw !== null && typeof raw === 'object') {
    const kind = (raw as Record<string, unknown>)['kind'];
    if (typeof kind === 'string') return kind;
  }
  return 'attestation';
}

/**
 * Create an attestation — a new `attestation` node + `attests` edge against
 * the LIVE subject issue, plus one `audit` row. The subject node is NEVER
 * mutated (no `UPDATE node … WHERE rowid = subject`).
 *
 * Errors: `InvalidArgumentError` (blank `subject.id`/`claim.kind`/`by`, an
 * absent `subject.revision`), `AnchorLocatorInvalidError` (a locator outside
 * the closed grammar, or a blank `anchor.digest`),
 * `StaleSupersedeError`/`IssueNotFoundError` (the subject uid is superseded or
 * unknown), `WriteContentionError`/`WriteIOError` (an exhausted driver-level
 * retry on the underlying `immediate` transaction).
 */
export async function attest(
  handle: IWriteStoreHandle,
  input: IAttestInput
): Promise<IAttestOutcome> {
  assertNonBlank('subject.id', input.subject?.id);
  assertRevisionPresent(input.subject?.revision);
  assertNonBlank('claim.kind', input.claim?.kind);
  assertNonBlank('anchor.locator', input.anchor?.locator);
  assertNonBlank('by', input.by);
  assertNotBareRoleLiteral('by', input.by);

  // A `path:` anchor is only useful with a content digest — a bare
  // `path:line` is insufficient (the whole point of content-addressing).
  if (
    typeof input.anchor.digest !== 'string' ||
    input.anchor.digest.trim().length === 0
  ) {
    throw new AnchorLocatorInvalidError(
      input.anchor.locator,
      'a path anchor requires a content digest'
    );
  }
  // Validate the locator grammar up front — a caller mistake throws, it is
  // never silently degraded to an `unverified` check.
  parseAnchor(input.anchor.locator);

  // Pre-transaction: resolve the live subject and its project root, then run
  // the git ladder OUTSIDE any write lock (mirrors `create-issue.ts`'s
  // pre-transaction citation-sha discipline).
  const preSubject = await resolveLiveIssueTx(handle.adapter, input.subject.id);
  const root = await resolveIssueProjectPath(handle.adapter, preSubject.rowid);
  const now = nowISO();
  let check = checkAnchor(input.anchor, {
    ...(root !== undefined ? { root } : {}),
    sinceISO: now,
    full: false,
    now,
    by: input.by,
  });

  return executeWriteTransaction(handle, async (tx: AdapterTransaction) => {
    const subjectRow = await resolveLiveIssueTx(tx, input.subject.id);

    // Stale-revision guard: never silently `verified` when the caller observed
    // a different revision than the node carries. String revisions (C10 SPEC
    // tokens) are opaque and skip the numeric comparison.
    if (
      typeof input.subject.revision === 'number' &&
      readRevision(subjectRow.metadata) !== input.subject.revision
    ) {
      check = {
        ...check,
        state: 'unknown',
        reason: 'revision-drift',
      };
    }

    const metadata: Record<string, unknown> = {
      subject: {
        id: subjectRow.uid,
        revision: input.subject.revision,
      },
      claim: {
        kind: input.claim.kind,
        ...(input.claim.body !== undefined ? { body: input.claim.body } : {}),
        asserted_by: input.by,
        asserted_at: now,
      },
      anchor: {
        locator: input.anchor.locator,
        digest: input.anchor.digest,
      },
      check,
      checks: [check],
      lifecycle: { status: 'active', supersedes: null, part_of: null },
    };

    const attestation = await writeNodeTx(tx, {
      at: now,
      kind: 'attestation',
      name: input.claim.kind,
      content: input.claim.body ?? '',
      metadata,
    });

    const rule = await resolveEdgeKindTx(tx, 'attests');
    await writeEdgeTx(tx, {
      at: now,
      srcRowid: subjectRow.rowid,
      srcUid: subjectRow.uid,
      srcKind: 'issue',
      dstRowid: attestation.rowid,
      dstUid: attestation.uid,
      dstKind: 'attestation',
      rel: 'attests',
      rule,
      typePolicy: handle.typePolicy,
    });

    await writeAudit({
      tx,
      typePolicy: handle.typePolicy,
      subjectRowid: subjectRow.rowid,
      subjectUid: subjectRow.uid,
      subjectKind: 'issue',
      actor: input.by,
      action: 'attested',
      to: attestation.uid,
      note: input.claim.kind,
      at: now,
    });

    return {
      attestationUid: attestation.uid,
      subject: { id: subjectRow.uid, revision: input.subject.revision },
      check,
    };
  });
}

/**
 * Re-run the anchor ladder against an existing attestation and APPEND the new
 * check to `checks[]` (earlier entries copied forward verbatim — never a
 * truncated history). Replaces the echoed `check` with the newest entry and
 * writes one `audit` row on the attestation node.
 *
 * Errors: `InvalidArgumentError` (blank `by`), `AttestationNotFoundError` (no
 * live `attestation` node carries the uid).
 */
export async function recheck(
  handle: IWriteStoreHandle,
  input: IRecheckInput
): Promise<IRecheckOutcome> {
  assertNonBlank('attestationUid', input.attestationUid);
  assertNonBlank('by', input.by);
  assertNotBareRoleLiteral('by', input.by);

  const prior = await resolveAttestationNode(handle.adapter, input.attestationUid);
  const subjectIssueRowid = await resolveAttestedIssueRowid(
    handle.adapter,
    prior.rowid
  );
  const root =
    subjectIssueRowid === undefined
      ? undefined
      : await resolveIssueProjectPath(handle.adapter, subjectIssueRowid);
  const anchor = readAnchor(prior.metadata);
  const priorChecks = readChecks(prior.metadata);
  const sinceISO =
    priorChecks.length > 0
      ? priorChecks[priorChecks.length - 1]!.checked_at
      : readAssertedAt(prior.metadata);
  const now = nowISO();
  const newCheck: IAttestCheck = anchor
    ? checkAnchor(anchor, {
        ...(root !== undefined ? { root } : {}),
        ...(sinceISO !== undefined ? { sinceISO } : {}),
        full: true,
        now,
        by: input.by,
      })
    : {
        state: 'unknown',
        method: 'none',
        checked_at: now,
        checked_by: input.by,
        reason: 'attestation carries no readable anchor',
      };

  return executeWriteTransaction(handle, async (tx: AdapterTransaction) => {
    const row = await resolveAttestationNode(tx, input.attestationUid);
    const meta = row.metadata ?? {};
    const checks = [...readChecks(meta), newCheck];
    const newMeta = { ...meta, check: newCheck, checks };
    const result = await tx.executeRun(
      'UPDATE node SET meta = ?, t_updated = ? WHERE rowid = ?',
      [JSON.stringify(newMeta), now, row.rowid]
    );
    if (result.rowsAffected !== 1) {
      throw new Error(
        `recheck: touch UPDATE affected ${result.rowsAffected} rows for rowid=${row.rowid}, expected exactly 1.`
      );
    }

    await writeAudit({
      tx,
      typePolicy: handle.typePolicy,
      subjectRowid: row.rowid,
      subjectUid: row.uid,
      subjectKind: 'attestation',
      actor: input.by,
      action: 'rechecked',
      note: claimKind(meta),
      at: now,
    });

    return { attestationUid: row.uid, checks };
  });
}

function readAssertedAt(
  metadata: Record<string, unknown> | undefined
): string | undefined {
  const raw = metadata?.['claim'];
  if (raw !== null && typeof raw === 'object') {
    const assertedAt = (raw as Record<string, unknown>)['asserted_at'];
    if (typeof assertedAt === 'string') return assertedAt;
  }
  return undefined;
}

