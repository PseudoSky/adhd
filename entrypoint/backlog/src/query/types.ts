/**
 * types.ts — the read/query-layer's own shared types (SPEC.md §5, §5a, §6.1, §6.5).
 *
 * These are the TYPESCRIPT shapes for the `get`/`query` verbs (§6.3.1, §6.5)
 * and the §3a registry read views. They intentionally mirror SPEC.md's own
 * `IIssue*`/`IProject*` interfaces field-for-field — this file is the single
 * place those interfaces are declared for the read layer; `get.ts`/`query.ts`/
 * `registry.ts` all import from here rather than re-declaring their own
 * copies, and the six sibling write verbs (`update`/`transition`/`claim`/
 * `relate`/`move`/`delete`) should import {@link IIssueCard} /
 * {@link IIssueField} from here too, rather than re-declaring a third copy
 * alongside `create-issue.ts`'s own `IIssueCard` (see this module's own
 * top-level doc comment in `index.ts` for the reconciliation note).
 */

import type {
  IObligationAppliesTo,
  IObligationOverride,
  IObligationSeverity,
  IPredicate,
} from '../write/obligation.js';

/** Identity is the global `uid` (SPEC.md §6.1) — a single scalar, never a composite key. */
export type IssueUid = string;

/**
 * The closed field vocabulary a `get`/`query` caller may request (SPEC.md
 * §6.5). `assertKnownFields` (this module's {@link assertKnownIssueFields})
 * rejects any name outside this union with a `BacklogValidationError` naming
 * it — never a silent drop.
 *
 * `plain` fields are cheap: each is either a column on the `issue` node
 * itself or a scalar living in `issue.meta.metadata` (`assignee`, `closedAt`,
 * `gitContext` — SPEC.md §6.5's own reclassification of `closedAt` as
 * `plain`, since it is read in the SAME single-row fetch as `assignee`, not a
 * second query; `gitContext` is the item-level disclosure-contract git
 * context, a sibling of `assignee` in the same metadata blob).
 *
 * `pseudo` fields are opt-in only: each costs a genuine extra read (an edge
 * traversal to another node kind, or only exists on a `searchRanked`
 * response) and is therefore NEVER included in the default card.
 */
export type IIssuePlainField =
  | 'uid'
  | 'title'
  | 'kind'
  | 'status'
  | 'priority'
  | 'project'
  | 'component'
  | 'createdAt'
  | 'updatedAt'
  | 'assignee'
  | 'author'
  | 'closedAt'
  | 'gitContext';

export type IIssuePseudoField =
  | 'body'
  | 'citations'
  | 'notes'
  | 'auditTrail'
  | 'blockers'
  | 'related'
  | '_score'
  | '_vector'
  | 'blocksOut' // NEW (C2): issues THIS one blocks (outbound `blocks`), live only
  | 'dependents' // NEW (C2): transitive count (number of nodes that reach this one via `blocks`)
  | 'partOf' // NEW (C2): the single parent this item is `part_of` (or null)
  | 'obligations' // NEW (C4): the declared, typed requirements on this item
  | 'verdict'; // NEW (C6): the derived actionability verdict (never stored)

export type IIssueField = IIssuePlainField | IIssuePseudoField;

export const ISSUE_PLAIN_FIELDS: readonly IIssuePlainField[] = [
  'uid',
  'title',
  'kind',
  'status',
  'priority',
  'project',
  'component',
  'createdAt',
  'updatedAt',
  'assignee',
  'author',
  'closedAt',
  'gitContext',
];

export const ISSUE_PSEUDO_FIELDS: readonly IIssuePseudoField[] = [
  'body',
  'citations',
  'notes',
  'auditTrail',
  'blockers',
  'related',
  '_score',
  '_vector',
  'blocksOut',
  'dependents',
  'partOf',
  'obligations',
  'verdict',
];

const ISSUE_FIELD_SET: ReadonlySet<string> = new Set<string>([
  ...ISSUE_PLAIN_FIELDS,
  ...ISSUE_PSEUDO_FIELDS,
]);

export function isKnownIssueField(name: string): name is IIssueField {
  return ISSUE_FIELD_SET.has(name);
}

/** SPEC.md §6.5: "Default (`fields` omitted): the exact five-field terse card established by `DEFAULT_CARD_FIELDS`." */
export const DEFAULT_ISSUE_CARD_FIELDS: readonly IIssuePlainField[] = [
  'uid',
  'kind',
  'title',
  'status',
  'priority',
];

/** A citation, projected for read (mirrors the write layer's `ICitationInput` shape plus the server-computed `sha`). */
export interface IIssueCitation {
  uid: string;
  file: string;
  lines?: string;
  /**
   * Free-text prose for this citation (the write layer's `ICitationInput.context`).
   * NOT the item's disclosure-contract git context — that is ITEM-level
   * provenance and lives on {@link IIssueCard.gitContext}, a sibling of
   * `assignee`, rendered once at the head of the `Citations:` block. This
   * per-citation `context` is never rendered by `markdown.ts` and cannot carry
   * the git context.
   */
  context?: string;
  symbol?: string;
  sha: string;
  at: string;
}

export interface IIssueNote {
  uid: string;
  author: string;
  text: string;
  at: string;
}

export interface IIssueAuditEntry {
  uid: string;
  actor: string;
  action: string;
  from?: string;
  to?: string;
  note?: string;
  sha: string;
  at: string;
}

/** A minimal cross-reference to another issue — used by the `blockers`/`related` pseudo-fields. */
export interface IIssueRef {
  uid: string;
  title: string;
  status: string;
  /**
   * Which live relation produced this ref (C2 — structural legibility).
   * ADDITIVE — existing consumers reading `uid`/`title`/`status` are
   * unaffected. `related` now surfaces every live relation type: `relates_to`
   * and `part_of` in both directions, and `blocks` (outbound, tagged
   * `blocks`) / incoming (tagged `blocked_by`). `similar_to` (C9's reviewed
   * similarity link) and the reserved `duplicate_of` are declared here for
   * the same ref shape's future producers.
   */
  rel?:
    | 'relates_to'
    | 'part_of'
    | 'blocks'
    | 'blocked_by'
    | 'similar_to'
    | 'duplicate_of';
}

/**
 * A declared obligation, projected for read (C4). This is the STORED shape,
 * never an evaluation: `requirement` is the predicate as written, and nothing
 * on the read path resolves it (that is C5's gate / C6's verdict). `on_fail` is
 * returned verbatim so a caller can see the declared severity.
 *
 * The predicate/applies-to/override types are imported `import type`-only from
 * `write/obligation.ts` — the grammar is declared in exactly one place, and a
 * type-only import introduces no runtime dependency from `query/**` onto
 * `write/**` (the two are already coupled on `write/errors.js`).
 */
export interface IObligationView {
  uid: string;
  applies_to: IObligationAppliesTo;
  requirement: IPredicate;
  on_fail: IObligationSeverity;
  override?: IObligationOverride;
}

/**
 * Provenance of an `IIssueCard._score` (DESIGN §2 Invariant 5: "a `score_kind`
 * provenance tag on every derived score"). A rank-derived score (`rrf`) is
 * ORDINAL — never to be labelled or read as a similarity/confidence; `bm25`
 * is likewise corpus-relative. A consumer that sees a bare `_score` with no
 * `_score_kind` cannot know which regime produced it, which is exactly the
 * conflation this tag prevents.
 */
export type IScoreKind = 'rrf' | 'bm25' | 'cosine' | 'rank' | 'priority';

// ---------------------------------------------------------------------------
// C6 — Verdict: derived actionability with reasons (DESIGN §2 Primitive 4)
// ---------------------------------------------------------------------------

/**
 * The closed CONDITION type vocabulary. A `Condition` names one thing that can
 * make an item non-actionable (or warn about it); `status` says whether that
 * named condition HOLDS (`{type:'Blocked',status:True}` ⇒ the item IS blocked).
 */
export type IConditionType =
  | 'Blocked'
  | 'Obligation'
  | 'Evidence'
  | 'Claim'
  | 'Reference'
  | 'Budget';

/** Whether the NAMED condition holds. `Unknown` is a first-class "could not determine", distinct from `False`. */
export type IConditionStatus = 'True' | 'False' | 'Unknown';

/** `block` flips actionability false; `warn` is reported but never blocks (systemd Condition-vs-Assert split). */
export type IConditionSeverity = 'block' | 'warn';

/**
 * The governed reason-code core (DESIGN §2 Primitive 4) plus the
 * `<domain>/<Code>` extension namespace. `Unknown` is the honest "the check
 * was not run / could not be decided".
 */
export type IVerdictReasonCode =
  | 'BlockedBy'
  | 'MissingObligation'
  | 'EvidenceUnverified'
  | 'EvidenceStale'
  | 'ClaimStale'
  | 'ReferenceUnresolved'
  | 'Unknown'
  | `${string}/${string}`; // governed extension namespace

/**
 * TRI-STATE (DESIGN §2 Primitive 4) — NEVER a bare boolean. `'unknown'` is
 * never a green light: a caller that handles only booleans must be told, and
 * the list path must report `'unknown'` rather than `true` where it cannot
 * afford the rung. `false` iff a `block`-severity condition is `True`;
 * `'unknown'` iff a `block`-severity condition is `Unknown` (and none is
 * `True`); otherwise `true`.
 */
export type IActionable = boolean | 'unknown';

/** One named condition of a {@link IVerdict}. */
export interface ICondition {
  type: IConditionType;
  /** Whether the NAMED condition HOLDS: `True` on a `Blocked` condition = IS blocked. */
  status: IConditionStatus;
  severity: IConditionSeverity;
  code: IVerdictReasonCode;
  message?: string;
  /** The thing to fix (blocker uid / attestation uid / obligation uid). */
  subject?: string;
}

/**
 * The verdict — derived on read, never stored (`revision` is the node's own
 * current content revision, so a caller can detect staleness; there is no
 * materialized status field anywhere).
 */
export interface IVerdict {
  actionable: IActionable;
  evaluated_at: string;
  revision: number;
  /** Ordered block-severity first, then warn. */
  conditions: ICondition[];
}

/**
 * The projected issue card (SPEC.md §6.5's `IIssueCard`). Every field is
 * OPTIONAL here because the shape is fields-projected: a caller that asked
 * for `['uid','title']` gets a card with only those two keys populated.
 * `uid` is always present regardless of the requested `fields` — an issue
 * card with no addressable identity is never a useful response.
 */
export interface IIssueCard {
  uid: string;
  title?: string;
  kind?: string;
  status?: string;
  priority?: string;
  project?: string;
  component?: string;
  createdAt?: string;
  updatedAt?: string;
  assignee?: string;
  author?: string;
  closedAt?: string;
  /**
   * The item-level disclosure-contract git context (repo `AGENTS.md`'s
   * "Cite what you read": the FIRST element of a `Citations:` block is
   * `<active git context>`). A plain field — a sibling of `assignee` in
   * `issue.meta.metadata`, read in the same single-row fetch. Rendered once at
   * the head of the `Citations:` block by `markdown.ts`; never per-citation.
   * Absent on every issue filed before the field existed, and on any issue
   * whose `create`/`transition` supplied no `gitContext`.
   */
  gitContext?: string;
  body?: string;
  citations?: IIssueCitation[];
  notes?: IIssueNote[];
  auditTrail?: IIssueAuditEntry[];
  blockers?: IIssueRef[];
  related?: IIssueRef[];
  _score?: number;
  /** Provenance tag for `_score` (DESIGN §2 Invariant 5). Present iff `_score` is; a rank-derived score is ordinal, never similarity/confidence. */
  _score_kind?: IScoreKind;
  _vector?: number[];
  // --- C2 (structural legibility) — ADDITIVE opt-in pseudo fields; the default
  // card is byte-for-byte unchanged because each is populated only when
  // explicitly requested via `fields`. ---
  /** Outbound `blocks` — issues that cannot start until this one is terminal. */
  blocksOut?: IIssueRef[];
  /**
   * Transitive dependent count: how many nodes reach THIS node via `blocks`
   * (inclusive of direct dependents). Deterministic, scope-bounded (bounded to
   * a page's candidate id set on a list read; unbounded but cycle-safe on a
   * single `get`).
   */
  dependents?: number;
  /** The `part_of` parent, if any (`n:1` — at most one). */
  partOf?: IIssueRef | null;
  // --- C4 (obligation) — ADDITIVE opt-in pseudo field; populated only when
  // explicitly requested via `fields`, so the default card is byte-for-byte
  // unchanged. The read path NEVER evaluates the predicate. ---
  /** The declared obligations on this item, in `has_obligation` edge order. */
  obligations?: IObligationView[];
  // --- C6 (verdict) — ADDITIVE opt-in pseudo field; populated only when
  // explicitly requested via `fields`, so the default card is byte-for-byte
  // unchanged. DERIVED on read, never stored. ---
  /** The derived actionability verdict + its typed reasons. */
  verdict?: IVerdict;
}

/**
 * `get`'s uid-addressed shape (SPEC.md §6.3.1/§6.5/AC-13) — the implementation
 * layer's {@link getIssue} (`get.ts`) takes exactly this, never the mounted
 * union below. Named `...ByUidInput` (rather than reusing the bare
 * `IIssueGetInput` name) because the MOUNTED `get` verb (`api.ts`) also
 * accepts the registry-detail shape (§3a/AC-11) — see {@link IIssueGetInput}.
 */
export interface IIssueGetByUidInput {
  uid: IssueUid;
  fields?: readonly IIssueField[];
  /** Bounds the `auditTrail`/`citations`/`related`/`blockers` pseudo fields to the LAST N rows (preserving each resolver's own order — the audit trail's oldest-first order is sliced to its tail). */
  lastN?: number;
  /** Cursor for the bounded sub-collection (opaque; from the previous page's last returned uid). */
  after?: string;
  /**
   * C6 — the highest verdict ladder rung this `get` may run. Default 3 (the
   * single-item default); a caller may raise it to 5 for a full anchor
   * re-resolve. The list views never accept this and always derive at rung 2
   * (DESIGN §2 Primitive 4, "Bounded derivation").
   */
  deriveThrough?: 1 | 2 | 3 | 4 | 5;
}

/** SPEC.md §6.5's `IIssueFilter`. */
export interface IIssueFilter {
  /** uid or name (SPEC.md §6.1). */
  project?: string;
  /** uid or name, scoped within `project`. */
  component?: string;
  kind?: string | string[];
  status?: string | string[] | 'open' | 'closed' | 'all';
  priority?: string | string[];
  assignee?: string;
  claimedBy?: string;
  /** Resolves via `authored_by` edge traversal — uid or name. */
  author?: string;
  /** FTS keyword, title+body — keyword-only, never hybrid. */
  grep?: string;
  /** Routes to `searchRanked` (§5a) — composes with `grep`, neither swallows the other. */
  semantic?: string;
  /** Item-anchored similarity/traversal seed (§6.1) — uid of the reference item. */
  anchor?: string;
  /**
   * uid or name of the parent `issue` this one is filed under via the `part_of`
   * edge (SPEC.md §1052/§1471: a plan is itself an `issue` row, not a
   * dedicated node kind — attaching an item to it is
   * `relate(childUid, planUid, 'part_of', 'add')`). Resolves candidate issues
   * by the incoming `part_of` edge into the resolved plan node, exactly like
   * the `project`/`component` edge-scoped filters.
   */
  plan?: string;
  /** `component.meta.path` (repo-relative package path, SPEC.md §3) — exact match against every live `component` row, unioned across matches. Distinct from `component`, which takes a uid/name rather than a filesystem path. */
  projectPath?: string;
  closedAt?: { since?: string; until?: string };
  createdAt?: { since?: string; until?: string };
  updatedAt?: { since?: string; until?: string };
}

export type IIssueSort =
  | 'priority'
  | 'updated'
  | 'created'
  | 'relevance'
  | 'textMatch';
export type IIssueSortDirection = 'asc' | 'desc';
/**
 * `projects`/`components`/`locations` (SPEC.md §3a/§8 AC-9) are the registry
 * LIST views — every live `project`/`component`/`location` row, optionally
 * narrowed by `filter.project` (and, for `locations`, `filter.component`) —
 * routed to `views/registry.ts`'s `listProjects`/`listComponents`/
 * `listLocations`, distinct from the issue-search views above (§6.1:
 * "conflating the two would be wrong").
 */
export type IIssueView =
  | 'list'
  | 'ready'
  | 'graph'
  | 'order'
  | 'stale'
  | 'similar'
  | 'overlap'
  | 'projects'
  | 'components'
  | 'locations';
export type IIssueQueryFormat = 'json' | 'markdown';

/** SPEC.md §5, §6.1's `axis` — the grouping dimension for `overlapUids` (§6.2). */
export type IOverlapAxis = 'file' | 'project' | 'component' | 'author';

export interface IIssueQueryInput {
  /**
   * The natural-language query — routed by `queryIssues` to `filter.semantic`
   * when the vector space can return ranked results, or to `filter.grep`
   * otherwise. Mutually exclusive with setting `filter.semantic` or
   * `filter.grep` yourself; pick one or the other, never both.
   */
  text?: string;
  filter?: IIssueFilter;
  fields?: readonly IIssueField[];
  sort?: IIssueSort;
  direction?: IIssueSortDirection;
  /** default 50, max 1000 (`MAX_QUERY_LIMIT`). */
  limit?: number;
  /** offset-based paging; mutually exclusive with `after`. */
  offset?: number;
  /** opaque keyset cursor from a prior page's `nextCursor`. */
  after?: string;
  view?: IIssueView;
  /**
   * default `'json'`. `'markdown'` is only supported for the four item-list
   * views (`list`/`ready`/`stale`/`similar`) — see {@link IIssueMarkdownResult}
   * — and rejects with `InvalidArgumentError('format', ...)` for any other
   * view (`graph`/`order`/`overlap`/`projects`/`components`/`locations`),
   * which return a shape DATA_MODEL.md §8's markdown projection has no rule
   * for.
   */
  format?: IIssueQueryFormat;
  /** `view:'overlap'` only (§6.2) — the axis to group `overlapUids` by. */
  overlapAxis?: IOverlapAxis;
  /** `view:'overlap'` only (§6.2) — the set of `uid`s to group by `overlapAxis`. */
  overlapUids?: readonly string[];
  /** `view:'stale'` only — minutes since `claimedAt`; falls back to `project_policy.claim_stale_after_min` (default 30) when omitted. */
  staleAfterMin?: number;
}

export const MAX_QUERY_LIMIT = 1000;
export const DEFAULT_QUERY_LIMIT = 50;

export interface IIssuePage {
  items: IIssueCard[];
  /** Pass back as `after` for the next page; absent ⇒ no more pages. */
  nextCursor?: string;
  hasMore: boolean;
}

/** SPEC.md §5's `DependencyGraph`, using this system's edge vocabulary (§6.2: `blocks`, not `DEPENDS_ON`). */
export interface IDependencyGraph {
  nodes: Array<{ uid: string; title: string; status: string }>;
  edges: Array<{
    from: string;
    to: string;
    rel: 'blocks' | 'relates_to' | 'part_of';
  }>;
}

export type ITopoOrderResult =
  | { ok: true; order: string[] }
  | { ok: false; cycle: string[] };

/** `view:'overlap'`'s output shape (§6.2) — one entry per distinct axis value shared by ≥1 of the input `uids`. */
export interface IOverlapGroup {
  axisValue: string;
  uids: string[];
}

/**
 * `view:'list'`'s result — {@link IIssuePage} plus the discriminator.
 *
 * Declared as an interface rather than written inline as
 * `({ view: 'list' } & IIssuePage)`. That distinction is load-bearing, not
 * stylistic: the schema extractor that derives every mount's response shape
 * cannot express a TypeScript intersection, and emitted a bare `{}` for that
 * branch. The runtime encodes each response against the derived schema, so
 * with `{}` in the union the list branch was projected onto a sibling member
 * — and `hasMore` and `nextCursor` were silently dropped from every CLI, MCP
 * and HTTP response, which made paging unreachable for every consumer while
 * the in-process return value looked correct. An `extends` clause extracts
 * into a complete object schema, so the wire shape matches the type.
 */
export interface IIssueListResult extends IIssuePage {
  view: 'list';
}

/**
 * `format:'markdown'`'s result shape (SPEC.md §6.5/§6.6, DATA_MODEL.md §8) —
 * returned instead of the matching JSON-shaped member above for any of the
 * four item-list views (`list`/`ready`/`stale`/`similar`; the only views whose
 * result is an `IIssueCard[]` DATA_MODEL.md §8's markdown projection can
 * render). `markdown` is the SAME page a `format:'json'` call would have
 * returned, re-serialized (`query/markdown.ts`'s `renderIssueCardsMarkdown`)
 * — never a second query path.
 */
export interface IIssueMarkdownResult {
  view: 'list' | 'ready' | 'stale' | 'similar';
  format: 'markdown';
  markdown: string;
}

/** The one discriminated result shape `query` (§6.3, §5) returns — the `view` field selects which of the following members is populated. */
export type IIssueQueryResult =
  | IIssueListResult
  | { view: 'ready'; items: IIssueCard[] }
  | { view: 'graph'; graph: IDependencyGraph }
  | { view: 'order'; order: ITopoOrderResult }
  | { view: 'stale'; items: IIssueCard[] }
  | { view: 'similar'; items: IIssueCard[] }
  | { view: 'overlap'; groups: IOverlapGroup[] }
  | { view: 'projects'; items: IProjectSummary[] }
  | { view: 'components'; items: IComponentSummary[] }
  | { view: 'locations'; items: ILocationSummary[] }
  | IIssueMarkdownResult;

// ---------------------------------------------------------------------------
// §3a registry read surface (project / component / location)
// ---------------------------------------------------------------------------

export interface IProjectSummary {
  uid: string;
  name: string;
  path?: string;
  repoUrl?: string;
  monorepo?: boolean;
  description?: string;
}

export interface IComponentSummary {
  uid: string;
  name: string;
  projectUid: string;
  path?: string;
  description?: string;
}

export type ILocationType = 'path' | 'url' | 'tool';

export interface ILocationSummary {
  uid: string;
  locType: ILocationType;
  value: string;
  componentUid: string;
}

export interface IProjectDetail extends IProjectSummary {
  components: Array<{ name: string; path?: string }>;
  locations: Array<{ locType: ILocationType; value: string }>;
}

export interface IComponentDetail extends IComponentSummary {
  project: { name: string; path?: string; repoUrl?: string };
  locations: Array<{ locType: ILocationType; value: string }>;
}

export interface ILocationDetail extends ILocationSummary {
  component: { name: string; path?: string };
  project: { name: string; path?: string; repoUrl?: string };
}

export interface IRegistryQueryFilter {
  project?: string;
  component?: string;
}

export interface ILookupResult {
  project: { uid: string; name: string; path?: string; repoUrl?: string };
  component?: { uid: string; name: string; path?: string };
  location?: { uid: string; locType: ILocationType; value: string };
  /** Present when only a partial (project-level, or path-prefix) match was found — never a silent null (§3a). */
  hint?: string;
  /**
   * C1 — a resolved-by-token hint. When `lookup` recognises `q` as a uid/uid
   * prefix or a unique issue title, the registry shape does not apply; instead
   * the caller is told which verb to re-issue (`get`) and with which uid, so a
   * transport can forward exactly one canonical request rather than guessing.
   */
  redirect?: { verb: 'get' | 'query'; uid?: string; query?: string };
  /**
   * C1 — the candidate set behind an ambiguity this read CHOSE to surface
   * rather than fail on. (A `lookup` whose title grep matches ≥2 issues still
   * throws `AmbiguousReferenceError`; this field exists for callers that
   * surface candidates alongside a chosen primary.)
   */
  candidates?: Array<{ uid: string; kind: string; name: string }>;
}

/**
 * `get`'s registry-detail shape (SPEC.md §3a/§8 AC-11) — `get --input
 * '{"registry":"project"|"component"|"location","name":...}'`, routed to
 * `views/registry.ts`'s `getRegistryDetail`. `filter` is honoured ONLY for
 * `registry:'component'` (SPEC.md §6.1's project-scoping rule — `name` alone
 * is ambiguous across projects, e.g. every project's reserved `(root)`
 * component shares the same name, §8 AC-23) and is ignored for `project`/
 * `location` (a location has no independent name at all — it is always
 * resolved by uid, §3a).
 */
export interface IIssueGetRegistryInput {
  registry: 'project' | 'component' | 'location';
  name: string;
  filter?: IRegistryQueryFilter;
}

/**
 * The MOUNTED `get` verb's input (`api.ts`) — either the uid-addressed issue
 * card ({@link IIssueGetByUidInput}, SPEC.md §6.3.1/AC-13, UNCHANGED) or the
 * registry-detail lookup ({@link IIssueGetRegistryInput}, §3a/AC-11). The two
 * shapes are structurally disjoint (`uid` vs. `registry`+`name`), which is
 * what lets `api.ts`'s `get` narrow on `'registry' in input` and is also what
 * keeps apigen's undiscriminated-union structural encoder
 * (`pickUnionBranch`/`scoreUnionBranch`, `@adhd/apigen-base-logical`) from
 * ever conflating the two: each branch's OWN required-key set immediately
 * disqualifies the other (a uid-input has no `registry`/`name`; a
 * registry-input has no `uid`).
 */
export type IIssueGetInput = IIssueGetByUidInput | IIssueGetRegistryInput;

/**
 * The MOUNTED `get` verb's result — the plain issue card ({@link IIssueCard},
 * exactly the five-field default per AC-13 when `uid` was given) or one of
 * the three registry detail shapes (§3a/AC-11). Same structural-disjointness
 * reasoning as {@link IIssueGetInput} above: `IIssueCard` requires only
 * `uid`, while every registry detail type requires several fields NONE of
 * the others (nor `IIssueCard`) declare (`IProjectDetail`:
 * `components`+`locations`; `IComponentDetail`: `projectUid`+`project`;
 * `ILocationDetail`: `locType`+`value`+`componentUid`+`component`+`project`)
 * — a missing required key disqualifies a branch outright in
 * `scoreUnionBranch`, so the four branches can never tie.
 *
 * NOTE (BUG-APIGEN-CORE-CLIENT-BARE-NAME-COLLISION-001, now fixed at the
 * source): putting `query/types.ts`'s `IIssueCard` at a top-level
 * operation-return position here (for the first time) exposed a real
 * apigen-core-client extraction defect — `write/create-issue.ts` ALSO
 * exported an interface bare-named `IIssueCard` (differently shaped:
 * `title`/`kind`/`status`/`project`/`component`/`createdAt` required there,
 * vs. only `uid` here), and the extractor's declaration resolution collided
 * on the bare name across the whole extracted program, non-deterministically
 * substituting the wrong shape into `query`'s `items` schema (confirmed
 * empirically: `dist/index.js` resolved it to the wrong, stricter shape;
 * `dist/index.mjs`, built from the identical source in the same pass, failed
 * to resolve it at all). Fixed by renaming `write/create-issue.ts`'s
 * interface to `ICreateIssueCard` — see that file's doc comment for the full
 * repro — so no workaround is needed here; this type is plain `IIssueCard`.
 */
export type IIssueGetResult =
  | IIssueCard
  | IProjectDetail
  | IComponentDetail
  | ILocationDetail;
