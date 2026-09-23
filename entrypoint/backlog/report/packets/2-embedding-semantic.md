# Packets — Domain 2: Embedding / Semantic / RAG

**Author:** architect (packet-authoring pass), 2026-09-22.
**Base branch:** `feat/backlog-hard-replacement` (worktree `.worktrees/backlog-v2`), the PR #9 cutover candidate.
**Live state:** the embedding funnel is **LIVE** — peer-spawned host, provider `0.5.3` / service-proxy `0.4.3`,
5 consumers → 1 host, self-reaps at `idleGraceMs` (~30 s); read-only verbs spawn zero. `embedding.enabled: true`
in the production namespace. `_adapter_meta` carries the BL-336 damage signature (six rows / three keys — EMBED-5).
**In flight — do NOT duplicate:** the one-shot-CLI vector-write durability fix is **landed in this worktree**
(`report/embed-durability-fix-spec.md`, segments A–G; `src/write/embed-drain.ts`, `src/store/embed-drain.spec.ts`,
`src/store/embed-drain-real-model.spec.ts` all present; item `276b8f2a`). The dedupe gate's **non-live over-match**
is fixed in that same pass. Coverage measurement is in flight (`ses_f341fbdc`); EMBED-1/EMBED-3 consume it, they do
not re-implement it. Every uid below was retrieved live via `adhd-backlog get` (all 23 resolved).

## Shared invariants every packet obeys

- **ADR catalog:** the `adhd` repo has **no** `docs/decisions/`; the governing catalog is
  `/Users/nix/dev/ai/sox-ecosystem/docs/decisions/` (0001–0020). Load-bearing here: **ADR-0013** (feature
  switches are typed config, **never** env vars — no `ADHD_BACKLOG_EMBED_*`/`SOX_EMBED_*` toggle may be
  introduced; an internal spawner→host idle-grace transport is an injection channel, not a switch),
  **ADR-0020** (the embedding funnel is **peer-spawned, self-reaping** — **never** call it a "daemon" or a
  managed service), **ADR-0012** (parallel-process enabled — never reason from single-writer),
  **ADR-0019** (native-chain deps are `optionalDependencies` via lazy non-literal dynamic import),
  **ADR-0010** (open node/edge typing), **ADR-0004** (data-root placement), **ADR-0006/0016** (live objects
  via DI). **ADR-0015 is PROPOSED, never accepted — do not adopt.**
- **Live-testing policy (AGENTS.md §7):** behavioural tests run by default, unflagged. An env-gate is
  legitimate **only** for a paid/external third-party service, documented in README + AGENTS.md + the test
  header with a **named owner**. A local fastembed/ONNX model is neither paid nor external, so "it loads a
  model", "it spawns a process", "it's slow" are **not** grounds to gate.
- **No gate bypass:** never `--no-verify`; never `--skip-nx-cache`; never `tsc` directly; pnpm only; no
  destructive git (`reset --hard`, `clean -f`, `stash`). Worktrees under `.worktrees/`; ephemeral artifacts
  under `tmp/` (app layer) / `.adhd/tmp/` (tooling).
- **Two repos:** `adhd` = `entrypoint/backlog/**`; `sox-ecosystem` = `libs/**`. A packet whose Scope names
  `libs/` needs the **sox-ecosystem owner's dispatch** (cross-repo) and could not be source-verified in this pass.
- **Disjointness:** the live/deploy architect owns deploy mechanics; **this domain owns the semantics +
  implementation** of `2039bb80`/`87799e1d` (their `LIVE-9` is a coordination placeholder — do **not** duplicate
  the implementation there). The `citation-component-linking` architect owns issue→component linking;
  **EMBED-6 owns only the dedupe scorer seam** that feeds it. The registry-surface architect owns
  `registry-surface-redesign.md`.

---

## PACKET EMBED-1: Enable-transition backfill — items written while disabled get vectorized and counted

- Goal: After embedding is enabled, every live issue missing a vector is swept (bounded, resumable, audited)
  and the count is reported, so semantic search never silently ranks only a subset.
- Scope: `entrypoint/backlog` — a new `src/write/embed-sweep.ts` (or an added enable-path call in
  `src/write/bootstrap.ts`), `src/cli.ts` (`store-check`/an explicit operator op), `src/api.ts`
  (`embedding_health` surfaces the count), `src/env.ts` (doc), reusing `tools/etl/embed-backfill.ts`'s
  `runEmbedBackfill` (verified at `:150`) + `tools/etl/embed-backfill-cli.ts`. **Non-goals:** the on-write
  observer / close-time drain (landed, in flight — `src/write/embed-drain.ts`); a new **mounted verb** (v2's
  surface is 14 fixed verbs — the backfill is a `tools/etl` script + an explicit enable-path call, never an
  `admin` grab-bag).
- Inputs: `88b26235` (high — full body read); `1acbd738` (the verdict-blindness sibling). `env.ts:119` names
  `admin(embedding_backfill)` — **verify that op exists**; `registry-surface-redesign.md` §1 D4/SPEC-v2 §6.6
  reject the `admin` grab-bag, so it very likely does **not** exist and the sweep must be the ETL script plus
  an explicit call. Live instance: production ran disabled 2026-09-22T21:40Z–23:17Z, so items created in that
  window have no vectors; `276b8f2a` loses vectors for one-shot writes even while enabled (the in-flight fix).
- Acceptance/DoD:
  1. Open a store with `embedding.enabled:true` after items were created while it was `false` → the
     un-vectorized live count is **detected** and either swept (default) or reported, never silent.
  2. The sweep is **bounded + resumable + audited**: it re-reads the vector space fresh (never trusts a prior
     run's report), writes one `embedding_upserted`/`embedding_failed` audit row per item, and a second run is
     a no-op (`alreadyEmbedded === totalLiveIssues`).
  3. The count is surfaced in the health read (`embedding_health` / `vector_coverage`) in **one call** — not
     derivable only by running a backfill.
  4. **Negative control:** comment out the enable-path sweep call → DoD-1 goes **red** (the count reads 0 /
     the store reports healthy while N items lack vectors). Record the red run.
- Tests: new `src/write/embed-sweep.spec.ts` driving a real store: create N issues with no `handle.embedding`,
  reopen with a fake `IEmbeddingBackend`, assert all N vectorized + N audit rows; plus a real-fastembed variant
  (default-running, local ONNX — not gated). `tools/etl/embed-backfill.spec.ts` already exercises
  `runEmbedBackfill` idempotency — extend it, do not fork it. `npx nx test backlog`.
- Dependencies: the landed `src/write/embed-drain.ts` (durable on-write embed) — the sweep races the same
  close-time loss it fixes. EMBED-2 supplies the `embedding_health` surface this count rides on.
- Size/tier: M · executor hint: `typescript` (adhd), `test`.
- Risks/unknowns: whether auto-sweep on enable is acceptable (vs report-only) — see gate. Whether
  `runEmbedBackfill` is reachable from a store-open path without a CLI round-trip (it takes a `handle`) — spike
  if it must be refactored to share the open handle.
- Decision gates: **Repo owner** — auto-sweep on first enabled open (default) vs report-only + a documented
  `tools/etl` step. Recommendation: **auto-sweep, bounded + resumable + audited, no toggle** (the enabled state
  is already typed config; a sweep is the designed behavior, not a feature switch — ADR-0013).

---

## PACKET EMBED-2: Persisted health record — one call answers "what is this store's health?"

- Goal: A consumer can read a persisted health verdict (integrity + vector coverage + engine/version +
  last-verified timestamp) in one call, instead of computing it per-call or scraping telemetry.
- Scope: `entrypoint/backlog` — a new `src/store/health-record.ts` (schema + read/write),
  `src/store/graph-backlog-store.ts` (expose `healthRecord()`), `src/cli.ts` (`store-check` emits it),
  `src/api.ts` (`embedding_health` reads it). **Non-goals:** the probe *content* (EMBED-3 owns the
  `vector_coverage` probe); the deploy mechanics (`LIVE-9`).
- Inputs: `87799e1d` (high — full body read). Stored today: `PRAGMA application_id` (`SOXT`/`SOXS`),
  `_sox_engine` (engine, sox_version, driver_version, first/last_opened_at), `_adapter_meta` (adapter_type,
  adapter_version, created_at, clean_shutdown). **Not stored:** any health verdict. Health today is
  (a) computed on demand, (b) emitted as `store.integrity.*` telemetry (a sink, not the store), (c) blind to
  semantic completeness (`1acbd738`), (d) historyless.
- Acceptance/DoD:
  1. A persisted record exists carrying at minimum: `integrity_verdict`, `vector_coverage` (embeddable-live vs
     vectorized), `engine`/`sox_version`/`backlog_version`, `last_verified_at`, bounded history (keep last N;
     never unbounded growth).
  2. Both the integrity check and the embedding health path **write** it; `store-check` (and one API call)
     **read** it — verified by reopening a fresh store on the same file and reading the record.
  3. The record is written through the store adapter (parallel-process safe, ADR-0012) — no sidecar file.
  4. **Negative control:** skip the write on the health path → the reopen-read returns a stale/absent record
     and the test goes **red**. Record the red run.
- Tests: `src/store/health-record.spec.ts` — write, close, reopen (fresh handle, same file), assert the record
  round-trips; assert bounded history (N+1 writes keeps N). Default-running.
- Dependencies: EMBED-3 supplies the `vector_coverage` value; EMBED-4 shares the store-meta helper (land
  EMBED-4's helper first, or make it part of this packet's `src/store/health-record.ts`). **Coordinate with
  `LIVE-9`** — they own how it is deployed/observed; do not let a second packet edit the same file.
- Size/tier: M · executor hint: `typescript` (adhd) + `backend` (schema), `test`.
- Risks/unknowns: storage shape — a dedicated `_backlog_health` table vs meta nodes. Spike if the adapter's
  schema-apply path cannot add a table without a version gate.
- Decision gates: **Repo owner** — table vs node-kind for the record. Recommendation: a dedicated
  `_backlog_health` table written via the adapter (mirrors `_sox_engine`; avoids polluting the graph
  vocabulary and the query surface).

---

## PACKET EMBED-3: `vector_coverage` integrity probe — a missing third of the corpus degrades the verdict

- Goal: An integrity verdict reports **not-ok** (or degraded) when a material fraction of embeddable content
  lacks vectors — instead of reporting healthy for ~13 hours while ~34% of the corpus was unsearchable.
- Scope: **sox-ecosystem** — `libs/data/store/store-adapter/src/integrity.ts` (add the probe to the
  `IntegrityProbe` union + the verdict aggregation), plus a coverage read in `libs/data/vectors/vector-store`
  if needed, and the `libs/memory-core` health surface if it gates on the probe. **Non-goals:** the heal
  mechanism (`healMissingVectors` already works); the `SOX_DISABLE_*` brake deletion (separate items).
- Inputs: `1acbd738` (high — full body read). `IntegrityProbe` is a five-member union today — `wal_identity`,
  `adapter_meta_unique`, `btree_index_populated`, `fts_index_live`, `pragma_integrity_check` — **all
  structural, none content-completeness**; the string `embed` appears twice in `integrity.ts`, both comments
  (`integrity.ts:100-104`). Live evidence: `embed_backlog` read **3,246** while `integrity.overall:"ok"`,
  `healthy:true`, all five probes `validated:true`.
- Acceptance/DoD:
  1. A `vector_coverage` probe reports live **embeddable** rows vs vectorized rows, using the exact predicate
     `healMissingVectors` uses (`kind='episode' AND t_invalid IS NULL AND content != ''`) — **not** total node
     count (the live store legitimately sits at ~4,934 vectors / ~9,496 nodes).
  2. The probe **degrades the top-level `overall`/`healthy` verdict** — it does not merely add a field.
  3. Trigger is **backlog-age**, not raw count: alarm only when the oldest pending item is older than N
     minutes (a count alarms spuriously during a legitimate bulk import). `embed_backlog_oldest_at` is already
     published and null-when-empty — consume it.
  4. The verdict also surfaces whether the automatic-recovery brake (`SOX_DISABLE_EMBED_HEAL`) is set, so a
     suppressed pipeline is visible where the verdict is read.
  5. **Negative control:** revert the verdict aggregation to ignore the new probe → the "34% missing reads
     not-ok" test goes **red**. Record the red run.
- Tests: a spec in `store-adapter` with a fixture store missing K% of vectors: assert the probe value and the
  degraded verdict; assert a store with only non-embeddable nodes reads **ok** (no permanent false positive).
  Default-running.
- Dependencies: none. Cross-repo (sox-ecosystem owner dispatch). Note the `SOX_DISABLE_*` env-brake itself is
  an ADR-0013 debt — do not propagate the pattern; the probe should report the brake's state, not add one.
- Size/tier: M · executor hint: `backend` (sox), `test`.
- Risks/unknowns: the probe's cost on a large store (a full scan per integrity run) — if non-trivial, the spike
  is whether coverage is a cheap `COUNT` join or must be sampled/cached (feeds EMBED-2's persisted record).
- Decision gates: **Repo owner** — the age threshold N. Recommendation: N ≈ 10 min (above the enrich tick
  cadence, below an operator's patience); a typed tuning constant (ADR-0013 D3), not an env toggle.

---

## PACKET EMBED-4: Backlog version/skill stamp — the store records which build wrote it

- Goal: The store records the `backlog` entrypoint version + deployed skill sha that wrote a row, so
  skill/binary drift is visible from the store instead of only from disk.
- Scope: `entrypoint/backlog` — a new `src/store/store-meta.ts` (or extend the existing engine-stamp path),
  `src/store/graph-backlog-store.ts` (stamp on open / version change), `src/cli.ts` (`version`/`store-check`
  read it). **Non-goals:** the deploy mechanics (`LIVE-9`); refusing on mismatch.
- Inputs: `2039bb80` (medium — full body read). Today only `_sox_engine` (sox_version, driver_version) and
  `_adapter_meta` (adapter_version) are stamped; nothing records the **backlog entrypoint version / deployed
  skill sha**. Consequence: drift (`268790d3`, `8fb08ec8`, `56865633`) is invisible from the store. Relates to
  `46951936` (the `version` command, DONE).
- Acceptance/DoD:
  1. On first open (and on a version change), the store carries `backlog_version` + `skill_sha`, mirroring
     `_sox_engine`'s shape.
  2. A mismatch between the running build and the stamped value **warns, never refuses** (filing/querying must
     not depend on the stamp).
  3. `store-check` (and the `version` command) can read it in one call.
  4. **Negative control:** skip the stamp on open → `store-check` reports no version and the test goes **red**.
     Record the red run.
- Tests: `src/store/store-meta.spec.ts` — open, close, reopen (fresh handle, same file), assert the stamp
  round-trips; assert a changed running version warns without failing the open. Default-running.
- Dependencies: EMBED-2 (shared store-meta helper). **Coordinate with `LIVE-9`** (deploy/observation).
- Size/tier: S–M · executor hint: `typescript` (adhd), `test`.
- Risks/unknowns: where the "skill sha" comes from (the installed `skill/SKILL.md` is an asset; its digest must
  be computed at build/install, not hardcoded). Spike if no build-time digest exists.
- Decision gates: none (the warn-never-refuse posture is the item's own ask). Recommendation: land EMBED-2 and
  EMBED-4 in one dispatch to one owner to avoid two packets editing `store-meta`.

---

## PACKET EMBED-5: `_adapter_meta` damage repair + a permanent one-row-per-key assertion

- Goal: The live store's duplicated `_adapter_meta` rows are repaired, the unique index is verified, and
  `store-check` refuses to call a store healthy when the table is not one-row-per-key.
- Scope: `entrypoint/backlog` — `src/cli.ts` (`store-check` assertion) plus a bounded, operator-invoked repair
  path (a `tools/etl` script); **sox-ecosystem** — `libs/data/store/store-adapter/src/adapter-meta.ts` if the
  index/dedupe needs a change. **Non-goals:** the `ON CONFLICT DO UPDATE` fix (already shipped).
- Inputs: `1c9ed8da` (medium — full body read). The live production store holds **six rows under three keys**
  in `_adapter_meta` because a second stamp landed while the unique index was damaged; the fix
  (`ON CONFLICT DO UPDATE`) shipped, but the damaged rows survive in the live store.
- Acceptance/DoD:
  1. `store-check` asserts `_adapter_meta` has **exactly one row per known key** and exits non-zero with a
     structured report on violation.
  2. A bounded, operator-invoked repair dedupes the rows and verifies the unique index; it reports what it did
     (explicit invocation, never an env-armed toggle — ADR-0013).
  3. After repair, `store-check` reads clean; a fresh reopen confirms the dedupe is durable.
  4. **Negative control:** plant a duplicate row → the new `store-check` assertion goes **red**; repair →
     green. Record the red run.
- Tests: `src/cli.store-check.spec.ts` (verified present, spawned-bin, real temp store) extended with the
  duplicate-row case; a repair spec asserting one-row-per-key after. Default-running.
- Dependencies: none. Cross-repo only if the sox `adapter-meta.ts` needs an index change.
- Size/tier: S · executor hint: `debug` (adhd) + `typescript`, `test`.
- Risks/unknowns: whether the live unique index is genuinely damaged (a repair may need to recreate it) —
  inspect the live store before writing the repair; spike if the index DDL cannot be re-applied idempotently.
- Decision gates: **Repo owner** — run the repair against the **live production store** (destructive-ish).
  Recommendation: yes, bounded + reported + after a backup; it is exactly the damage class the item names.

---

## PACKET EMBED-6: Dedupe `{score, reasons}` scorer seam — file/citation overlap ranks

- Goal: Two items citing the same file at overlapping line ranges rank above two items sharing only generic
  prose, and every candidate explains *why* it collided.
- Scope: `entrypoint/backlog` — `src/write/create-issue.ts` (the duplicate-candidate type + the dedupe scan),
  a new `src/write/dedupe-scorers.ts`, `src/write/create-duplicate-gate.spec.ts`. **Non-goals:** the **non-live
  over-match** fix (in flight in the same durability pass — do not duplicate); issue→component linking (the
  `citation-component-linking` architect); the embedding model itself.
- Inputs: `56becdc4` (high — full body read). The item's own citations point at the **deleted** old layer
  (`src/store/crud.ts:124-128,130-193,268-270,313-315`) — **target the current `create-issue.ts` duplicate
  scan** (verify the exact candidate type/symbol before edit; the item predates the v2 write layer). The
  candidate return today is unranked; the item's design constraint is explicit: implement behind a
  `{score, reasons[]}` seam so citation overlap is one scorer among several and embeddings slot in later with
  no consumer change. `citation-component-linking.md` §3.2 defines the citation-node read path
  (`meta.target`/`meta.line`) this scorer must reuse.
- Acceptance/DoD:
  1. The duplicate candidate gains `reasons: IDedupeReason[]` (`{ scorer: 'file'|'lines'|'symbol'|'error'|'content',
     weight, detail }`), and `score` becomes the **fused** multi-scorer value; the flat shape stays for
     backward compat (additive, non-breaking).
  2. Scorers: exact file-path match (highest), overlapping line ranges on the same file (higher still), shared
     symbol names, shared error strings, existing content-hash similarity (**de-weighted**).
  3. Candidates are returned **ranked** (best-first) with stable ordering.
  4. `reasons` names each contributing scorer; the API returns `{score, reasons}` per candidate.
  5. **Negative control:** two items citing the same `file:lines` rank **above** two items sharing only generic
     prose; disable the file/lines scorer → the ordering assertion goes **red**. Record the red run.
- Tests: `create-duplicate-gate.spec.ts` extended with: same-file-overlap ranks first; `reasons` names the
  scorer; ordering stable across runs. Read candidate citations through the **same** path `get` uses (the
  citation edges / `meta.target`) — do not hand-roll a second reader.
- Dependencies: none strictly; the linking architect's packet may consume `{score, reasons}` — sequence EMBED-6
  **before** their consumer change.
- Size/tier: M · executor hint: `typescript` (adhd), `test`.
- Risks/unknowns: whether a candidate's citations are cheaply reachable at scan time (one edge read per candidate
  vs a batched read). Spike if the candidate set is large and the read is N+1.
- Decision gates: none. Recommendation: implement the `{score, reasons}` seam now (the item explicitly sequences
  it so embeddings slot in later as one more scorer with no consumer change).

---

## PACKET EMBED-7: Fastembed lock — one machine-stable path + a service label written with the claim

- Goal: A memory-server host and a backlog CLI host contend on the **same** lock file, and the warning names
  which service the competing host belongs to.
- Scope: **sox-ecosystem** — `libs/data/embed/embedding-provider/src/fastembedLock.ts`
  (`resolveFastembedLockPath`, payload shape), the funnel/host spawn path that sets the child env (item names
  `fastembedProcessHost.ts`; the prior pass names `funnelClient.ts` — **verify the exact module**),
  `src/fastembedProcessHost.ts` (claim/warn), `src/sharedFastembedProcess.ts` (reader). **Non-goals:** a
  machine-wide broker (the item's "durable option" — not this packet); the provider-side service label plumbing
  that already shipped (evidenced below).
- Inputs: `6f331a04` (high) + `348cc700` (high) — both full bodies read. **Two distinct gaps, one file family:**
  - **Path split** (`6f331a04`): `resolveFastembedLockPath()` derives from `os.tmpdir()`
    (`fastembedLock.ts:72-74`); launchd's memory-server (no `TMPDIR`) writes `/tmp/sox-fastembed-host.lock`, a
    shell CLI writes `$TMPDIR/sox-fastembed-host.lock` — the two never see each other. Live evidence: 792
    `competing_host_detected` events, 777 on `$TMPDIR/…`, exactly 1 on `/tmp/…`; the two lock files prove the
    split directly.
  - **Payload identity** (`348cc700`): the `$TMPDIR` lock (shell/funnel-spawned) carries **no `service`
    field**, while the `/tmp` lock (launchd memory-server) carries `"service":"memory-server"` — so the label
    exists on some paths and is not threaded by the CLI/funnel spawn env. `FastembedLockInfo`
    (`fastembedLock.ts:27-54`) is `{ pid, startedAt, poolGroup? }`; the warning
    (`fastembedProcessHost.ts:156-166`) prints only pid/startedAt/path; `detectCompetingFastembedHost`
    (`sharedFastembedProcess.ts:127-166`) returns only `{pid, startedAt}`. Also: the lock is
    **last-writer-wins**, so its `pid` cannot identify the contention partner (`348cc700`'s triage addendum).
- Acceptance/DoD:
  1. `resolveFastembedLockPath()` resolves ONE machine-stable path derived from the data root
     (`$SOX_ECOSYSTEM_HOME`, ADR-0004), independent of `TMPDIR`; `SOX_FASTEMBED_LOCK_PATH` remains an override.
  2. The funnel host spawn env carries the owning service identity (resolved via the existing service-label
     mechanism — **not** a new feature toggle), so a funnel-spawned host writes a lock with a `service` label,
     and `detectCompetingFastembedHost` returns it (so telemetry carries `competing_host_service`).
  3. Same-service suppression: a competing lock whose `service` matches the reader's own suppresses the
     warning; cross-service keeps it, now with identity.
  4. A default-running test proves a TMPDIR-unset (launchd-like) writer and a TMPDIR-set (shell-like) writer
     resolve the **same** path; and that the funnel-spawned host's lock carries its service.
  5. **Negative control:** unset the service identity in the funnel spawn env → the "funnel host lock has a
     service label" test goes **red**. Record the red run.
- Tests: `fastembedLock.spec.ts` (same-path proof, both TMPDIR shapes), plus a funnel-spawned-host lock-label
  spec. Default-running.
- Dependencies: none. Cross-repo (sox-ecosystem owner dispatch).
- Size/tier: M · executor hint: `backend` (sox), `test`.
- Risks/unknowns: the last-writer-wins pid ambiguity is **not** fully solved by a service label (the label can
  also be last-writer). Decide whether to make the claim write atomic with identity, or accept the label as
  "the last claimant" and document it. Spike if the item's "append/registry-shaped lock" is required for a
  truthful partner identity.
- Decision gates: **Repo owner** — path home (`$SOX_ECOSYSTEM_HOME` vs a fixed `/tmp` shim) and whether the
  last-writer ambiguity is in scope. Recommendation: data-root path + service label now; file the
  registry-shaped lock as its own item.

---

## PACKET EMBED-8: Warmup readiness, not file-presence — and a degraded verdict when the vec channel is absent

- Goal: A downloaded-but-cold model either warms up (retry) or degrades a **visible** health verdict — it never
  leaves the provider permanently uninitialized behind an `ok` verdict.
- Scope: **sox-ecosystem** — `libs/data/embed/embedding-provider/src/fastembed.ts` (`initModel`),
  `src/index.ts` (`isModelCached`/`warmupTimeoutMs`), and `libs/memory-core`'s health surface (make
  `embed_state !== 'real'` degrade the top-level verdict). **Non-goals:** reopening BL-376 (correctly
  RESOLVED — the successor item says so); the cache-hit **retry** already added by this item's own fix.
- Inputs: `e0b9f977` (high — full body read). The split is on "has the model been **downloaded**?" but warmup
  duration is governed by "is it page-cache resident + is the EP graph compiled?". Live repro 2026-08-08: first
  start FAILED with `warmup timed out after 8000ms` (proving `isModelCached()` was true), second start succeeded
  with `execution_provider: coreml` — the only variable was page-cache residency. The failed child stayed alive
  at 0.0% CPU holding a loaded model. **Two consequences:** no recovery without an operator restart;
  `memory_ping` returned `ok:true, integrity.overall:ok` with the vec channel absent. `warmupTimeoutMs` splits
  8 s (cache hit) vs 180 s (miss) at `index.ts:267-278`, mirrored at `fastembed.ts:270-273`.
- Acceptance/DoD:
  1. Warmup distinguishes **readiness** from file-presence (e.g. time a probe read, or treat the first load
     after process start as cold regardless of file presence) — a downloaded-but-cold model is not held to the
     8 s cache-hit budget.
  2. On a cold-start timeout the provider **recovers** rather than staying uninitialized for the process
     lifetime.
  3. `embed_state !== 'real'` **degrades the top-level health verdict** (`overall`/`healthy`), so a
     five-minute vec outage is visible at the summary line, not only in a deep field.
  4. **Verify against the funnel (ADR-0020):** under the shared-host path the provider is inert and warmup runs
     in the host's private pool on first real embed — assert the degradation is still surfaced to the consumer
     (the funnel must not mask it).
  5. **Negative control:** with the model downloaded but not page-cache resident, warmup must complete or
     retry — the pre-fix behavior (permanent `uninitialized` + `ok:true`) is the red arm. Record it.
- Tests: the warmup-timeout-split spec + the cache-hit-retry spec extended with the downloaded-but-cold case
  (injected fake client, no download); a memory-core health spec asserting `embed_state !== 'real'` ⇒ not `ok`.
  Default-running.
- Dependencies: none. Cross-repo.
- Size/tier: M · executor hint: `backend` (sox), `test`.
- Risks/unknowns: "readiness" detection without a real cold cache is hard to test hermetically — the
  fake-client seam covers the branch, but the page-cache case may need a documented manual reproduction. Spike
  if the EP-graph compile time cannot be observed without a real CoreML session.
- Decision gates: none. Recommendation: the health-verdict degradation (DoD-3) is the cheapest, highest-value
  half — land it first if the readiness detector needs a spike.

---

## PACKET EMBED-9: HOL pool under the funnel — re-measure p99 and prove the pool actually grows

- Goal: Under the funnel, the host's private pool grows past size 1 when memory allows, and production p99 is
  re-measured — the "fixed" claim is proven in practice, not asserted.
- Scope: **sox-ecosystem** — `libs/data/embed/embedding-provider/src/sharedFastembedProcess.ts`
  (`AdaptiveFastembedProcessPool`, `resolveFastembedPoolCeiling`), `hol-pool-sizing.spec.ts`,
  `hol-pool-benchmark.spec.ts`, and a funnel-level assertion. **Non-goals:** re-fixing the routing counter
  (fixed: synchronous `inFlight` at routing-decision time); the stub-host golden's scope.
- Inputs: `d0767e15` (high — full body read). The pool is `AdaptiveFastembedProcessPool({minSize:1,
  maxSize: resolveFastembedPoolCeiling()})`; under the funnel the **host's private pool** is what matters.
  **STILL OPEN:** on a memory-pressured box the clamp resolves to **size 1** (the pre-fix topology); when
  measured 2026-08-15 the machine had 135 MB free. NOT re-measured since. Sizing is
  `max(1, min(cpuCap, memoryCap))` with a 1 GB safety margin; each child carries its own ~207 MB dirty
  malloc block (no shared mmap).
- Acceptance/DoD:
  1. Under the funnel (5 consumers → 1 host), the host's private pool grows past `minSize:1` when the machine
     has headroom — asserted at the funnel level, not only in the isolated benchmark.
  2. A re-measurement of the steady-state p99 at a stated concurrency/delay is recorded, with the machine's
     free-memory at measurement time — so the "pool actually helps" claim is evidence-backed.
  3. The adaptive pool must not be **worse** than pool=1 at low concurrency.
  4. **Negative control:** construct the pool with `maxSize:1` → the "pool beats single" assertion goes **red**
     (already demonstrated in the golden). Re-run and record.
- Tests: `hol-pool-benchmark.spec.ts` (golden, already has teeth) + a new funnel-level pool-growth assertion
  (real processes, stub host). Default-running.
- Dependencies: none. Cross-repo.
- Size/tier: M · executor hint: `performance` (sox), `test`.
- Risks/unknowns: the measurement depends on the host machine's free memory — a measurement on a pressured box
  is not a verdict. Spike if the ceiling heuristic itself is the defect (then this becomes a design change, not
  a measurement).
- Decision gates: none.

---

## PACKET EMBED-10: `execution_provider` on the already-loaded path — stop reporting `cpu`

- Goal: A second provider with the same `(model, cacheDir)` reports the **real** execution provider
  (`coreml`/`cuda`/…) instead of flipping to `cpu`.
- Scope: **sox-ecosystem** — `libs/data/embed/embedding-provider/src/fastembedProcessHost.ts` (`loadModel`).
  **Non-goals:** `fastembed.ts`'s consumer-side assignment (it correctly copies
  `res.execution_provider || 'cpu'`).
- Inputs: `5124be6c` (low — full body read). The `loadModel()` cache-hit branch (embedder already loaded with
  the same model+cacheDir) returns `execution_provider` hardcoded to `cpu`; the load branch reports the real
  first EP (coreml on darwin). A second `FastembedProvider` with the same model+cacheDir re-inits via the
  cache-hit branch and `fastembed.ts:initModel` overwrites `_executionProvider` with `cpu`, flipping
  `health().execution_provider` from coreml back to cpu. Purely cosmetic (does not affect inference),
  deliberately preserved in the prior fix.
- Acceptance/DoD:
  1. The already-loaded fast path returns the provider recorded at load time (e.g. a module-level
     `_executionProvider` set beside `_currentModel`/`_currentCacheDir`), not `'cpu'`.
  2. `health().execution_provider` is stable across a re-init with the same `(model, cacheDir)`.
  3. **Negative control:** re-init with the same model → assert the reported EP is unchanged; with the fix
     reverted it flips to `cpu` and the test goes **red**. Record the red run.
- Tests: a fork test: init → re-init same model → assert the second reply's `execution_provider` equals the
  first. Default-running.
- Dependencies: none. Cross-repo. (Cosmetic — sequence after EMBED-8/EMBED-9 if the owner serializes sox work.)
- Size/tier: S · executor hint: `typescript`/`debug` (sox), `test`.
- Risks/unknowns: none material.
- Decision gates: none.

---

## PACKET EMBED-11: `bl426` real-model shutdown suite — hermetic, loud, not silently skipped

- Goal: The native-shutdown suite either runs its real-model assertions or fails loudly; it never silently
  skips on a machine whose cache is present-but-empty.
- Scope: **sox-ecosystem** — the embedding-provider's `bl426` shutdown spec (cache dir, `isModelCached`
  precondition, timeout headroom), and `src/cache.ts` if the empty-dir short-circuit is fixed there.
  **Non-goals:** the adhd CI workflow gating (that is `LIVE-6`'s `bb38c9f4`/`81de39f7`); the `onnxStderrFilter`
  surface drift (EMBED-13).
- Inputs: `c8d6ca86` (medium — full body read). The suite's cacheDir pointed at
  `os.tmpdir()/sox-fastembed-bl426-cache` holding an **empty** `fast-bge-small-en-v1.5/` that permanently
  short-circuits fastembed's download (`FlagEmbedding.retrieveModel` treats any existing modelDir as complete;
  `downloadFileFromGCS` reuses partial tarballs). The item recommends: BL-567-pattern skip/mock-by-default when
  the model is not genuinely cached (`isModelCached`), **validate `tokenizer.json` presence**, and raise the
  timeout headroom (a clean cold download ~= 28 s races the 30 s scenario timeout).
- Acceptance/DoD:
  1. `isModelCached` (or the suite's precondition) rejects a **present-but-empty** model dir — validate
     `tokenizer.json` (+ the ONNX weight file), not a directory's existence.
  2. The suite's timeout headroom accommodates a real cold load.
  3. A missing model is a **loud** failure or a documented, visible skip naming the exact path — never a silent
     green. (Per AGENTS.md §7 a model download is **setup**, so the honest default is to provision it; only an
     optional external binary may self-skip with a visible warning.)
  4. **Negative control:** plant an empty model dir → the precondition test goes **red** (it currently passes,
     proving the hazard); clear it → green. Record the red run.
- Tests: the suite itself + a unit assertion on `isModelCached` against an empty dir. Default-running where the
  model is present; the skip must be loud.
- Dependencies: none. Cross-repo. Coordinate CI provisioning with `LIVE-6` so the two do not both edit the
  workflow.
- Size/tier: S–M · executor hint: `test` (sox).
- Risks/unknowns: hermeticity vs a 73 MB download — a fixture model or a pre-provisioned cache in CI is the
  clean fix; spike if the download cannot be provisioned offline.
- Decision gates: none.

---

## PACKET EMBED-12: Restore a default-running real-model semantic spec on the production seam

- Goal: A default-running spec drives the real embedding stack through the **shipped** seam
  (`bootstrapSemanticStoreMembers` / `ensureSemanticReady`) and proves "an issue embedded by `create()` is
  findable by a paraphrase query."
- Scope: `entrypoint/backlog` — `src/api.semantic-production-seam.spec.ts` and/or
  `src/store/embed-drain-real-model.spec.ts` (both **verified present** in this worktree), plus
  `tools/gate/embedding-usage-gate.mjs` if a new file needs a declaration. **Non-goals:** the deleted legacy
  `src/store/rag-e2e.spec.ts` path (its `semantic-search.ts` seam is production-dead — the file is **absent**
  from this worktree).
- Inputs: `e769bdc4` (high — full body read, enriched). Wave 0 Seg F deleted `src/store/rag-e2e.spec.ts` (the
  only default-running real-stack spec). All four specs importing `bootstrapSemanticStoreMembers`
  (`query/superseded-ranking.spec.ts`, `query/text-routing.spec.ts`, `write/bootstrap.spec.ts`,
  `write/create-duplicate-gate.spec.ts`) mock the provider — so the production seam was verified only against a
  fake. **However:** `src/api.semantic-production-seam.spec.ts` already exists (verified) — **first verify it
  actually drives `bootstrapSemanticStoreMembers`/`ensureSemanticReady` with real fastembed and asserts the
  paraphrase outcome**; if it does, this packet closes the item with that evidence; if it drives a fake, extend
  it. `embed-drain-real-model.spec.ts` proves the close-time drain with a real model — adjacent, not the same
  assertion.
- Acceptance/DoD:
  1. A default-running (unflagged) spec drives real fastembed (local ONNX, no env gate) through
     `bootstrapSemanticStoreMembers`/`ensureSemanticReady` against a real store + real Turso vector space, and
     asserts the model-independent invariant: an item embedded via the write path is retrievable by a
     semantically-related query that shares little/no vocabulary.
  2. If a prerequisite is missing (model absent), the spec **fails loudly** — never silently skips (AGENTS.md
     §7; fastembed is local, so no gate exception applies).
  3. **Negative control:** revert the bootstrap wiring to a fake → the paraphrase assertion goes **red**. Record
     the red run.
- Tests: the spec itself. `npx vitest run src/api.semantic-production-seam.spec.ts`;
  `node tools/gate/embedding-usage-gate.mjs` stays CLEAN.
- Dependencies: the landed embed-durability change touches the same write path — coordinate; do not both edit
  `api.semantic-production-seam.spec.ts` in the same window.
- Size/tier: S–M · executor hint: `test` (adhd).
- Risks/unknowns: if the existing spec is already sufficient, this is a verification + close, not new code —
  check first.
- Decision gates: none.

---

## PACKET EMBED-13: `check-changeset-surface` red — record the unreleased drift in changesets

- Goal: `check-changeset-surface` passes: the committed-but-unreleased public-surface drift in
  `sox-embedding-provider` and `sox-memory-core` is recorded in changesets instead of failing the gate.
- Scope: **sox-ecosystem** — new `.changeset/*.md` files naming `@adhd/sox-embedding-provider` and
  `@adhd/sox-memory-core`. **Non-goals:** weakening `scripts/check-changeset-surface.ts`; hand-editing any
  `package.json` version (changesets owns version + changelog); the gate's bump-type validation gap.
- Inputs:
  - `065b672f` (medium) — commit `2ad942d4` added `onnxStderrFilter.ts` (imported by
    `sharedFastembedProcess.ts`, not referenced from the entrypoint), so `dist/*.d.ts` differs from published
    `0.5.0` with no changeset. Non-blocking (local version == npm), but committed public-surface drift. The
    consumer-visible tail: the production backlog install resolves `@adhd/sox-embedding-provider@0.4.1`, whose
    dist forks the fastembed child with `stdio: ['ignore','inherit','inherit','ipc']` and has no
    `onnxStderrFilter`, so raw CoreML stderr reaches the terminal on every store-opening verb — **shipping the
    changeset is necessary but not sufficient; the consumer's dependency on `0.4.1` must also move** (that
    re-point is deploy/publish work — coordinate `LIVE-1`/`LIVE-2`, do not edit the installed artifact here).
  - `3bdd1586` (medium), `cd07303a` (medium), `148acecb` (low) — the same class for `@adhd/sox-memory-core`:
    `dist/*.d.ts` (`embed.d.ts`, `enrich.d.ts`, `neardup.d.ts`, `supersession-chain.d.ts`, `curate.d.ts`,
    `index.d.ts`) drifted from published `0.10.2` across post-publish commits with no changeset; local version
    == npm so it will not republish. `148acecb` first recorded it at published `0.6.0` (drift has since grown).
- Acceptance/DoD:
  1. `npx tsx scripts/check-changeset-surface.ts` reports `OK` (no FAIL) for **both** packages.
  2. Each changeset names its package and states the surface addition; the embedding-provider one is a
     **patch** (unreleased drift); the memory-core bump is confirmed by whoever authored the surface changes
     (likely minor per 0.x policy) — do not guess.
  3. No package version is hand-edited.
  4. **Negative control:** remove the changeset(s) → the gate FAILs again (proves the changeset is what turns it
     green). Record both runs.
- Tests: the gate command itself (`pnpm run check-changeset-surface`), plus its existing
  `scripts/check-changeset-surface.test.ts`.
- Dependencies: none. Cross-repo (sox-ecosystem owner dispatch, release-train window). The consumer re-point
  depends on `LIVE-1`/`LIVE-2`.
- Size/tier: S · executor hint: `backend` (sox release tooling).
- Risks/unknowns: the memory-core surface changes span several commits — reconstructing the correct bump
  description needs the authors' input; spike only if a changeset cannot be written without a wrong claim.
- Decision gates: none.

---

## PACKET EMBED-14: Silent vec/edge insert failures in `graphifyImport`/`buildCommunities`

- Goal: A bulk import/copy that silently drops vectors or edges reports a non-zero failure/skip count instead
  of `{ok:true, imported:N}`.
- Scope: **sox-ecosystem** — `libs/memory-core/src/extensions.ts` (`graphifyImport` ~509-741,
  `buildCommunities` ~741-905). **Non-goals:** rethrow/abort on a bad row (per-row tolerance is correct — the
  defect is the **silence**); the LOW/MEDIUM sites the item already classified.
- Inputs: `9e3eb686` (high — full body read). Four HIGH sites, all read-verified:
  `extensions.ts:649` (dst-node `INSERT OR IGNORE INTO vec_node`, `catch { /* non-fatal */ }`),
  `:687` (main-loop vec_node insert, immediately followed by an **unconditional** `importedNodes++`),
  `:1048` (edge-insert loop, `importedEdges++` inside the try, no failure count), `:870`
  (`buildCommunities` MEMBER_OF insert, `memberCount++` inside the try, `catch { /* skip */ }`). The original
  incident site `embed-pipeline.ts:456` is already fixed (comment confirms) — this is the same signature
  elsewhere.
- Acceptance/DoD:
  1. `graphifyImport` returns `vec_insert_failures: N` (and a skipped-edge count) alongside
     `{ok, imported, edges_imported, shape}`; the count is incremented in the catch blocks at `:649`/`:687`.
  2. `buildCommunities` surfaces a skipped-member count.
  3. **Negative control (the item's own, verbatim):** force one node's vec_node insert to fail → TODAY the
     return shows `ok:true, imported:N` with no indication (red); AFTER, it surfaces a non-zero failure count
     (green). A second test does the same for the MEMBER_OF edge insert. Record the red run.
- Tests: an `extensions` spec with a fixture whose vec_node insert is forced to fail (malformed embedding /
  locked table). Default-running.
- Dependencies: none. Cross-repo.
- Size/tier: M · executor hint: `typescript`/`debug` (sox), `test`.
- Risks/unknowns: the item's own note lists unscanned same-class packages (`apps/sox/src/main.ts`,
  `libs/host-runtime`, `libs/install-engine`, `libs/service-proxy`, `libs/registry`, `libs/source-provider`,
  `embedding-provider/src/cache.ts`) — out of scope here; file separately if the audit is to continue.
- Decision gates: none.

---

## PACKET EMBED-15: Cluster threshold + embed-pipeline counters/gauge + the BL-154 invariant doc

- Goal: Clustering actually forms communities on topical prose, embed counters have a current-state gauge, and
  the BL-154 invariant doc stops implying a serialization it does not provide.
- Scope: **sox-ecosystem** — `libs/memory-core/src/cluster.ts` (threshold), `src/embed-pipeline.ts`
  (counters + the BL-154 header). **Non-goals:** the incremental-cluster dead stub, the near-dup invalidation
  bugs, the enrich-tick starvation (separate items).
- Inputs:
  - `e914fbf5` (medium) — `resolveDefaultThreshold(){return 0.82;}` at `cluster.ts:918-920`, consumed at
    `:429`; measured intra-group cosine **0.67–0.70** on real bge-base-en-v1.5 → **zero clusters** at 0.82; at
    **0.65** → `cluster_count=3`, `coverage=1.0`, 100% purity on a 24-episode/3-topic corpus.
  - `ac459719` (medium) — success counters (`applies_applied`, `heals_applied`, `embeds_completed`) are
    **lifetime monotonic**, no gauge (`recordApplyOutcome` at `embed-pipeline.ts:301-304`, `:621,632-635`), so
    any comparison to `COUNT(*)` chases phantom data loss. `healStaleVectors` (`:756-865`) deletes-then-
    reinserts an already-good row, re-incrementing the counter with no net coverage change.
  - `ceb75996` (medium) — `embed-pipeline.ts:22-28`'s BL-154 invariant reads as "Phase-B must be serialized";
    the file's own dated self-correction (`:30-40`) says it is **QUEUE RE-ENTRANCY ONLY**, and concurrency is
    the adapter's `needsWriteSerialization`/`concurrentTransactions`. A real commit-revert round-trip
    (`0bde9f9` → `06fcff7`) happened because of the misread.
- Acceptance/DoD:
  1. The default cluster threshold is re-calibrated to the measured topical range (0.65), with the calibration
     evidence in the comment; a test asserts a 24-episode/3-topic corpus yields 3 communities at `coverage=1.0`
     (the pre-fix 0.82 yields 0 → **red** arm).
  2. Embed-pipeline exposes a **current-state** gauge per counter (pending/current vs lifetime), so a consumer
     can compare against `COUNT(*)` without phantom loss; a test asserts the gauge falls when the backlog
     drains.
  3. `embed-pipeline.ts:22-40` is rewritten to state the actual contract (queue re-entrancy only; concurrency
     is the adapter's `needsWriteSerialization`/`concurrentTransactions`), with **no single-writer/serialization
     claim** (ADR-0012 hard rule).
  4. **Negative control:** revert the threshold to 0.82 → the corpus test goes **red**; revert the gauge → the
     drain test goes **red**. Record both.
- Tests: a `cluster` spec (corpus → 3 communities), an `embed-pipeline` spec (gauge drains). Default-running.
- Dependencies: none. Cross-repo.
- Size/tier: M · executor hint: `backend`/`refactor` (sox), `test`.
- Risks/unknowns: re-calibrating a shared threshold affects every consumer — reconcile with any item claiming
  upward mis-calibration before choosing the number.
- Decision gates: **Repo owner** — the threshold value (0.65 measured vs a different target). Recommendation:
  **0.65**, with the measurement recorded; keep it a typed tuning constant (ADR-0013 D3).

---

## PACKET EMBED-16: Verify-and-close two items that may already be fixed upstream

- Goal: `72d980e5` and `2d88fba7` are closed with runnable evidence, or re-opened with a concrete repro.
- Scope: verification only — no source change unless a gap is proven. **sox-ecosystem** —
  `libs/service-proxy/src/ensure-backend.ts`, `libs/data/graph/graph-store/src/index.ts`.
- Inputs:
  - `72d980e5` (high) — "`ensureBackend`'s poll loop uses an unref'd sleep timer." The item cites
    `ensure-backend.ts:276` (`setTimeout(r, ms).unref?.()`) and `:390` (`child.unref()`), with a live repro
    (`soxe upgrade --all` completing in 0.23 s, exit 0, mid-sentence truncation). **Verify the installed
    `@adhd/sox-service-proxy@0.4.3` dist** (`node_modules/@adhd/sox-service-proxy/dist/ensure-backend.js`)
    still unrefs the poll timer; if a later build ref'd it, close with the dist evidence.
  - `2d88fba7` (high) — "`GraphBackend.transaction<T>(fn)` cannot select a mode." **In-repo evidence the fix
    shipped:** `wave-3a-semantic-adoption-spec.md` §2 finding 6 states `@adhd/sox-graph-store@0.11.0` ships
    the tx-scoped `transaction(fn, {mode})` / `GraphTransaction` surface. **Verify `index.ts`'s signature and
    the installed 0.11.0 dist**; if the wrapper forwards `opts`, close. If it still passes through
    deferred-only, widen the signature (`transaction<T>(fn, opts?: {mode?: 'deferred'|'immediate'|'concurrent'})`,
    forward; keep `'concurrent'` caller-selected since it throws on SqliteAdapter) — that is the fix the item
    names.
- Acceptance/DoD:
  1. For each item: either a cited line in the **installed** `dist` proving the fix, or a failing repro proving
     it is still open. No third outcome.
  2. If a gap is proven for `2d88fba7`, the widened signature ships with a test asserting a check-then-act write
     inside `transaction(fn, {mode:'immediate'})` is atomic under two processes.
  3. **Negative control (only if a fix is made):** revert the mode forwarding → the two-process atomicity test
     goes **red**. Record it.
- Tests: the existing regression specs; run against the **installed** versions. `2d88fba7`'s fix, if needed, is
  a prerequisite for the backlog v2 write layer's `immediate`-mode usage (SPEC-v2) — sequence it early.
- Dependencies: none. Cross-repo.
- Size/tier: S · executor hint: `debug` (sox).
- Risks/unknowns: source-vs-dist skew is the whole point — do not close on source alone. If `sox-graph-store`
  is already `0.11.0` in the backlog's tree, `2d88fba7` is a close-with-evidence; the wave-3a adoption is
  what pulls that bump in.
- Decision gates: none.

---

## Coordination map (disjointness)

| Surface | Owner | This domain does **not** touch |
|---|---|---|
| Deploy/re-cutover, bin/MCP re-point, publish | live/deploy architect (`LIVE-1…11`) | deploy mechanics of `2039bb80`/`87799e1d`; the `@adhd/sox-embedding-provider@0.4.1` re-point (EMBED-13 notes it only) |
| `2039bb80` + `87799e1d` implementation | **this domain** (EMBED-2, EMBED-4) | `LIVE-9` is a placeholder — do not duplicate |
| Issue→component linking from citations | `citation-component-linking` architect | the linker; EMBED-6 owns only the dedupe `{score,reasons}` seam |
| Registry surface redesign | `registry-surface-redesign` architect | `registry-surface-redesign.md` |
| CI workflow gating / affected-set blind spot | `LIVE-6` (`bb38c9f4`, `81de39f7`) | the workflow; EMBED-11 owns sox spec hermeticity only |
| `PLUGIN_ARCHITECTURE.md` / `RAG-SPEC.md` funnel text | `LIVE-8` | the doc rewrite; EMBED-8/9 own the code |
| `libs/data/embed/**` | **this domain** (EMBED-7…11) | — |
| `libs/memory-core/**` (embed/cluster) | **this domain** (EMBED-3, EMBED-14, EMBED-15) | — |
| `libs/data/store/store-adapter` (integrity, adapter-meta) | **this domain** (EMBED-3, EMBED-5) | — |

**Cross-repo note:** EMBED-3, 7, 8, 9, 10, 11, 13, 14, 15, 16 live in `sox-ecosystem` (`a1e8f31c`), not `adhd`.
They need the sox-ecosystem owner's dispatch. EMBED-1, 2, 4, 5, 6, 12 land in `entrypoint/backlog` (`adhd`).

## Inputs / gaps

- **All 23 domain uids retrieved live** via `adhd-backlog get` and read in full (`88b26235`, `87799e1d`,
  `1acbd738`, `2039bb80`, `1c9ed8da`, `56becdc4`, `72d980e5`, `348cc700`, `6f331a04`, `e0b9f977`, `d0767e15`,
  `5124be6c`, `c8d6ca86`, `e769bdc4`, `065b672f`, `3bdd1586`, `cd07303a`, `148acecb`, `9e3eb686`, `2d88fba7`,
  `e914fbf5`, `ceb75996`, `ac459719`). None is a bad uid.
- **In-repo verified paths:** `tools/etl/embed-backfill.ts:150` (`runEmbedBackfill`), `tools/etl/embed-backfill-cli.ts`,
  `tools/etl/embed-backfill.spec.ts`, `src/write/embed-drain.ts`, `src/store/embed-drain.spec.ts`,
  `src/store/embed-drain-real-model.spec.ts`, `src/api.semantic-production-seam.spec.ts`,
  `src/cli.ts` (`store-check`), `src/env.ts:119` (`admin(embedding_backfill)` prose). `src/store/semantic-search.ts`
  is **absent** from this worktree (the legacy seam was removed).
- `report/registry-surface-redesign.md` and `report/citation-component-linking.md` are **absent** from this
  worktree's `report/` (read from the main repo at `/Users/nix/dev/node/adhd/entrypoint/backlog/report/`);
  EMBED-6 is written to be independent of them.
- **`admin(embedding_backfill)` is likely dead prose** (SPEC-v2 §6.6 rejects the `admin` grab-bag;
  `registry-surface-redesign.md` §1 D4 confirms the v2 surface is the 14 mounted verbs). EMBED-1 must verify
  and, if absent, route the sweep through `tools/etl/embed-backfill.ts` + an explicit enable-path call — never
  a new mounted verb.
- **sox-ecosystem file paths in EMBED-3/7/8/9/10/11/13/14/15/16 are item-body-derived and could not be
  source-verified in this pass** (cross-repo; the dispatch brief forbids sox-repo access). Each packet names
  the verification step; treat the exact module/line as needing confirmation against the installed dist before
  dispatch.
