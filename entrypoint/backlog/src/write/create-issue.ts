/**
 * create-issue.ts — `createIssue` (SPEC.md §4 + §6.3.2).
 *
 * One `store.adapter.transaction(fn, {mode:'immediate'})` (§4c) over: resolve
 * `project` (find-only, §1/§6.1) → resolve `component` (find-only when given;
 * `project`'s reserved `(root)` default when omitted, §3/§6.1/§9 AC-23) →
 * find-or-mint `kind`/`status`/`priority`/`agent` (§1/§4c's hand-composed
 * find-then-create) → write the `issue` node → write `owns_component` +
 * `has_kind` + `has_status` (+ `has_priority` when resolved) + `authored_by`
 * + each citation's `citation` node/`has_citation` edge → `writeAudit` (§4a)
 * — all against the SAME `tx` handle, never a call to the library's
 * `writeNode`/`writeEdge`/`findOrCreateNode` themselves (§4c).
 */

import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve as resolvePath } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { AdapterTransaction } from '@adhd/sox-store-adapter';
import {
  type IResolvedCatalogRow,
  type IResolvedProjectRow,
  mintOrResolveCatalogTx,
  nextPriorityRankTx,
  resolveComponentTx,
  resolveDefaultComponentTx,
  resolveEdgeKindTx,
  resolveProjectPolicy,
  resolveProjectTx,
} from './catalog.js';
import { writeAudit } from './audit.js';
import { CitationUnverifiableError, InvalidArgumentError, WriteIOError } from './errors.js';
import { type IWriteStoreHandle, executeWriteTransaction, nowISO, writeEdgeTx, writeNodeTx } from './tx.js';

/**
 * A filing-time citation (§6.3.2, carried forward from the established `Citation` shape in
 * spirit — `blastRadius` stays best-effort, `model.ts:110-120`). Named
 * `ICitationInput` here (not the spec's bare `Citation`) per this repo's
 * "prefix shared/data interfaces with `I`" convention.
 */
export interface ICitationInput {
  file: string;
  lines?: string;
  context?: string;
  symbol?: string;
  /** Best-effort enrichment payload — not re-specified here; carried through verbatim into the citation node's metadata. */
  blastRadius?: unknown;
}

export interface ICreateIssueInput {
  title: string;
  body: string;
  /** uid or name — resolved per §6.1; REQUIRED (every issue has a component chain). NEVER minted by this verb (§1/§6.1). */
  project: string;
  /** uid or name, scoped within `project` — RESOLVED ONLY, never created. Omitted (undefined) resolves to `project`'s reserved default component `(root)` (§3/§6.1/§9 AC-23) — a THIRD case, distinct from a resolved or an unresolved name. */
  component?: string;
  /** catalog name or uid; default is the project's configured `policy.defaultKind`, falling back to the global `"issue"` row. An unresolved NAME mints; a uid-shaped ref that does not resolve throws (§6.1). */
  kind?: string;
  /** catalog name or uid; default is `policy.defaultStatus`, falling back to the global `"open"` row (minted with `terminal:false` if it does not yet exist). An unresolved NAME mints with `terminal:false`; a uid-shaped ref that does not resolve throws (§6.1). */
  status?: string;
  /** catalog name or uid; genuinely OPTIONAL — §6.3.2 states minting behavior for a GIVEN unresolved name but, unlike `kind`/`status`, states no fallback for the omitted case; omitted therefore writes no `has_priority` edge at all (a deliberate reading of §6.3.2's more precise per-field text over §4's summary prose — see this project's own README/CHANGELOG note on this slice for the citation). An unresolved NAME mints with `rank` = one past the current max (lowest urgency); a uid-shaped ref that does not resolve throws. */
  priority?: string;
  citations?: ICitationInput[];
  /** catalog agent name/uid; defaults to `by`. An unresolved NAME mints; a uid-shaped ref that does not resolve throws (§6.1). */
  author?: string;
  /** Plain metadata scalar (§6.2) — no edge. */
  assignee?: string;
  /** The acting agent/human identity (§6.3's opening rule) — REQUIRED on every mutating verb. A missing/blank value throws `InvalidArgumentError('by', ...)` before any write runs. */
  by: string;
  /**
   * §4b: waits for the fire-and-forget on-write embedding observer before
   * returning when `true`. **Not implemented in this slice.** the spec's own
   * embedding observer (`createEmbeddingObserver`, FEAT-021) fires from
   * `GraphWriteObserver.onNodeWritten`, which only fires from INSIDE
   * `GraphBackend.writeNode`/`writeNodeInTx` (verified against the published
   * `@adhd/sox-graph-store` dist) — a hook this write layer structurally
   * never calls (§4c's entire premise is that those library methods
   * autocommit outside our transaction). So today, `awaitEmbed` is accepted
   * for input-shape parity with §6.3.2 but has no effect; wiring an
   * embedding round-trip onto a hand-composed `writeNodeTx` insert (a NEW
   * post-commit hook this write layer would have to invoke itself) is real
   * work for the store-bootstrap/embedding-observer slice, not silently
   * faked here.
   */
  awaitEmbed?: boolean;
}

/** The "plain" card fields (§6.5) this verb already has in hand after a create — never field-projected, unlike a `query` response. */
export interface IIssueCard {
  uid: string;
  title: string;
  kind: string;
  status: string;
  priority?: string;
  project: string;
  component: string;
  createdAt: string;
  assignee?: string;
  author?: string;
  closedAt?: string;
}

export interface ICreateIssueResult {
  created: true;
  uid: string;
  item: IIssueCard;
  /** Present only when this create was superseding an existing issue — always absent here; `createIssue` alone never mints via the `supersedes` composition (§6.3.2), which is a separate, not-yet-built code path (`updateIssue`'s body-change CAS). */
  supersededUid?: string;
}

function assertNonBlank(field: string, value: string | undefined): asserts value is string {
  if (value === undefined || value.trim().length === 0) {
    throw new InvalidArgumentError(field, 'is required');
  }
}

/**
 * §8.5's two-branch citation-sha rule, run identically at live-write time
 * (§8.5: "this is also the canonical rule for computing citation.sha on the
 * LIVE write path"). Confined to `project.metadata.path` (BUG blind-review
 * finding 1): a citation whose resolved path lands OUTSIDE the project root
 * — an absolute path anywhere else on the host, or a relative path that
 * walks back out via `../` — is treated identically to "file not found":
 * it returns `'unverified'`, never reads the file, and never throws a third
 * branch. This is a deliberate choice to keep §8.5's rule exactly
 * two-branched (project has no known path → unverified; file not
 * confirmed → unverified) rather than adding an escape-specific throw. It
 * still closes the reported hole: under the default
 * `project_policy.citation_requires_sha` (`true`), `'unverified'` is
 * REJECTED by `createIssue`'s own policy gate below, so an escaping path can
 * never satisfy that policy and can never be used as a
 * file-exists/readable oracle for paths outside the project — the read
 * itself never happens, so no distinguishable success/failure signal about
 * the escaped path ever reaches the caller.
 *
 * The confinement check uses `path.resolve` + `path.relative` (never a raw
 * string `startsWith` on `projectPath`, which a sibling directory sharing a
 * name prefix — e.g. `/repo` vs `/repo-evil` — would defeat).
 */
async function computeCitationSha(project: IResolvedProjectRow, file: string): Promise<string> {
  const projectPath = project.metadata?.path;
  if (typeof projectPath !== 'string' || projectPath.length === 0) return 'unverified';

  const root = resolvePath(projectPath);
  const candidate = isAbsolute(file) ? resolvePath(file) : resolvePath(root, file);
  const rel = relative(root, candidate);
  const escapesRoot = rel === '..' || rel.startsWith(`..${'/'}`) || rel.startsWith('..\\') || isAbsolute(rel);
  if (escapesRoot) return 'unverified';

  try {
    const content = await readFile(candidate);
    return createHash('sha256').update(content).digest('hex');
  } catch (err) {
    // §4c's error taxonomy, reused (never a parallel classification, BUG
    // blind-review finding 3): "the cited file genuinely is not there" is
    // the ONLY case that legitimately degrades to the `'unverified'`
    // sentinel — ENOENT (missing path segment) and ENOTDIR (a path segment
    // that should be a directory is a file, so the target cannot exist)
    // both mean exactly that. Any other failure (EACCES, EPERM, EMFILE,
    // EISDIR, ELOOP, …) is a REAL I/O failure, not a "file doesn't exist"
    // signal, and must surface as `WriteIOError` rather than silently
    // masquerade as an absent citation.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'unverified';
    throw new WriteIOError(err);
  }
}

function enforceAllowedSet(allowed: readonly string[], field: 'kind' | 'status', value: string): void {
  if (allowed.length > 0 && !allowed.includes(value)) {
    throw new InvalidArgumentError(field, `"${value}" is not in this project's allowed ${field} set`);
  }
}

/**
 * `project_policy.requiredFields` is generic, operator-configurable data
 * (§2) — it has no awareness of this verb's own find-or-mint/resolve-only
 * distinctions. Run it against the RESOLVED values (`component`/`kind`/
 * `status` are always a non-blank name by the time this runs — resolved
 * from a given ref, or minted, or defaulted, §6.1/§9 AC-23), never the raw
 * caller input (BUG blind-review finding 4): AC-23's own guarantee is that
 * omitting `component` NEVER throws, and a raw-input check would make an
 * operator-configured `requiredFields: ['component']` violate that
 * regardless of caller intent. Checking the resolved value instead makes
 * the guarantee hold unconditionally, because a resolved `component` is
 * never blank. `priority` stays genuinely optional per its own doc comment
 * (line ~60) — if a project's policy lists it as required and the caller
 * omitted it, `resolvedValues.priority` is `undefined` and this correctly
 * throws; that is the field's documented no-fallback behavior, not a bug.
 */
function enforceRequiredFields(required: readonly string[], resolvedValues: Record<string, unknown>): void {
  for (const field of required) {
    const value = resolvedValues[field];
    if (value === undefined || value === null || (typeof value === 'string' && value.trim().length === 0)) {
      throw new InvalidArgumentError(field, 'is required by this project\'s field policy');
    }
  }
}

/**
 * Create a new issue (§4, §6.3.2). One `immediate` transaction; `skipDedupe:
 * true` on every entity write (§1) via `writeNodeTx`.
 *
 * Errors: `InvalidArgumentError` (missing/blank `title`/`body`/`project`/`by`,
 * or a blank `citations[i].file`), `CatalogNotFoundError('project'|'component'|
 * 'kind'|'status'|'priority'|'agent', ref)` (`'component'` fires only when a
 * name/uid was GIVEN and did not resolve — omitting `component` never throws
 * it), `CitationUnverifiableError(file)` (policy-gated via
 * `project_policy.citation_requires_sha`), `WriteContentionError`/
 * `WriteIOError` (§4c — an exhausted driver-level retry on the underlying
 * `immediate` transaction).
 */
export async function createIssue(handle: IWriteStoreHandle, input: ICreateIssueInput): Promise<ICreateIssueResult> {
  // §6.3's opening rule + §6.3.2's own required-field list — validated
  // before any driver call runs (E_VALIDATION, never retried, §4c).
  assertNonBlank('title', input.title);
  assertNonBlank('body', input.body);
  assertNonBlank('project', input.project);
  assertNonBlank('by', input.by);
  const citations = input.citations ?? [];
  citations.forEach((citation, i) => assertNonBlank(`citations[${i}].file`, citation.file));

  // BUG blind-review finding 2: every citation's `sha` is computed HERE,
  // before `executeWriteTransaction` ever opens the `immediate`-mode
  // transaction, never inside it. `handle.adapter` (a `StoreAdapter`) is a
  // structural superset of `AdapterTransaction` — it exposes the same
  // `executeGet`/`executeAll`/`executeRun`/`exec` — so `resolveProjectTx`
  // can run this same pre-resolve as a plain autocommit read with no lock
  // held, letting `computeCitationSha`'s `fs.readFile` calls run entirely
  // OUTSIDE any write-lock scope. `citation_requires_sha` is enforced here
  // too, for the same reason: it is a pure `E_VALIDATION` decision (no
  // driver call needed to make it) and belongs with every other
  // before-the-transaction check this file already runs (`assertNonBlank`
  // above). The write transaction below re-resolves `project` (and
  // therefore `policy`) fresh against its own `tx` handle — it never reuses
  // the rowid/metadata read here — so the actual writes are authoritative
  // against the transaction's own snapshot; only the already-computed
  // `sha` STRINGS are carried in.
  //
  // Window this opens (deliberately accepted, per finding 2's own ask): a
  // cited file can change or be deleted between this pre-resolve hash and
  // the transaction's commit. §8.5 already documents `citation.sha` as a
  // best-effort content-address computed "on the live write path", not a
  // durable integrity guarantee that continues to hold after the citation
  // is filed (nothing revalidates it later either, e.g. on read) — so a
  // TOCTOU on file *content* here is the same pre-existing best-effort
  // window this design always had, just shortened rather than widened: the
  // OLD code re-read every citation file again on every `E_CONTENTION`
  // retry (a strictly WIDER, per-retry re-open window on the same file),
  // where this fix reads each file exactly once no matter how many times
  // the surrounding transaction retries.
  const preResolvedProject = await resolveProjectTx(handle.adapter, input.project);
  const preResolvedPolicy = resolveProjectPolicy(preResolvedProject);
  const citationShas: string[] = [];
  for (const citation of citations) {
    const sha = await computeCitationSha(preResolvedProject, citation.file);
    if (sha === 'unverified' && preResolvedPolicy.citationRequiresSha) {
      throw new CitationUnverifiableError(citation.file);
    }
    citationShas.push(sha);
  }

  return executeWriteTransaction(handle, async (tx: AdapterTransaction) => {
    // ONE timestamp for every row this logical write produces — the catalog
    // mints, the issue node, each citation node, and every edge. Captured here
    // rather than just before the issue INSERT because the kind/status/priority/
    // agent mints happen first, and letting each `writeNodeTx` stamp its own
    // `nowISO()` is what made a single `createIssue` write rows with differing
    // `t_created`, drifting from both the returned `createdAt` and the audit's `at`.
    const now = nowISO();
    const project = await resolveProjectTx(tx, input.project);
    const policy = resolveProjectPolicy(project);

    const component: IResolvedCatalogRow = input.component !== undefined
      ? await resolveComponentTx(tx, { projectUid: project.uid, ref: input.component })
      : await resolveDefaultComponentTx(tx, { projectRowid: project.rowid });

    const kindName = input.kind ?? policy.defaultKind ?? 'issue';
    const kindRow = await mintOrResolveCatalogTx(tx, { catalogKind: 'kind', ref: kindName, at: now });
    enforceAllowedSet(policy.allowedKinds, 'kind', kindRow.name);

    const statusName = input.status ?? policy.defaultStatus ?? 'open';
    const statusRow = await mintOrResolveCatalogTx(tx, {
      catalogKind: 'status',
      ref: statusName,
      at: now,
      mintMetadata: async () => ({ terminal: false }),
    });
    enforceAllowedSet(policy.allowedStatuses, 'status', statusRow.name);

    let priorityRow: IResolvedCatalogRow | undefined;
    if (input.priority !== undefined) {
      priorityRow = await mintOrResolveCatalogTx(tx, {
        catalogKind: 'priority',
        ref: input.priority,
        at: now,
        mintMetadata: async (mintTx) => ({ rank: await nextPriorityRankTx(mintTx) }),
      });
    }

    const authorName = input.author ?? input.by;
    const authorRow = await mintOrResolveCatalogTx(tx, { catalogKind: 'agent', ref: authorName, at: now });

    enforceRequiredFields(policy.requiredFields, {
      ...input,
      component: component.name,
      kind: kindRow.name,
      status: statusRow.name,
      priority: priorityRow?.name,
    });

    const issueMetadata: Record<string, unknown> = {};
    if (input.assignee !== undefined) issueMetadata.assignee = input.assignee;

    const issue = await writeNodeTx(tx, { kind: 'issue', name: input.title, content: input.body, metadata: issueMetadata, at: now });

    const ownsComponentRule = await resolveEdgeKindTx(tx, 'owns_component');
    await writeEdgeTx(tx, {
      at: now,
      srcRowid: component.rowid, srcUid: component.uid, srcKind: 'component',
      dstRowid: issue.rowid, dstUid: issue.uid, dstKind: 'issue',
      rel: 'owns_component', rule: ownsComponentRule, typePolicy: handle.typePolicy,
    });

    const hasKindRule = await resolveEdgeKindTx(tx, 'has_kind');
    await writeEdgeTx(tx, {
      at: now,
      srcRowid: issue.rowid, srcUid: issue.uid, srcKind: 'issue',
      dstRowid: kindRow.rowid, dstUid: kindRow.uid, dstKind: 'kind',
      rel: 'has_kind', rule: hasKindRule, typePolicy: handle.typePolicy,
    });

    const hasStatusRule = await resolveEdgeKindTx(tx, 'has_status');
    await writeEdgeTx(tx, {
      at: now,
      srcRowid: issue.rowid, srcUid: issue.uid, srcKind: 'issue',
      dstRowid: statusRow.rowid, dstUid: statusRow.uid, dstKind: 'status',
      rel: 'has_status', rule: hasStatusRule, typePolicy: handle.typePolicy,
    });

    if (priorityRow) {
      const hasPriorityRule = await resolveEdgeKindTx(tx, 'has_priority');
      await writeEdgeTx(tx, {
      at: now,
        srcRowid: issue.rowid, srcUid: issue.uid, srcKind: 'issue',
        dstRowid: priorityRow.rowid, dstUid: priorityRow.uid, dstKind: 'priority',
        rel: 'has_priority', rule: hasPriorityRule, typePolicy: handle.typePolicy,
      });
    }

    const authoredByRule = await resolveEdgeKindTx(tx, 'authored_by');
    await writeEdgeTx(tx, {
      at: now,
      srcRowid: issue.rowid, srcUid: issue.uid, srcKind: 'issue',
      dstRowid: authorRow.rowid, dstUid: authorRow.uid, dstKind: 'agent',
      rel: 'authored_by', rule: authoredByRule, typePolicy: handle.typePolicy,
    });

    if (citations.length > 0) {
      const hasCitationRule = await resolveEdgeKindTx(tx, 'has_citation');
      for (let i = 0; i < citations.length; i += 1) {
        const citation = citations[i];
        // §8.5's sha is already computed (and policy-gated) BEFORE this
        // transaction opened, above — see the `preResolvedProject`/
        // `citationShas` block. This loop only writes the already-decided
        // value; it never re-reads the filesystem inside the write lock
        // (BUG blind-review finding 2).
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
          srcRowid: issue.rowid, srcUid: issue.uid, srcKind: 'issue',
          dstRowid: citationNode.rowid, dstUid: citationNode.uid, dstKind: 'citation',
          rel: 'has_citation', rule: hasCitationRule, typePolicy: handle.typePolicy,
        });
      }
    }

    await writeAudit({
      tx,
      typePolicy: handle.typePolicy,
      subjectRowid: issue.rowid,
      subjectUid: issue.uid,
      subjectKind: 'issue',
      actor: input.by,
      action: 'created',
      at: now,
    });

    return {
      created: true as const,
      uid: issue.uid,
      item: {
        uid: issue.uid,
        title: input.title,
        kind: kindRow.name,
        status: statusRow.name,
        priority: priorityRow?.name,
        project: project.uid,
        component: component.uid,
        createdAt: now,
        assignee: input.assignee,
        author: authorRow.name,
      },
    };
  });
}
