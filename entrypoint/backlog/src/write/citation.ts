/**
 * write/citation.ts — first-class citation write verbs + the shared
 * citation-sha resolver.
 *
 * ## What this module owns
 *
 * A `citation` is already a first-class graph NODE (`kind='citation'`) joined
 * to its issue by a `has_citation` edge (`DATA_MODEL.md` §0.2/§4/§5). Before
 * this module there was no way to ADD or REMOVE one after the fact: a citation
 * could only be written at `create`/`transition` time (as a whole array), and
 * once written it could never be retired. That produced exactly the "redundant
 * surfaces" the citation model rejects — evidence could only be added by
 * re-writing the issue, and a stale citation could only be dealt with by a
 * prose `Citations:` block beside the structured one.
 *
 * This module adds the two symmetric verbs:
 *
 *  - {@link addCitation} — mint the citation node + its `has_citation` edge +
 *    an audit row, atomically in ONE `immediate` transaction (§4c), hand-
 *    composed against the same `tx` (never the bare-adapter `writeNode`/
 *    `writeEdge`). It generalizes exactly what `create-issue.ts` already does
 *    for filing-time citations.
 *  - {@link removeCitation} — bi-temporally invalidate the citation node AND
 *    its `has_citation` edge, addressed by the citation's OWN uid (never by
 *    re-specifying `(target,line)` — there is no composite identity, §1).
 *
 * Both are also exposed as tx-threaded primitives ({@link appendCitationTx}/
 * {@link removeCitationTx}/{@link readLiveCitationsTx}) so `update`'s
 * diff-emitter can apply a citation change INSIDE the update's own single
 * transaction rather than opening a second one (§4c: one transaction per verb
 * invocation).
 *
 * ## The sha gate, generalized
 *
 * {@link computeCitationSha}/{@link resolveCitationShas} are the ONE copy of
 * §8.5's two-branch citation-sha rule that `create-issue.ts` and
 * `transition.ts` previously each duplicated. They compute a cited file's
 * sha256 in the working tree OR — when the citation names a `revision` — from a
 * git revision (`git show <revision>:<path>`), so branch-only evidence is
 * citable (see `../citation.ts`'s header). The `citation_requires_sha` policy
 * gate is applied identically for every caller.
 */

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve as resolvePath, sep } from 'node:path';
import type { AdapterTransaction } from '@adhd/sox-store-adapter';
import {
  citationKeyFromMetadata,
  citationNodeMetadata,
  type ICitation,
  type ICitationRecord,
} from '../citation.js';
import {
  projectHasKnownPath,
  type IProjectPolicy,
  type IResolvedProjectRow,
  resolveEdgeKindTx,
  resolveProjectPolicy,
} from './catalog.js';
import { writeAudit } from './audit.js';
import {
  CatalogNotFoundError,
  CitationNotFoundError,
  CitationUnverifiableError,
  InvalidArgumentError,
  assertNotBareRoleLiteral,
  citationReadError,
} from './errors.js';
import {
  isMissingPathError,
  resolveCitationTarget,
  resolveSiblingProjectRootsTx,
  toolOwnedCitationRoots,
} from './citation-path.js';
import {
  type IWriteStoreHandle,
  executeWriteTransaction,
  getNodeByRowidTx,
  invalidateEdgeTx,
  nowISO,
  resolveLiveIssueTx,
  resolveUidPrefixTx,
  sha256Hex,
  writeEdgeTx,
  writeNodeTx,
} from './tx.js';

function assertNonBlank(
  field: string,
  value: string | undefined
): asserts value is string {
  if (value === undefined || value.trim().length === 0) {
    throw new InvalidArgumentError(field, 'is required');
  }
}

interface IRawEdgeSrcRow {
  src: number;
}

/**
 * Two-hop `owns_component`/`owns_project` walk — the SAME graph-invariant
 * pattern `transition.ts`/`update.ts`/`move.ts` each define locally; this file
 * carries its own copy per this package's established per-file-duplication
 * convention for these small tx-scoped helpers. Accepts either an open `tx` or
 * the bare `handle.adapter` (a structural superset exposing the same read
 * methods), so the same function serves both the pre-transaction sha resolve
 * (no lock held) and any in-transaction read.
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
      `citation: issue rowid=${issueRowid} has no live "owns_component" edge — graph invariant violation ` +
        '(every live issue must own exactly one live parent component).'
    );
  }
  const projectEdge = await tx.executeGet<IRawEdgeSrcRow>(
    'SELECT src FROM edge WHERE dst = ? AND rel = ? AND t_invalid IS NULL',
    [componentEdge.src, 'owns_project']
  );
  if (!projectEdge) {
    throw new Error(
      `citation: component rowid=${componentEdge.src} has no live "owns_project" edge — graph invariant violation ` +
        '(every live component must be owned by exactly one live project).'
    );
  }
  const projectRow = await getNodeByRowidTx(tx, projectEdge.src);
  if (projectRow?.kind !== 'project' || projectRow.tInvalid !== null) {
    throw new Error(
      `citation: resolved project rowid=${projectEdge.src} is missing, invalidated, or not a "project" node — ` +
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

// ---------------------------------------------------------------------------
// Revision-pinned sha resolution (git show <revision>:<path>)
// ---------------------------------------------------------------------------

/**
 * The conservative grammar a `revision` must satisfy before it is handed to
 * `git`. Deliberately NOT a shell regex — `execFile` never invokes a shell —
 * but git itself treats a leading `-` as an OPTION, and a `..` as a revision
 * RANGE, so both are refused here rather than left for git to misinterpret.
 */
const GIT_REVISION_RE = /^[A-Za-z0-9][A-Za-z0-9._/@{}~^-]*$/;

function isSafeRevision(revision: string): boolean {
  return (
    revision.length > 0 &&
    revision.length <= 256 &&
    GIT_REVISION_RE.test(revision) &&
    !revision.includes('..')
  );
}

/**
 * Resolve `file` (absolute, or relative to `root`) to a repo-relative path
 * (forward-slashed, as git wants), or `undefined` when it escapes `root` — the
 * same lexical rule `anchor-check.ts`'s `toRepoRelative` applies to a
 * `path:` anchor.
 */
function toRepoRelative(root: string, file: string): string | undefined {
  const absRoot = resolvePath(root);
  const abs = isAbsolute(file)
    ? resolvePath(file)
    : resolvePath(absRoot, file);
  const rel = relative(absRoot, abs);
  if (
    rel === '' ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    return undefined;
  }
  return rel.split(sep).join('/');
}

/**
 * The sha256 of `relpath`'s blob AT `revision`, or `undefined` when it cannot
 * be resolved (unknown revision, path absent at that revision, not a git work
 * tree, no `git` binary) — never a throw. A `revision` outside
 * {@link isSafeRevision} is refused here (returns `undefined`) before any
 * process is spawned.
 *
 * Reads the blob as bytes, so the digest matches the working-tree path's
 * `readFile` byte hash exactly for the same content.
 */
function readCitationShaAtRevision(
  root: string,
  revision: string,
  relpath: string
): string | undefined {
  if (!isSafeRevision(revision)) return undefined;
  try {
    const out = execFileSync(
      'git',
      ['-C', root, 'show', `${revision}:${relpath}`],
      { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }
    );
    return sha256Hex(out);
  } catch {
    // A non-zero git exit (unknown revision / absent path), a missing `git`,
    // or a spawn failure all mean the revision-pinned target could not be
    // resolved — degrade to the caller's `unverified` sentinel rather than
    // masking it as a real I/O fault.
    return undefined;
  }
}

/**
 * §8.5's two-branch citation-sha rule, in ONE place (the generalization of the
 * copy `create-issue.ts`/`transition.ts` each used to carry).
 *
 * Branch 1: a PATH-LESS project cannot content-address anything, so every
 * citation degrades to the `'unverified'` sentinel up front.
 *
 * Branch 2a (revision-pinned): when `revision` is given, the target is resolved
 * against the git revision (`git show <revision>:<relpath>`) rather than the
 * working tree — so a file that exists only on an unmerged branch is citable.
 * The read is confined to the project's own git object database (git refuses a
 * `..` path), so no filesystem containment check is needed for it.
 *
 * Branch 2b (working tree): the target must resolve (canonically) within the
 * project root OR within one of `allowedExternalRoots` —
 * `citation-path.ts`'s {@link resolveCitationTarget}. The only filesystem read
 * happens after acceptance.
 *
 * §4c's error taxonomy is preserved exactly: ENOENT/ENOTDIR → `'unverified'`
 * (the file genuinely is not there); EISDIR → `CitationTargetIsDirectoryError`;
 * any other errno → `WriteIOError` (`citationReadError`).
 */
export async function computeCitationSha(
  project: IResolvedProjectRow,
  file: string,
  revision: string | undefined,
  allowedExternalRoots: readonly string[],
  siblingRoots: readonly string[] = []
): Promise<string> {
  if (!projectHasKnownPath(project)) return 'unverified';

  if (revision !== undefined) {
    const relpath = toRepoRelative(project.metadata.path, file);
    if (relpath === undefined) return 'unverified';
    return readCitationShaAtRevision(project.metadata.path, revision, relpath)
      ?? 'unverified';
  }

  try {
    const { accepted, candidate } = await resolveCitationTarget(
      project.metadata.path,
      file,
      [...allowedExternalRoots, ...toolOwnedCitationRoots(), ...siblingRoots]
    );
    if (!accepted) return 'unverified';

    const content = await readFile(candidate);
    return sha256Hex(content);
  } catch (err) {
    if (isMissingPathError(err)) return 'unverified';
    throw citationReadError(err, file);
  }
}

/**
 * Compute the sha for every citation in `citations`, in caller order — NO
 * policy gate (see {@link assertCitationShasVerifiable}). This is the
 * filesystem/git half of the citation-sha pre-resolve, callable on its own by a
 * caller (`update`'s diff-emitter) that must defer the gate until it knows
 * which citations are actually being ADDED.
 */
export async function computeCitationShas(
  project: IResolvedProjectRow,
  citations: readonly ICitation[],
  allowedExternalRoots: readonly string[],
  siblingRoots: readonly string[] = []
): Promise<string[]> {
  const shas: string[] = [];
  for (const citation of citations) {
    shas.push(
      await computeCitationSha(
        project,
        citation.file,
        citation.revision,
        allowedExternalRoots,
        siblingRoots
      )
    );
  }
  return shas;
}

/**
 * Enforce `project_policy.citationRequiresSha` over an already-computed sha
 * list, paired index-for-index with `citations`. Only where verification is
 * POSSIBLE (the project has a known `path`) is a `"unverified"` sha a hard
 * `CitationUnverifiableError` naming the allowed roots; a path-less project
 * records `sha:"unverified"` verbatim, with the deliberate waiver logged (DEBT
 * a934e089) rather than silently applied. `verb` names the caller in that log.
 *
 * Split from {@link computeCitationShas} so `update`'s diff-emitter can compute
 * shas for its whole desired set but gate ONLY the citations it actually adds —
 * so an issue holding a citation whose file has since vanished can still be
 * updated (that already-live citation is neither re-added nor re-gated; only a
 * genuinely new, unverifiable citation is refused).
 */
export function assertCitationShasVerifiable(
  project: IResolvedProjectRow,
  policy: IProjectPolicy,
  citations: readonly ICitation[],
  shas: readonly string[],
  verb: string
): void {
  for (let i = 0; i < citations.length; i += 1) {
    if (shas[i] === 'unverified' && policy.citationRequiresSha) {
      if (projectHasKnownPath(project)) {
        throw new CitationUnverifiableError(
          citations[i].file,
          policy.citationAllowedExternalRoots
        );
      }
      console.error(
        `${verb}: citation_requires_sha waived for path-less project uid="${project.uid}" — cannot verify citation "${citations[i].file}", persisting sha:"unverified" (set the project's metadata.path to make citation_requires_sha enforceable).`
      );
    }
  }
}

/**
 * Compute AND policy-gate the sha for every citation in `citations`, in caller
 * order — the ONE implementation `createIssue`/`transition`'s pre-transaction
 * citation loop and `addCitation`'s single-citation resolve share. Composes
 * {@link computeCitationShas} + {@link assertCitationShasVerifiable}.
 */
export async function resolveCitationShas(
  project: IResolvedProjectRow,
  policy: IProjectPolicy,
  citations: readonly ICitation[],
  siblingRoots: readonly string[],
  verb: string
): Promise<string[]> {
  const shas = await computeCitationShas(
    project,
    citations,
    policy.citationAllowedExternalRoots,
    siblingRoots
  );
  assertCitationShasVerifiable(project, policy, citations, shas, verb);
  return shas;
}

// ---------------------------------------------------------------------------
// tx-threaded citation primitives (reused by the verbs and by `update`)
// ---------------------------------------------------------------------------

/** Mint ONE `citation` node + its `has_citation` edge against the issue, inside the caller's open `tx`. NEVER writes an audit row — the calling verb owns the ONE audit its §4a contract requires. */
export async function appendCitationTx(
  tx: AdapterTransaction,
  handle: IWriteStoreHandle,
  params: {
    issueRowid: number;
    issueUid: string;
    citation: ICitation;
    sha: string;
    at: string;
  }
): Promise<{ rowid: number; uid: string }> {
  const citationNode = await writeNodeTx(tx, {
    at: params.at,
    kind: 'citation',
    name: params.citation.file,
    content: params.citation.context ?? params.citation.file,
    metadata: citationNodeMetadata(params.citation, params.sha, params.at),
  });
  const rule = await resolveEdgeKindTx(tx, 'has_citation');
  await writeEdgeTx(tx, {
    at: params.at,
    srcRowid: params.issueRowid,
    srcUid: params.issueUid,
    srcKind: 'issue',
    dstRowid: citationNode.rowid,
    dstUid: citationNode.uid,
    dstKind: 'citation',
    rel: 'has_citation',
    rule,
    typePolicy: handle.typePolicy,
  });
  return citationNode;
}

/** A live citation attached to an issue — just the identity + diff key the diff-emitter needs. */
export interface ILiveCitationRow {
  rowid: number;
  uid: string;
  /** {@link citationKey}-shaped (`file` + `lines`), read off the persisted `target`/`line`. */
  key: string;
}

/**
 * The LIVE citations currently attached to `issueRowid`, in edge order — the
 * "live set" `update`'s diff-emitter compares a desired set against. A live
 * `has_citation` edge whose target node is missing or invalidated is skipped
 * defensively (the invariant is that the two are invalidated together, so this
 * should never fire).
 */
export async function readLiveCitationsTx(
  tx: AdapterTransaction,
  issueRowid: number
): Promise<ILiveCitationRow[]> {
  const { rows } = await tx.executeAll<{ dst: number }>(
    `SELECT dst FROM edge WHERE src = ? AND rel = 'has_citation' AND t_invalid IS NULL`,
    [issueRowid]
  );
  const out: ILiveCitationRow[] = [];
  for (const row of rows) {
    const node = await getNodeByRowidTx(tx, row.dst);
    if (!node) continue;
    if (node.tInvalid !== null) continue;
    out.push({
      rowid: node.rowid,
      uid: node.uid,
      key: citationKeyFromMetadata(node.metadata),
    });
  }
  return out;
}

/**
 * Bi-temporally invalidate ONE citation: its node (`t_invalid` + a merged
 * `meta.invalidatedReason`/`invalidatedAt`, never a wholesale replace — the
 * `rmLocation`/`delete` shape) AND its owning `has_citation` edge. Hand-
 * composed against `tx`.
 *
 * Never writes an audit row — the calling verb owns it (so `update` emits its
 * single `'updated'` audit for a whole diff rather than one per citation).
 */
export async function removeCitationTx(
  tx: AdapterTransaction,
  params: {
    citationRowid: number;
    citationUid: string;
    at: string;
    reason?: string;
  }
): Promise<void> {
  const row = await getNodeByRowidTx(tx, params.citationRowid);
  if (!row) {
    throw new Error(
      `removeCitation: citation rowid=${params.citationRowid} vanished mid-transaction.`
    );
  }
  const mergedMeta = {
    ...(row.metadata ?? {}),
    ...(params.reason !== undefined
      ? { invalidatedReason: params.reason }
      : {}),
    invalidatedAt: params.at,
  };
  const result = await tx.executeRun(
    'UPDATE node SET t_invalid = ?, meta = ? WHERE rowid = ? AND t_invalid IS NULL',
    [params.at, JSON.stringify(mergedMeta), row.rowid]
  );
  if (result.rowsAffected !== 1) {
    throw new Error(
      `removeCitation: invalidate UPDATE affected ${result.rowsAffected} rows for uid="${params.citationUid}", expected exactly 1.`
    );
  }

  const edge = await tx.executeGet<IRawEdgeSrcRow>(
    `SELECT src FROM edge WHERE dst = ? AND rel = 'has_citation' AND t_invalid IS NULL`,
    [row.rowid]
  );
  if (edge) {
    await invalidateEdgeTx(tx, {
      srcRowid: edge.src,
      dstRowid: row.rowid,
      rel: 'has_citation',
      reason: params.reason,
      at: params.at,
    });
  }
}

// ---------------------------------------------------------------------------
// The mounted verbs
// ---------------------------------------------------------------------------

/** Resolve a citation uid (exact or unique prefix) to its live node, mapping a miss to {@link CitationNotFoundError} — the `AttestationNotFoundError` pattern, applied to `citation`. */
async function resolveCitationNodeTx(
  exec: AdapterTransaction,
  uid: string
): Promise<{ rowid: number; uid: string; metadata: Record<string, unknown> | undefined }> {
  try {
    const row = await resolveUidPrefixTx(exec, uid, {
      expectedKind: 'citation',
    });
    return { rowid: row.rowid, uid: row.uid, metadata: row.metadata };
  } catch (err) {
    if (err instanceof CatalogNotFoundError) {
      throw new CitationNotFoundError(uid);
    }
    throw err;
  }
}

export interface IAddCitationInput {
  /** The `issue` uid the citation is attached to. */
  uid: string;
  /** The citation to add — the SAME {@link ICitation} contract `create`/`transition` accept, including the optional `revision`. */
  citation: ICitation;
  /** The acting identity (§6.3's opening rule). REQUIRED. */
  by: string;
}

export interface IAddCitationOutcome {
  /** The minted `citation` node's own uid — the identity `removeCitation` addresses. */
  uid: string;
  /** The issue the citation was attached to (unchanged). */
  issueUid: string;
  /** The minted citation, projected (the read shape). */
  citation: ICitationRecord;
}

/**
 * Add ONE citation to an existing issue (§6.3, §4). One `immediate`
 * transaction: resolve `uid` → live `issue` → mint the `citation` node + its
 * `has_citation` edge → `writeAudit`, all against the SAME `tx` (never the
 * bare-adapter `writeNode`/`writeEdge`, §4c). The cited file's sha is computed
 * BEFORE the transaction opens, exactly as `create`/`transition` do, so the
 * write lock is never held across a filesystem/git read.
 *
 * Errors: `InvalidArgumentError` (blank `uid`/`by`/`citation.file`),
 * `IssueNotFoundError` (no live `issue` carries `uid`), `StaleSupersedeError`
 * (`uid` names a superseded issue), `CitationUnverifiableError` (the target did
 * not resolve to a real sha and the owning project requires one — including a
 * `revision` that does not resolve), `WriteContentionError`/`WriteIOError`
 * (§4c).
 */
export async function addCitation(
  handle: IWriteStoreHandle,
  input: IAddCitationInput
): Promise<IAddCitationOutcome> {
  assertNonBlank('uid', input.uid);
  assertNonBlank('by', input.by);
  assertNotBareRoleLiteral('by', input.by);
  assertNonBlank('citation.file', input.citation?.file);

  // Pre-transaction resolve (no lock held): the issue's project + policy feed
  // the sha gate; the sha itself is a filesystem/git read.
  const preIssueRow = await resolveLiveIssueTx(handle.adapter, input.uid);
  const preProject = await resolveIssueProjectTx(
    handle.adapter,
    preIssueRow.rowid
  );
  const prePolicy = resolveProjectPolicy(preProject);
  const preSiblingRoots = await resolveSiblingProjectRootsTx(
    handle.adapter,
    preProject.uid
  );
  const shas = await resolveCitationShas(
    preProject,
    prePolicy,
    [input.citation],
    preSiblingRoots,
    'addCitation'
  );

  return executeWriteTransaction(handle, async (tx: AdapterTransaction) => {
    const now = nowISO();
    const issueRow = await resolveLiveIssueTx(tx, input.uid);
    const appended = await appendCitationTx(tx, handle, {
      issueRowid: issueRow.rowid,
      issueUid: issueRow.uid,
      citation: input.citation,
      sha: shas[0],
      at: now,
    });

    await writeAudit({
      tx,
      typePolicy: handle.typePolicy,
      subjectRowid: issueRow.rowid,
      subjectUid: issueRow.uid,
      subjectKind: 'issue',
      actor: input.by,
      action: 'citation-added',
      to: appended.uid,
      note: input.citation.file,
      at: now,
    });

    return {
      uid: appended.uid,
      issueUid: issueRow.uid,
      citation: {
        uid: appended.uid,
        file: input.citation.file,
        lines: input.citation.lines,
        context: input.citation.context,
        symbol: input.citation.symbol,
        blastRadius: input.citation.blastRadius,
        revision: input.citation.revision,
        sha: shas[0],
        at: now,
        targetType: 'path',
      },
    };
  });
}

export interface IRemoveCitationInput {
  /** The `citation` uid to soft-remove — the citation's OWN uid, never a `(target,line)` re-specification. */
  uid: string;
  /** The acting identity (§6.3's opening rule). REQUIRED. */
  by: string;
  /** Optional explanation recorded on the invalidation and the audit row (mirrors `rmLocation`'s `reason`). */
  reason?: string;
}

export interface IRemoveCitationOutcome {
  uid: string;
  invalidated: true;
}

/**
 * Soft-remove ONE citation by its own `uid` (§6.3, §4). One `immediate`
 * transaction: resolve `uid` → LIVE `citation` node (`resolveCitationNodeTx`,
 * never a bare `getNodeByUid`) → bi-temporally invalidate the node AND its
 * `has_citation` edge ({@link removeCitationTx}) → `writeAudit`, all against the
 * SAME `tx`. The citation's ISSUE is untouched: its uid is preserved and no
 * node is superseded.
 *
 * Errors: `InvalidArgumentError` (blank `uid`/`by`), `CitationNotFoundError`
 * (no LIVE `citation` node carries `uid` — including an already-removed uid, or
 * a uid that names a node of a different kind, the "foreign citation" refusal),
 * `WriteContentionError`/`WriteIOError` (§4c).
 */
export async function removeCitation(
  handle: IWriteStoreHandle,
  input: IRemoveCitationInput
): Promise<IRemoveCitationOutcome> {
  assertNonBlank('uid', input.uid);
  assertNonBlank('by', input.by);
  assertNotBareRoleLiteral('by', input.by);

  return executeWriteTransaction(handle, async (tx: AdapterTransaction) => {
    const now = nowISO();
    const citationRow = await resolveCitationNodeTx(tx, input.uid);

    // The audit is attached to the OWNING ISSUE where one is still reachable
    // (its trail is the useful home), falling back to the citation node itself.
    const edge = await tx.executeGet<IRawEdgeSrcRow>(
      `SELECT src FROM edge WHERE dst = ? AND rel = 'has_citation' AND t_invalid IS NULL`,
      [citationRow.rowid]
    );
    let subjectRowid = citationRow.rowid;
    let subjectUid = citationRow.uid;
    let subjectKind = 'citation';
    if (edge) {
      const issue = await getNodeByRowidTx(tx, edge.src);
      if (issue?.kind === 'issue' && issue.tInvalid === null) {
        subjectRowid = issue.rowid;
        subjectUid = issue.uid;
        subjectKind = 'issue';
      }
    }

    await removeCitationTx(tx, {
      citationRowid: citationRow.rowid,
      citationUid: citationRow.uid,
      at: now,
      reason: input.reason,
    });

    await writeAudit({
      tx,
      typePolicy: handle.typePolicy,
      subjectRowid,
      subjectUid,
      subjectKind,
      actor: input.by,
      action: 'citation-removed',
      from: citationRow.uid,
      note: input.reason,
      at: now,
    });

    return { uid: citationRow.uid, invalidated: true as const };
  });
}
