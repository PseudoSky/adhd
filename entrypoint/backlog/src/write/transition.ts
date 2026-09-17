/**
 * transition.ts — `transition` (SPEC.md §4a, §6.3.4, §8 AC-15).
 *
 * The ONE path into a status change (§6.2/§6.3.3's DEBT-010 fix: `update`
 * structurally cannot carry a `status` field, §8 AC-14 — see `update.ts`,
 * this file's own sibling, deliberately owned by the same agent for exactly
 * that boundary). Writes a fresh `transition` node (`{from_status,
 * to_status, agent, note, sha, at}`, §3) + a `has_transition` edge, swaps the
 * issue's `has_status` edge onto the resolved `toStatus`, stamps or clears
 * `issue.meta.metadata.closedAt` (§6.3.4), and writes exactly one `audit` row
 * — all inside ONE `immediate` transaction (§4c).
 *
 * **`transition.sha`.** DATA_MODEL.md §10 point 2: "sha256 over the
 * canonical JSON serialization of `{issue_id, from, to, agent_id, note, at}`
 * ... the same convention SPEC.md §4a already states for the audit `sha`,
 * applied identically here rather than inventing a second scheme." `audit.ts`
 * (the frozen foundation) cites this SAME sentence for its own `sha` and
 * hashes `{actor, action, target_uid, from, to, note, at}` — this file
 * mirrors that exact field-naming convention (`target_uid`/`from`/`to`,
 * `null` for an absent `note` rather than omitting the key, `canonicalJSONStringify`
 * + `sha256Hex`, both frozen `tx.ts` exports the foundation's own CONTRACT.md
 * states are "the one canonical form both `audit.sha` and `transition.sha`
 * are computed over") rather than the relational `issue_id`/`agent_id`
 * naming DATA_MODEL.md's own (pre-graph-native) prose happens to use — this
 * is a resolved SPEC ambiguity, not an invented scheme; see the package's own
 * write-verb report for the full citation.
 *
 * **`closedAt` clearing (§8 AC-15).** `touch(nodeId, meta)` REPLACES the
 * entire `meta` column wholesale, never merges (verified against the
 * published dist — see `claim.ts`'s identical citation) — so the new
 * metadata object this file builds explicitly OMITS `closedAt` whenever
 * `toStatus.terminal` is false (including a reopen of a previously-terminal
 * issue), rather than spreading the old value forward and leaving a stale
 * timestamp that would keep matching a `filter.closedAt.until` range query.
 *
 * **Citations.** `ITransitionInput.citations` is written as `citation` nodes
 * + `has_citation` edges against the issue exactly like `create`'s own
 * citation handling (§6.2's own citations table entry, unchanged in spirit)
 * — the `CitationUnverifiableError`/`CitationRequiredError` pair this file's
 * Errors list names only make sense if a real citation write (and its real
 * sha computation) backs them. The sha computation itself runs BEFORE this
 * file's `immediate` transaction opens, mirroring `create-issue.ts`'s own
 * discipline (§4c/§4b: never hold the write lock across a filesystem read).
 *
 * **`project_policy.requiredFields`.** §2 names `transition` alongside
 * `createIssue`/`update` as enforcing `project_field_requirement` "the same
 * way... at the top of" each verb. `create-issue.ts`'s own
 * `enforceRequiredFields` is unexported (this package's established
 * per-file-duplication convention, exactly like this file's own
 * `resolveIssueProjectTx`/`computeCitationSha` copies), so this file carries
 * its own.
 *
 * The check is scoped to `transition`'s own STATIC input surface —
 * `status` (`toStatusRow.name`, always resolved) and `note` (`input.note`,
 * always a live concern of this verb whether or not a given call supplies
 * one) — never the raw spread of every declared `requiredFields` name.
 * A declared name outside that pair (`'priority'`, `'component'`, `'kind'`,
 * `'assignee'`, …) is not a concern this verb resolves at all and is
 * silently skipped, exactly the way `create-issue.ts`'s own doc comment
 * discusses `'component'` as a legitimate required-field declaration that
 * only the verbs which actually touch a project role need answer for.
 * Earlier this file spread `{...input, status: toStatusRow.name}` and
 * checked every key of `policy.requiredFields` against that object
 * unconditionally — so a project merely DECLARING `requiredFields:
 * ['priority']` (a real, spec-legitimate policy, unrelated to this call)
 * threw `InvalidArgumentError('priority', …)` on every single transition
 * against that project, including ones on issues that already have a
 * priority set. That was a bug, not a stricter reading of §2; fixed by
 * building `enforceRequiredFields`'s `resolvedValues` argument from a fixed
 * `{status, note}` object rather than the input spread, and having the loop
 * skip any required field name absent as an OWN key of that object — same
 * "is this key even part of this verb's input surface" skip `update.ts`'s
 * copy performs per-call over its optional `kind`/`priority`/`author`
 * override fields, just evaluated here against a fixed set rather than a
 * per-call one (transition has no partial-patch ambiguity: `status` is
 * unconditionally this call's concern, and `note` is unconditionally a
 * named concern of this verb — present as a key whether or not a given call
 * supplies a value — independently of every other role a project might
 * also require for OTHER verbs).
 */

import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve as resolvePath } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { AdapterTransaction } from '@adhd/sox-store-adapter';
import type { ICitationInput } from './create-issue.js';
import {
  type IResolvedProjectRow,
  mintOrResolveCatalogTx,
  resolveEdgeKindTx,
  resolveProjectPolicy,
} from './catalog.js';
import { writeAudit } from './audit.js';
import {
  CitationRequiredError,
  CitationUnverifiableError,
  InvalidArgumentError,
  IssueNotFoundError,
  NoteRequiredError,
  StaleSupersedeError,
  WriteIOError,
  assertNotBareRoleLiteral,
} from './errors.js';
import {
  type IWriteStoreHandle,
  canonicalJSONStringify,
  executeWriteTransaction,
  getNodeByRowidTx,
  getNodeByUidTx,
  invalidateEdgeTx,
  nowISO,
  sha256Hex,
  writeEdgeTx,
  writeNodeTx,
  resolveLiveIssueTx,
} from './tx.js';

export interface ITransitionInput {
  /** The `issue` uid to transition (§6.3, an "Issue verb"). */
  uid: string;
  /** The identity of the acting agent or person (§6.3's opening rule). REQUIRED. */
  by: string;
  /** catalog name or uid. An unresolved NAME mints a new status row with `terminal:false` (exactly like `create`'s own `status` field, §6.3.2/§6.1); a uid-shaped ref that does not resolve throws `CatalogNotFoundError('status', ref)`. */
  toStatus: string;
  /** REQUIRED unless `project_policy.transition_requires_note` is `false` (default `true`) — optional in the type; enforced at runtime (`NoteRequiredError`), never at the TS level. */
  note?: string;
  /** REQUIRED (≥1) when `project_policy.citation_required` is `true` AND `toStatus` resolves to a terminal status. Written as `citation` nodes + `has_citation` edges exactly like `create`'s own citations. */
  citations?: ICitationInput[];
}

export interface ITransitionOutcome {
  uid: string;
  fromStatus: string;
  toStatus: string;
  /** Present iff `toStatus.terminal` — see this file's own doc comment on `closedAt`. */
  closedAt?: string;
  /** The minted `transition` node's own uid, for audit-trail addressing. */
  transitionUid: string;
}

function assertNonBlank(
  field: string,
  value: string | undefined
): asserts value is string {
  // `typeof value !== 'string'` (rather than `=== undefined`) also catches an
  // explicit `null` — reachable from an untyped CLI/HTTP/MCP JSON caller even
  // though `ITransitionInput`'s TS type only declares `string | undefined` —
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

/**
 * Two-hop `owns_component`/`owns_project` walk — the SAME graph-invariant
 * pattern `claim.ts`'s `resolveIssueProjectPolicyTx` and `move.ts`'s
 * `resolveOwningProjectTx` already define locally (neither is exported, so
 * this file carries its own copy, per this package's established
 * per-file-duplication convention for these small tx-scoped helpers).
 * Accepts either an open `tx` or the bare `handle.adapter` — a structural
 * superset exposing the same three methods, exactly as `create-issue.ts`'s
 * own pre-transaction `resolveProjectTx(handle.adapter, ...)` call already
 * relies on — so this same function serves both the pre-transaction
 * citation-sha resolve (no lock held) and the authoritative in-transaction
 * resolve (the transaction's own snapshot).
 */
async function resolveIssueProjectTx(
  tx: AdapterTransaction,
  issueRowid: number
): Promise<IResolvedProjectRow> {
  const componentEdge = await tx.executeGet<IRawEdgeSrcRow>(
    'SELECT src FROM edge WHERE dst = ? AND rel = ? AND t_invalid IS NULL',
    [issueRowid, 'owns_component']
  );
  if (!componentEdge) {
    throw new Error(
      `transition: issue rowid=${issueRowid} has no live "owns_component" edge — graph invariant violation ` +
        '(every live issue must own exactly one live parent component).'
    );
  }
  const projectEdge = await tx.executeGet<IRawEdgeSrcRow>(
    'SELECT src FROM edge WHERE dst = ? AND rel = ? AND t_invalid IS NULL',
    [componentEdge.src, 'owns_project']
  );
  if (!projectEdge) {
    throw new Error(
      `transition: component rowid=${componentEdge.src} has no live "owns_project" edge — graph invariant violation ` +
        '(every live component must be owned by exactly one live project).'
    );
  }
  const projectRow = await getNodeByRowidTx(tx, projectEdge.src);
  if (
    !projectRow ||
    projectRow.kind !== 'project' ||
    projectRow.tInvalid !== null
  ) {
    throw new Error(
      `transition: resolved project rowid=${projectEdge.src} is missing, invalidated, or not a "project" node — ` +
        'graph invariant violation.'
    );
  }
  return {
    rowid: projectRow.rowid,
    uid: projectRow.uid,
    name: projectRow.name ?? '',
    metadata: projectRow.metadata,
  };
}

/**
 * §8.5's two-branch citation-sha rule, identical to `create-issue.ts`'s own
 * (private, unexported) `computeCitationSha` — duplicated here per this
 * package's established per-file convention (see this file's own doc
 * comment on {@link resolveIssueProjectTx}).
 */
async function computeCitationSha(
  project: IResolvedProjectRow,
  file: string
): Promise<string> {
  const projectPath = project.metadata?.path;
  if (typeof projectPath !== 'string' || projectPath.length === 0)
    return 'unverified';

  const root = resolvePath(projectPath);
  const candidate = isAbsolute(file)
    ? resolvePath(file)
    : resolvePath(root, file);
  const rel = relative(root, candidate);
  const escapesRoot =
    rel === '..' ||
    rel.startsWith(`..${'/'}`) ||
    rel.startsWith('..\\') ||
    isAbsolute(rel);
  if (escapesRoot) return 'unverified';

  try {
    const content = await readFile(candidate);
    return createHash('sha256').update(content).digest('hex');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'unverified';
    throw new WriteIOError(err);
  }
}

function enforceAllowedStatus(allowed: readonly string[], value: string): void {
  if (allowed.length > 0 && !allowed.includes(value)) {
    throw new InvalidArgumentError(
      'toStatus',
      `"${value}" is not in this project's allowed status set`
    );
  }
}

/**
 * `project_field_requirement` (§2) — see this file's own doc comment for why
 * a declared field absent as an OWN key of `resolvedValues` (i.e. outside
 * `transition`'s static `{status, note}` input surface) is skipped rather
 * than treated as missing.
 */
function enforceRequiredFields(
  required: readonly string[],
  resolvedValues: Record<string, unknown>
): void {
  for (const field of required) {
    if (!(field in resolvedValues)) continue;
    const value = resolvedValues[field];
    if (
      value === undefined ||
      value === null ||
      (typeof value === 'string' && value.trim().length === 0)
    ) {
      throw new InvalidArgumentError(
        field,
        "is required by this project's field policy"
      );
    }
  }
}

/**
 * Transition an issue's status (§4a, §6.3.4). One `immediate` transaction.
 *
 * Errors: `InvalidArgumentError` (`uid`/`by`/`toStatus` missing/blank, blank
 * `citations[i].file`, or a resolved `toStatus` outside this project's
 * `allowedStatuses` set), `IssueNotFoundError` (no live `issue` node carries
 * `uid`), `StaleSupersedeError(uid)` (`uid` was already superseded by a prior
 * `update` — this file's own doc comment on `update.ts` explains why that
 * reuses this error class rather than a new one), `CatalogNotFoundError('status',
 * toStatus)` (uid-shaped `toStatus` only — an unresolved NAME instead
 * auto-mints with `terminal:false`, exactly as `create`'s own `status` field,
 * §6.1), a project-declared `requiredFields` entry (§2 — here, always just
 * `status`, see this file's own doc comment) left blank,
 * `NoteRequiredError` (policy-gated), `CitationRequiredError`
 * (policy-gated, terminal-only), `CitationUnverifiableError(target)`
 * (policy-gated via `project_policy.citation_requires_sha` — a given
 * citation's `sha` resolved to the `"unverified"` sentinel and the project
 * requires a real hash), `WriteContentionError`/`WriteIOError` (§4c — an
 * exhausted driver-level retry on the underlying `immediate` transaction).
 */
export async function transition(
  handle: IWriteStoreHandle,
  input: ITransitionInput
): Promise<ITransitionOutcome> {
  assertNonBlank('uid', input.uid);
  assertNonBlank('by', input.by);
  assertNotBareRoleLiteral('by', input.by);
  assertNonBlank('toStatus', input.toStatus);

  const citations = input.citations ?? [];
  citations.forEach((c, i) => assertNonBlank(`citations[${i}].file`, c.file));

  // Pre-transaction citation-sha computation, skipped entirely when there are
  // no citations (the common case never pays for a project/policy resolve it
  // doesn't need) — mirrors `create-issue.ts`'s own "never hold the write
  // lock across `fs.readFile`" discipline (§4c/§4b).
  const citationShas: string[] = [];
  if (citations.length > 0) {
    const preIssueRow = await getNodeByUidTx(handle.adapter, input.uid);
    if (
      !preIssueRow ||
      preIssueRow.kind !== 'issue' ||
      preIssueRow.tInvalid !== null
    ) {
      throw new IssueNotFoundError(input.uid);
    }
    const preProject = await resolveIssueProjectTx(
      handle.adapter,
      preIssueRow.rowid
    );
    const prePolicy = resolveProjectPolicy(preProject);
    for (const citation of citations) {
      const sha = await computeCitationSha(preProject, citation.file);
      if (sha === 'unverified' && prePolicy.citationRequiresSha) {
        throw new CitationUnverifiableError(citation.file);
      }
      citationShas.push(sha);
    }
  }

  return executeWriteTransaction(handle, async (tx: AdapterTransaction) => {
    const now = nowISO();

    const issueRow = await resolveLiveIssueTx(tx, input.uid);

    // Re-resolved fresh against THIS transaction's own snapshot — never
    // reusing the pre-transaction read above, which only ever informed the
    // already-decided sha strings (mirrors `create-issue.ts`'s identical
    // "the actual writes are authoritative against the transaction's own
    // snapshot" discipline).
    const project = await resolveIssueProjectTx(tx, issueRow.rowid);
    const policy = resolveProjectPolicy(project);

    const currentStatusEdge = await tx.executeGet<IRawEdgeDstRow>(
      'SELECT dst FROM edge WHERE src = ? AND rel = ? AND t_invalid IS NULL',
      [issueRow.rowid, 'has_status']
    );
    if (!currentStatusEdge) {
      throw new Error(
        `transition: issue rowid=${issueRow.rowid} has no live "has_status" edge — graph invariant violation ` +
          '(every live issue must carry exactly one live status).'
      );
    }
    const currentStatusRow = await getNodeByRowidTx(tx, currentStatusEdge.dst);
    if (
      !currentStatusRow ||
      currentStatusRow.kind !== 'status' ||
      currentStatusRow.tInvalid !== null
    ) {
      throw new Error(
        `transition: resolved status rowid=${currentStatusEdge.dst} is missing, invalidated, or not a "status" node — ` +
          'graph invariant violation.'
      );
    }
    const fromStatusName = currentStatusRow.name ?? '';

    const toStatusRow = await mintOrResolveCatalogTx(tx, {
      catalogKind: 'status',
      ref: input.toStatus,
      at: now,
      mintMetadata: async () => ({ terminal: false }),
    });
    enforceAllowedStatus(policy.allowedStatuses, toStatusRow.name);
    enforceRequiredFields(policy.requiredFields, {
      status: toStatusRow.name,
      note: input.note,
    });
    const toStatusFullRow = await getNodeByRowidTx(tx, toStatusRow.rowid);
    const toTerminal = toStatusFullRow?.metadata?.['terminal'] === true;

    const hasNote =
      typeof input.note === 'string' && input.note.trim().length > 0;
    if (!hasNote && policy.transitionRequiresNote) {
      throw new NoteRequiredError(issueRow.uid);
    }
    if (toTerminal && policy.citationRequired && citations.length === 0) {
      throw new CitationRequiredError(issueRow.uid);
    }

    // §4a's audit/transition sha convention, mirroring `audit.ts`'s own
    // `writeAudit` field-naming EXACTLY (`target_uid`/`from`/`to`, `null` for
    // an absent `note` rather than omitting the key) — see this file's own
    // doc comment for the full citation of why this naming, not
    // DATA_MODEL.md's relational `issue_id`/`agent_id` prose, is authoritative.
    const canonicalTransitionFields: Record<string, unknown> = {
      target_uid: issueRow.uid,
      from: fromStatusName,
      to: toStatusRow.name,
      agent: input.by,
      note: input.note ?? null,
      at: now,
    };
    const transitionSha = sha256Hex(
      canonicalJSONStringify(canonicalTransitionFields)
    );

    const transitionNode = await writeNodeTx(tx, {
      kind: 'transition',
      content: input.note ?? '',
      metadata: {
        from_status: fromStatusName,
        to_status: toStatusRow.name,
        agent: input.by,
        note: input.note ?? null,
        sha: transitionSha,
        at: now,
      },
      at: now,
    });

    const hasTransitionRule = await resolveEdgeKindTx(tx, 'has_transition');
    await writeEdgeTx(tx, {
      at: now,
      srcRowid: issueRow.rowid,
      srcUid: issueRow.uid,
      srcKind: 'issue',
      dstRowid: transitionNode.rowid,
      dstUid: transitionNode.uid,
      dstKind: 'transition',
      rel: 'has_transition',
      rule: hasTransitionRule,
      typePolicy: handle.typePolicy,
    });

    // The actual status change: invalidate the OLD `has_status` edge, write
    // the NEW one — hand-composed invalidate-then-write, mirroring
    // `move.ts`'s identical `owns_component` sequencing (§4c). A same-status
    // "transition" (toStatus === current status) is still a real, fully
    // audited event (SPEC.md states no same-status no-op exemption, unlike
    // `move`'s explicit same-placement no-op, §6.3.6) — this invalidates and
    // re-writes the SAME edge, harmlessly refreshing its timestamps.
    await invalidateEdgeTx(tx, {
      srcRowid: issueRow.rowid,
      dstRowid: currentStatusEdge.dst,
      rel: 'has_status',
      reason: `transitioned to "${toStatusRow.name}"`,
      at: now,
    });
    const hasStatusRule = await resolveEdgeKindTx(tx, 'has_status');
    await writeEdgeTx(tx, {
      at: now,
      srcRowid: issueRow.rowid,
      srcUid: issueRow.uid,
      srcKind: 'issue',
      dstRowid: toStatusRow.rowid,
      dstUid: toStatusRow.uid,
      dstKind: 'status',
      rel: 'has_status',
      rule: hasStatusRule,
      typePolicy: handle.typePolicy,
    });

    if (citations.length > 0) {
      const hasCitationRule = await resolveEdgeKindTx(tx, 'has_citation');
      for (let i = 0; i < citations.length; i += 1) {
        const citation = citations[i];
        const sha = citationShas[i];
        const citationNode = await writeNodeTx(tx, {
          at: now,
          kind: 'citation',
          name: citation.file,
          content: citation.context ?? citation.file,
          metadata: {
            target: citation.file,
            target_type: 'path',
            sha,
            line: citation.lines ?? null,
            at: now,
            symbol: citation.symbol ?? null,
            blastRadius: citation.blastRadius ?? null,
          },
        });
        await writeEdgeTx(tx, {
          at: now,
          srcRowid: issueRow.rowid,
          srcUid: issueRow.uid,
          srcKind: 'issue',
          dstRowid: citationNode.rowid,
          dstUid: citationNode.uid,
          dstKind: 'citation',
          rel: 'has_citation',
          rule: hasCitationRule,
          typePolicy: handle.typePolicy,
        });
      }
    }

    // §6.3.4's closedAt stamp/clear — see this file's own doc comment.
    const newIssueMetadata: Record<string, unknown> = {
      ...(issueRow.metadata ?? {}),
    };
    if (toTerminal) {
      newIssueMetadata.closedAt = now;
    } else {
      delete newIssueMetadata.closedAt;
    }
    const touchResult = await tx.executeRun(
      'UPDATE node SET meta = ?, t_updated = ? WHERE rowid = ?',
      [JSON.stringify(newIssueMetadata), now, issueRow.rowid]
    );
    if (touchResult.rowsAffected !== 1) {
      throw new Error(
        `transition: closedAt touch UPDATE affected ${touchResult.rowsAffected} rows for rowid=${issueRow.rowid}, expected exactly 1.`
      );
    }

    await writeAudit({
      tx,
      typePolicy: handle.typePolicy,
      subjectRowid: issueRow.rowid,
      subjectUid: issueRow.uid,
      subjectKind: 'issue',
      actor: input.by,
      action: 'transitioned',
      from: fromStatusName,
      to: toStatusRow.name,
      note: input.note,
      at: now,
    });

    return {
      uid: issueRow.uid,
      fromStatus: fromStatusName,
      toStatus: toStatusRow.name,
      closedAt: toTerminal ? now : undefined,
      transitionUid: transitionNode.uid,
    };
  });
}
