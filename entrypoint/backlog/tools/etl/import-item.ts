/**
 * import-item.ts — Pass 1's per-issue transaction body (SPEC.md §8.6 step
 * 5 / §8.8): one source item's FULL bundle — issue node, catalog edges,
 * citations, notes, transitions, import audit, and (when the source node
 * was not live) the immediate invalidate — all inside ONE
 * `executeWriteTransaction` (`{mode:'immediate'}`), or none of it lands.
 *
 * Every hand-composed write in here (project/component resolve, catalog
 * mint, node/edge writes, audit) runs against the SAME `tx` the caller's
 * `executeWriteTransaction` callback receives — never a bare
 * `handle.adapter` call, never the frozen library's own
 * `findOrCreateNode`/`writeNode`/`writeEdge`.
 */
import type { AdapterTransaction } from '@adhd/sox-store-adapter';
import {
  mintOrResolveCatalogTx,
  nextPriorityRankTx,
  resolveDefaultComponentTx,
  resolveEdgeKindTx,
  type IResolvedProjectRow,
} from '../../src/write/catalog.js';
import { writeAudit } from '../../src/write/audit.js';
import { type IWriteStoreHandle, canonicalJSONStringify, executeWriteTransaction, nowISO, sha256Hex, writeEdgeTx, writeNodeTx } from '../../src/write/tx.js';
import { upsertComponentTx } from './catalog-upsert.js';
import { computeCitationSha, citationTargetType, parseStartLine } from './citation.js';
import { reconstructTransitions } from './transitions.js';
import { buildProvenance } from './identity.js';
import { ETL_ACTOR, IMPORTED_ACTION, MISSING_CITATION_FILE, PRIORITY_RANK, TERMINAL_STATUSES } from './constants.js';
import type { IItemRow, IRawAuditMeta } from './corpus-types.js';

export interface IImportItemInput {
  handle: IWriteStoreHandle;
  item: IItemRow;
  /** The item's raw `repo` string, ALREADY resolved through the `meta.repo ?? node.namespace` fallback (`toBacklogItem`'s own rule) — verbatim, pre-normalization. */
  rawRepo: string;
  /** The NORMALIZED project row this item's `rawRepo` resolves to (SPEC.md §8.4) — resolved-only here; project seeding is a separate up-front pass (§8.6 step 3). */
  project: IResolvedProjectRow;
  /** This item's own real transition-kind audit events, chronologically sorted (may be empty). */
  transitionEvents: readonly IRawAuditMeta[];
  /** `"adhd"`'s known filesystem path, or `undefined` for every other project (SPEC.md §8.4/§8.5). */
  adhdProjectPath: string | undefined;
}

export interface IImportItemResult {
  uid: string;
  citationsUnverified: number;
  citationsVerified: number;
  /** Citations with no `file` at all (a genuine source-data anomaly — see `MISSING_CITATION_FILE`). A subset of `citationsUnverified`, broken out so it is never mistaken for an ordinary "file not found" unverified citation. */
  citationsMalformed: number;
}

/**
 * Imports one source backlog-item row. Citation SHAs are computed BEFORE the
 * transaction opens (mirrors `create-issue.ts`'s own documented reasoning:
 * keep `fs.readFile` calls outside the `immediate`-mode write-lock window),
 * then written as already-decided string values inside it.
 */
export async function importItem(input: IImportItemInput): Promise<IImportItemResult> {
  const { handle, item, rawRepo, project, transitionEvents, adhdProjectPath } = input;
  const meta = item.itemMeta;
  const citations = meta.citations ?? [];

  const citationShas = await Promise.all(citations.map((c) => computeCitationSha(adhdProjectPath, c.file)));
  const citationsVerified = citationShas.filter((c) => c.verified).length;
  const citationsUnverified = citationShas.length - citationsVerified;
  const citationsMalformed = citations.filter((c) => typeof c.file !== 'string' || c.file.length === 0).length;

  const { transitions, consumedNoteIndices, firstTerminalTransitionAt } = reconstructTransitions(meta, transitionEvents);

  const uid = await executeWriteTransaction(handle, async (tx: AdapterTransaction) => {
    const now = nowISO();

    const component = meta.projectPath !== undefined
      ? await upsertComponentTx(tx, { projectUid: project.uid, name: meta.projectPath, at: now })
      : await resolveDefaultComponentTx(tx, { projectRowid: project.rowid });

    const kindName = meta.kind ?? 'issue';
    const kindRow = await mintOrResolveCatalogTx(tx, { catalogKind: 'kind', ref: kindName, at: now });

    const statusName = meta.status ?? 'UNKNOWN';
    const statusRow = await mintOrResolveCatalogTx(tx, {
      catalogKind: 'status',
      ref: statusName,
      at: now,
      mintMetadata: async () => ({ terminal: TERMINAL_STATUSES.has(statusName) }),
    });

    let priorityRow: { rowid: number; uid: string; name: string } | undefined;
    if (meta.priority !== undefined) {
      priorityRow = await mintOrResolveCatalogTx(tx, {
        catalogKind: 'priority',
        ref: meta.priority,
        at: now,
        mintMetadata: async (mintTx) => {
          const rank = meta.priority !== undefined && meta.priority in PRIORITY_RANK ? PRIORITY_RANK[meta.priority] : await nextPriorityRankTx(mintTx);
          return { rank };
        },
      });
    }

    let authorRow: { rowid: number; uid: string; name: string } | undefined;
    if (meta.author !== undefined) {
      authorRow = await mintOrResolveCatalogTx(tx, { catalogKind: 'agent', ref: meta.author, at: now });
    }

    // §6.2/create-issue.ts's real shipped shape: `assignee`/`closedAt` are
    // SINGLE-level scalar keys directly on the issue's own `meta` — SPEC.md
    // §8.1's "issue.meta.metadata.closedAt" prose is inconsistent with this
    // (see the ETL run report's `specGaps`); the actual write verb's code is
    // followed here as ground truth.
    const issueMetadata: Record<string, unknown> = {};
    if (meta.assignee !== undefined) issueMetadata.assignee = meta.assignee;
    const isCurrentlyTerminal = TERMINAL_STATUSES.has(statusName);
    if (isCurrentlyTerminal) {
      issueMetadata.closedAt = firstTerminalTransitionAt ?? meta.updatedAt ?? now;
    }

    const issue = await writeNodeTx(tx, { kind: 'issue', name: meta.title ?? '', content: meta.body ?? '', metadata: issueMetadata, at: now });

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

    if (authorRow) {
      const authoredByRule = await resolveEdgeKindTx(tx, 'authored_by');
      await writeEdgeTx(tx, {
        at: now,
        srcRowid: issue.rowid, srcUid: issue.uid, srcKind: 'issue',
        dstRowid: authorRow.rowid, dstUid: authorRow.uid, dstKind: 'agent',
        rel: 'authored_by', rule: authoredByRule, typePolicy: handle.typePolicy,
      });
    }

    if (citations.length > 0) {
      const hasCitationRule = await resolveEdgeKindTx(tx, 'has_citation');
      for (let i = 0; i < citations.length; i += 1) {
        const citation = citations[i];
        const { sha } = citationShas[i];
        const file = typeof citation.file === 'string' && citation.file.length > 0 ? citation.file : MISSING_CITATION_FILE;
        const citationNode = await writeNodeTx(tx, {
          at: now,
          kind: 'citation',
          name: file,
          content: citation.context ?? file,
          metadata: {
            target: file,
            target_type: citationTargetType(file),
            sha,
            line: parseStartLine(citation.lines) ?? null,
            at: meta.updatedAt ?? now, // source citations carry no timestamp of their own — reuses `updatedAt` as the same best-effort proxy `auditTrail()` already used (SPEC.md §8.2).
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

    const remainingNotes = (meta.notes ?? []).filter((_, i) => !consumedNoteIndices.has(i));
    if (remainingNotes.length > 0) {
      const hasNoteRule = await resolveEdgeKindTx(tx, 'has_note');
      for (const note of remainingNotes) {
        const noteNode = await writeNodeTx(tx, {
          at: now,
          kind: 'note',
          content: note.text,
          metadata: { author: note.by, text: note.text, at: note.at },
        });
        await writeEdgeTx(tx, {
          at: now,
          srcRowid: issue.rowid, srcUid: issue.uid, srcKind: 'issue',
          dstRowid: noteNode.rowid, dstUid: noteNode.uid, dstKind: 'note',
          rel: 'has_note', rule: hasNoteRule, typePolicy: handle.typePolicy,
        });
      }
    }

    if (transitions.length > 0) {
      const hasTransitionRule = await resolveEdgeKindTx(tx, 'has_transition');
      for (const t of transitions) {
        const canonicalFields = { from_status: t.from_status, to_status: t.to_status, agent: t.agent, note: t.note, at: t.at };
        const sha = sha256Hex(canonicalJSONStringify(canonicalFields));
        const transitionNode = await writeNodeTx(tx, {
          at: now,
          kind: 'transition',
          name: `${t.from_status ?? 'UNKNOWN'} → ${t.to_status}`,
          content: t.note,
          metadata: { ...canonicalFields, sha },
        });
        await writeEdgeTx(tx, {
          at: now,
          srcRowid: issue.rowid, srcUid: issue.uid, srcKind: 'issue',
          dstRowid: transitionNode.rowid, dstUid: transitionNode.uid, dstKind: 'transition',
          rel: 'has_transition', rule: hasTransitionRule, typePolicy: handle.typePolicy,
        });
      }
    }

    const provenance = buildProvenance(item.rowid, rawRepo, item._extract.tags_parsed, meta);
    await writeAudit({
      tx,
      typePolicy: handle.typePolicy,
      subjectRowid: issue.rowid,
      subjectUid: issue.uid,
      subjectKind: 'issue',
      actor: ETL_ACTOR,
      action: IMPORTED_ACTION,
      note: JSON.stringify(provenance),
      at: now,
    });

    // §8.6 step 5's final clause: historically superseded/dropped-duplicate
    // ancestors are imported THEN immediately invalidated, using the SAME
    // hand-composed UPDATE `delete.ts` runs (never the library's bare
    // `invalidate`, which autocommits outside this transaction).
    if (item._extract.state === 'invalidated') {
      const reason = item._extract.invalidated_reason ?? meta.invalidatedReason ?? 'invalidated in source (no reason recorded)';
      const invalidatedAt = meta.invalidatedAt ?? item.t_invalid ?? now;
      const mergedMeta = { ...issueMetadata, invalidatedReason: reason, invalidatedAt };
      const result = await tx.executeRun('UPDATE node SET t_invalid = ?, meta = ? WHERE rowid = ? AND t_invalid IS NULL', [invalidatedAt, JSON.stringify(mergedMeta), issue.rowid]);
      if (result.rowsAffected !== 1) {
        throw new Error(`importItem: invalidate UPDATE affected ${result.rowsAffected} rows for freshly-written issue uid="${issue.uid}", expected exactly 1.`);
      }
    }

    return issue.uid;
  });

  return { uid, citationsUnverified, citationsVerified, citationsMalformed };
}
