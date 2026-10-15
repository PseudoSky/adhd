# Spec 0b80a7b5 — dispatch dag.json: no silent loss of the observation record under concurrent cycles

user-request (verbatim): "For ones that dont [meet DoR]: bucket -> architect spec -> product revision -> impl ready. ... Do not merge or run tests until I say so."
items: 0b80a7b5-9f7c-46ac-9275-66fada769c63 (bug, HIGH, project adhd)
dor: needs-decision — check: segments A and B below are fully writable and ready; the durable-home question (move the observation record into a store) is an ADR-0001 scope ruling and cannot be decided here. Size: S (A+B), L (C, not specced).

## Observed facts (O = opened; R = reported by item)
- O: item premise "no mutual exclusion" is PARTLY STALE. `runCycleCore` already takes a per-DAG exclusive lock for non-dry runs: `entrypoint/dispatch-cli/src/lib/core.ts:688-695` (`acquireDispatchLock(dispatchLockPath(dagPath), resolve(dagPath))`, `wx` create, pid-liveness reclaim; lock file under `os.tmpdir()/adhd-dispatch-locks/<sha16>.lock`, core.ts:700-705; impl `packages/dispatch/dispatch-orchestrator/src/lib/process-guard.ts:55-95`).
- O: residual gaps that remain true:
  1. dry-run returns before the lock (`core.ts:687` `if (dryRun) return orchestrateCycle(deps)`); `orchestrateCycle` calls `client.saveDag` (orchestrator.ts:1794,1883,1960) so a dry run can write the same dag.json concurrently.
  2. temp name is fixed: `packages/dispatch/dispatch-serializer-json/src/index.ts:32` `.${filename}.tmp`; two writers (library callers of `orchestrate`/`DagClient` bypass the CLI lock) clobber each other's temp then `renameSync` can throw ENOENT or publish a torn mix. Also the temp is never removed on failure.
  3. stale-lock reclaim race: `process-guard.ts:90-91` reads holder, then `rmSync(lockPath)` — a competitor that reclaimed in between has its fresh lock deleted (TOCTOU).
  4. `DagClient` mutators (`dispatch-core-client/src/lib/client.ts:60-87`) and the orchestrator write the WHOLE in-memory dag (`saveDag(dag)`), a read-modify-write with no revision check: any writer outside the CLI lock loses the other's `dispatch_log` entries silently.
  5. `orchestrate()` (multi-cycle loop, orchestrator.ts:1981) has no production caller; roadmap A1 (`docs/product/dispatcher-platform/ROADMAP.md:546,550,720`) wires it. The lock must then span the loop, not one cycle.
- R: dag.json is the only durable home of `status/attempt_count/guard_*/tokens_actual`, `turns[]`, `results[]` (types.ts:442-495) and agent-mcp ephemeral tasks keep no context (agent-mcp/src/server.ts:524, tools/task.ts:356). Plausible; not re-opened.
- O (gx): `createJsonFileSerializer` upstream HIGH (3 direct: `buildClient`, `guardDagExists`, `validateCore`; d2 `runCycleCore`, `snapshotCore`, `optimizeCore`, `eligibleCore`, `statusCore`).
- ADR constraint (adhd 0001 D1/D4/D7): a new store must start on `@adhd/sox-store-adapter`; D4 explicitly lists `dispatch-orchestrator` as "needs a scope ruling"; D7.3 says an application lock "may ADD safety around a specific path; never REPLACE multiprocess support". So the lock here is additive and legal, but the moving of the observation record into a store (item fix option a, roadmap F1) is a ruling on whether dag.json becomes an adhd "store". No store in this ecosystem is single-writer; do not describe the lock as making dispatch single-writer — it serializes cycles on one DAG file only.

## Design decisions
D1 (A, ready) unique temp + cleanup in the serializer: temp = `.${filename}.${pid}.${randomBytes(6).toString('hex')}.tmp`; `try{write;rename}finally{unlink temp if present}`. Rejected: keep fixed temp + lock only (library callers bypass the lock).
D2 (B, ready) lock hygiene in `process-guard.ts`: reclaim only if the lock file content still equals the stale body just read (compare-then-unlink via rename to a unique name, then verify), never a blind `rmSync`. Add a test seam `AcquireOptions.onStaleRead?: () => void`.
D3 (B, ready) cover every dag-writing path with the existing lock: acquire in both dry and wet branches of `runCycleCore`; expose `withDagLock(dagPath, fn)` from `core.ts` so A1's `--to-terminal` holds ONE lock across the whole `orchestrate()` loop. Rejected: waiting/queueing for the lock (existing contract is fail-fast `DuplicateDispatchError`; changing it is a behavior change nobody asked for).
D4 (B, ready) optimistic revision check as defence for non-CLI writers: add optional `revision:number` to `DagJson`, `writeDag` re-reads the on-disk revision and rejects with `StaleDagError` when it differs from the loaded one; `DagClient` mutators reload-and-retry once for append-only ops (`appendDispatchLog`). Needs product confirmation because it touches the `dispatch-base-spec` schema (additive optional field; validate via `validateDagJson`).
D5 (C, DECISION) durable home. Options: (i) keep dag.json + A/B/D4 (recommended interim); (ii) move OBSERVED state to an adapter-backed store per roadmap F1 under ADR-0001 (needs the D4 scope ruling and its own spec). Not specced here; sequencing: C must precede or accompany A1.
Rejected: `proper-lockfile` (new external dependency needs human approval; existing primitive suffices); sentinel files beside dag.json (pollutes the working tree).

## Write-scope (exact)
- /Users/nix/dev/node/adhd/packages/dispatch/dispatch-serializer-json/src/index.ts (+ index.spec.ts)
- /Users/nix/dev/node/adhd/packages/dispatch/dispatch-orchestrator/src/lib/process-guard.ts (+ src/test/process-guard.spec.ts)
- /Users/nix/dev/node/adhd/entrypoint/dispatch-cli/src/lib/core.ts (lines ~680-705 only) (+ src/test/dispatch-guards.spec.ts)
- D4 only: /Users/nix/dev/node/adhd/packages/dispatch/dispatch-base-spec/src/lib/types.ts (+validator), /Users/nix/dev/node/adhd/packages/dispatch/dispatch-core-client/src/lib/client.ts, serializer.ts
- docs: packages/dispatch READMEs; roadmap note on A1 ordering.

## Acceptance criteria
- AC1 Two serializers writing the same dag path concurrently never share a temp path, never leave a `.tmp` after success or failure, and the final file is valid JSON of one writer's document.
- AC2 A competitor that acquires the lock between a reclaimer's stale-read and its unlink keeps its lock (no deletion), and the reclaimer reports `DuplicateDispatchError`.
- AC3 `dispatch run --dry-run` against a DAG whose lock is held by a live pid is refused with `DuplicateDispatchError`.
- AC4 `withDagLock` held across an N-cycle `orchestrate()` loop refuses a second process for the entire loop and releases on throw.
- AC5 (D4, if approved) a writer whose loaded revision is stale gets `StaleDagError` and no bytes are written; an `appendDispatchLog` retry preserves both processes' entries.
- AC6 Two real `dispatch run` processes on one DAG: exactly one proceeds, the other exits non-zero with `duplicate_dispatch`; the surviving dag's `dispatch_log` length equals the entries produced by the survivor.

## Test plan (tier S default; cite `0b80a7b5 AC<n>`)
AC1, AC2, AC5: S (temp fs, injected `isAlive`/`onStaleRead`; AC1 spies on `writeFileSync` paths to prove uniqueness; negative control = restore fixed temp name and watch AC1 go red). AC3, AC4: S with injected runner. AC6: P (`*.e2e.ts` in `dispatch-cli`, real processes, barrier-released via a latch file, isolated cwd/fake HOME; cannot be seen at S because it needs two OS processes).

## Risks / serialization
- Shares `entrypoint/dispatch-cli/src/lib/core.ts` with roadmap A1 (not in this batch) — land first. `dispatch-orchestrator` is also named by ADR-0001 D4: do not add any `better-sqlite3` use.
- Open for product/user: approve D4 (schema field) and the ADR-0001 D4 scope ruling for D5(ii); correct the item body (lock exists; real gaps are 1-4).

## Product revision
dor (product): ready for the SLICE D1+D2+D3 (AC1, AC2, AC3, AC4, AC6). D4 (AC5) and D5 are NOT in this slice; they wait on architect-decision (below).
- Resolved (product): ship D1-D3 now; they are additive safety, keep the fail-fast `DuplicateDispatchError` contract (queueing rejected as an unrequested behavior change), and close the observed silent-loss gaps 1-3. Item body to be corrected: the lock exists, real gaps are 1-4.
- Deferred, flagged (scope cut): D4 optimistic `revision` field (gap 4, non-CLI writers) and D5 durable-home move. D5(i) "keep dag.json" is the interim; log a follow-up backlog item for D4 (cites this spec, AC5).
- Handed to architect-decision (not decided here): see "architect-decision questions" in the product report; a one-question brief on whether dag.json is an ADR-0001 "store" and whether D4's additive optional `revision` field with a reject-on-stale write is acceptable under it.
- Serialization: lands BEFORE roadmap A1 (shares core.ts). Priority: P1, rank 3 (silent data loss of the observation record; S size).
