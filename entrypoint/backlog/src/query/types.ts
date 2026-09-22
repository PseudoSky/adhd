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
  | '_vector';

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
  _vector?: number[];
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
