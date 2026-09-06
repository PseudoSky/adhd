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
exports, `catalog.ts` — 12 exports, `errors.ts` — 15 exports, `audit.ts` — 3
exports. **Total: 54 exports.**

---

## `tx.ts` (24 exports)

### `IWriteStoreHandle` — interface (`tx.ts:38`)
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

### `ITxNodeRow` — interface (`tx.ts:51`)
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

### `nowISO()` — function (`tx.ts:100`)
```ts
export function nowISO(): string
```
Guarantees: returns the current UTC timestamp in the exact ISO-8601 shape
`@adhd/sox-graph-store` stamps every row with.

### `sha256Hex(input)` — function (`tx.ts:105`)
```ts
export function sha256Hex(input: string | Buffer): string
```
Guarantees: `sha256` hex digest of the given content — used for citation and
audit content-addressing; NEVER the library's own dedupe hash (that is
trim+lowercase, computed separately inside `writeNodeTx`).

### `canonicalJSONStringify(value)` — function (`tx.ts:117`)
```ts
export function canonicalJSONStringify(value: Record<string, unknown>): string
```
Guarantees: deterministic JSON serialization with object keys sorted at every
nesting level and `undefined` values omitted (never serialized as `null`) —
the one canonical form both `audit.sha` and `transition.sha` are computed
over.

### `getNodeByUidTx(tx, uid)` — function (`tx.ts:140`)
```ts
export async function getNodeByUidTx(tx: AdapterTransaction, uid: string): Promise<ITxNodeRow | null>
```
Guarantees: `uid` → node, issued against the caller's own open `tx` (never
the bare adapter) — mirrors the library's `getNodeByUid` SELECT exactly.
Returns `null` for no match; does not filter on `t_invalid` itself (callers
that need "live only" check `row.tInvalid === null` themselves).

### `getNodeByRowidTx(tx, rowid)` — function (`tx.ts:146`)
```ts
export async function getNodeByRowidTx(tx: AdapterTransaction, rowid: number): Promise<ITxNodeRow | null>
```
Guarantees: same as `getNodeByUidTx`, keyed by internal `rowid` instead —
used to resolve an edge endpoint's kind without a redundant round trip.

### `IWriteNodeTxInput` — interface (`tx.ts:151`)
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

### `writeNodeTx(tx, input)` — function (`tx.ts:226` after this task's edits)
```ts
export async function writeNodeTx(tx: AdapterTransaction, input: IWriteNodeTxInput): Promise<{ rowid: number; uid: string }>
```
Guarantees: hand-composed node INSERT issued against `tx`, mirroring the
library's own `writeNodeInTx` INSERT column list and defaults exactly.
**Unconditionally skips dedupe for every kind, structurally** — there is no
branch in this function, and no field on `IWriteNodeTxInput`, that can select
the library's content-hash-SELECT-then-maybe-insert behavior. SPEC.md §1/§4
("All entity writes pass `skipDedupe: true`") name no kind that is exempt, so
this function never runs that SELECT for any kind at all: always a fresh
INSERT, always a fresh `crypto.randomUUID()` uid.

### `EdgeMultiplicity` — type (`tx.ts:264`)
```ts
export type EdgeMultiplicity = 'n:1' | '1:n' | 'n:m';
```
Guarantees: the closed set of multiplicity values every `edge_kind` rule
declares. `n:1` caps the edge's SOURCE out-degree at one; `1:n` caps the
TARGET in-degree at one; `n:m` is uncapped on both sides.

### `IEdgeKindRule` — interface (`tx.ts:266`)
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

### `IWriteEdgeTxInput` — interface (`tx.ts:274`)
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

### `writeEdgeTx(tx, input)` — function (`tx.ts:365`)
```ts
export async function writeEdgeTx(tx: AdapterTransaction, input: IWriteEdgeTxInput): Promise<void>
```
Guarantees: validates `input.rule`'s declared `sourceKind`/`targetKind`
against the actual endpoint kinds (throws `BacklogEdgeKindMismatchError` on
mismatch), enforces `checkMultiplicityTx`'s capped-side conflict check
(throws `SingleValuedRelationConflictError`), calls the injected
`TypePolicy` directly in-process, THEN issues the upsert INSERT — same `ON
CONFLICT(src, dst, rel) DO UPDATE` / re-livening (`t_invalid = NULL`) as the
library's own `writeEdgeInternal`, issued against `tx`.

### `BacklogEdgeKindMismatchError` — class (`tx.ts:406`)
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

### `IInvalidateEdgeTxInput` — interface (`tx.ts:415`)
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

### `invalidateEdgeTx(tx, input)` — function (`tx.ts:434`)
```ts
export async function invalidateEdgeTx(tx: AdapterTransaction, input: IInvalidateEdgeTxInput): Promise<void>
```
Guarantees: mirrors the library's `invalidateEdge` exactly — idempotent
no-op if the edge is already invalidated or absent; otherwise sets
`t_invalid` and merges `invalidatedAt`/`invalidatedReason` into `meta`,
issued against `tx`.

### `executeWriteTransaction(handle, fn)` — function (`tx.ts:543`)
```ts
export async function executeWriteTransaction<T>(
  handle: IWriteStoreHandle,
  fn: (tx: AdapterTransaction) => Promise<T>,
): Promise<T>
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

### `isUidShaped(ref)` — function (`catalog.ts:57`)
```ts
export function isUidShaped(ref: string): boolean
```
Guarantees: `true` iff `ref` matches the 36-character version-4-UUID shape
exactly (case-insensitive) — the SOLE disambiguation between "treat as
`uid`" (exact resolve-or-throw) and "treat as `name`" (find, and for flat
catalogs, find-then-mint) used everywhere in this file.

### `IResolvedCatalogRow` — interface (`catalog.ts:61`)
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

### `IResolvedProjectRow` — interface (`catalog.ts:67`)
```ts
export interface IResolvedProjectRow extends IResolvedCatalogRow {
  metadata: Record<string, unknown> | undefined;
}
```
Guarantees: `IResolvedCatalogRow` plus the project's parsed `meta` blob
(`undefined` if absent or unparsable) — the shape `resolveProjectPolicy`
reads `metadata.policy` off of.

### `resolveProjectTx(tx, ref)` — function (`catalog.ts:111`)
```ts
export async function resolveProjectTx(tx: AdapterTransaction, ref: string): Promise<IResolvedProjectRow>
```
Guarantees: resolves `ref` (uid or name) to a LIVE `project` row inside `tx`.
Resolved-ONLY — NEVER mints a project. Throws `CatalogNotFoundError` on no
match.

### `resolveComponentTx(tx, input)` — function (`catalog.ts:137`)
```ts
export async function resolveComponentTx(
  tx: AdapterTransaction,
  input: { projectUid: string; ref: string },
): Promise<IResolvedCatalogRow>
```
Guarantees: resolves `input.ref` (uid or name) to a LIVE `component` row
scoped to `input.projectUid` inside `tx`. Resolved-ONLY — an unresolved name,
or a uid-shaped ref belonging to a DIFFERENT project, throws
`CatalogNotFoundError('component', ref)` rather than forking a new component.

### `resolveDefaultComponentTx(tx, input)` — function (`catalog.ts:168`)
```ts
export async function resolveDefaultComponentTx(
  tx: AdapterTransaction,
  input: { projectRowid: number },
): Promise<IResolvedCatalogRow>
```
Guarantees: resolves the project's reserved `(root)` component via the
`owns_project` edge traversal (never a bare name lookup, so a `(root)` row
belonging to a different project can never be mismatched onto this one).
NEVER mints — throws `CatalogNotFoundError('component', '(root)')` if
missing (a row `upsertProject` is expected to already guarantee).

### `FlatCatalogKind` — type (`catalog.ts:184`)
```ts
export type FlatCatalogKind = 'kind' | 'status' | 'priority' | 'agent';
```
Guarantees: the closed set of catalog kinds that are mintable on an
unresolved NAME (never on an unresolved uid-shaped ref).

### `IMintOrResolveInput` — interface (`catalog.ts:186`)
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

### `mintOrResolveCatalogTx(tx, input)` — function (`catalog.ts:209`)
```ts
export async function mintOrResolveCatalogTx(
  tx: AdapterTransaction,
  input: IMintOrResolveInput,
): Promise<IResolvedCatalogRow>
```
Guarantees: find-then-create for `kind`/`status`/`priority`/`agent`. A
uid-shaped `ref` that does not resolve throws `CatalogNotFoundError` (uids
are never auto-vivified). A name-shaped `ref` that does not resolve is
minted via `writeNodeTx` inside the SAME `tx`.

### `nextPriorityRankTx(tx)` — function (`catalog.ts:232`)
```ts
export async function nextPriorityRankTx(tx: AdapterTransaction): Promise<number>
```
Guarantees: returns one past the current max `priority.meta.rank` (0 if no
priority rows exist) — a novel priority can never silently outrank an
existing one.

### `EDGE_KIND_TABLE` — const (`catalog.ts:245`)
```ts
export const EDGE_KIND_TABLE: readonly IEdgeKindRule[];
```
Guarantees: the fixed, complete `(rel, source_kind, target_kind,
multiplicity)` table for every declared `rel` in the schema (17 rows at the
time of this contract: `owns_project`, `owns_component`, `has_kind`,
`has_status`, `has_priority`, `authored_by`, `has_note`, `has_citation`,
`has_transition`, `audits`, `depends_on`, `has_location`, `relates_to`,
`supersedes`, `blocks`, `duplicate_of`, `part_of`). This is the single source
of truth `resolveEdgeKindTx` reconciles against the live `edge_kind` catalog
rows.

### `resolveEdgeKindTx(tx, rel)` — function (`catalog.ts:304`)
```ts
export async function resolveEdgeKindTx(tx: AdapterTransaction, rel: string): Promise<IEdgeKindRule>
```
Guarantees: resolves the `edge_kind` catalog row for `rel` inside `tx`.
`edge_kind` is NEVER caller-mintable — on a miss (no dedicated seed script
exists yet), self-heals by seeding the row from `EDGE_KIND_TABLE`, the
identical fixed shape a real seed script would write. A malformed existing
row (corrupt or missing `meta` keys) is invalidated and replaced in the SAME
`tx`, converging to exactly one live `edge_kind` row per `rel`. Throws
`CatalogNotFoundError('edge_kind', rel)` if `rel` isn't in
`EDGE_KIND_TABLE` at all.

### `IProjectPolicy` — interface (`catalog.ts:354`)
```ts
export interface IProjectPolicy {
  readonly transitionRequiresNote: boolean;
  readonly citationRequired: boolean;
  readonly citationRequiresSha: boolean;
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
`allowedKinds` empty means "no restriction."

### `resolveProjectPolicy(project)` — function (`catalog.ts:395`)
```ts
export function resolveProjectPolicy(project: IResolvedProjectRow): IProjectPolicy
```
Guarantees: returns a FRESH `IProjectPolicy` object on every call (never a
shared reference), merging `project.metadata.policy` field-by-field over the
frozen `DEFAULT_PROJECT_POLICY` defaults. A project with no `policy` object
at all gets every default field exactly as SPEC.md §2 states.

*(Note: `IEdgeKindRule` is re-exported by `catalog.ts` via its `import type`
from `tx.ts` — it is counted once, under `tx.ts`, above.)*

---

## `errors.ts` (15 exports)

### `WriteErrorCode` — type (`errors.ts:39`)
```ts
export type WriteErrorCode = 'E_CONTENTION' | 'E_CONSTRAINT' | 'E_VALIDATION' | 'E_IO';
```
Guarantees: the closed code union every `IWriteError` carries.

### `IWriteError` — interface (`errors.ts:49`)
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

### `BacklogWriteError` — abstract class (`errors.ts:65`)
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

### `WriteContentionError` — class (`errors.ts:87`)
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

### `WriteIOError` — class (`errors.ts:116`)
```ts
export class WriteIOError extends BacklogWriteError {
  readonly code: 'E_IO';
  readonly retryable: true;
  constructor(cause: unknown);
}
```
Guarantees: thrown on the FIRST (and only) occurrence of a
recognized-but-otherwise-unclassified database error — never auto-retried,
because `writeAudit` rides inside every write transaction as an unguarded
INSERT and a retry whose earlier attempt actually committed would double the
audit trail.

### `StaleSupersedeError` — class (`errors.ts:133`)
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

### `CatalogNotFoundError` — class (`errors.ts:149`)
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

### `InvalidArgumentError` — class (`errors.ts:159`)
```ts
export class InvalidArgumentError extends BacklogWriteError {
  readonly code: 'E_VALIDATION';
  readonly retryable: false;
  constructor(public readonly field: string, detail?: string);
}
```
Guarantees: thrown when a caller-supplied argument is missing, blank, or
fails a project-declared invariant.

### `IssueNotFoundError` — class (`errors.ts:169`)
```ts
export class IssueNotFoundError extends BacklogWriteError {
  readonly code: 'E_VALIDATION';
  readonly retryable: false;
  constructor(public readonly uid: string);
}
```
Guarantees: thrown when no live `issue` node carries the given `uid`.

### `ClaimHeldError` — class (`errors.ts:182`)
```ts
export class ClaimHeldError extends BacklogWriteError {
  readonly code: 'E_VALIDATION';
  readonly retryable: false;
  constructor(public readonly heldBy: string, public readonly heldSince: string);
}
```
Guarantees: thrown by `claim` when the lease is held by someone else, not yet
stale, and the caller did not pass `force: true`.

### `SingleValuedRelationConflictError` — class (`errors.ts:214`)
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

### `CitationUnverifiableError` — class (`errors.ts:244`)
```ts
export class CitationUnverifiableError extends BacklogWriteError {
  readonly code: 'E_VALIDATION';
  readonly retryable: false;
  constructor(public readonly target: string);
}
```
Guarantees: thrown when a citation's `sha` resolves to the `"unverified"`
sentinel and `project_policy.citationRequiresSha` (default `true`) rejects
that.

### `NoteRequiredError` — class (`errors.ts:254`)
```ts
export class NoteRequiredError extends BacklogWriteError {
  readonly code: 'E_VALIDATION';
  readonly retryable: false;
  constructor(public readonly uid: string);
}
```
Guarantees: thrown by `transition` when `project_policy.transitionRequiresNote`
(default `true`) is set and no `note` was given.

### `CitationRequiredError` — class (`errors.ts:264`)
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

### `BacklogValidationError` — class (`errors.ts:285`)
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

### `classifyDriverError(err)` — function (`errors.ts:331`)
```ts
export function classifyDriverError(err: unknown): IWriteError
```
Guarantees: classifies a caught RAW driver-level error (never one of our own
`BacklogWriteError` subclasses) into the internal `IWriteError` envelope,
using `@adhd/sox-store-adapter`'s portable driver-shaped detection
predicates — never a raw `err.code`/message match. `isDatabaseError(err)`
distinguishes a recognized-but-unclassified database error (`E_IO`,
`retryable: true`) from a genuinely unrecognized non-database failure
(`E_IO`, `retryable: false` — never retried, since it never even reached the
driver).

---

## `audit.ts` (3 exports)

### `IWriteAuditInput` — interface (`audit.ts:37`)
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

### `IAuditWriteResult` — interface (`audit.ts:55`)
```ts
export interface IAuditWriteResult {
  rowid: number;
  uid: string;
  sha: string;
}
```
Guarantees: the rowid/uid of the newly-written `audit` node plus its computed
content-addressing `sha`.

### `writeAudit(input)` — function (`audit.ts:71`)
```ts
export async function writeAudit(input: IWriteAuditInput): Promise<IAuditWriteResult>
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
