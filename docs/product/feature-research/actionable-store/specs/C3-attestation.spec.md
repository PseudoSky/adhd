# C3 — Attestation: anchored, verifiable evidence that never churns identity

**Ticket:** `38631ad4-c721-4527-a117-c31b6c3df26c` · priority HIGH ·
component `9a7bf578` (backlog). **Design:** `actionable-store/DESIGN.md` §2
Primitive 2, §5 AC3, §7.6. **Depends on:** C1 (subject resolution / project-root
resolution). **Blocks:** C5, C6.

## DoR

- **Owner repo:** `entrypoint/backlog` (adhd) · **Wave:** 2 · **Dependencies:** C1 (non-terminal — C3 cannot land until C1's `resolveUidPrefix`/chain-walk export is terminal; the foundation amendment in Segment A is a shared C3/C4/C5 request) · **Evidence requirement:** `attestation.spec.ts` + `anchor-check.spec.ts` (real store, real git CLI) with the AC1–AC7 negative controls; AC3/AC4 must prove the pre-fix path goes RED. No LLM; runs default.

> **Research note.** The external prior-art research this primitive rests on
> (in-toto `{subject-by-digest, predicateType, predicate}`, git notes, Jujutsu
> change-id, GitHub `status × conclusion` + first-class `stale`, Wikidata
> deprecate-with-reason, C2PA claim-vs-assertion) is already folded into
> `DESIGN.md` §2 Primitive 2 and is not re-run here. No new third-party
> dependency is introduced: anchors are checked with `node:fs`, `node:crypto`
> and the local `git` CLI the repo already shells to.

## Summary

Add a first-class **Attestation** record — a separate node keyed to an issue,
never written into it — plus two new verbs `attest` (create) and `recheck`
(append a check). The record carries `{subject, claim, anchor, check}` and an
append-only `checks[]` history. Anchors are `locator + digest`; a check is
computed by a cheap-first ladder (existence at HEAD → changed-since-filing →
full re-resolve on demand) and records its own `method`, so `unverified` /
`stale` / `unknown` are explicit states, never an absent field. The item's
`uid` never changes: an attestation is a *sibling* record, and after an
`update` body-edit supersedes the issue the existing
`carryForwardResidualEdgesTx` sweep re-points the `attests` edge onto the new
node, while `subject.id` is normalised through the `SUPERSEDES` chain on read.
Two sources are corrected at source (adhd ADR-0002): the tool's own installed
skill root becomes a citable evidence root, and a sibling-project root is
resolved before an anchor is probed.

## Files

| Package / Repo | Path | Change | Read tokens | Output tokens |
|---|---|---|---|---|
| backlog | `entrypoint/backlog/src/write/attestation.ts` | create | 0 | 900 |
| backlog | `entrypoint/backlog/src/write/anchor-check.ts` | create | 0 | 550 |
| backlog | `entrypoint/backlog/src/write/errors.ts` | modify | 250 | 220 |
| backlog | `entrypoint/backlog/src/write/catalog.ts` | modify (foundation — see gate) | 120 | 60 |
| backlog | `entrypoint/backlog/src/write/citation-path.ts` | modify | 200 | 140 |
| backlog | `entrypoint/backlog/src/write/create-issue.ts` | modify | 200 | 160 |
| backlog | `entrypoint/backlog/src/write/transition.ts` | modify | 200 | 160 |
| backlog | `entrypoint/backlog/src/store/vocabulary-guard.ts` | modify (foundation) | 60 | 20 |
| backlog | `entrypoint/backlog/src/query/resolve.ts` | modify (export chain walk) | 120 | 60 |
| backlog | `entrypoint/backlog/src/api.ts` | modify | 200 | 120 |
| backlog | `entrypoint/backlog/src/index.ts` | modify | 60 | 30 |
| backlog | `entrypoint/backlog/src/write/attestation.spec.ts` | create | 0 | 700 |
| backlog | `entrypoint/backlog/src/write/anchor-check.spec.ts` | create | 0 | 350 |

**Foundation gate (CONTRACT.md).** `write/tx.ts`, `write/catalog.ts`,
`write/errors.ts` and `write/audit.ts` are declared READ-ONLY to downstream
agents. This spec does **not** edit `tx.ts` or `audit.ts`. It **requests** two
`catalog.ts` amendments and one `errors.ts` addition and must be handed to the
foundation owner as a request, not applied unilaterally: (a) three rows appended
to `EDGE_KIND_TABLE`, (b) one node-kind added to `RECOGNIZED_NODE_KINDS`
(`store/vocabulary-guard.ts`), (c) new error classes. C4 and C5 depend on the
same two catalog rows, so the amendment is one shared change.

## Interface changes

### `entrypoint/backlog/src/write/attestation.ts` (NEW)

```typescript
export type AttestationCheckState = 'unverified' | 'verified' | 'stale' | 'unknown';

/** The closed mechanical-check enum. `refuted` is deliberately ABSENT — a
 *  mechanical anchor proves present/matching/stale/absent only; "the claim is
 *  contradicted" is a semantic judgement owned by the obligation layer. */
export interface IAttestCheck {
  state: AttestationCheckState;
  /** Which rung of the cheap-first ladder actually ran: 'exists_at_head' |
   *  'changed_since' | 'full_resolve' | 'none'. Asserted by AC7. */
  method: string;
  checked_at: string;
  checked_by: string;
  reason?: string;
}

export interface IAttestationAnchor {
  /** Grammar (closed): `path:<file>[:<line>]` | `url:<url>` | `query:<cql>` |
   *  `registry:<ref>`. A bare hand-maintained `path:line` is INSUFFICIENT
   *  without a `digest`. */
  locator: string;
  /** Content hash (sha256 hex) the locator resolved to at assert time. */
  digest: string;
}

export interface IAttestClaim {
  /** Open vocabulary, e.g. 'published-artifact' | 'live-system'. */
  kind: string;
  body?: string;
}

export interface IAttestInput {
  /** The LOGICAL subject: chain-head uid + the content revision observed. */
  subject: { id: string; revision: number };
  claim: IAttestClaim;
  anchor: IAttestationAnchor;
  by: string;
}

export interface IAttestOutcome {
  attestationUid: string;
  subject: { id: string; revision: number };
  check: IAttestCheck;
}

export interface IRecheckInput { attestationUid: string; by: string }
export interface IRecheckOutcome { attestationUid: string; checks: IAttestCheck[] }

// ── C10 widening (reciprocal note; the amendment is OWNED here, requested by C10) ──
// C10's `annotate()` delegates to `attest` to record a comment against a spec
// REVISION. That needs two additive widenings of the declaration above, not a
// second path:
//   (a) `subject.id` may name a `SPEC` node (its SUPERSEDES normalisation is a
//       no-op for an unchained node);
//   (b) `subject.revision` accepts an opaque `sha256:<hex>` token string as well
//       as the numeric counter — i.e. `revision: number | string`.
// Additive only: an `issue` subject with a numeric revision is byte-for-byte
// unchanged. See C10-store-citizen-documents.spec.md §Interface changes
// (`annotate`) for the I/O C10 defines in terms of this widening.
export type AttestRevisionRef = number | string;

export async function attest(handle: IWriteStoreHandle, input: IAttestInput): Promise<IAttestOutcome>;
export async function recheck(handle: IWriteStoreHandle, input: IRecheckInput): Promise<IRecheckOutcome>;
```

**Node storage** — `kind: 'attestation'`, `name: claim.kind`,
`content: claim.body ?? ''`, `metadata`:

```jsonc
{
  "subject":   { "id": "<chain-head uid>", "revision": 3 },
  "claim":     { "kind": "published-artifact", "body": "…",
                 "asserted_by": "claude:1", "asserted_at": "<iso>" },
  "anchor":    { "locator": "path:dist/index.js", "digest": "<sha256>" },
  "check":     { /* the LATEST IAttestCheck, echoed for cheap reads */ },
  "checks":    [ /* append-only IAttestCheck[] — recheck pushes, never overwrites */ ],
  "lifecycle": { "status": "active", "supersedes": null, "part_of": null }
}
```

**Edge** — `attests` (`issue → attestation`, `1:n`), written with
`writeEdgeTx` after `resolveEdgeKindTx(tx, 'attests')`.

### `entrypoint/backlog/src/write/catalog.ts` (FOUNDATION REQUEST)

```typescript
// EDGE_KIND_TABLE — append three rows (edition owned by the foundation owner):
{ rel: 'attests',          sourceKind: 'issue',      targetKind: 'attestation', multiplicity: '1:n' }, // C3
{ rel: 'has_obligation',   sourceKind: 'issue',      targetKind: 'obligation',  multiplicity: '1:n' }, // C4
{ rel: 'satisfies',        sourceKind: 'obligation', targetKind: 'attestation', multiplicity: 'n:m' }, // C5
```

### `entrypoint/backlog/src/store/vocabulary-guard.ts` (FOUNDATION)

```typescript
export const RECOGNIZED_NODE_KINDS: ReadonlySet<string> = new Set([
  /* …existing 13… */
  'attestation',   // C3
  'obligation',    // C4
]);
```

Without this, a store whose only new live nodes are attestations would be
refused as "foreign vocabulary" on the `LIMIT 1` recognised-kind probe.

### `entrypoint/backlog/src/write/errors.ts` (ADD)

```typescript
/** A supplied anchor locator is outside the closed grammar, or is a bare
 *  path:line with no digest. E_VALIDATION → invalid_argument. */
export class AnchorLocatorInvalidError extends BacklogWriteError {
  readonly code = 'E_VALIDATION' as const;
  readonly retryable = false;
  constructor(public readonly locator: string, detail?: string) { /* … */ }
}

/** `recheck` named an attestation uid that is not a live `attestation` node.
 *  E_VALIDATION → item_not_found. */
export class AttestationNotFoundError extends BacklogWriteError {
  readonly code = 'E_VALIDATION' as const;
  readonly retryable = false;
  constructor(public readonly uid: string) { /* … */ }
}
```

### `entrypoint/backlog/src/write/citation-path.ts` (MODIFY)

```typescript
// BEFORE (existing, unchanged):
export function defaultCitationAllowedExternalRoots(): string[] { return []; }

// AFTER (add alongside it):
/** The TOOL's own installed evidence roots — the skills this package installs
 *  (install-skill.ts's hostSkillsDir table). Always-on, typed, and NARROWER
 *  than the machine-global `~/.adhd/backlog` default the module header
 *  rejects: it grants only the tool's own installed docs, never the store. */
export function toolOwnedCitationRoots(home?: string): string[];
// returns, for the resolved home:
//   join(home, '.claude', 'skills', 'backlog')
//   join(resolveCodexHomeDir(home), 'skills', 'backlog')
//   join(home, '.config', 'opencode', 'skills', 'backlog')
```

### `entrypoint/backlog/src/query/resolve.ts` (MODIFY — export the chain walk)

```typescript
// BEFORE (module-private):
async function currentUidOf(graph, superseded): Promise<string | undefined>

// AFTER (exported, same body; add a uid-shaped wrapper):
export { currentUidOf };
/** Normalise any issue uid (possibly superseded) to its SUPERSEDES-chain HEAD
 *  uid. Returns the input unchanged for an already-live uid.
 *  ONE concept, ONE implementation: this delegates to C1's `resolveLogicalIssue`
 *  (which returns the head NodeRecord); it is NOT a second chain walk (ADR-0002). */
export async function resolveLogicalIssueId(graph: GraphBackend, uid: string): Promise<string>;
```

### `entrypoint/backlog/src/api.ts` (MODIFY)

```typescript
export async function attest(ctx: BacklogCtx, input: IAttestInput): Promise<IOutcomeEnvelope<IAttestOutcome>>;
export async function recheck(ctx: BacklogCtx, input: IRecheckInput): Promise<IOutcomeEnvelope<IRecheckOutcome>>;
// Both route through writeHandle(ctx, { needsSemantic: false }).
```

**`outputSchema` shape (adhd ADR-0004).** `IOutcomeEnvelope<T>` is a union of
object arms, so per ADR-0004 D2 no `outputSchema`/`structuredContent` is
emitted for these verbs — the flat payload rides `content`. The success payload
`IAttestOutcome` / `IRecheckOutcome` are already top-level objects, so if the
transport later narrows to the object arm they are valid `outputSchema` roots.

## Behavioral changes

### `write/attestation.ts` — `attest()`

- **Change:** new verb. One `executeWriteTransaction` (BEGIN IMMEDIATE, adhd
  ADR-0001 + ADR-0012 — **no** temp-file/rename/flock anywhere; atomicity is
  the store's job).
- **Subject normalisation:** `resolveLiveIssueTx(tx, input.subject.id)` → then
  `subject.id` is stored as the resolved **live** uid; on read the chain walk
  (`resolveLogicalIssueId`) maps any superseded uid forward. `subject.revision`
  is the caller-observed revision; if it differs from the node's current
  `readRevision(meta)`, the check state is `unknown` with reason
  `revision-drift` (never silently `verified`).
- **Anchor parse + check:** `parseAnchor(locator)`; run the cheap-first ladder
  in `anchor-check.ts`; persist `IAttestCheck` + push into `checks[]`.
- **Never mutates the subject.** No `UPDATE node … WHERE rowid = subject` —
  the attestation is a new node + a new edge only.
- **Write:** `writeNodeTx(kind:'attestation')` → `resolveEdgeKindTx(tx,
  'attests')` → `writeEdgeTx(issue → attestation)` → `writeAudit(action:
  'attested', to: attestationUid)`.
- **Default behavior unchanged** — no existing verb's path is touched except
  the citation gate (below).

### `write/attestation.ts` — `recheck()`

- **Change:** new verb, one `executeWriteTransaction`.
- Resolve `attestationUid` → live `attestation` node (else
  `AttestationNotFoundError`).
- Re-run the ladder; **append** the new `IAttestCheck` to `checks[]` and
  replace `check` with it. Earlier entries are copied forward verbatim —
  wholesale `meta` replace, never a truncated history (AC6).
- `writeAudit(action: 'rechecked')` on the attestation node.

### `write/anchor-check.ts` — `checkAnchor()`

Pure-ish ladder, no store writes, bounded:

1. `existsAtHead(path)` → `git -C <root> cat-file -e HEAD:<relpath>` (exit 0 =
   present). Cheap; no file read, no network, no agent.
2. `changedSinceFiling(path, sinceISO)` → `git log --oneline --since=<t> --
   <relpath>` non-empty, OR the HEAD blob hash differs from `digest`.
3. Full re-resolve (`digest` match) — **only when asked** (`opts.full`), for
   `recheck` and the verdict's rung 5.
4. Missing path at HEAD → `stale` (it existed when filed, is gone now) with
   `method:'exists_at_head'`; unresolvable root / not a git repo / non-path
   locator → `unknown` with a reason; a `url`/`query`/`registry` locator with
   no checker wired → `unverified` (explicit, never absent).

### `write/citation-path.ts` + `create-issue.ts` + `transition.ts` — citable roots

- Both `computeCitationSha` copies gain `siblingRoots: readonly string[]` and
  call `resolveCitationTarget(projectRoot, file, [...policy.citationAllowedExternalRoots,
  ...toolOwnedCitationRoots(), ...siblingRoots])`.
- New helper `resolveSiblingProjectRootsTx(tx, excludeProjectUid)` returns the
  `metadata.path` of every other LIVE `project` row — so a sibling-repo
  citation is probed against **its own** root (and a citation into another
  registered project verifies rather than falsely refuting). Cross-repo
  citations are therefore accepted on write.
- `CitationUnverifiableError` continues to name roots; it now also names the
  tool roots so a rejection is actionable.

## Independent segments

### Segment A — foundation amendments (must land first)

- **Files:** `write/catalog.ts` (3 rows), `store/vocabulary-guard.ts` (2 kinds),
  `write/errors.ts` (2 classes).
- **Dependencies:** none. **Blocks** B–G.
- **Read tokens:** ~180. **Output tokens:** ~240.
- **Required context:** read `EDGE_KIND_TABLE` in `catalog.ts` and `RECOGNIZED_NODE_KINDS` in `vocabulary-guard.ts` ONLY. Hand to the foundation owner per CONTRACT.md.

### Segment B — anchor-check.ts

- **Files:** new `write/anchor-check.ts`.
- **Dependencies:** none (pure; uses `node:child_process`/`node:crypto`).
- **Read tokens:** 0. **Output tokens:** ~450. **Required context:** none.

### Segment C — attestation.ts

- **Files:** new `write/attestation.ts`.
- **Dependencies:** A (edge rule), B, and `query/resolve.ts` chain walk.
- **Read tokens:** ~250 (imports of `write/transition.ts` for the
  `resolveIssueProjectTx`/pre-transaction pattern + `write/audit.ts`).
- **Output tokens:** ~850.

### Segment D — citation roots

- **Files:** `citation-path.ts`, `create-issue.ts`, `transition.ts`.
- **Dependencies:** none. **Read tokens:** ~400. **Output tokens:** ~320.
- **Required context:** `create-issue.ts`'s and `transition.ts`'s
  `computeCitationSha` (`transition.ts` is the canonical copy).

### Segment E — chain-walk export

- **Files:** `query/resolve.ts`.
- **Dependencies:** none. **Read tokens:** ~120. **Output tokens:** ~60.

### Segment F — mount surface

- **Files:** `api.ts`, `index.ts`.
- **Dependencies:** C, D. **Read tokens:** ~200. **Output tokens:** ~150.

### Segment G — tests

- **Files:** `attestation.spec.ts`, `anchor-check.spec.ts`, plus the citation
  cases in `create-issue.spec.ts`/`transition.spec.ts`.
- **Dependencies:** all. **Read tokens:** ~200. **Output tokens:** ~900.
- **Required context:** `test/helpers/open-test-issue-store.ts` and
  `freshTmpDir` (see `query/get-superseded-uid.spec.ts` for the harness shape).

## Execution strategies

### Segment B

1. Create `write/anchor-check.ts` exporting `parseAnchor`, `checkAnchor` (and
   the `existsAtHead`/`changedSinceFiling` helpers).
2. `child_process.execFileSync('git', [...], {cwd, stdio:'pipe'})` wrapped so a
   non-repo / missing git degrades to `unknown`, never throws.
3. NEVER read a whole file unless `opts.full` — the whole point is the cheap
   pre-filter.
4. Do not add a network call of any kind.

### Segment C

1. Mirror `transition.ts`'s pre-transaction/project-resolve skeleton.
2. Validate: `subject`/`claim.kind`/`anchor.locator`/`anchor.digest`/`by` all
   non-blank (`assertNonBlank`); `assertNotBareRoleLiteral('by', …)`.
3. Resolve live subject with `resolveLiveIssueTx`; compare
   `readRevision`(C6 module) to `subject.revision`.
4. Write node + `attests` edge + audit **inside one** `executeWriteTransaction`.
5. Do NOT touch the subject node or mutate any existing row.

### Segment D

1. Add `toolOwnedCitationRoots` to `citation-path.ts` (import
   `hostSkillsDir`/`resolveCodexHomeDir` from `../install-skill.js`).
2. In BOTH `computeCitationSha` copies, accept a `siblingRoots` arg and merge
   the arrays at the `resolveCitationTarget` call.
3. Add `resolveSiblingProjectRootsTx` (a `SELECT … FROM node WHERE kind='project'
   AND t_invalid IS NULL` reading `meta.path`, excluding the item's own project).
4. Thread it through the pre-transaction block in both verbs.

## Test cases

Every AC maps to one test whose **negative control** is named; concurrency
uses latches/barriers, never sleeps.

- **AC1 — `attest` leaves `uid` unchanged.**
  `attestation.spec.ts`: `createIssue` → capture `uid` → `attest` → re-`get`,
  assert `uid` identical and a new `attestation` node exists.
  *Negative control:* revert the "never mutate subject" rule (add an
  `UPDATE node … touch`) → assert card `updatedAt`/`revision` changes → red.

- **AC2 — survives a body-edit supersession.**
  `attest` on `uid A`, then `update {body}` → `uid B`; assert the attestation
  still resolves to the logical item (chain walk returns `B`) and the `attests`
  edge points at `B` (carry-forward sweep).
  *Negative control:* remove `'attests'` from the swept rels (or from
  `EDGES_NEVER_SWEPT`-adjacent logic) → edge stays on the dead node → red.

- **AC3 — tool-skill root accepted.**
  Seed a project with a known `path`; cite
  `path:<home>/.claude/skills/backlog/SKILL.md`; assert write succeeds and
  `sha !== 'unverified'`.
  *Negative control:* call `resolveCitationTarget` with only the project root →
  `accepted:false` → assert `CitationUnverifiableError` → the pre-fix path must
  fail the test.

- **AC4 — sibling-repo citation verifies (not a false refusal).**
  Two projects, each with its own `path`; cite project-B's file from an item in
  project-A; assert success and a real `sha`. Assert the check is NOT a
  `CitationUnverifiableError`.
  *Negative control:* omit `siblingRoots` → refusal → red.

- **AC5 — absent anchor is an explicit negative state.**
  `attest` with `path:does/not/exist.ts` at HEAD → `check.state` is
  `stale`/`unverified` and the `check` field is **present** with a `reason`.
  *Negative control:* make a missing anchor write no `check` key → assert the
  field's absence → red.

- **AC6 — `recheck` appends.**
  `recheck` twice with different outcomes; assert `checks.length === 2` and the
  first entry is byte-identical to its pre-recheck value.
  *Negative control:* implement recheck as replacement → `checks.length===1` → red.

- **AC7 — pre-filter is cheap and named.**
  File deleted since filing; assert `existsAtHead=false` and
  `check.method === 'exists_at_head'` (no `full_resolve`, no network/agent).
  *Negative control:* force the ladder to always run `full_resolve` → `method`
  differs → red.

### UX acceptance

- End user runs `backlog attest --input '{"subject":{"id":"…","revision":2},
  "claim":{"kind":"published-artifact"},"anchor":{"locator":"registry:pkg@1.2.3",
  "digest":"…"},"by":"dispatcher:1"}'` → `{ok:true,data:{attestationUid,
  check:{state:…}}}`.
- End user cites a path outside the project and outside every root → the
  refusal names `project_policy.citationAllowedExternalRoots` **and** the tool
  roots.

## Blast radius

> **Tooling note.** `gitnexus` is not exposed in this agent's tool set, so the
> blast radius below is derived by direct source reading (cited line ranges),
> not by `gitnexus_impact`. If `gx` is available in the executing
> environment, run `gx impact attest`/`gx impact computeCitationSha` before
> editing and reconcile.

- `computeCitationSha` — **2 copies** (`create-issue.ts` and `transition.ts`; `transition.ts` is the canonical copy). Both are reached by `create`/`transition`, which are mounted on all four transports. Risk: **MEDIUM** — a signature change to a shared write-path helper; the merge is additive (default `[]` args keep existing callers compiling) per CONTRACT-style discipline.
- `citation-path.ts` — imported by `errors.ts`, `create-issue.ts`, `transition.ts`. Additive export only. **LOW**.
- `EDGE_KIND_TABLE` / `resolveEdgeKindTx` — read by every edge-writing verb; appending rows is additive (`EDGE_KIND_BY_REL` map). **LOW**.
- `RECOGNIZED_NODE_KINDS` — read by the open/write/query guards; appending kinds can only *widen* recognition. **LOW**.
- `carryForwardResidualEdgesTx` (in `update.ts`) — already sweeps every non-excluded rel in both directions, so `attests` is carried for free. **No change**; called out because AC2 depends on it.
- `resolveIssueByUid` — unchanged; the new `resolveLogicalIssueId` is additive
  and must NOT be called from the `StaleSupersedeError` throw path (that stays
  as-is).

## Deliberately NOT changed

- `tx.ts` / `audit.ts` (frozen foundation).
- `update`'s supersede mechanism — C1/C3 do **not** add a stable-uid column;
  the logical id is resolved by walking `SUPERSEDES`, per `DESIGN.md` §2
  Primitive 1.
- No CEL, no `timeout` field (design §7 conditions 4 and Primitive 3).
