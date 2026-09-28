# Write-layer foundation — frozen export contract

**These four files are READ-ONLY to downstream agents: `tx.ts`, `catalog.ts`,
`errors.ts`, `audit.ts`.** Roughly nine agents build verbs (`update`,
`transition`, `claim`, `relate`, `move`, `delete`, `supersede`, …) and views on
top of this foundation. If you believe one of these four files must change to
support your verb or view, **you do not edit it — you return with the
request** (what export you need, what shape, why the existing surface can't
express it) to whoever owns the foundation. An agent that edits one of these
files to make its own verb easier is silently changing semantics under the
other eight agents building in parallel.

Every export below was read directly out of the current file (paths and line
numbers are cited per-export). Nothing here is guessed. Counts: `tx.ts` — 24
exports, `catalog.ts` — 12 exports, `errors.ts` — 19 exports, `audit.ts` — 3
exports. **Total: 58 exports.**

---

## `tx.ts` (25 exports)

### `IWriteStoreHandle` — interface (`tx.ts:89`)

```ts
export interface IWriteStoreHandle {
  readonly adapter: StoreAdapter;
  readonly typePolicy: TypePolicy;
}
```

Guarantees: the two dependencies every write verb needs — the raw
`StoreAdapter` (never `GraphBackend.transaction`, which cannot request
`immediate` mode) and the SAME injected `TypePolicy` instance the store's
`GraphBackend` was constructed with. Constructed once at store-open time and
threaded through every write verb.

### `ITxNodeRow` — interface (`tx.ts:115`)

```ts
export interface ITxNodeRow {
  rowid: number;
  uid: string;
  kind: string;
  name: string | null;
  content: string;
  metadata: Record<string, unknown> | undefined;
  tInvalid: string | null;
  isSuperseded: boolean;
}
```

Guarantees: the shape every node row read back inside a transaction is mapped
onto — `metadata` is always either a parsed object or `undefined` (never a
raw JSON string, never a thrown parse error).

### `nowISO()` — function (`tx.ts:168`)

```ts
export function nowISO(): string;
```

Guarantees: returns the current UTC timestamp in the exact ISO-8601 shape
`@adhd/sox-graph-store` stamps every row with.

### `sha256Hex(input)` — function (`tx.ts:173`)

```ts
export function sha256Hex(input: string | Buffer): string;
```

Guarantees: `sha256` hex digest of the given content — used for citation and
audit content-addressing; NEVER the library's own dedupe hash (that is
trim+lowercase, computed separately inside `writeNodeTx`).

### `canonicalJSONStringify(value)` — function (`tx.ts:185`)

```ts
export function canonicalJSONStringify(value: Record<string, unknown>): string;
```

Guarantees: deterministic JSON serialization with object keys sorted at every
nesting level and `undefined` values omitted (never serialized as `null`) —
the one canonical form both `audit.sha` and `transition.sha` are computed
over.

### `getNodeByUidTx(tx, uid)` — function (`tx.ts:208`)

```ts
export async function getNodeByUidTx(tx: INodeReadExecutor, uid: string): Promise<ITxNodeRow | null>;
```

Guarantees: `uid` → node, issued against the caller's own open `tx` (never
the bare adapter) — mirrors the library's `getNodeByUid` SELECT exactly.
Returns `null` for no match; does not filter on `t_invalid` itself (callers
that need "live only" check `row.tInvalid === null` themselves). The
`INodeReadExecutor` parameter accepts any `{ executeGet, executeAll }` handle
— an `AdapterTransaction`, a `StoreAdapter`, or graph-store's
`GraphTransaction`.

### `resolveUidPrefixTx(exec, ref, opts?)` — function (`tx.ts:237`)

```ts
export async function resolveUidPrefixTx(
  exec: INodeReadExecutor,
  ref: string,
  opts?: { expectedKind?: string }
): Promise<ITxNodeRow>;
```

Guarantees: the single write-side uid funnel. Exact match wins (fast path);
otherwise a UNIQUE uid prefix resolves. An exact/prefix miss throws
`IssueNotFoundError` (kind `issue`) or `CatalogNotFoundError` (any other
kind); a prefix below `MIN_UID_PREFIX_LENGTH` throws `InvalidArgumentError`;
a prefix matching ≥2 live rows of the expected kind throws
`AmbiguousReferenceError` naming every candidate — never an arbitrary pick.
`resolveLiveIssueTx` and `catalog.ts`'s `resolveByUidTx` both delegate here,
so every issue verb and `rm-location` share ONE prefix contract.

### `getNodeByRowidTx(tx, rowid)` — function (`tx.ts:326`)

```ts
export async function getNodeByRowidTx(tx: AdapterTransaction, rowid: number): Promise<ITxNodeRow | null>;
```

Guarantees: same as `getNodeByUidTx`, keyed by internal `rowid` instead —
used to resolve an edge endpoint's kind without a redundant round trip.

### `IWriteNodeTxInput` — interface (`tx.ts:337`)

```ts
export interface IWriteNodeTxInput {
  kind: string;
  name?: string;
  content?: string;
  metadata?: Record<string, unknown>;
  at?: string;
  skipDedupe?: never;
}
```

Guarantees: `kind` is never validated against a closed vocabulary (the schema
is open by design). `content` defaults to `name` when omitted. `at` is the
single logical-write timestamp — a caller composing several rows in one
transaction must capture one `now` and pass it to every `writeNodeTx`/
`writeEdgeTx` call, or timestamps drift apart within what should be one
atomic instant. `skipDedupe` is typed `never` — declaring it on an input
object literal is a compile error; see `writeNodeTx`'s own guarantee below
for why.

### `writeNodeTx(tx, input)` — function (`tx.ts:480`)

```ts
export async function writeNodeTx(tx: AdapterTransaction, input: IWriteNodeTxInput): Promise<{ rowid: number; uid: string }>;
```

Guarantees: hand-composed node INSERT issued against `tx`, mirroring the
library's own `writeNodeInTx` INSERT column list and defaults exactly.
**Unconditionally skips dedupe for every kind, structurally** — there is no
branch in this function, and no field on `IWriteNodeTxInput`, that can select
the library's content-hash-SELECT-then-maybe-insert behavior. SPEC.md §1/§4
("All entity writes pass `skipDedupe: true`") name no kind that is exempt, so
this function never runs that SELECT for any kind at all: always a fresh
INSERT, always a fresh `crypto.randomUUID()` uid.

### `EdgeMultiplicity` — type (`tx.ts:558`)

```ts
export type EdgeMultiplicity = 'n:1' | '1:n' | 'n:m';
```

Guarantees: the closed set of multiplicity values every `edge_kind` rule
declares. `n:1` caps the edge's SOURCE out-degree at one; `1:n` caps the
TARGET in-degree at one; `n:m` is uncapped on both sides.

### `IEdgeKindRule` — interface (`tx.ts:560`)

```ts
export interface IEdgeKindRule {
  rel: string;
  sourceKind: string;
  targetKind: string;
  multiplicity: EdgeMultiplicity;
}
```

Guarantees: the resolved shape of one `rel`'s declared endpoint-kind and
multiplicity rule. `sourceKind: '*'` is the one declared sentinel (`audits`)
that skips the source-kind match.

### `IWriteEdgeTxInput` — interface (`tx.ts:568`)

```ts
export interface IWriteEdgeTxInput {
  srcRowid: number;
  srcUid: string;
  srcKind: string;
  dstRowid: number;
  dstUid: string;
  dstKind: string;
  rel: string;
  metadata?: Record<string, unknown>;
  weight?: number;
  rule: IEdgeKindRule;
  typePolicy: TypePolicy;
  at?: string;
}
```

Guarantees: every field `writeEdgeTx` needs to validate AND write one edge in
one call — `rule` must be the caller's own already-resolved `edge_kind` rule
(via `catalog.ts`'s `resolveEdgeKindTx`), never re-derived internally. `at`
follows the same one-logical-write-one-timestamp rule as
`IWriteNodeTxInput.at`.

### `writeEdgeTx(tx, input)` — function (`tx.ts:672`)

```ts
export async function writeEdgeTx(tx: AdapterTransaction, input: IWriteEdgeTxInput): Promise<void>;
```

Guarantees: validates `input.rule`'s declared `sourceKind`/`targetKind`
against the actual endpoint kinds (throws `BacklogEdgeKindMismatchError` on
mismatch), enforces `checkMultiplicityTx`'s capped-side conflict check
(throws `SingleValuedRelationConflictError`), calls the injected
`TypePolicy` directly in-process, THEN issues the upsert INSERT — same `ON
CONFLICT(src, dst, rel) DO UPDATE` / re-livening (`t_invalid = NULL`) as the
library's own `writeEdgeInternal`, issued against `tx`.

### `BacklogEdgeKindMismatchError` — class (`tx.ts:735`)

```ts
export class BacklogEdgeKindMismatchError extends BacklogWriteError {
  readonly code: 'E_VALIDATION';
  readonly retryable: false;
  constructor(rel: string, side: 'source' | 'target', expectedKind: string, actualKind: string);
}
```

Guarantees: thrown when a resolved `edge_kind` rule's declared endpoint kind
does not match the actual endpoint being written — a write-layer composition
defect, expected to be unreachable in practice; fails loudly rather than
writing a mismatched edge.

### `IInvalidateEdgeTxInput` — interface (`tx.ts:751`)

```ts
export interface IInvalidateEdgeTxInput {
  srcRowid: number;
  dstRowid: number;
  rel: string;
  reason?: string;
  at?: string;
}
```

Guarantees: everything `invalidateEdgeTx` needs to invalidate one live edge,
with an optional human-readable `reason` merged into the edge's `meta`.

### `invalidateEdgeTx(tx, input)` — function (`tx.ts:770`)

```ts
export async function invalidateEdgeTx(tx: AdapterTransaction, input: IInvalidateEdgeTxInput): Promise<void>;
```

Guarantees: mirrors the library's `invalidateEdge` exactly — idempotent
no-op if the edge is already invalidated or absent; otherwise sets
`t_invalid` and merges `invalidatedAt`/`invalidatedReason` into `meta`,
issued against `tx`.

### `executeWriteTransaction(handle, fn)` — function (`tx.ts:885`)

```ts
export async function executeWriteTransaction<T>(handle: IWriteStoreHandle, fn: (tx: AdapterTransaction) => Promise<T>): Promise<T>;
```

Guarantees: the ONE transaction wrapper every write verb calls. Opens
`handle.adapter.transaction(fn, { mode: <resolved mode> })` where the mode is
`'immediate'` in every normal run (see the `ADHD_BACKLOG_UNSAFE_TX_MODE`
contract below) and layers the retry contract on top: a thrown
`BacklogWriteError` is rethrown untouched (already-decided, terminal);
`E_CONTENTION` retries up to 3 total attempts (250ms, then 500ms linear
backoff) before throwing `WriteContentionError`; a recognized-but-
unclassified database error (`E_IO`, `isDatabaseError(err)` true) throws
`WriteIOError` on the first occurrence, never retried; anything else
(unrecognized non-database failure, or an `E_CONSTRAINT` not already handled
as a named class) is rethrown untouched.

**Env var contract — `ADHD_BACKLOG_UNSAFE_TX_MODE`:** read fresh on every
call to `executeWriteTransaction` (never cached at import time). Unset, or
exactly `"immediate"` → `'immediate'` mode (the only mode used in normal
operation). Exactly `"deferred"` → `'deferred'` mode — strips the
`BEGIN IMMEDIATE` RESERVED-lock CAS guarantee, for negative-control test runs
ONLY. Any other value throws synchronously rather than silently falling back
to `'immediate'`. **Never set this in normal operation or a deployed
process.**

Exports not listed above but present in `tx.ts` as non-exported internals
(not part of this contract, listed for completeness of the file's export
audit): `mapNodeRow`, `parseJsonObject`, `checkMultiplicityTx`, `sleep`,
`resolveTransactionMode`, `TX_MODES`, `TxMode`, `CONTENTION_RETRY_BACKOFFS_MS`
are all unexported — not callable from outside this file, not part of this
contract.

---

## `catalog.ts` (12 exports)

### `isUidShaped(ref)` — function (`uid-prefix.ts:47`)

```ts
export function isUidShaped(ref: string): boolean;
```

Guarantees: `true` iff `ref` matches the 36-character version-4-UUID shape
exactly (case-insensitive) — the SOLE disambiguation between "treat as
`uid`" (exact resolve-or-throw) and "treat as `name`" (find, and for flat
catalogs, find-then-mint). The definition lives in `write/uid-prefix.ts`
(which also owns the uid-PREFIX classification) and is re-exported from
`catalog.ts` so existing importers keep their path.

### `IResolvedCatalogRow` — interface (`catalog.ts:89`)

```ts
export interface IResolvedCatalogRow {
  rowid: number;
  uid: string;
  name: string;
}
```

Guarantees: the minimal resolved shape every catalog resolution returns —
`name` is never `null` here (a live catalog row with a null name is treated
as unresolved and throws before this shape is ever constructed).

### `IResolvedProjectRow` — interface (`catalog.ts:95`)

```ts
export interface IResolvedProjectRow extends IResolvedCatalogRow {
  metadata: Record<string, unknown> | undefined;
}
```

Guarantees: `IResolvedCatalogRow` plus the project's parsed `meta` blob
(`undefined` if absent or unparsable) — the shape `resolveProjectPolicy`
reads `metadata.policy` off of.

### `resolveProjectTx(tx, ref)` — function (`catalog.ts:143`)

```ts
export async function resolveProjectTx(tx: AdapterTransaction, ref: string): Promise<IResolvedProjectRow>;
```

Guarantees: resolves `ref` (uid or name) to a LIVE `project` row inside `tx`.
Resolved-ONLY — NEVER mints a project. Throws `CatalogNotFoundError` on no
match.

### `resolveComponentTx(tx, input)` — function (`catalog.ts:182`)

```ts
export async function resolveComponentTx(tx: AdapterTransaction, input: { projectUid: string; ref: string }): Promise<IResolvedCatalogRow>;
```

Guarantees: resolves `input.ref` (uid or name) to a LIVE `component` row
scoped to `input.projectUid` inside `tx`. Resolved-ONLY — an unresolved name,
or a uid-shaped ref belonging to a DIFFERENT project, throws
`CatalogNotFoundError('component', ref)` rather than forking a new component.

### `resolveDefaultComponentTx(tx, input)` — function (`catalog.ts:217`)

```ts
export async function resolveDefaultComponentTx(tx: AdapterTransaction, input: { projectRowid: number }): Promise<IResolvedCatalogRow>;
```

Guarantees: resolves the project's reserved `(root)` component via the
`owns_project` edge traversal (never a bare name lookup, so a `(root)` row
belonging to a different project can never be mismatched onto this one).
NEVER mints — throws `CatalogNotFoundError('component', '(root)')` if
missing (a row `upsertProject` is expected to already guarantee).

### `FlatCatalogKind` — type (`catalog.ts:237`)

```ts
export type FlatCatalogKind = 'kind' | 'status' | 'priority' | 'agent';
```

Guarantees: the closed set of catalog kinds that are mintable on an
unresolved NAME (never on an unresolved uid-shaped ref).

### `IMintOrResolveInput` — interface (`catalog.ts:239`)

```ts
export interface IMintOrResolveInput {
  catalogKind: FlatCatalogKind;
  ref: string;
  mintMetadata?: (tx: AdapterTransaction) => Promise<Record<string, unknown>>;
  at?: string;
}
```

Guarantees: `mintMetadata` is evaluated lazily — only invoked on an actual
mint, never read or applied when `ref` resolves to an existing row. `at` is
NOT threaded into `resolveEdgeKindTx`'s own `edge_kind` rows (those keep
their own clock; see that function's guarantee below).

### `RESERVED_TERMINAL_STATUS_NAMES` — const (`catalog.ts:285`)

```ts
export const RESERVED_TERMINAL_STATUS_NAMES: ReadonlySet<string>;
```

Guarantees: the ONE in-code definition of the reserved terminal status
vocabulary (`closed`, `DONE`, `FIXED`, `RESOLVED`, `INVALID`, `SUPERSEDED`),
case-sensitive. The mint layer seeds a `status` row's `terminal` flag from it
(`mintOrResolveStatusTx`); `query/card.ts`'s `isStatusTerminal` stays
name-blind (ADR-0002 D1). `catalog-repair.ts` re-exports this SAME set rather
than declaring its own.

### `isReservedTerminalStatusName(name)` — function (`catalog.ts:300`)

```ts
export function isReservedTerminalStatusName(name: string): boolean;
```

Guarantees: exact, case-sensitive membership in
`RESERVED_TERMINAL_STATUS_NAMES` — the same predicate the `(kind,name)`
resolve uses.

### `mintOrResolveCatalogTx(tx, input)` — function (`catalog.ts:353`)

```ts
export async function mintOrResolveCatalogTx(tx: AdapterTransaction, input: IMintOrResolveInput): Promise<IResolvedCatalogRow>;
```

Guarantees: find-then-create for `kind`/`status`/`priority`/`agent`. A
uid-shaped `ref` that does not resolve throws `CatalogNotFoundError` (uids
are never auto-vivified). A name-shaped `ref` that does not resolve is
minted via `writeNodeTx` inside the SAME `tx`.

### `mintOrResolveStatusTx(tx, input)` — function (`catalog.ts:427`)

```ts
export async function mintOrResolveStatusTx(tx: AdapterTransaction, input: { ref: string; at?: string }): Promise<IResolvedCatalogRow>;
```

Guarantees: the ONE sanctioned status mint path. On a miss it SEEDS
`terminal` from `RESERVED_TERMINAL_STATUS_NAMES` — `true` for an exact
reserved name, `false` for every other name (SPEC.md §6.3.2) — never from a
call-site literal and never at read time. Idempotent (`resolveEdgeKindTx`-style
self-heal): an existing row is resolved, never re-minted, so no duplicate rows
accumulate. A uid-shaped `ref` that does not resolve throws
`CatalogNotFoundError`.

### `nextPriorityRankTx(tx)` — function (`catalog.ts:442`)

```ts
export async function nextPriorityRankTx(tx: AdapterTransaction): Promise<number>;
```

Guarantees: returns one past the current max `priority.meta.rank` (0 if no
priority rows exist) — a novel priority can never silently outrank an
existing one.

### `EDGE_KIND_TABLE` — const (`catalog.ts:457`)

```ts
export const EDGE_KIND_TABLE: readonly IEdgeKindRule[];
```

Guarantees: the fixed, complete `(rel, source_kind, target_kind,
multiplicity)` table for every declared `rel` in the schema (20 rows at the
time of this contract: `owns_project`, `owns_component`, `has_kind`,
`has_status`, `has_priority`, `authored_by`, `has_note`, `has_citation`,
`has_transition`, `audits`, `depends_on`, `has_location`, `relates_to`,
`supersedes`, `blocks`, `duplicate_of`, `part_of`, `attests`,
`has_obligation`, `satisfies`). `attests`, `has_obligation` and `satisfies`
are INTERNAL rels (C3/C4/C5) — they are deliberately NOT members of
`relate`'s public `RelateRel` union. This is the single source of truth
`resolveEdgeKindTx` reconciles against the live `edge_kind` catalog rows.

**`part_of` is `n:1` — one parent per item (C2, AC6).** An item has at most ONE
`part_of` parent. A second `part_of` write on the same source (a DIFFERENT
target) is rejected by the generic `checkMultiplicityTx` gate with a
`SingleValuedRelationConflictError` whose `side` is `source`, whose `rel` is
`part_of`, and whose `conflictingUid` names the pre-existing parent — the SAME
gate `supersedes`/`duplicate_of` use, with no `part_of`-specific code path.
Re-adding the SAME parent is a no-op (`noop: true`). A multi-parent model would
require changing this row's multiplicity, not special-casing `part_of`.

### `resolveEdgeKindTx(tx, rel)` — function (`catalog.ts:616`)

```ts
export async function resolveEdgeKindTx(tx: AdapterTransaction, rel: string): Promise<IEdgeKindRule>;
```

Guarantees: resolves the `edge_kind` catalog row for `rel` inside `tx`.
`edge_kind` is NEVER caller-mintable — on a miss (no dedicated seed script
exists yet), self-heals by seeding the row from `EDGE_KIND_TABLE`, the
identical fixed shape a real seed script would write. A malformed existing
row (corrupt or missing `meta` keys) is invalidated and replaced in the SAME
`tx`, converging to exactly one live `edge_kind` row per `rel`. Throws
`CatalogNotFoundError('edge_kind', rel)` if `rel` isn't in
`EDGE_KIND_TABLE` at all.

### `IProjectPolicy` — interface (`catalog.ts:684`)

```ts
export interface IProjectPolicy {
  readonly transitionRequiresNote: boolean;
  readonly citationRequired: boolean;
  readonly citationRequiresSha: boolean;
  readonly citationAllowedExternalRoots: readonly string[];
  readonly defaultStatus?: string;
  readonly defaultKind?: string;
  readonly dedupeScanEnabled: boolean;
  readonly dedupeThreshold: number;
  readonly claimStaleAfterMin: number;
  readonly allowedStatuses: readonly string[];
  readonly allowedKinds: readonly string[];
  readonly requiredFields: readonly string[];
}
```

Guarantees: every field is `readonly` at the type level. `allowedStatuses`/
`allowedKinds` empty means "no restriction." `citationAllowedExternalRoots`
is external absolute roots a citation may be read from, IN ADDITION to the
project's own `metadata.path` root (BUG c6d35272): a citation target is
accepted iff its canonical (symlink-resolved) path lies within the project
root or one of these roots; a `..` traversal or an escaping symlink stays
rejected, and only the resulting `sha` is persisted. This array defaults to
`[]` at the type layer, and `resolveProjectPolicy`'s injected runtime default
is ALSO `[]` — there is NO machine-global default root, because the runtime's
own data home `~/.adhd/backlog` contains only the backlog store
(`production/data/backlog-v2.db`) and its `backup-*`/`backups/` snapshots
(BUG 62059b57 follow-up). A non-empty array opts the project into the
carve-out; an empty array (the default, or an explicit `[]`) leaves it
disabled. A malformed (non-`string[]`) value falls back to the — also empty —
default rather than being spread. Typed per-project config, never an
environment toggle.

### `resolveProjectPolicy(project)` — function (`catalog.ts:758`)

```ts
export function resolveProjectPolicy(project: IResolvedProjectRow): IProjectPolicy;
```

Guarantees: returns a FRESH `IProjectPolicy` object on every call (never a
shared reference), merging `project.metadata.policy` field-by-field over the
frozen `DEFAULT_PROJECT_POLICY` defaults. A project with no `policy` object
at all gets every default field exactly as SPEC.md §2 states.

_(Note: `IEdgeKindRule` is re-exported by `catalog.ts` via its `import type`
from `tx.ts` — it is counted once, under `tx.ts`, above.)_

---

## `citation-path.ts` (7 exports)

The typed, project-scoped citation-path carve-out (BUG c6d35272) — the module
behind `IProjectPolicy.citationAllowedExternalRoots`. Pure path resolution:
no file CONTENT is ever read here; only canonical (`realpath`) paths are
computed and compared.

### `defaultCitationAllowedExternalRoots()` — function (`citation-path.ts:78`)

```ts
export function defaultCitationAllowedExternalRoots(): string[];
```

Returns `[]` — there is NO machine-global default root. The runtime's own data
home `~/.adhd/backlog` is the STORE's home, not an evidence tree: it contains
only the machine-global backlog database
(`production/data/backlog-v2.db`) and its `backup-*`/`backups/` snapshots
(plus a `test/` store), so granting it would let a citation resolve INTO the
shared backlog graph (BUG 62059b57 follow-up — the earlier narrowing from
`~/.adhd` stopped one directory too high). Projects opt into specific external
roots via `citationAllowedExternalRoots`; the carve-out mechanism is
unchanged. Read LAZILY on every `resolveProjectPolicy` call (never a
module-load constant), so the call surface stays stable if a legitimate
machine-global root is ever re-introduced.

### `displayExternalRoot(root)` — function (`citation-path.ts:89`)

```ts
export function displayExternalRoot(root: string): string;
```

`~`-anchors a root under the current home directory; returns the absolute path
otherwise. Used only to render `CitationUnverifiableError` messages.

### `isPathWithin(root, candidate)` — function (`citation-path.ts:106`)

```ts
export function isPathWithin(root: string, candidate: string): boolean;
```

Lexical containment via `path.relative` — never a bare `startsWith`, which a
name-prefix sibling (`/repo` vs `/repo-evil`) would defeat.

### `isMissingPathError(err)` — function (`citation-path.ts:132`)

```ts
export function isMissingPathError(err: unknown): boolean;
```

`true` for exactly `ENOENT`/`ENOTDIR` — the only errnos that mean "the file
genuinely is not there" and may degrade a citation to `'unverified'`. Every
other code (`EACCES`, `EISDIR`, `ELOOP`, …) is a real I/O failure. Shared by
`canonicalizePath` and both write verbs' `computeCitationSha` (BUG c6d35272
follow-up) so the taxonomy cannot drift. NOT used by `tools/etl/citation.ts`,
which deliberately also exempts `EISDIR`.

### `canonicalizePath(p)` — function (`citation-path.ts:150`)

```ts
export async function canonicalizePath(p: string): Promise<string>;
```

`realpath` of `p`; on ENOENT/ENOTDIR, realpaths the nearest EXISTING ancestor
and re-joins the non-existent tail. Any other errno propagates untouched.

### `IResolvedCitationTarget` — interface (`citation-path.ts:166`)

```ts
export interface IResolvedCitationTarget {
  accepted: boolean;
  candidate: string;
}
```

### `resolveCitationTarget(projectRoot, file, allowedRoots)` — function (`citation-path.ts:184`)

```ts
export async function resolveCitationTarget(
  projectRoot: string,
  file: string,
  allowedRoots: readonly string[]
): Promise<IResolvedCitationTarget>;
```

Canonical containment of `file` against `projectRoot` ∪ `allowedRoots`.
`projectRoot` and every allowed root are canonicalized through the same pass as
the candidate, so a `..` traversal or an escaping symlink cannot widen the
surface.

---

## `errors.ts` (20 exports)

### `WriteErrorCode` — type (`errors.ts:41`)

```ts
export type WriteErrorCode = 'E_CONTENTION' | 'E_CONSTRAINT' | 'E_VALIDATION' | 'E_IO';
```

Guarantees: the closed code union every `IWriteError` carries.

### `IWriteError` — interface (`errors.ts:55`)

```ts
export interface IWriteError {
  code: WriteErrorCode;
  retryable: boolean;
  retry_after_ms?: number;
  message: string;
  cause: unknown;
}
```

Guarantees: the write layer's INTERNAL envelope for a caught driver-level
failure — never the shape a caller of a write verb receives directly (they
only ever catch a named `BacklogWriteError` subclass). `cause` is never
swallowed.

### `BacklogWriteError` — abstract class (`errors.ts:71`)

```ts
export abstract class BacklogWriteError extends Error implements IWriteError {
  abstract readonly code: WriteErrorCode;
  abstract readonly retryable: boolean;
  readonly retry_after_ms?: number;
  readonly cause: unknown;
  protected constructor(message: string, cause?: unknown, retryAfterMs?: number);
}
```

Guarantees: common base for every transport-facing error the write layer
throws. `tx.ts`'s retry loop uses `instanceof BacklogWriteError` to recognize
an already-decided, terminal failure and rethrow it untouched.

### `WriteContentionError` — class (`errors.ts:97`)

```ts
export class WriteContentionError extends BacklogWriteError {
  readonly code: 'E_CONTENTION';
  readonly retryable: true;
  constructor(retryAfterMs: number, cause: unknown);
}
```

Guarantees: thrown after `E_CONTENTION` exhausts the retry budget (3 total
attempts). `retryable` stays `true` even on exhaustion — the caller, not the
write layer, owns any retry beyond this bound.

### `WriteIOError` — class (`errors.ts:126`)

```ts
export class WriteIOError extends BacklogWriteError {
  readonly code: 'E_IO';
  readonly retryable: true;
  readonly causeMessage: string;
  readonly causeCode?: string;
  constructor(cause: unknown);
}
```

Guarantees: thrown on the FIRST (and only) occurrence of a
recognized-but-otherwise-unclassified database error — never auto-retried,
because `writeAudit` rides inside every write transaction as an unguarded
INSERT and a retry whose earlier attempt actually committed would double the
audit trail. Also thrown for a citation read that fails with an errno other
than ENOENT/ENOTDIR/EISDIR (e.g. EACCES). `message` ends with the raw
underlying error's message, which is also exposed verbatim as `causeMessage`
(and its `code`, when present, as `causeCode`); `cause` is the original
error object (56a2133e). Every `E_IO` is also recorded at `error` level as
the `backlog.write.io_failure` telemetry event with `origin`
(`transaction`|`citation_sha`), `retryable`, `error`, `error_code` and
`stack`.

### `StaleSupersedeError` — class (`errors.ts:215`)

```ts
export class StaleSupersedeError extends BacklogWriteError {
  readonly code: 'E_CONSTRAINT';
  readonly retryable: false;
  constructor(public readonly uid: string);
}
```

Guarantees: the one deliberate `E_CONSTRAINT` this spec's own CAS raises —
thrown when `supersede`'s `is_superseded` guard affects zero rows (a
concurrent writer already superseded the same target). Never retryable.

### `CatalogNotFoundError` — class (`errors.ts:248`)

```ts
export class CatalogNotFoundError extends BacklogWriteError {
  readonly code: 'E_VALIDATION';
  readonly retryable: false;
  constructor(public readonly catalogKind: string, public readonly ref: string);
}
```

Guarantees: thrown when a `project`/`component`/`kind`/`status`/`priority`/
`agent`/`edge_kind` reference did not resolve — a uid-shaped ref with no live
row, or a `project`/`component` name (neither is ever mint-on-miss).

### `AmbiguousReferenceError` — class (`errors.ts:274`)

```ts
export class AmbiguousReferenceError extends BacklogWriteError {
  readonly code: 'E_VALIDATION';
  readonly retryable: false;
  constructor(
    public readonly ref: string,
    public readonly candidates: ReadonlyArray<{ uid: string; kind: string; name: string }>
  );
}
```

Guarantees: thrown when a uid PREFIX resolves to two or more live nodes.
Carries every candidate (`uid` + `kind` + `name`) so the caller can
disambiguate; the resolver NEVER auto-selects. Maps to the distinct envelope
code `ambiguous_reference` (exit 1) — not `item_not_found` — so a caller can
branch: a short reference is actionable, an absent uid is not.

### `InvalidArgumentError` — class (`errors.ts:335`)

```ts
export class InvalidArgumentError extends BacklogWriteError {
  readonly code: 'E_VALIDATION';
  readonly retryable: false;
  constructor(public readonly field: string, detail?: string);
}
```

Guarantees: thrown when a caller-supplied argument is missing, blank, or
fails a project-declared invariant.

### `IssueNotFoundError` — class (`errors.ts:349`)

```ts
export class IssueNotFoundError extends BacklogWriteError {
  readonly code: 'E_VALIDATION';
  readonly retryable: false;
  constructor(public readonly uid: string);
}
```

Guarantees: thrown when no live `issue` node carries the given `uid`.

### `ClaimHeldError` — class (`errors.ts:375`)

```ts
export class ClaimHeldError extends BacklogWriteError {
  readonly code: 'E_VALIDATION';
  readonly retryable: false;
  constructor(public readonly heldBy: string, public readonly heldSince: string);
}
```

Guarantees: thrown by `claim` when the lease is held by someone else, not yet
stale, and the caller did not pass `force: true`.

### `SingleValuedRelationConflictError` — class (`errors.ts:432`)

```ts
export class SingleValuedRelationConflictError extends BacklogWriteError {
  readonly code: 'E_VALIDATION';
  readonly retryable: false;
  readonly side: 'source' | 'target';
  readonly cappedUid: string;
  readonly rel: string;
  readonly conflictingUid: string;
  constructor(input: { side: 'source' | 'target'; cappedUid: string; rel: string; conflictingUid: string });
}
```

Guarantees: thrown by `checkMultiplicityTx` (and surfaced by `relate`) when a
single-valued rel's capped side already has a value that isn't the one being
added. A single named-options constructor — the two multiplicity branches
resolve `cappedUid`/`conflictingUid` via different SQL joins, and named
fields make a source/target field swap a compile error instead of a silent
message-text bug.

### `CitationUnverifiableError` — class (`errors.ts:478`)

```ts
export class CitationUnverifiableError extends BacklogWriteError {
  readonly code: 'E_VALIDATION';
  readonly retryable: false;
  constructor(
    public readonly target: string,
    public readonly allowedExternalRoots: readonly string[]
  );
}
```

Guarantees: thrown when a citation's `sha` resolves to the `"unverified"`
sentinel and `project_policy.citationRequiresSha` (default `true`) rejects
that. Applies only where verification is possible — a project with a non-empty
`path` whose citation target is missing OR whose canonical path lies outside
the project root AND every `citationAllowedExternalRoots` entry (BUG
c6d35272); a path-less project records `sha:"unverified"` verbatim instead.
The message names the allowed external roots (`~`-anchored) and the
`project_policy.citationAllowedExternalRoots` field that controls them, so the
rejection is actionable; with an empty allowlist (the default, or an explicit
`[]`) it instead names the project root and says the policy array is empty.

### `CitationTargetIsDirectoryError` — class (`errors.ts:524`)

```ts
export class CitationTargetIsDirectoryError extends BacklogWriteError {
  readonly code: 'E_VALIDATION';
  readonly retryable: false;
  constructor(target: string);
}
```

Guarantees: thrown by `createIssue` and `transition` when a citation's
target resolves to a directory (`readFile` fails with `EISDIR`). A directory
has no content to hash, so the payload can never succeed as-is; nothing is
written. The mapping from a citation read error to this class or to
`WriteIOError` lives in `errors.ts`'s `citationReadError` (56a2133e).

### `NoteRequiredError` — class (`errors.ts:554`)

```ts
export class NoteRequiredError extends BacklogWriteError {
  readonly code: 'E_VALIDATION';
  readonly retryable: false;
  constructor(public readonly uid: string);
}
```

Guarantees: thrown by `transition` when `project_policy.transitionRequiresNote`
(default `true`) is set and no `note` was given.

### `CitationRequiredError` — class (`errors.ts:566`)

```ts
export class CitationRequiredError extends BacklogWriteError {
  readonly code: 'E_VALIDATION';
  readonly retryable: false;
  constructor(public readonly uid: string);
}
```

Guarantees: thrown by `transition` when `project_policy.citationRequired`
(default `false`) is set, the target status is terminal, and no citation was
given.

### `BacklogValidationError` — class (`errors.ts:589`)

```ts
export class BacklogValidationError extends BacklogWriteError {
  readonly code: 'E_VALIDATION';
  readonly retryable: false;
  constructor(public readonly field: string, detail?: string);
}
```

Guarantees: the READ layer's own validation class (an unknown `fields` entry,
or an out-of-range/non-integral `limit`) — deliberately the SAME
`E_VALIDATION`-class member of this same error union, not a parallel one, so
a `query`/`get` caller catches it identically to any write-verb error.

### `AnchorLocatorInvalidError` — class (`errors.ts:604`)

```ts
export class AnchorLocatorInvalidError extends BacklogWriteError {
  readonly code: 'E_VALIDATION';
  readonly retryable: false;
  constructor(public readonly locator: string, detail?: string);
}
```

Guarantees: a supplied anchor locator is outside the closed grammar
(`path:<file>[:<line>]` | `url:<url>` | `query:<cql>` | `registry:<ref>`), or
is a bare `path:line` with no `digest`. A caller-input mistake — `E_VALIDATION`,
never retryable; nothing is written.

### `AttestationNotFoundError` — class (`errors.ts:623`)

```ts
export class AttestationNotFoundError extends BacklogWriteError {
  readonly code: 'E_VALIDATION';
  readonly retryable: false;
  constructor(public readonly uid: string);
}
```

Guarantees: thrown by `recheck` when the named uid is not a live `attestation`
node. Distinct from `IssueNotFoundError` (an `issue` uid) and
`CatalogNotFoundError`, so a caller can branch on the missing record kind;
`E_VALIDATION`, never retryable.

### `InvalidPredicateError` — class (`errors.ts:645`)

```ts
export class InvalidPredicateError extends BacklogWriteError {
  readonly code: 'E_VALIDATION';
  readonly retryable: false;
  constructor(public readonly detail: string);
}
```

Guarantees: thrown by `obligate` when a `requirement` is outside the CLOSED
predicate core — an unknown `op`, a missing/ill-typed leaf, an unexpected extra
key, or `evidence.min < 1`. Raised before any transaction opens, so an invalid
predicate never holds a write lock; `E_VALIDATION`, never retryable.

### `ObligationNotFoundError` — class (`errors.ts:660`)

```ts
export class ObligationNotFoundError extends BacklogWriteError {
  readonly code: 'E_VALIDATION';
  readonly retryable: false;
  constructor(public readonly uid: string);
}
```

Guarantees: thrown by `unobligate` when the named uid is not a live `obligation`
node. Distinct from `IssueNotFoundError` / `AttestationNotFoundError`, so a
caller can branch on the missing record kind; `E_VALIDATION`, never retryable.

### `classifyDriverError(err)` — function (`errors.ts:706`)

```ts
export function classifyDriverError(err: unknown): IWriteError;
```

Guarantees: classifies a caught RAW driver-level error (never one of our own
`BacklogWriteError` subclasses) into the internal `IWriteError` envelope,
using `@adhd/sox-store-adapter`'s portable driver-shaped detection
predicates — never a raw `err.code`/message match. `isDatabaseError(err)`
distinguishes a recognized-but-unclassified database error (`E_IO`,
`retryable: true`) from a genuinely unrecognized non-database failure
(`E_IO`, `retryable: false` — never retried, since it never even reached the
driver).

### `ObligationUnsatisfiedError(refusal)` — class (`errors.ts:788`)

```ts
export class ObligationUnsatisfiedError extends BacklogWriteError {
  readonly code: 'E_VALIDATION';
  readonly retryable: false;
  constructor(public readonly refusal: import('./gate.js').IGateRefusal);
}
```

Guarantees: thrown by `transition` on a **terminal** status change when the C5
closure gate found a `block`-severity obligation unsatisfied. Maps to the
envelope code `precondition_failed` (exit 1), with the structured refusal in
`error.details.refusal` (adhd ADR-0004). Thrown from INSIDE `transition`'s open
`BEGIN IMMEDIATE` transaction and before any write, so the throw rolls back and
a re-read shows the status unchanged. Never retryable. **Additive (C5)** —
appended after every pre-existing export so no `CONTRACT.md` anchor shifted.

### `OverrideNotPermittedError(obligationUid, actor)` — class (`errors.ts:808`)

```ts
export class OverrideNotPermittedError extends BacklogWriteError {
  readonly code: 'E_VALIDATION';
  readonly retryable: false;
  constructor(public readonly obligationUid: string, public readonly actor: string);
}
```

Guarantees: thrown by `transition` (via the C5 gate) when a claimed override of
a refusing obligation is not permitted — the actor is not in the obligation's
`override.actors`, or the reason is blank. An override ALWAYS requires a
recorded reason (DESIGN §2 Primitive 3), never a configurable boolean. Maps to
`precondition_failed`; never retryable. **Additive (C5)** — appended after every
pre-existing export so no `CONTRACT.md` anchor shifted.

---

## `audit.ts` (3 exports)

### `IWriteAuditInput` — interface (`audit.ts:45`)

```ts
export interface IWriteAuditInput {
  tx: AdapterTransaction;
  typePolicy: TypePolicy;
  subjectRowid: number;
  subjectUid: string;
  subjectKind: string;
  actor: string;
  action: string;
  from?: string;
  to?: string;
  note?: string;
  at?: string;
}
```

Guarantees: `tx` must be the SAME open transaction the caller's own subject
write already opened — there is no other way to call `writeAudit`.
`subjectKind` may be ANY kind, per `audits`' declared `source_kind: '*'`
sentinel. `at` defaults to `nowISO()` but should be reused from the caller's
own already-computed `now`.

### `IAuditWriteResult` — interface (`audit.ts:63`)

```ts
export interface IAuditWriteResult {
  rowid: number;
  uid: string;
  sha: string;
}
```

Guarantees: the rowid/uid of the newly-written `audit` node plus its computed
content-addressing `sha`.

### `writeAudit(input)` — function (`audit.ts:79`)

```ts
export async function writeAudit(input: IWriteAuditInput): Promise<IAuditWriteResult>;
```

Guarantees: writes exactly one `audit` node + its `audits` edge, against the
SAME `tx` the caller's own subject write already opened — never a separate
call, never after the subject transaction has committed. `sha` is ALWAYS
computed here (never optional, never caller-supplied) as `sha256` over the
canonical (sorted-key) JSON serialization of the audit's own recorded fields
(`actor`/`action`/`target_uid`/`from`/`to`/`note`/`at`) — "automatic, cannot
be forgotten" (SPEC.md §4a). The ONE structural exception NOT implemented
here: the embedding audit row (`embedding_upserted`/`embedding_deleted`/
`embedding_failed`), which necessarily runs in its own follow-up transaction
after the subject transaction has already committed — out of scope for this
foundation.

---

## `uid-prefix.ts` (11 exports)

The uid-REFERENCE resolution primitives — exact match or UNIQUE prefix —
shared by the read path (`GraphBackend`, consumed by `query/resolve.ts`) and
the write path (`resolveUidPrefixTx`). `isUidShaped` is defined here as well
and documented under `catalog.ts`, which re-exports it.

### `MIN_UID_PREFIX_LENGTH` — const (`uid-prefix.ts:56`)

```ts
export const MIN_UID_PREFIX_LENGTH = 8;
```

Guarantees: the shortest uid prefix accepted — eight hex characters, the
first UUID block and 32 bits of address space. A shorter uid ATTEMPT is
refused as too short rather than allowed to match broadly.

### `isUidPrefixShaped(ref)` — function (`uid-prefix.ts:68`)

```ts
export function isUidPrefixShaped(ref: string): boolean;
```

Guarantees: `true` iff `ref` is a proper prefix (`>= 8`, `< 36` characters)
of a canonical uid string — hex characters with hyphens only at the canonical
`8-4-4-4-12` boundary positions.

### `UidRefKind` — type (`uid-prefix.ts:83`)

```ts
export type UidRefKind = 'exact' | 'prefix' | 'too-short' | 'not-uid';
```

Guarantees: how a reference reads — an exact uid, a uid prefix, a too-short
uid attempt, or not uid-shaped at all.

### `classifyUidRef(ref)` — function (`uid-prefix.ts:91`)

```ts
export function classifyUidRef(ref: string): UidRefKind;
```

Guarantees: classifies a reference into `UidRefKind`; a strict uid context
rejects `too-short` while a uid-or-name context falls back to a name lookup,
so a genuine short value that is itself a valid name is never swallowed.

### `IUidCandidate` — interface (`uid-prefix.ts:105`)

```ts
export interface IUidCandidate {
  uid: string;
  kind: string;
  name: string | null;
  isSuperseded: boolean;
}
```

Guarantees: one live node matching a uid prefix, projected to the fields the
ambiguity decision and its error need.

### `IUidPrefixQueryExecutor` — interface (`uid-prefix.ts:117`)

```ts
export interface IUidPrefixQueryExecutor {
  executeAll<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<{ rows: T[] }>;
}
```

Guarantees: the minimal structural executor a prefix read needs — satisfied
by an `AdapterTransaction`, graph-store's `GraphTransaction`, or a bare
`StoreAdapter` alike.

### `INodeReadExecutor` — interface (`uid-prefix.ts:129`)

```ts
export interface INodeReadExecutor extends IUidPrefixQueryExecutor {
  executeGet<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<T | null>;
}
```

Guarantees: the executor a full uid resolution needs — the prefix candidate
read plus the exact single-row read.

### `queryLiveUidPrefixCandidates(exec, prefix)` — function (`uid-prefix.ts:155`)

```ts
export async function queryLiveUidPrefixCandidates(exec: IUidPrefixQueryExecutor, prefix: string): Promise<IUidCandidate[]>;
```

Guarantees: every LIVE node whose uid starts with `prefix`. The range
predicate is an indexed prefix scan; the input is lower-cased once (uids are
minted lowercase), so callers never reason about collation. Soft-deleted rows
are excluded in SQL; a superseded row is returned with its flag carried.

### `selectUniqueUidCandidate(ref, candidates)` — function (`uid-prefix.ts:178`)

```ts
export function selectUniqueUidCandidate(ref: string, candidates: readonly IUidCandidate[]): IUidCandidate | null;
```

Guarantees: the sole candidate, or `null` when none. Two or more candidates
throw `AmbiguousReferenceError` naming every one — the resolver NEVER
auto-selects.

### `missingUidError(expectedKind, ref, asPrefix)` — function (`uid-prefix.ts:196`)

```ts
export function missingUidError(expectedKind: string | undefined, ref: string, asPrefix: boolean): Error;
```

Guarantees: the kind-appropriate not-found error (`IssueNotFoundError` for
`issue`, `CatalogNotFoundError` otherwise); `asPrefix` selects the
"no item matches the uid prefix" wording over the exact-uid wording.

### `tooShortUidError(ref)` — function (`uid-prefix.ts:206`)

```ts
export function tooShortUidError(ref: string): InvalidArgumentError;
```

Guarantees: the refusal for a uid attempt below `MIN_UID_PREFIX_LENGTH`.

---

## C1 Reference — soft-retire redirect semantics (additive; outside the frozen four)

`merge-project` soft-retires a duplicate `project` row rather than deleting it.
The row keeps its `uid` FOREVER, is stamped `t_invalid` (so it is invisible to
every live-only list view), and gains two `meta` keys: `redirectTo` (the
canonical survivor's uid) and `retiredAt`. `query/resolve.ts`'s `tryResolveRef`
falls back to a ONE-HOP redirect on a live-name miss, so the retired NAME still
resolves to the survivor — `query {filter:{project:"<retired name>"}}` returns
the survivor's union. The fallback runs ONLY after a live-name miss, so it can
never change the result of a name that resolves to a live row.

`query/redirect.ts`'s `followRedirect(graph, record)` is the read half: it
returns the live survivor a row points at, or `null` when the row carries no
`redirectTo`. A redirect pointing at a missing/retired row, or a
redirect→redirect chain longer than one hop, THROWS `InvalidArgumentError`
rather than chaining silently. `rm-project` retires a project without a
survivor and writes NO `redirectTo`, so a removed name resolves to nothing.

`query/resolve.ts`'s `resolveLogicalIssue(graph, ref)` is the non-throwing
logical-id resolver: one redirect hop, then the `SUPERSEDES` chain to its head
(via the now-exported `currentUidOf`). Contrast `resolveIssueByUid`, which still
THROWS `StaleSupersedeError` on a superseded uid — the split is deliberate:
`get`/`card`/`stats` want the stale-reference signal, while an attestation
subject wants the same logical item back.
