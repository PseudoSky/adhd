/**
 * mapping.ts — BacklogItem <-> graph node/edge (DESIGN.md §2).
 *
 * `kind: 'generic'` is used for backlog items (the closed `NodeMeta.kind`
 * enum has no `'backlog-item'` variant — DESIGN.md §2.1). `namespace` is the
 * repo slug (hard graph partition — SPEC.md §3). `metadata` carries every
 * other `BacklogItem` field verbatim as JSON (DESIGN.md §2.2).
 *
 * DEVIATION from DESIGN.md §2.2's literal `content = \`${title}\n\n${body}\``:
 * `@adhd/sox-graph-store`'s `writeNode()` dedupes by
 * `sha256(content.trim().toLowerCase())` GLOBALLY (not scoped by namespace/
 * repo) and, on a hash collision, silently RETURNS THE EXISTING node id
 * without applying the new node's meta at all (verified by reading
 * `~/dev/ai/sox-ecosystem/libs/data/graph/graph-store/src/index.ts`'s
 * `writeNode()`). Two different backlog items in two different repos with
 * byte-identical (case-insensitive, trim-insensitive) title+body would
 * therefore silently collapse into ONE node, permanently losing the second
 * item's data. `buildNodeContent` appends an HTML-comment uniqueness marker
 * carrying `repo::humanId` (globally unique, allocated via the same CAS
 * primitive as claims) so this can never happen — negligible FTS noise, zero
 * loss-of-data risk. Filed as DEBT-BACKLOG-CONTENT-HASH-COLLISION-001.
 */
import { createHash } from 'node:crypto';
import type { NodeRecord } from '@adhd/sox-graph-store';
import type { BacklogItem, BacklogStatus, Citation, Note, Priority } from '../model.js';

export const BACKLOG_ITEM_TAG = 'backlog-item';
export const BACKLOG_PLAN_TAG = 'backlog-plan';
export const BACKLOG_ASSIGNEE_TAG = 'backlog-assignee';
const CONTENT_MARKER_PREFIX = 'adhd-backlog:';

/**
 * Mirrors `@adhd/sox-graph-store`'s PRIVATE (unexported) `hashContent()`
 * (`sha256(content.trim().toLowerCase())`) exactly. Needed only by
 * `updateItemNode` (crud.ts), which writes `node.content`/`node.content_hash`
 * directly via raw SQL (DESIGN.md §14's sanctioned escape hatch for the one
 * gap `touch()` doesn't cover — DEBT-BACKLOG-CONTENT-IMMUTABLE-001) and must
 * keep `content_hash` consistent with the `content` it just wrote, exactly as
 * `writeNode()` would have. If upstream ever changes its normalization, this
 * copy must change with it — there is no shared primitive to import instead.
 */
export function computeContentHash(content: string): string {
  return createHash('sha256').update(content.trim().toLowerCase()).digest('hex');
}

/**
 * `@adhd/sox-graph-store`'s `searchNodes(query)` binds `query` DIRECTLY as an
 * FTS5 `MATCH` argument, parsed by FTS5's own boolean/column-filter query
 * grammar — NOT a plain-text search. `searchNodes`'s own `query.replace(/"/g,
 * '""')` cannot make this safe for arbitrary text: doubling an EXISTING `"`
 * always yields an EVEN number of quote characters in the output, so a
 * caller can never end up with a validly single-quoted phrase this way
 * (verified empirically — wrapping a title in quotes before calling
 * `searchNodes` still throws). A title containing a bare `-`, `:`, `(`, `)`,
 * or `"` (all real English titles — "off-by-one", "fix: the thing" — not
 * edge cases) crashes `createItemNode`'s dedupe scan outright with a raw
 * `SqliteError`, since `force:true` (the only path that SKIPS the dedupe
 * scan) is not the default. `dedupeScan` (crud.ts) uses this to strip every
 * FTS5-syntax-significant character to a space before searching — this is
 * BEHAVIOR-PRESERVING for the already-working case (a title with no special
 * characters passes through unchanged, still an implicit-AND bareword
 * query), and merely prevents the CRASH for the common case that hits one.
 */
export function sanitizeFtsQuery(text: string): string {
  return text
    .replace(/["():^*]|-/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * The JSON shape persisted in `node.meta` (DESIGN.md §2.2/§4.1). Every
 * mutating store operation reads the CURRENT full object, computes a new
 * COMPLETE object, and writes it back via `mutateMetadata` — `touch()`
 * replaces `meta` wholesale (verified, DESIGN.md §14 point 4), so a partial
 * write here would silently drop every other field.
 */
export interface BacklogNodeMeta {
  humanId: string;
  kind: string;
  family: string;
  title: string;
  body: string;
  status: BacklogStatus;
  priority?: Priority;
  repo: string;
  projectPath?: string;
  plan?: string;
  /** Source markdown path this item was imported from, if any (DEBT-BACKLOG-IMPORT-PLAN-PROVENANCE-001). */
  importedFrom?: string;
  assignee?: string;
  claimedBy?: string;
  claimedAt?: string;
  citations: Citation[];
  notes: Note[];
  createdAt: string;
  updatedAt: string;
  /** Set by archiveResolved — excludes the item from renderToMarkdown's default view. */
  archivedAt?: string;
  /** Dedupe-scan exact-match fields (DESIGN.md §2.4). */
  dedupeSymbol?: string;
  dedupePath?: string;
  dedupeErrorText?: string;
}

export function humanIdKind(humanId: string): string {
  return humanId.split('-')[0] ?? humanId;
}

export function humanIdFamily(humanId: string): string {
  return humanId.replace(/-\d+$/, '');
}

/** See the file-level DEVIATION doc comment for why the marker is appended. */
export function buildNodeContent(repo: string, humanId: string, title: string, body: string): string {
  return `${title}\n\n${body}\n\n<!-- ${CONTENT_MARKER_PREFIX}${repo}::${humanId} -->`;
}

export function buildNodeName(repo: string, humanId: string): string {
  return `${repo}::${humanId}`;
}

/** DESIGN.md §2.2 — importance derived deterministically from priority. */
export function importanceForPriority(priority: Priority | undefined): number {
  switch (priority) {
    case 'CRITICAL':
      return 10;
    case 'HIGH':
      return 8;
    case 'MEDIUM':
      return 5;
    case 'LOW':
      return 2;
    default:
      return 1;
  }
}

export function buildTags(kind: string, family: string, userTags: readonly string[] = []): string[] {
  return [...new Set<string>([BACKLOG_ITEM_TAG, kind, family, ...userTags])];
}

/** A node counts as a live backlog item iff it carries the tag AND is not superseded (DESIGN.md §14). */
export function isLiveBacklogItemNode(node: NodeRecord): boolean {
  return node.tags.includes(BACKLOG_ITEM_TAG) && !node.isSuperseded;
}

export function toBacklogItem(node: NodeRecord): BacklogItem {
  const meta = (node.metadata ?? {}) as Partial<BacklogNodeMeta>;
  const humanId = meta.humanId ?? '';
  const kind = meta.kind ?? humanIdKind(humanId);
  const family = meta.family ?? humanIdFamily(humanId);
  const reservedTags = new Set<string>([BACKLOG_ITEM_TAG, kind, family]);
  return {
    nodeId: node.id,
    humanId,
    kind,
    family,
    title: meta.title ?? node.summary ?? '',
    body: meta.body ?? '',
    status: meta.status ?? 'UNKNOWN',
    priority: meta.priority,
    repo: meta.repo ?? node.namespace,
    projectPath: meta.projectPath,
    plan: meta.plan,
    importedFrom: meta.importedFrom,
    assignee: meta.assignee,
    claimedBy: meta.claimedBy,
    claimedAt: meta.claimedAt,
    citations: meta.citations ?? [],
    notes: meta.notes ?? [],
    tags: node.tags.filter((t) => !reservedTags.has(t)),
    createdAt: meta.createdAt ?? node.tCreated,
    updatedAt: meta.updatedAt ?? meta.createdAt ?? node.tCreated,
  };
}
