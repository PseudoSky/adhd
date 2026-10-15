# Spec 87799e1d — persisted store health record (extend the existing `last_integrity` row)

user-request (verbatim): "For ones that dont [meet DoR]: bucket -> architect spec -> product revision -> impl ready. ... Do not merge or run tests until I say so."
items: 87799e1d-0dfc-41ba-b2cd-919513d7a7b6 (feature, HIGH, filed under project adhd but the mechanism lives in sox-ecosystem)
dor: needs-decision — check: a done-state is writable only after three open choices (D2 history bound, D3 vector-coverage owner, D4 read surface) are ruled; also cross-repo authority (adhd ADR-0002/ROADMAP D-B: adhd may fix sox CODE but not redesign sox). Size: M.

## Observed facts (O = opened; R = item only)
- O: item premise "no persisted health record" is PARTLY STALE. `_adapter_meta` key `last_integrity` (class `latest-json`) already persists the last integrity verdict: `/Users/nix/dev/ai/sox-ecosystem/libs/data/store/store-adapter/src/integrity.ts:3746` (`INTEGRITY_META_KEY`), envelope `{v:1, run_at_ms, result}` (l.3750-3756), written l.3806, read l.3831; key classes `/Users/nix/dev/ai/sox-ecosystem/libs/data/store/store-adapter/src/adapter-meta.ts:75-87`. Rendering (`healthy` only when positively demonstrated, `last_run_at`, `age_seconds`) is `integrity-status.ts:135-244`.
- O: genuinely missing: (a) no vector/semantic coverage in the persisted verdict (sox item 1acbd738, status open: a store missing 34% of vectors reads `ok`); (b) no history (single latest-wins row); (c) no single read that returns verdict + coverage + engine/version + last-verified.
- O: `embedding_health` is not a live symbol in either repo: adhd folded it into `embedding-status` / `SemanticBackend.health()` (`entrypoint/backlog/SPEC.md:2804`, `docs/plan/backlog-sox-rebuild/README.md:299`; readiness probe `entrypoint/backlog/src/readiness.ts:55-69`); the item's AC1 therefore names a retired tool. R: sox memory-core still has embed health in ping (`libs/memory-core/src/bug021-ping-health-reflects-embed-failures.spec.ts`), not opened further.
- O: `_adapter_meta` is a key/value table; adding keys needs no SQL migration (ADR sox 0008 not re-read; confirm). Concurrent writers: every adhd/sox store is parallel-process enabled (sox ADR-0012, adhd ADR-0001 D7) — the record must tolerate two processes writing it.
- gx does not index sox-ecosystem; blast radius from rg: `integrity.ts` is 3800+ lines; touch only the persist/read functions near l.3746-3840.

## Design decisions
D1 Extend, don't add a table: add `last_health` (class `latest-json`, in `JSON_ADAPTER_META_KEYS`) next to `last_integrity`; envelope `{v:1, verified_at_ms, integrity:<overall>, vector:{expected,present,coverage}|null, engine, sox_version, adapter_version}`. Rejected: a new `_store_health` table (needs migration + rebuild support in `rebuildAdapterMetaTable`); a separate health file (breaks "persisted into the store it describes", integrity.ts l.3740-3745).
D2 (DECISION) History: recommended = bounded ring in one JSON key `health_history` (N=20, newest last, `latest-json`), written in the same transaction as `last_health`. Alternative: latest only (cheapest; fails the "what was it before" ask). Alternative rejected: unbounded append table.
D3 (DECISION) Vector coverage is computed by the CONSUMER of the adapter (memory-core, backlog's semantic backend), not by the adapter, which has no notion of vectors. Adapter exposes `recordHealth(adapter, {vector})`; consumers call it after their coverage pass; verdict is `healthy:false, reason:'vector coverage <threshold'` when `coverage < threshold` (threshold typed config, default 0.99; never an env var — sox ADR-0013). Rejected: adapter reaching into the vector store (layering break).
D4 (DECISION) One-call read: `readStoreHealth(adapter)` in store-adapter returns `{latest, history, age_seconds, healthy, reason}`; surfaced via memory `memory_ping` (sox) and backlog `embedding-status` (adhd) additively (ADR-0006/0007: new optional response field only, no verb change). Rejected: a new backlog verb (breaks the 29-verb freeze process).
D5 concurrency: the value is a JSON text in a KV row, so a monotonic guard cannot be written in the UPSERT itself; do the read-modify-write (append to `health_history`, replace `last_health` only if the new `verified_at_ms` is not older) inside one `BEGIN IMMEDIATE` transaction with the bounded busy-retry contract of adhd ADR-0001 D3 / sox ADR-0012.

## Write-scope (exact, sox-ecosystem unless noted)
- /Users/nix/dev/ai/sox-ecosystem/libs/data/store/store-adapter/src/adapter-meta.ts (key class table), integrity.ts (persist/read near l.3746-3840 only), integrity-status.ts, index.ts, new `store-health.ts` (+ `__tests__/store-health.test.ts`)
- /Users/nix/dev/ai/sox-ecosystem/libs/memory-core/src/ (ping surface + coverage call; file chosen by implementer via rg `memory_ping`)
- /Users/nix/dev/node/adhd/entrypoint/backlog/src/readiness.ts and the `embedding-status` mount (additive field) — only after the sox adapter version containing `readStoreHealth` is published and pinned (adhd ADR-0001 D6).
- NOT in scope: schema migrations, any new MCP verb.

## Acceptance criteria
- AC1 After an integrity pass and a coverage pass, `_adapter_meta` holds `last_health` with verdict, vector coverage, engine, versions and `verified_at_ms`.
- AC2 `readStoreHealth` returns latest plus up to 20 history entries newest-last, in one call.
- AC3 Coverage below threshold yields `healthy:false` with a reason even when the integrity verdict is `ok` (the 1acbd738 case: 66% present).
- AC4 The record survives close/reopen and a crash-open (`clean_shutdown=0`).
- AC5 A corrupt/unknown-version `last_health` reads as `unknown`, never healthy (integrity-status.ts rule).
- AC6 Two processes recording health concurrently lose no history entry and never produce invalid JSON.
- AC7 `embedding-status` / `memory_ping` expose the record additively; existing fields byte-identical.

## Test plan (tier S default; cite `87799e1d AC<n>`)
AC1-AC5: S with a real in-process adapter on a temp DB (existing `integrity-status.test.ts` harness); AC3 negative control: set coverage 1.0 -> healthy. AC6: P two real processes sharing a store (same shape as adhd ADR-0001 D5 harness; barrier-released). AC7: S on the mounted surface (`api.surface.spec.ts`) plus one P e2e on built bin. Tests authored by `test-author`; record must run red against current main first.

## Risks / serialization
- Cross-repo: sox change must publish before adhd consumes (pin). Touches `integrity.ts` and `adapter-meta.ts`, which spec 26280300 (sidecar growth, AC3) may also touch — serialize 87799e1d first; both have uncommitted sox edits nearby (git status shows host-runtime/memory-server modified).
- Open for product: D2 history bound, D3 threshold/owner, D4 surface, and whether to correct the item to drop `embedding_health` and name `last_integrity` as the starting point.
