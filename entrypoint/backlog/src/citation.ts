/**
 * citation.ts — the ONE citation contract (leaf module, zero imports).
 *
 * ## Why this module exists
 *
 * A citation used to be described by TWO independent, drifting shapes:
 *
 *  - the **persisted** encoding `create-issue.ts`/`transition.ts` wrote into a
 *    `citation` node's `meta` — `{ target, target_type, sha, line, at }` (plus
 *    the unconsumed `symbol`/`blastRadius`); and
 *  - the **transport** input `ICitationInput` a caller supplied —
 *    `{ file, lines?, context?, symbol?, blastRadius? }`,
 *
 * with `query/card.ts` hand-inverting one into the other at read time. There
 * was no single definition of "a citation": a field added to one side silently
 * failed to round-trip, and the read projection lived in the query layer while
 * the write encoding lived in the write layer. `DATA_MODEL.md` §4 documented
 * the persisted set, `SPEC.md` §6.3.2 documented the transport set, and neither
 * was the source of truth for the other.
 *
 * This module is that one source. `ICitation` is THE typed contract; the
 * persisted encoding is an implementation detail produced by exactly one
 * function ({@link citationNodeMetadata}) and read back by exactly one function
 * ({@link citationFromNode}). Nothing else in the package may hand-roll either
 * direction.
 *
 * It is a LEAF with zero imports on purpose: it is imported by the write
 * verbs, by the query read projection (`query/card.ts`), and by the pure type
 * barrel (`query/types.ts`), so it must never drag the write or query graph
 * into a consumer that only needs the shape.
 *
 * ## The `revision` field — citing against a git revision, not just the tree
 *
 * A citation whose file exists only on an unmerged branch could not be filed
 * at all: the working-tree sha gate (`citation-path.ts` + `computeCitationSha`)
 * read the file from the checked-out tree, found nothing, and refused. The
 * optional {@link ICitation.revision} names a git revision (branch/tag/sha) the
 * target is resolved against instead — `git show <revision>:<path>` — so
 * branch-only evidence is citable. The revision is persisted verbatim on the
 * citation node (`meta.revision`) and surfaced on read, so a reader can tell a
 * working-tree citation from a revision-pinned one.
 */

/**
 * The ONE citation contract — a caller-facing citation, and the shape every
 * read projection extends. This is what `SPEC.md` §6.3.2's `Citation` and
 * `DATA_MODEL.md` §4's `citation` node both mean.
 *
 * Field vocabulary (the reconciliation): the persisted node stores
 * `file` as `meta.target` and `lines` as `meta.line` (the graph-native names
 * `DATA_MODEL.md` §4 fixes), but the CONTRACT a consumer passes and receives is
 * always `file`/`lines` — never `target`/`line`. The two are bridged ONLY by
 * {@link citationNodeMetadata}/{@link citationFromNode}, never at a call site.
 */
export interface ICitation {
  /** The cited target — a repo-relative or absolute filesystem path (the persisted `meta.target`). REQUIRED and non-blank. */
  file: string;
  /**
   * The line or line-range WITHIN `file` (the persisted `meta.line`). OPTIONAL —
   * a whole-file citation omits it. Kept a free `string` (e.g. `"120-140"`) so
   * a caller is not forced to narrow to a single integer.
   *
   * `lines` (pl.) is the CONTRACT name; `line` is the persisted one end. Both
   * spellings intentionally diverge from the persisted key — see this
   * interface's own doc comment.
   */
  lines?: string;
  /**
   * Free-text prose for THIS citation. Persisted as the citation node's
   * `content` column (never its `meta`), which is what {@link citationFromNode}
   * reads back into this field. NOT the item-level disclosure-contract git
   * context — that lives on the issue (`gitContext`) and is rendered once at
   * the head of its `Citations:` block, never per-citation.
   */
  context?: string;
  /** The named symbol (`function`/`class`/`method`) this citation points at, when narrower than a whole file. */
  symbol?: string;
  /**
   * Best-effort enrichment payload carried through verbatim. Not re-specified
   * here (SPEC.md §6.3.2 declares it `CitationBlastRadius`, a type that exists
   * nowhere in the package): the write layer has always stored whatever
   * JSON-serializable value a caller passed and `similarity-scan.ts` reads it
   * only when it is a string. Typed `unknown` to match that existing behavior
   * exactly rather than introducing a third, narrower shape.
   */
  blastRadius?: unknown;
  /**
   * A git revision (branch/tag/sha) the `file` is resolved against, instead of
   * the working tree. Present only for revision-pinned citations — see this
   * module's header. Persisted as `meta.revision`.
   */
  revision?: string;
}

/**
 * The pre-unification name of the transport contract, kept as an alias so an
 * existing importer (`write/transition.ts`) compiles unchanged. New code
 * should use `ICitation`; this name means the SAME declaration, never a second
 * shape.
 */
export type ICitationInput = ICitation;

/**
 * A citation as PROJECTED FOR READ — the contract plus the server-computed
 * identity (`uid`), content-address (`sha`), and filing instant (`at`), and the
 * persisted `target_type` (today always `'path'`). `query/types.ts`'s
 * `IIssueCitation` extends this, so the read surface and the write surface can
 * never drift.
 */
export interface ICitationRecord extends ICitation {
  /** The citation node's own uid — the identity `removeCitation` addresses (never a `(target,line)` composite). */
  uid: string;
  /** `sha256` of the cited content at filing time, or the fixed sentinel `"unverified"` (§8.5). */
  sha: string;
  /** The filing instant (the node's own `meta.at`, falling back to `t_created` for a legacy row). */
  at: string;
  /** The persisted target discriminator (`'path'` today). Optional so a legacy row without one still projects. */
  targetType?: string;
}

/**
 * The minimal node view {@link citationFromNode} needs — a structural subset of
 * `@adhd/sox-graph-store`'s `NodeRecord` (and of the write layer's
 * `ITxNodeRow`), so neither type has to be imported here.
 */
export interface ICitationNodeView {
  uid: string;
  /** `string | null` from the write layer's `ITxNodeRow`, `string | undefined` from the query layer's `NodeRecord` — both accepted. */
  name: string | null | undefined;
  content: string;
  metadata: Record<string, unknown> | undefined;
  tCreated: string;
}

/**
 * Encode a citation into the `citation` node's `meta` blob — the ONE writer of
 * the persisted citation encoding. `sha` is computed by the caller (the write
 * layer's sha gate) and `at` is the write's single logical timestamp, so both
 * are passed in rather than recomputed here.
 *
 * `file` is stored as `target`, `lines` as `line` (the graph-native keys
 * `DATA_MODEL.md` §4 fixes). `revision` is always present (`null` when absent),
 * so a stored citation node's shape does not vary by presence of the field.
 */
export function citationNodeMetadata(
  citation: ICitation,
  sha: string,
  at: string
): Record<string, unknown> {
  return {
    target: citation.file,
    target_type: 'path',
    sha,
    line: citation.lines ?? null,
    at,
    symbol: citation.symbol ?? null,
    blastRadius: citation.blastRadius ?? null,
    revision: citation.revision ?? null,
  };
}

/**
 * Decode a `citation` node back into the contract + the server fields — the ONE
 * reader of the persisted citation encoding. Every field the write side
 * persists round-trips: `file`↔`target`, `lines`↔`line`, `context`↔`content`,
 * `symbol`, `blastRadius`, `revision`.
 *
 * Defensive on a malformed/legacy row (mirrors the mapping `query/card.ts`
 * previously hand-rolled, verbatim): a missing `sha` degrades to the
 * `"unverified"` sentinel (never a fabricated hash), and a missing `at` to the
 * node's `t_created`. A malformed `meta` never throws — the caller gets a
 * best-effort projection, never a crash.
 */
export function citationFromNode(node: ICitationNodeView): ICitationRecord {
  const md = node.metadata ?? {};
  return {
    uid: node.uid,
    file: typeof md['target'] === 'string' ? md['target'] : node.name ?? '',
    lines: typeof md['line'] === 'string' ? md['line'] : undefined,
    context: node.content || undefined,
    symbol: typeof md['symbol'] === 'string' ? md['symbol'] : undefined,
    blastRadius: md['blastRadius'] ?? undefined,
    revision: typeof md['revision'] === 'string' ? md['revision'] : undefined,
    sha: typeof md['sha'] === 'string' ? md['sha'] : 'unverified',
    at: typeof md['at'] === 'string' ? md['at'] : node.tCreated,
    targetType:
      typeof md['target_type'] === 'string' ? md['target_type'] : undefined,
  };
}

/**
 * The identity used to DIFF a desired citation set against the live one
 * (`update`'s citations diff): `file`, `lines`, AND `revision`. Deliberately
 * excludes `sha`/`context`/`symbol`/`blastRadius` — the diff is add-or-remove
 * on the citation's TARGET, never an in-place descriptive edit (a citation is
 * content-addressed evidence; changing its prose is a new citation, so the old
 * one is removed and the new one added).
 *
 * `revision` IS part of the identity, unlike those descriptive fields: two
 * citations of the same `(file, lines)` resolved against DIFFERENT revisions
 * are different evidence, so a desired set that changes only a citation's
 * revision is a genuine remove+add, never a silent no-op.
 *
 * A `\u0000` separator makes the key unambiguous (`"a.ts" + "1"` can never
 * collide with `"a.ts1" + ""`).
 */
export function citationKey(
  citation: Pick<ICitation, 'file' | 'lines' | 'revision'>
): string {
  return `${citation.file}\u0000${citation.lines ?? ''}\u0000${
    citation.revision ?? ''
  }`;
}

/**
 * {@link citationKey} for a persisted metadata blob (a live citation node),
 * reading the same `target`/`line`/`revision` ends
 * {@link citationNodeMetadata} wrote.
 */
export function citationKeyFromMetadata(
  metadata: Record<string, unknown> | undefined
): string {
  const md = metadata ?? {};
  const file = typeof md['target'] === 'string' ? md['target'] : '';
  const lines = typeof md['line'] === 'string' ? md['line'] : '';
  const revision = typeof md['revision'] === 'string' ? md['revision'] : '';
  return `${file}\u0000${lines}\u0000${revision}`;
}
