# C1 — Reference: canonical identity & resolution

> **Ticket:** `73d0b9c6-ac2e-46d4-b0c7-4df386a30d2c` (CRITICAL) · component `9a7bf578`
> **Design:** `../DESIGN.md` §2 Primitive 1, §5 AC1, §6 Identity, §7 conditions 1/5 · **Conceptual test:** `../CONCEPTUAL_TEST.md` §A.1/§A.5/§D.1-2
> **ADRs read:** ADR-0001 (store atomicity — the store owns atomicity; no temp-file/lock tricks), ADR-0002 (correct the source), ADR-0003 (CJS-only publish), ADR-0004 (flat MCP `content`, no `{result}` envelope).

## DoR

- **Owner repo:** `entrypoint/backlog` (adhd) · **Wave:** 1 · **Dependencies:** none (C1 is a leaf of the dependency graph; it blocks C2/C3/C9) · **Evidence requirement:** `nx test backlog` green driving the real mounted verbs through the in-process barrel on a seeded temp store, with the AC1–AC8 negative controls (each must go RED); exit-code keyed, not stdout.

> **Name reconciliation.** C1 defines the non-throwing logical-id resolver as `resolveLogicalIssue` (returns the head `NodeRecord`). C3's `resolveLogicalIssueId` is the same concept — a thin uid-string wrapper. **One concept, one implementation:** `resolveLogicalIssueId(graph, uid)` delegates to `resolveLogicalIssue`. Do not mint a second chain walk (adhd ADR-0002).

## Summary

Give every token a consumer holds (short uid prefix, project name, repo URL, component/location path) exactly one canonical resolution or a loud, typed failure that names the candidates. Canonical identity is the immutable `uid` minted at creation; `name`/`repoUrl` become mutable attributes. Add `merge-project`/`rm-project` with a one-hop `Redirect` row (soft-retire, never hard-delete, ids never reused), and expose the existing `SUPERSEDES`-chain walk as a *resolving* logical-id API (today it is private and error-path-only). All work is read-path resolution or store-owned atomic writes — no file-atomic patterns (ADR-0001).

## Premise corrections (read before implementing)

1. **`currentUidOf` already walks the `SUPERSEDES` chain** (in `query/resolve.ts`) — but it is *private*, runs only on the error path, and `resolveIssueByUid` **throws** `StaleSupersedeError` instead of redirecting (also in `resolve.ts`). C1 AC7's "still resolves to the same logical item" therefore needs a **new non-throwing resolver**, not a new chain walk. Do not re-implement the walk (ADR-0002) — export it. (Cited by symbol; line anchors rot on every edit.)
2. **`lookup` is location-only by construction, not by accident.** `lookup` (in `query/views/registry.ts`) only ever queries `kind:'location'` and throws `CatalogNotFoundError('location', q)` on a miss. There is no uid/title/project branch at all. C1 AC4 is a genuine new routing behaviour.
3. **"The location registry is effectively empty" is a data claim, not verifiable from source.** The code path exists and works; treat the emptiness as a population fact, not a code defect. The fix is the fallback routing in AC4, which makes `lookup` useful regardless of population.
4. **Project equality is by `name` today**, not by id: `upsertProject` upserts on `name` only (`write/catalog.ts`), and `resolveProjectTx` matches name OR uid (`catalog.ts`). A `name`/`repoUrl` split is therefore possible *by construction*. AC5 requires a new dedupe-by-`repoUrl` reconciliation step, and the design's §7 condition 5 applies: **the sox-store duplicates are a sox-side decision request, never an adhd rewrite** (ADR-0002).

## Files

| Package / Repo | Path | Change | Read tokens | Output tokens |
|----------------|------|--------|-------------|---------------|
| entrypoint/backlog | src/write/errors.ts | modify | 120 | 60 |
| entrypoint/backlog | src/write/catalog.ts | modify | 200 | 180 |
| entrypoint/backlog | src/query/resolve.ts | modify | 160 | 260 |
| entrypoint/backlog | src/query/views/registry.ts | modify | 160 | 200 |
| entrypoint/backlog | src/query/types.ts | modify | 80 | 90 |
| entrypoint/backlog | src/write/merge-project.ts | create | 0 | 320 |
| entrypoint/backlog | src/query/redirect.ts | create | 0 | 90 |
| entrypoint/backlog | src/api.ts | modify | 60 | 120 |
| entrypoint/backlog | src/index.ts | modify | 30 | 40 |
| entrypoint/backlog | src/server.ts | modify | 20 | 20 |

## Interface changes

### src/write/errors.ts — new typed error for ambiguity

```typescript
// AFTER (new class, emitted alongside IssueNotFoundError / CatalogNotFoundError)
/**
 * A unique-prefix resolution matched ≥2 live nodes. Carries the candidate set
 * (uid + name + kind) so the caller can pick one; NEVER auto-selects.
 */
export class AmbiguousReferenceError extends BacklogWriteError {
  readonly code = 'E_VALIDATION' as const;
  readonly retryable = false;
  constructor(
    public readonly ref: string,
    public readonly candidates: ReadonlyArray<{ uid: string; kind: string; name: string }>
  ) {
    super(
      `"${ref}" is ambiguous — ${candidates.length} candidates: ` +
        candidates.map((c) => `${c.uid} (${c.kind} "${c.name}")`).join(', ')
    );
  }
}
```
`AmbiguousReferenceError` maps to a **new** envelope code `ambiguous_reference` (exit 1) — *not* `item_not_found` and *not* `validation` — so a caller can branch on it structurally. Add `'ambiguous_reference'` to `BACKLOG_ERROR_CODES`, `BACKLOG_EXIT_CODE`, and the class→code map in `envelope.ts` (ADR-0004: derived union, derived table).

### src/query/redirect.ts (new) — the one-hop `Redirect` primitive

```typescript
export interface IRedirect {
  /** The canonical uid this retired row points at. */
  toUid: string;
  /** Why the row was retired — recorded on the retired node's audit + meta. */
  reason: string;
}
/**
 * If `record` is a soft-retired row carrying `meta.redirectTo`, return the
 * canonical live node it points at (one hop only; a redirect→redirect chain
 * longer than one hop throws). Otherwise null.
 */
export async function followRedirect(
  graph: GraphBackend,
  record: NodeRecord
): Promise<NodeRecord | null>;
```

### src/query/resolve.ts — prefix + redirect + logical-id resolution

```typescript
// AFTER (new exports; existing signatures unchanged)
/**
 * Resolve `ref` to exactly one live node by UNIQUE uid PREFIX. Exact-uid is
 * returned directly; a unique prefix is returned; ≥2 matches throw
 * AmbiguousReferenceError; zero throws IssueNotFoundError iff no live node
 * starts with the prefix, else CatalogNotFoundError for a non-issue kind.
 */
export async function resolveUidPrefix(
  graph: GraphBackend,
  ref: string,
  opts?: { expectedKind?: string }
): Promise<NodeRecord>;

/**
 * Resolve a token to a LOGICAL issue id: follows a merge Redirect one hop,
 * then the SUPERSEDES chain to its head. NEVER throws on a superseded uid
 * (contrast resolveIssueByUid, which throws StaleSupersedeError). Returns the
 * current head node. This is the resolver C3's `subject.id` uses.
 */
export async function resolveLogicalIssue(
  graph: GraphBackend,
  ref: string
): Promise<NodeRecord>;

// EXPORT the existing chain walk (no body change) so redirect/logical-id code
// reuses it rather than duplicating it (ADR-0002):
export { currentUidOf };  // was module-private (in resolve.ts)
```

`tryResolveRef` (in `resolve.ts`) gains a redirect fallback: on a NAME miss against live rows, query non-live `project`/`component` rows whose `meta.redirectTo` is set and whose `name` equals `ref`, and follow the redirect one hop. This makes AC5's "the retired name resolves via one-hop redirect" true without resurrecting the retired row into list views.

### src/query/views/registry.ts — `lookup` routes by kind

```typescript
// BEFORE: export async function lookup(graph, q): Promise<ILookupResult>  (location-only)
// AFTER:  lookup accepts an optional kind hint and falls back to issue/registry routing
export interface ILookupInput {
  q: string;
  /** optional: 'location' | 'project' | 'component' | 'issue' */
  kind?: string;
}
export async function lookup(
  graph: GraphBackend,
  input: string | ILookupInput
): Promise<ILookupResult>;
```
Routing order: (1) if `q` is uid-shaped or a uid prefix → `resolveUidPrefix` → return `{ redirect: { verb: 'get', uid } }`; (2) title grep via `graph.searchNodes(q)` (kind `issue`) → if exactly one, return a redirect to `get`; if ≥2, `AmbiguousReferenceError`; (3) existing location classify→match→walk; (4) project name/repoUrl match. `ILookupResult` (in `query/types.ts`) gains an optional `redirect?: { verb: 'get' | 'query'; uid?: string; query?: string }` and `candidates?: Array<{uid,kind,name}>`.

### src/write/merge-project.ts (new)

```typescript
import type { IProjectSummary } from '../query/types.js';

export interface IMergeProjectInput {
  fromUid: string;   // the duplicate / retiring row
  toUid: string;     // the canonical survivor
  by: string;        // identity; asserted non-blank + not a bare role literal
}
export interface IMergeProjectOutcome {
  survivorUid: string;
  retiredUid: string;
  /** How many issues' `owns_component` chains were re-pointed onto the survivor. */
  movedIssues: number;
  /** Always true — the retired uid is never reusable. */
  retired: true;
}

/**
 * One BEGIN IMMEDIATE transaction (ADR-0001): re-point every component owned
 * by `fromUid` (owns_project) onto `toUid`, set `fromUid.meta.redirectTo =
 * toUid` + `fromUid.meta.retiredAt`, stamp `t_invalid`, and write an audit row.
 * Idempotent: a second call with the same (from,to) is a no-op success.
 */
export async function mergeProject(handle: IWriteStoreHandle, input: IMergeProjectInput): Promise<IMergeProjectOutcome>;

export interface IRmProjectInput { uid: string; reason: string; by: string }
/** Soft-retire without a survivor: sets `meta.retiredAt`, stamps `t_invalid`, audits. No redirectTo. */
export async function rmProject(handle: IWriteStoreHandle, input: IRmProjectInput): Promise<{ uid: string; retired: true }>;
```

`write/catalog.ts` `upsertProjectTx` gains a pre-mint guard: before minting a new `project`, scan live `project` rows whose `meta.repoUrl` equals the input's `repoUrl` (if given) — on a hit, **update that row** instead of minting a second (the dedupe half of AC5). Document this as advisory-dedupe, not auto-merge.

### src/api.ts — mount the two verbs

```typescript
// AFTER: new exported operation wrappers
export async function mergeProject(ctx: BacklogCtx, input: IMergeProjectInput) { ... }
export async function rmProject(ctx: BacklogCtx, input: IRmProjectInput) { ... }
```
Mount names `merge-project` / `rm-project`; add both to `BACKLOG_VERBS` (in `server.ts`) so `server.ts`'s extraction and the transports cannot drift. Re-export from `index.ts`. The `get` verb itself (in `api.ts`) is unchanged in shape; its dispatch narrows on `'registry' in input` and is untouched.

## Behavioral changes

### `get {uid:"4fc3704e"}` — prefix resolution

- **Change:** `getIssue` (in `query/get.ts`) resolves via `resolveUidPrefix` before `resolveIssueByUid`.
- **Unique prefix** → item. **Exact 36-char uid** → item. **Ambiguous** → `AmbiguousReferenceError`. **None** → `IssueNotFoundError`. Preserves AC1/AC2/AC3.
- **Scope:** only the uid branch; the registry-detail branch (`registry` in input) is untouched.

### `resolveIssueByUid` / `resolveLogicalIssue` split

- **Change:** leave `resolveIssueByUid` throwing on supersession (existing callers rely on it — `get`, `card` blockers, `stats`). Add `resolveLogicalIssue` as the non-throwing head-resolver; C3's attestation `subject.id` will use it.
- **Do NOT** change `StaleSupersedeError`'s shape.

### `lookup {q}` — kind routing

- **Change:** see routing order above. Existing location-only behaviour preserved as step 3 so current consumers of an exact location path are unchanged.
- **Add import** of `resolveUidPrefix` from `./resolve.js` — call sites inside `views/registry.ts`.

### Filing with an unresolvable component (AC8)

- **Change:** `resolveComponentTx` (in `write/catalog.ts`) already throws `CatalogNotFoundError('component', ref)`. The gap is the **silent `(root)` default** in `createIssue` when `component` is omitted: when the caller *supplied* a component that failed to resolve, the error must propagate (already does); when the caller supplied none, the reserved `(root)` default is used (`resolveDefaultComponentTx`, in `catalog.ts`) — **that default stays**, but it must be visible: add `placementResolved: 'explicit' | 'default-root'` to the create outcome so "silently defaulted" is distinguishable from "resolved". AC8's negative control asserts the silent default is impossible when a component was supplied.

## Data / migration steps

1. **No schema change.** Redirect lives in `node.meta.redirectTo`; retirement is `t_invalid` (existing bi-temporal column). Reconciliation of existing duplicate `project` rows is a **reviewed operator action** via the new `merge-project` verb — never an automatic write.
2. **`Retired ids never reused`:** `uid` is already minted per node (`writeNodeTx`); no reuse path exists. A regression test asserts `create` mints a fresh uid after a merge.
3. **sox-store duplicates:** out of scope. File a sox-side decision request per ADR-0002 D4; the adhd verbs operate on the adhd store only.

## Test list (each AC → a test, with its negative control)

| AC | Test (real store, real verbs — no mocks) | Negative control (must go RED) |
|----|------------------------------------------|-------------------------------|
| AC1 | `get` with the first 8 hex of a real seeded item returns it | PoC returning first match on a prefix shared by 2 items → must throw `AmbiguousReferenceError` |
| AC2 | Ambiguous prefix returns ≥2 typed candidates, no item | A resolver that returns the first match must fail the test |
| AC3 | Same ref: nonexistent prefix → `item_not_found`; ambiguous prefix → `ambiguous_reference` — **different codes** | A build mapping both to `item_not_found` must fail |
| AC4 | `lookup` with a real issue uid / real title / `"adhd"` each resolve or redirect; **none** returns `not_found "location"` | Restore the location-only body (`views/registry.ts:375`) → must go RED |
| AC5 | After `merge-project`, `query {filter:{project:<survivor>}}` returns the union; the retired name resolves via one-hop redirect | A build returning only pre-merge rows, or not resolving the retired name, must fail |
| AC6 | `merge-project` twice is idempotent; retired uid absent from `view:'projects'`; a subsequent `create` mints a fresh uid | A build that re-lists the retired row or reuses its uid must fail |
| AC7 | `attest` → body-edit `update` (new uid) → read attestation subject → resolves to the same logical item | A build using `resolveIssueByUid` (throws on the old uid) must fail |
| AC8 | Filing with an unresolvable component errors naming it; a supplied component that resolves yields `placementResolved:'explicit'` | A test asserting a silent `(root)` placement for a *supplied* component must fail |

Integration harness: seed a temp store under `tmp/backlog/c1/`, run the real mounted verbs via the in-process barrel, assert exit codes/envelopes (trust exit codes, not stdout).

## Blast radius (gitnexus)

- `resolveIssueByUid` — callers: `query/get.ts`, `query/card.ts` (via `assembleIssueCard`), `query/views/stats.ts`, `query/query.ts` (ready/stale). **Signature unchanged** → no caller edits. Adding `resolveLogicalIssue`/`resolveUidPrefix` is additive.
- `tryResolveRef` — callers: `resolveEdgeScopedCandidates`, `resolveValidatedCatalogFilter`, `views/registry.ts` (`listProjects`/`listComponents`/`listLocations`/`getRegistryDetail`/`lookup`), `views/stats.ts`, `query.ts` filter resolution. The redirect fallback adds one extra query **only on a name miss**; hot paths that resolve live names are unaffected. **Audit:** a redirect fallback must never change a resolved live name's result.
- `lookup` — mounted at the `lookup` verb in `api.ts`; only consumer is the `lookup` verb + `ILookupResult`. Adding `redirect`/`candidates` is additive.
- `BACKLOG_ERROR_CODES` — a **derived** union (in `envelope.ts`): adding a code requires the class and the map together, or the union is a lie. Update `server.ts` verb list in the same commit.
- `upsertProjectTx` — callers: `upsertProject`, ETL import (`tools/etl/import-item.ts` participates via `*Tx`). The repoUrl pre-guard changes mint-vs-update behaviour for repoUrl-bearing projects; the ETL's golden-parity gate must be re-run.

## Independent segments (execution order)

### Segment 1 — Error + envelope (files: `write/errors.ts`, `envelope.ts`)
- Deps: none. Read: `errors.ts:248-282`, `envelope.ts:30-95`. Read ~150 tok, out ~120 tok.
- Add `AmbiguousReferenceError`; add `ambiguous_reference` to the derived union + exit table.
- **Do NOT** touch any other class.

### Segment 2 — Prefix + redirect + logical-id primitives (files: `query/resolve.ts`, `query/redirect.ts` create)
- Deps: Segment 1. Read: `resolve.ts:64-219` (~160 tok). Out ~300 tok.
- Export `currentUidOf`; add `resolveUidPrefix`, `resolveLogicalIssue`; create `followRedirect`.
- **Do NOT** alter `resolveIssueByUid`'s throw behaviour.

### Segment 3 — `lookup` routing (file: `query/views/registry.ts`, `query/types.ts`)
- Deps: Segment 2. Read: `registry.ts:350-498` + `types.ts:433-455` (~160 tok). Out ~250 tok.
- Add `ILookupInput`, routing order, `ILookupResult.redirect/candidates`.

### Segment 4 — `merge-project` / `rm-project` (files: `write/merge-project.ts` create, `write/catalog.ts`, `api.ts`, `index.ts`, `server.ts`)
- Deps: Segments 1-2. Read: `catalog.ts:833-973`, `api.ts` verb block (~782), `server.ts:188-207` (~260 tok). Out ~420 tok.
- Model the transaction on `catalog-merge.ts` (journal/reverse posture). RepoUrl pre-guard in `upsertProjectTx`.
- **Do NOT** attempt automatic dedupe writes; the verb is explicit and reviewed.

## Documentation

- Update `entrypoint/backlog/skill/SKILL.md` verb surface (merge-project, rm-project, prefix syntax) and `query-lookup` routing.
- Note the redirect semantics in `entrypoint/backlog/src/write/CONTRACT.md`.
- If the CLI help enumerates verbs, no edit is needed (it is generated from the mounted surface).
