# Embed durability fix — implementation spec

**Status:** IMPLEMENTED — segments A–G. Author: architect; implemented by the typescript
executor. Target: `.worktrees/backlog-v2`, branch `feat/backlog-hard-replacement`.

Resolved before implementation:

- **Drain bound.** No numeric guard is recoverable from the deleted module — its drain was
  an unbounded `for(;;)` in every revision of `store/embed-queue.ts` (`git log -p`). The
  bound is therefore `DEFAULT_EMBED_DRAIN_TIMEOUT_MS = 30_000` (§3.1).
- **Exit-code policy.** The §3.3 default: a *recorded* embed failure warns and exits 0; an
  *unrecorded* death warns and sets `process.exitCode = 1`.
- **Spec correction.** §3.1's `drain` algorithm as literally written misses `'unrecorded'`
  entries (the producer unregisters them on settle, so they are gone from the final
  snapshot). The implementation keeps `'unrecorded'` entries registered and has the drain
  await only `'pending'` entries, so an unrecorded death is always reported.

**Direction is already decided** (prior one-shot `architect-decision` verdict): reinstate a
**bounded close-time drain**, not per-write await, not fire-and-forget-with-warning, and
make drain failure **loud and recorded**.

---

## 1. Root cause (mapped against the post-Seg-F reality)

Seg F (`111c19bd`) deleted `store/embed-queue.ts` and the `flushEmbeds` import/member/await.
**Nothing tracks in-flight embeds today.** Verified:

- `write/embedding-observer.ts:128-183` — `scheduleIssueEmbedding` runs the embed/vector
  round-trip and its follow-up `embedding_*` audit transaction, and is otherwise a bare
  fire-and-forget promise. It has **no registration** anywhere.
- `store/graph-backlog-store.ts:126-130` — `closeGraphBacklogStore` is `await store.adapter.close()`
  and nothing else. No drain.
- `store/graph-backlog-store.ts:141-154` — `closeGraphBacklogStoreSafe` catches and `console.error`s,
  then returns: a drain failure (if one existed) could not reach the command's exit code.
- `write/create-issue.ts:987-1000` / `update.ts:1001-1028` / `delete.ts:155-164` — fire-and-forget by
  default (`awaitEmbed` omitted). The `awaitEmbed:true` knob is the *only* current durability path.
- The prior art (recoverable from `BACKLOG_BACKLOG.md:704`, review of `embed-queue.ts:120`) was a
  **per-store `WeakMap<GraphBacklogStore, Set<Promise<void>>>`**, untracked on success *and*
  failure, with a flush loop that **re-snapshots** (drain-until-empty). That is the shape to
  rebuild — but against `scheduleIssueEmbedding`, not the deleted RAG write path.

**Failure sequence (one-shot CLI, live-reproduced):** the subject write commits → the verb
schedules the embed fire-and-forget and returns → `create` reports `ok:true` → the CLI's
`finally` calls `closeGraphBacklogStoreSafe` → `adapter.close()` sets `closed = true`. The
still-pending `embedDocument` then resolves, and `upsertVector` / the follow-up audit
transaction hit a closed connection. `TursoAdapterImpl._ensureHealthy()`
(`sox-store-adapter/dist/turso-adapter.js:1043-1050`) only reconnects on
`_poisoned || _released || _neverOpened` — **not** on `closed` (correct: closed is terminal) —
so the driver throws `TypeError: The database connection is not open`. That is caught by
`scheduleIssueEmbedding`, which then tries to write the `embedding_failed` audit row through
the *same* closed adapter, which also throws, is caught by the audit `try/catch`
(`embedding-observer.ts:170-182`), and degrades to a log line. **The embed dies unrecorded.**

### Idle-release (A16/A17) is a contributing churn, not the mechanism

`TursoAdapterImpl` voluntarily tears down its connection after an idle window
(`releaseIdleConnection()` / `_armIdleFlush()`, `turso-adapter.d.ts:40-52, 709-751`). That is
**designed to be transparent**: it sets `_released` (not `closed`) and the next adapter op
reconnects via `_ensureHealthy()`. So an idle-release landing during a long `embedDocument`
does **not** produce the failure — the embed's follow-up op reconnects. The failure is purely
`close()`-before-settle. Idle-release matters only in that the drain must be robust to a
`_released` connection mid-drain; it is, because the drain's own audit write reconnects
transparently.

---

## 2. Does this need a sox-package change? **No.**

Stated explicitly, with reasoning:

1. **The drain is a backlog-owned lifecycle concern.** The adapter has no knowledge of the
   embeds backlog schedules; there is no adapter API that could own them. `flushEmbeds` must
   live where the promises are created — `entrypoint/backlog`.
2. **The adapter's close semantics are correct.** `close()` being terminal (and
   `_ensureHealthy()` early-returning when `closed`) is the right contract. The drain runs
   *before* `adapter.close()`, so the post-close state is never exercised on the normal path.
3. **Idle-release needs no sox change** — it already recovers transparently (§1).
4. **ADR-0012 (`turso-multiprocess-write…`, ACCEPTED, authoritative) is not violated.** The
   invariant is "multiple processes may hold concurrent write connections; writers serialize
   via `multiprocess_wal`'s writer slot". The drain adds **no lock and no serialization** — it
   only awaits promises this process itself created. §4's "silent loss is the thing the design
   must never do" is exactly what this spec fixes, and §3's "adapter owns driver-shaped
   DETECTION, consumer owns stable taxonomy" is untouched (the drain does not classify driver
   errors; it prevents them).
5. **ADR-0013 (`feature switches are typed config, never env vars`, ACCEPTED)** — the drain is
   **unconditional**, not behind any env var. The drain bound is a tuning *constant* with an
   optional typed override, permitted by D3 (numeric threshold, never gates a code path). Do
   **not** add an `ADHD_BACKLOG_EMBED_DRAIN=0`-style toggle.
6. **ADR-0015 (`backlog-single-writer-daemon-tier`) is PROPOSED, never accepted.** The fix
   must not rely on a daemon: it works in the current one-process-per-command topology. (Note
   also the repo hard rule — never reason from a single-writer claim.)

**Two sox-side observations to file (non-blocking, NOT to be hand-rolled here):**

- `TursoAdapterImpl.close()` does **not** await/drain `_inFlightOps` (unlike
  `releaseIdleConnection()`, which refuses when `_inFlightOps > 0`). Any consumer that closes
  while an adapter op is in flight gets the same opaque `TypeError` rather than a bounded wait
  or a typed error. Worth a sox backlog item / future ADR. This fix removes backlog's exposure
  to it; it does not fix the class.
- `isDatabaseError` (ADR-0012 §3's driver-shaped detection) does not appear to recognize
  `"The database connection is not open"`. If the above is ever fixed, adding that marker in
  `@adhd/sox-store-adapter`'s `errors.ts` is the ADR-0012-compliant home — **not** a backlog-side
  regex.

---

## 3. Design

### 3.1 New module `src/write/embed-drain.ts`

A per-adapter in-flight registry, mirroring the existing `membersCache`
(`WeakMap<StoreAdapter, …>`) precedent in `write/bootstrap.ts:254`. Keying on the **adapter**
(not the store) is deliberate: `scheduleIssueEmbedding` only receives `IWriteStoreHandle`,
whose `adapter` is required — so the registry reaches the producer with **zero interface
churn**, and `closeGraphBacklogStore(store)` reaches it via `store.adapter`.

```ts
import type { StoreAdapter } from '@adhd/sox-store-adapter';

export type EmbedAction = 'upsert' | 'delete';
/** 'unrecorded' = round-trip failed AND its embedding_failed audit row could not be written. */
export type EmbedOutcome = 'pending' | 'upserted' | 'deleted' | 'failed' | 'unrecorded';

export interface IPendingEmbed {
  readonly subjectRowid: number;
  readonly subjectUid: string;
  readonly actor: string;
  readonly action: EmbedAction;
  readonly settled: Promise<void>;   // the promise scheduleIssueEmbedding returns
  outcome: EmbedOutcome;             // 'pending' until the producer settles it
}

export interface IEmbedDrainResult {
  readonly drained: number;                          // settled during the drain
  readonly stillPending: readonly IPendingEmbed[];   // unsettled when the bound elapsed
  readonly recordedAsFailed: number;                 // of stillPending, embedding_failed written before close
  readonly unrecorded: readonly IPendingEmbed[];     // outcome NOT durably recorded → loud signal
}

export interface IEmbedDrainOptions { readonly timeoutMs?: number; }

export interface IEmbedDrainRegistry {
  /** Add an entry; returns the disposer the producer calls once `settled` resolves. */
  register(entry: IPendingEmbed): () => void;
  readonly size: number;
  snapshot(): readonly IPendingEmbed[];
  drain(opts?: IEmbedDrainOptions): Promise<IEmbedDrainResult>;
}

/** Tuning constant (ADR-0013 D3 — a threshold, never a feature gate). */
export const DEFAULT_EMBED_DRAIN_TIMEOUT_MS = 30_000;

export function embedDrainFor(adapter: StoreAdapter): IEmbedDrainRegistry;
```

`drain` algorithm — **drain-until-empty, bounded** (the "existing never-hang guard"):

```
deadline = now + (opts.timeoutMs ?? DEFAULT_EMBED_DRAIN_TIMEOUT_MS)
while (size > 0):
    remaining = deadline - now
    if remaining <= 0: break
    round = snapshot()                      // re-snapshot every pass: new entries can register mid-drain
    await withDeadline(Promise.allSettled(round.map(e => e.settled)), remaining)  // → 'timeout' | void
    if timed out: break
unrecorded = snapshot().filter(e => e.outcome === 'unrecorded')
return { drained: <completions observed>, stillPending: snapshot(), recordedAsFailed: 0, unrecorded }
```

`withDeadline(p, ms)` resolves `'timeout'` on a `setTimeout` (`.unref()`d) or `void` when `p`
settles — no unhandled rejection (`Promise.allSettled` never rejects). `recordedAsFailed` is
filled by `closeGraphBacklogStore` (§3.3); `drain` stays registry-pure.

### 3.2 `src/write/embedding-observer.ts` — register on schedule, return the outcome

Restructure `scheduleIssueEmbedding` from `async` to a thin **non-async wrapper** so it can
register its own promise. Body moves to `runEmbedRoundTrip`, which returns the outcome instead
of swallowing it.

**BEFORE**
```ts
export async function scheduleIssueEmbedding(
  handle: IWriteStoreHandle, input: IScheduleEmbeddingInput
): Promise<void>
```

**AFTER**
```ts
export function scheduleIssueEmbedding(
  handle: IWriteStoreHandle, input: IScheduleEmbeddingInput
): Promise<void> {
  const backend = handle.embedding;
  if (!backend) return Promise.resolve();          // unconfigured — true no-op, no audit row
  const settled = runEmbedRoundTrip(handle, backend, input);   // never rejects (existing contract)
  const entry: IPendingEmbed = {
    subjectRowid: input.subjectRowid, subjectUid: input.subjectUid,
    actor: input.actor, action: input.action, settled, outcome: 'pending',
  };
  const unregister = embedDrainFor(handle.adapter).register(entry);
  settled.then(
    (outcome) => { entry.outcome = outcome; unregister(); },
    () => { entry.outcome = 'unrecorded'; unregister(); },      // contract breach → worst case
  );
  return settled.then(() => undefined);            // public signature stays Promise<void>
}

/** The existing body, now returning the outcome. 'unrecorded' when the audit write itself fails. */
async function runEmbedRoundTrip(
  handle: IWriteStoreHandle, backend: IEmbeddingBackend, input: IScheduleEmbeddingInput
): Promise<Exclude<EmbedOutcome, 'pending'>>;

/** Record each still-unsettled embed as embedding_failed, BEFORE the connection closes. */
export async function recordUnsettledEmbedsAsFailed(
  handle: IWriteStoreHandle, pending: readonly IPendingEmbed[]
): Promise<{ recorded: IPendingEmbed[]; unrecorded: IPendingEmbed[] }>;
```

- `runEmbedRoundTrip` returns `'upserted' | 'deleted'` on success, `'failed'` when the
  round-trip threw **and** the `embedding_failed` row was persisted, and `'unrecorded'` when
  the audit write itself failed (today's `embedding-observer.ts:170-182` catch). Its
  never-throws contract and all existing doc comments are preserved.
- `recordUnsettledEmbedsAsFailed` loops the pending entries and, per entry, runs
  `executeWriteTransaction(handle, tx => writeAudit({ …, action: 'embedding_failed',
  note: EMBED_DRAIN_TIMEOUT_NOTE }))`. An entry whose audit write throws lands in `unrecorded`.

### 3.3 `src/store/graph-backlog-store.ts` — drain, record, close, and be loud

**Interface (additive):**
```ts
export interface GraphBacklogStore {
  readonly adapter: StoreAdapter;
  readonly graph: GraphBackend;
  readonly typePolicy: TypePolicy;
  /** Drain every embed the write layer scheduled against this store's adapter. */
  flushEmbeds(opts?: IEmbedDrainOptions): Promise<IEmbedDrainResult>;
}
```
`openGraphBacklogStore`'s returned literal gains
`flushEmbeds: (opts) => embedDrainFor(adapter).drain(opts)`.

**`closeGraphBacklogStore` — BEFORE `await store.adapter.close()`; AFTER:**
```ts
export async function closeGraphBacklogStore(store: GraphBacklogStore): Promise<IEmbedDrainResult> {
  const drained = await store.flushEmbeds();
  const rec = drained.stillPending.length
    ? await recordUnsettledEmbedsAsFailed(store, drained.stillPending)
    : { recorded: [], unrecorded: [] };
  await store.adapter.close();                       // unchanged: always closes, even if the drain failed
  return { ...drained, recordedAsFailed: rec.recorded.length,
           unrecorded: [...drained.unrecorded, ...rec.unrecorded] };
}
```
The recording runs **while the connection is still open**, which is the whole point: an
unsettled embed's outcome becomes a durable `embedding_failed` audit row instead of a lost
log line.

**`closeGraphBacklogStoreSafe` — no longer silently discards:**
```ts
export async function closeGraphBacklogStoreSafe(store: GraphBacklogStore | undefined): Promise<void> {
  if (!store) return;
  let result: IEmbedDrainResult;
  try { result = await closeGraphBacklogStore(store); }
  catch (err) { console.error(`backlog: store close failed (data is durable; WAL checkpoint may be pending): ${…}`); return; }

  if (result.unrecorded.length > 0) {
    console.error(
      `backlog: ${result.unrecorded.length} scheduled embed(s) died UNRECORDED — the store closed ` +
      `before they settled and the embedding_failed audit row could not be written. The subject ` +
      `write(s) are durable; the vector(s) are missing. Re-run the embedding backfill.`);
    if (!process.exitCode) process.exitCode = 1;     // data-integrity defect ⇒ non-zero exit
  } else if (result.stillPending.length > 0) {
    console.error(
      `backlog: ${result.stillPending.length} scheduled embed(s) did not settle before close — ` +
      `recorded as embedding_failed. The subject write(s) are durable.`);
  }
}
```

**One judgment call, stated so it can be overridden:** a **recorded** embed failure (the
`embedding_failed` row is durable) warns on stderr but **does not** change the exit code —
`create` still reports `ok:true`, because the subject write genuinely succeeded and the
failure *is* recorded. Only an **unrecorded** death sets `process.exitCode = 1`. This is the
literal reading of the decision's goal ("`create` can never return `ok:true` while a scheduled
embed dies **unrecorded**") and preserves the existing "filing must never depend on RAG"
contract. If the intent is "any embed failure ⇒ exit 1", that is a one-line change in the
`else if` branch — flag before implementing.

`closeGraphBacklogStore`'s return type widens from `Promise<void>` to
`Promise<IEmbedDrainResult>`. This is **non-breaking** (a `Promise<T>` is assignable where
`Promise<void>` is expected, and every existing caller `await`s or ignores it). It is exported
from `index.ts:92`, so `@adhd/backlog` takes a **patch/minor** bump on ship. **No sox package
version changes.**

### 3.4 What is deliberately NOT changed

- `awaitEmbed` stays; the default stays fire-and-forget. The drain is the new *backstop* for
  one-shot hosts, restoring the pre-Seg-F guarantee without forcing every caller to await.
- No new env var (ADR-0013). No new lock, no serialization (ADR-0012). No sox API change.
- `server.ts` / `serve` need no change: they close through the same
  `closeGraphBacklogStoreSafe`, so the drain covers graceful shutdown too.

---

## 4. Files

| Path | Change | Read tokens | Output tokens |
|---|---|---|---|
| `src/write/embed-drain.ts` | create | ~60 (bootstrap.ts:236-290 pattern) | ~320 |
| `src/write/embedding-observer.ts` | modify | ~183 (whole file — it is the file under edit) | ~180 |
| `src/store/graph-backlog-store.ts` | modify | ~154 | ~130 |
| `src/store/embed-drain.spec.ts` | create | ~120 (embed-write-path.spec harness) | ~380 |
| `src/store/embed-write-path.spec.ts` | modify (header + negative control) | ~120 | ~90 |
| `RAG-SPEC.md` §2.2, `DESIGN.md:500-504`, `PLUGIN_ARCHITECTURE.md:111-112` | modify | ~60 | ~70 |
| `tools/gate/embedding-usage-gate.mjs` | modify (declaration only, if the gate flags the new spec) | ~40 | ~20 |

---

## 5. Independent segments

### Segment A — the drain registry (no dependencies)
- **Files:** `src/write/embed-drain.ts` (create).
- **Read:** `src/write/bootstrap.ts:236-290` **only** — the `membersCache` WeakMap precedent.
- **Output:** ~320 tokens. **Required context:** none beyond that slice.
- Implement `IPendingEmbed` / `IEmbedDrainResult` / `IEmbedDrainRegistry` / `embedDrainFor` /
  `drain` / `withDeadline` exactly as §3.1. Do **not** import anything from `store/`.

### Segment B — producer registration (depends on A)
- **Files:** `src/write/embedding-observer.ts`.
- **Read:** the whole file (183 lines) — it is the file under edit.
- **Output:** ~180 tokens.
- Restructure per §3.2. **Never** change the never-throws contract, `composeEmbedText`, or the
  call-site contract (strictly post-commit).

### Segment C — close-path drain + loud failure (depends on A, B)
- **Files:** `src/store/graph-backlog-store.ts`.
- **Read:** the whole file (154 lines).
- **Output:** ~130 tokens.
- Add `flushEmbeds` to the interface + literal; rewrite `closeGraphBacklogStore` and
  `closeGraphBacklogStoreSafe` per §3.3. **Never** remove the unconditional
  `await store.adapter.close()` — a failed drain must still close the adapter.

### Segment D — tests with teeth (depends on C)
- **Files:** `src/store/embed-drain.spec.ts` (create), `src/store/embed-write-path.spec.ts` (modify).
- **Read:** `src/store/embed-write-path.spec.ts:56-155` (the `deferred()` + fake-backend harness) and
  `src/test/helpers/open-test-issue-store.ts`.
- **Output:** ~470 tokens.
- Drive the **real production close path** (`closeGraphBacklogStore` / `…Safe`), never
  `TestIssueStore.close()` (which is a bare `adapter.close()` and bypasses the drain).

### Segment E — docs truth-up (depends on C)
- **Files:** `RAG-SPEC.md:39-45`, `DESIGN.md:500-504`, `PLUGIN_ARCHITECTURE.md:111-112`,
  `src/store/embed-write-path.spec.ts:1-42` header.
- **Output:** ~70 tokens. Every one of these currently asserts "there is no store-level drain"
  — that becomes false. Rewrite to the new reality; no meta-commentary (state the current
  design as fact).

### Segment F — real-model / consumer acceptance (depends on C)
- **Files:** a new `src/store/embed-drain-real-model.spec.ts` (or an addition to
  `src/api.semantic-production-seam.spec.ts`).
- **Output:** ~200 tokens.
- See §6.3. **Unflagged, default-running** — fastembed is local ONNX, so AGENTS.md §7's
  paid/external gating exception does **not** apply (this also restores the real-model coverage
  the removal pass dropped, item `e769bdc4`).

### Segment G — gate declaration (depends on D/F)
- **Files:** `tools/gate/embedding-usage-gate.mjs`.
- **Output:** ~20 tokens. Run the gate; if a new spec is flagged, add it to `DECLARED_INJECTED_FAKE`
  or `REAL_BY_DESIGN` with a stated reason — never weaken the gate.

---

## 6. Test plan

### 6.1 Unit / integration (`embed-drain.spec.ts`, deterministic, no sleeps)

Harness: `openTestIssueStore` + `seedProject` + a fake `IEmbeddingBackend` whose
`embedDocument`/`upsertVector` can be gated by a `deferred()` promise (as
`embed-write-path.spec.ts:56-120` already does). Build the handle with `embedding` set, call
`createIssue` with `awaitEmbed` **omitted**, then drive `closeGraphBacklogStore(store)`.

1. **Fire-and-forget survives close (the headline).** Gate `upsertVector`; `createIssue`
   returns; `const closing = closeGraphBacklogStore(store); await Promise.resolve();
   gate.resolve(); await closing;` → reopen a fresh store on the same file → assert the vector
   is present and exactly **one** `embedding_upserted` audit row exists.
   *Negative control (proves teeth):* comment out the `await store.flushEmbeds()` in
   `closeGraphBacklogStore` → this test goes **RED** (no vector, no `embedding_upserted` row).
   Record the red run.
2. **Unsettled embed is recorded, not lost.** Gate never resolves; drain bound overridden to a
   small value (e.g. `{ timeoutMs: 50 }` via `store.flushEmbeds`/an injectable option) →
   assert `result.stillPending.length === 1`, `result.recordedAsFailed === 1`,
   `result.unrecorded.length === 0`; after reopen, exactly one `embedding_failed` row with the
   drain-timeout note exists.
3. **Unrecorded is loud.** Force the recording's audit write to fail (an adapter whose
   `transaction` throws, injected at the unit seam) → assert `closeGraphBacklogStore` returns
   `unrecorded.length === 1`, and that `closeGraphBacklogStoreSafe` emits the stderr warning
   **and** sets `process.exitCode = 1` (restore `process.exitCode` in `finally`).
4. **No latency regression.** Keep the existing `embed-write-path.spec.ts:203-239` assertion
   that `createIssue` returns before a gated embed settles — must stay green.
5. **Invert the old negative control.** `embed-write-path.spec.ts:272-301` currently asserts
   the vector is **lost** ("there is no drain to have waited for it"). Rewrite it to assert the
   post-fix outcome (recorded `embedding_failed` + `stillPending`), and update the file header
   (§Segment E). Leaving it as-is would pin the bug in place.

### 6.2 Assertions with teeth (mandatory)
- Every new behavioural test must FAIL if the fix is reverted. The named negative controls are
  (a) removing `await store.flushEmbeds()` and (b) removing the `recordUnsettledEmbedsAsFailed`
  call. Run both, record the red output.
- Assert the **consumer-visible outcome** (vector present after reopen; audit row durable),
  never "`flushEmbeds` was called".

### 6.3 Real-model / consumer acceptance (default-running)
- Through `bootstrapSemanticStoreMembers` with real fastembed, `create` **without** `awaitEmbed`,
  `closeGraphBacklogStore`, reopen, assert the item is vector-reachable (`view:"similar"` /
  `searchRanked`). A mock provider can fake a vector; only a real model proves the one-shot
  path end-to-end.
- CLI-level (strongest, mirrors `cli.spec.ts`'s spawned-bin pattern): spawn the built
  `dist/index.js create` against a temp `HOME`/sandbox store with `embedding.enabled`, then
  assert the process's stderr contains **no** `"unrecorded"` and a fresh store finds the vector.
  If the spawned-bin prerequisite (fastembed) is missing, **fail loudly** — never silently skip.

### 6.4 Verification commands (run from `entrypoint/backlog`)
```
npx nx build backlog
npx nx lint backlog
npx vitest run src/store/embed-drain.spec.ts src/store/embed-write-path.spec.ts
npx vitest run                     # full suite — must be 0 failures
node tools/gate/embedding-usage-gate.mjs
```
Then the negative controls (§6.2). **Do not use `--skip-nx-cache`.** If a build artefact
matters, `npx nx run backlog:verify-dist-load`.

---

## 7. Resolved decisions

1. **Exit-code policy** (§3.3): a **recorded** embed failure warns but exits 0; only an
   **unrecorded** death exits 1. Implemented as written — the literal reading of "loud and
   recorded", and the one that preserves the "filing must never depend on RAG" contract.
2. **Drain bound value.** No numeric guard is recoverable — `store/embed-queue.ts`'s drain was
   unbounded in every revision (`git log -p` across the file's whole history). The bound is
   `DEFAULT_EMBED_DRAIN_TIMEOUT_MS = 30_000` (generous for a warm local ONNX embed; it exists
   only to stop a wedged round-trip hanging process exit).
3. **`GraphBacklogStore.flushEmbeds` export.** Not added to `index.ts`: the `GraphBacklogStore`
   interface is already exported, so the method rides along and its return type resolves through
   the generated declaration. No separate export needed.
4. **`closeGraphBacklogStore` takes an optional `opts?: IEmbedDrainOptions`** (a bounded-wait
   override) so the drain bound is tunable and deterministically testable. `closeGraphBacklogStoreSafe`
   keeps the default. Non-breaking addition.
