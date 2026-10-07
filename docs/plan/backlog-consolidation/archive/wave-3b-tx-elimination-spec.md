# Wave 3b Spec — Adopt `@adhd/sox-graph-store@0.11.0` tx-scoped primitives; eliminate the hand-composed SQL mirrors

> Source: architect spec, 2026-09-22. Persisted by the orchestrator for
> resumability. **Decision required before execution: Design A vs Design B**
> (below). Design A recommended — it is the only design that *deletes* the SQL
> and achieves the user's elimination goal.

## Summary

Adopt the G1 `GraphTransaction` surface as the write layer's transaction handle:
widen `IWriteStoreHandle` with `graph`, route `executeWriteTransaction` through
`handle.graph.transaction(fn, {mode})` (production callbacks receive a
`GraphTransaction`), and re-implement the five mirroring helpers in `tx.ts`
(`getNodeByUidTx`, `getNodeByRowidTx`, `writeNodeTx`, `writeEdgeTx`'s INSERT
half, `invalidateEdgeTx`) plus `claim.ts`'s `touchMetadataTx` and `delete.ts`'s
invalidate as thin delegations to the typed primitives. **Pure refactor** — the
G1 correction: writes were never autocommitting against the bare adapter; the
pre-G1 gap was API-only. Behavior preserved by construction; the load-bearing
suite is the proof.

## Central finding — two constraints collide (decision needed)

1. **The load-bearing suite calls helpers through `store.adapter.transaction`**,
   which yields a bare `AdapterTransaction` (no typed methods). 8 of the 11
   named suites do this (`claim.spec.ts:51,71,593,655`, `transition.spec.ts:52,118`,
   `move.spec.ts:60,112`, `update.spec.ts:40`, `delete.spec.ts:33`,
   `catalog-verbs.spec.ts:64`, `create-issue.spec.ts:37`,
   `superseded-uid-guard.spec.ts:107`), as does `seedProject`, `transition.ts:330,339`,
   and two child-process fixtures. Re-typing the helpers to `GraphTransaction`
   therefore cannot keep those files byte-unchanged.
   - **Design A (RECOMMENDED):** re-type helpers to `GraphTransaction`; migrate
     ~14 call sites from `.adapter.transaction` → `.graph.transaction` (one
     token each, **no assertion changes**) and `transition.ts`'s bare reads to
     `handle.graph.getNodeByUid`. The only design that deletes the SQL.
   - **Design B (strict "unchanged suite"):** keep `AdapterTransaction`
     signatures, runtime capability probe, typed path when present, raw SQL as
     a **test-only fallback**. Production issues zero hand-composed SQL; suite
     untouched — but the mirrors are not deleted.

2. **GAP-A — 0.11.0 exposes no write-timestamp parameter.** `writeNode`/`writeEdge`/
   `invalidate`/`invalidateEdge`/`touch` stamp their own `nowISO()`
   (`index.ts:2019, 2670, 2128, 2614, 2159`). Backlog's one-instant invariant
   (`tx.ts:283-300`, `catalog.ts:242-252`, `create-issue.ts:668-673`) cannot be
   preserved: `t_created`/`t_valid`/`t_updated`/`t_invalid` become
   library-stamped; only `t_occurred` is controllable via `NodeMeta.tOccurred`.
   `createIssue` returns `createdAt: now` (`create-issue.ts:913`) but persisted
   `t_created` (read by `card.ts:298`) would differ. **Mitigation:** pass
   `tOccurred: at`; read back `uid`/`tCreated` via `tx.getNode(rowid)`. No
   load-bearing spec asserts cross-row timestamp equality. **Flag, do not
   force**; consider requesting `WriteNodeOpts.at` upstream (file as sox item).

## Files

| Path | Change |
|---|---|
| `entrypoint/backlog/package.json` | modify (19-21, 37-40) — `^0.11.0`, `^0.4.7`, `^0.1.6` |
| `src/write/tx.ts` | modify (header 1-24; 82-105; 119-210; 249-273; 418-485; 541-596; 610-728; 788-876) |
| `src/write/claim.ts` | modify (47-54; 171-186) |
| `src/write/delete.ts` | modify (48-54; 126-134) |
| `src/write/catalog.ts` | modify (header note only) |
| `src/api.ts` | modify (211-212) — `graph: ctx.store.graph` |
| `src/write/transition.ts` | modify (330, 339) |
| `src/test/helpers/open-test-issue-store.ts` | modify (52-57, 107-140) |
| `src/test/fixtures/cross-process-issue-writer.ts`, `cross-process-claim-worker.ts` | modify (65 / 52) |
| `src/write/tx-parity.spec.ts` | create |
| `src/write/CONTRACT.md` | modify (86-103, 122-128, 193-240, 251-255) |
| 8 spec files (Design A only) | modify (1 token/site) |

## Interface changes

- `IWriteStoreHandle` gains `readonly graph: GraphBackend` (keeps `adapter`).
- The five helpers re-type `tx: AdapterTransaction` → `tx: GraphTransaction`.
- `executeWriteTransaction`: `fn: (tx: GraphTransaction) => Promise<T>`;
  `handle.adapter.transaction(fn, {mode})` → `handle.graph.transaction(fn, {mode})`.
- New `mapNodeRecord(rec: NodeRecord): ITxNodeRow` replaces `IRawNodeRow`/`mapNodeRow`.
- `writeNodeTx` body: `tx.writeNode(content, {kind, name, metadata?, tOccurred?}, {skipDedupe})`
  → `tx.getNode(rowid)` read-back for `uid`. Keep `resolveDedupeMode()` env door
  (`'on'` → `skipDedupe:false`, AC-22 dedupe control still collapses to 1 row).
- `writeEdgeTx`: keep the `sourceKind`/`targetKind` check + `checkMultiplicityTx`;
  delete the explicit `typePolicy.validateEdge/validateRel` call (library validates
  via the same `OPEN_TYPE_POLICY` instance) and the INSERT; `tx.writeEdge(src,dst,rel,{weight?,metadata?})`.
  **Behavior delta (flag):** library wraps CHECK/FK violations in `ConstraintError`.
- `invalidateEdgeTx` → `tx.invalidateEdge(src,dst,rel,reason)`.
- `claim.ts touchMetadataTx` → `tx.touch(rowid, {metadata})` (drop rowsAffected assertion).
- `delete.ts` invalidate → `tx.invalidate(row.rowid, reason)` (keep the
  `resolveLiveIssueTx` liveness guard — the documented divergence).

## Keep (no 0.11.0 API absorbs these)

`checkMultiplicityTx` JOIN (no typed `dst != ?` filter) · catalog.ts's four S-10
shapes (no metadata-scoped node find in a tx; `findOrCreateNode` would resurrect
invalidated rows) · `upsertProjectTx`/`upsertComponentTx` metadata-only UPDATE
(`touch` adds unwanted `t_updated`) · `nextPriorityRankTx` MAX · `upsertLocation`
triple · `rmLocation` guarded invalidate · `resolveEdgeKindTx` self-heal ·
`update.ts:617,870` hand-composed edge INSERTs (deliberately bypass the
uniqueness gate — out of scope) · `resolveLiveIssueTx` · `executeWriteTransaction`
(E_CONTENTION retry + audit-atomicity) · `canonicalJSONStringify`/`sha256Hex`/
`parseJsonObject` · the negative-control env doors.

## Segments

| # | Segment | Files | Depends | Executor |
|---|---|---|---|---|
| 1 | Deps + lockfile | `package.json` | — | typescript |
| 2 | Handle widened + construction | `tx.ts:82-105`, `api.ts:211`, 2 fixtures, `open-test-issue-store.ts` | 1 | typescript |
| 3 | `executeWriteTransaction` → graph | `tx.ts:788-876` | 2 | typescript |
| 4 | Read helpers + mapper | `tx.ts:119-210, 263-273` | 1 | refactor |
| 5 | Write helpers + dedupe threading | `tx.ts:418-485, 610-661, 708-728` | 4 | refactor |
| 6 | claim + delete delegation | `claim.ts:171-186`, `delete.ts:126-134` | 5 | refactor |
| 7 | Call-site migration (**A only**) | 8 specs + `transition.ts:330,339` | 5 | refactor |
| 8 | Parity spec + negative controls | `tx-parity.spec.ts` (create) | 6 | test |
| 9 | Doc corrections (false-premise headers) | `tx.ts:1-24`, `CONTRACT.md`, `catalog.ts` header | 5 | typescript |
| 10 | Verification | — | 8,9 | test/review |

## Verification matrix

- **Load-bearing suite green unchanged (assertions):** `cross-process-write-safety.spec.ts`
  (AC-22), `claim.spec.ts` (AC-16 CAS), `delete.spec.ts`, `catalog-verbs.spec.ts`,
  `update.spec.ts`, `transition.spec.ts`, `relate.spec.ts`, `move.spec.ts`,
  `create-issue.spec.ts`, `audit-fields.spec.ts`, `superseded-uid-guard.spec.ts`.
- **Parity (new):** typed write vs hand-composed write → byte-identical deterministic
  columns (node: kind…last_access excluding uid/rowid/t_created/t_valid; edge:
  src,dst,rel,weight,origin,meta,t_invalid); assert `t_occurred === at`. Negative
  control: perturb one column → red.
- **Negative controls unchanged:** `ADHD_BACKLOG_UNSAFE_TX_MODE=deferred` still flips
  the CAS test red; `ADHD_BACKLOG_UNSAFE_DEDUPE_MODE=on` still collapses colliding
  creates to 1 row.
- **Integration:** real `createIssue` → `claim` → `transition` → `update` →
  `deleteIssue`; consumer-visible outcome asserted.
- **UX acceptance:** real `adhd-backlog create`/`query` (CLI/MCP).
- **Gates:** `nx affected -t test`, `nx lint`, `verify-dist-load`, `detect-changes`.

## 0.11.0 API gaps (flag — do not force)

| # | Mirror | Not covered because | Disposition |
|---|---|---|---|
| GAP-A | every timestamp write | no `at` param on typed writes | mitigate (`tOccurred`; read-back); flag; consider upstream `WriteNodeOpts.at` |
| GAP-B | `writeNodeTx` return `{rowid,uid}` | typed writes return rowid only | one extra `tx.getNode(rowid)` |
| G1 | `checkMultiplicityTx` JOIN | no typed `dst != ?` edge filter | keep hand-composed |
| G2 | catalog S-10 four shapes | no metadata-scoped tx find | keep; S-10 separate internal refactor |
| G3 | metadata-only `UPDATE`s | `touch` always stamps `t_updated` | keep |
| G4 | `nextPriorityRankTx`, `upsertLocation` | no aggregate / tx `json_extract` find | keep |
| G5 | `rmLocation`/`resolveEdgeKindTx` guarded invalidate | `tx.invalidate` has no `t_invalid IS NULL` guard | keep |
| G6 | `update.ts:617,870` edge INSERTs | deliberate uniqueness-gate bypass | out of scope |

**ADR note:** ADR-0013 (no behavior-switching env vars) is in tension with the
retained negative-control env doors — pre-existing, documented, different repo.
