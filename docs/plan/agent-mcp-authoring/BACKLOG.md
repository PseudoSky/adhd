# agent-mcp-authoring — plan backlog

Findings from the 2026-07-08 reconciliation of this plan against the live
`sox-ecosystem` corpus at `/Users/nix/dev/ai/sox-ecosystem` (HEAD).

**Root cause (proven):** the plan's sox-consumption design (D5, added 2026-06-29)
was authored against sox-ecosystem's **package.json `sox.concerns` documentation**,
not against its **source**. Where the two disagree, the plan followed the docs.
Three of the four load-bearing API claims are contradicted by the code.

---

## Blockers — plan cannot execute as written

### AMA-001 — `type:'hash'` embedding provider does not exist
- **Where:** `contexts/embedding-substrate.md` (Interface design, default config `{type:'hash', model:'hash-768', options:{dimensions:768}}`); `decisions.md` §D5; `contexts/_shared.md` §sox-ecosystem table.
- **Evidence:** `libs/data/embed/embedding-provider/src/index.ts:128-146` — `createEmbeddingProvider` switches on `'fastembed'` and `'remote'` only; every other value hits `default:` and throws `ResolutionError("Unknown embedding provider type: ... (expected 'fastembed' or 'remote')")`. No hash provider file, class, or branch exists in `src/` (`cache.ts embedWorker.ts embedding-provider.spec.ts fastembed.ts index.ts remote.ts`).
- **Impact:** `embedding-substrate`'s default config throws at factory time. The package's own invariant is *"createEmbeddingProvider() THROWS ResolutionError … never silently downgrades to hash"*, so this fails loudly on the state's first test. `[embedding-substrate.1]` (determinism across process restarts) and `inv:enrichment-deterministic` (idempotent re-define) both rest on this provider. **The plan's entire CI-determinism strategy has no implementation behind it.**
- **Note:** `embedding-provider/package.json` `sox.concerns` claims *"deterministic hash provider as first-class alternative"* — stale documentation in sox-ecosystem, not code. This is the proximate cause of the plan's error.
- **Closest real substitute:** `@adhd/sox-memory-core` exports `DeterministicTestProvider` + `featureHashEmbed` (`libs/memory-core/src/index.ts:140`, impl `embed-test-provider.ts`): 768-dim, L2-normalised, djb2 feature hashing, implements `EmbeddingProvider`. But its header reads *"TEST-ONLY … NOT for production — no ONNX, no I/O"*, its `modelId` is `test-feature-hash-768` (not `hash-768`), and it lives in `memory-core`, not `embedding-provider`.
- **Status:** OPEN — hard blocker on `embedding-substrate`, `enrichment-pipeline`, `discovery-tools`.

### AMA-002 — `extractiveSummary` is not exported by `@adhd/sox-ingest`
- **Where:** `contexts/enrichment-pipeline.md` — `import { extractiveSummary } from '@adhd/sox-ingest'` appears in **two** declared modules (`enrich/enrich-component.ts`, `enrich/summarize.ts`).
- **Evidence:** `libs/data/ingest/ingest/src/index.ts:78` — `function extractiveSummary(content, maxSentences)` is declared **without `export`**; it is module-private, called only internally by `ingest()` at line 186. The package's public surface is `hexSha256`, `splitIntoChunksSentence`, `ingest`, plus the chunker-registry family.
- **Impact:** both declared modules fail to compile. `[enrichment-pipeline.2]` tests a function that cannot be imported.
- **Correct routes:** (a) `ingest(content, { summaryMaxSentences: N })` → returns `{ contentHash, summary, tags, chunks? }` — this *also* supplies the SHA-256 content hash the plan's idempotence check needs (step 1) and free deterministic tags; or (b) `import { extractiveSummary } from '@adhd/sox-memory-core'` (`libs/memory-core/src/index.ts:198`), a 6-line wrapper: `content.length < 100 ? content : ingest(content, {summaryMaxSentences:2}).summary`.
- **Note:** the plan's behavioural claim *"lead-N sentences"* is **correct** — the impl is `sentences.slice(0, maxSentences)`. It is `ingest/package.json`'s `sox.concerns` ("sentence-scoring") that is inaccurate. `[enrichment-pipeline.2]`'s *"content < 100 chars returns as-is"* describes memory-core's wrapper exactly.
- **Status:** OPEN.

### AMA-003 — `createEmbeddingProvider` is async; plan declares a sync wrapper
- **Where:** `contexts/embedding-substrate.md` — `export function createRegistryEmbedder(config?): EmbeddingProvider`.
- **Evidence:** `embedding-provider/src/index.ts:128` — `export async function createEmbeddingProvider(config): Promise<EmbeddingProvider>`.
- **Impact:** the declared wrapper signature is unimplementable; must be `Promise<EmbeddingProvider>`. Cascades into `seedAnchors` and every call site.
- **Status:** OPEN.

### AMA-004 — no npm path exists for any required sox package
- **Evidence (npm registry, 2026-07-08):** `@adhd/sox-memory-core@0.2.1` is the **only** published package. `sox-embedding-provider`, `sox-vector-store`, `sox-ingest`, `sox-analysis`, `sox-graph-store`, `sox-hybrid-search`, `sox-task-queue`, `sox-blob-store`, `sox-claim-verification` → **all 404**.
- **The published `memory-core@0.2.1` is a different architecture from HEAD:** its dist contains **0** occurrences of `extractiveSummary`, and it depends on `@adhd/sox-memory-enrich@1.1.0` — a package published to npm but **absent from the current workspace**. HEAD `memory-core@0.3.0` instead depends on six `workspace:*` packages (`analysis`, `embedding-provider`, `graph-store`, `hybrid-search`, `ingest`, `vector-store`).
- **`workspace:*` is not resolvable by the consumer.** Empirically verified in an isolated scratch repo: `npm install` inside a package declaring `workspace:*` → `npm error code EUNSUPPORTEDPROTOCOL / Unsupported URL Type "workspace:": workspace:*`. Via a `file:` dep, top-level `npm install` misleadingly **exits 0** (npm symlinks without recursing) but the module is never materialised — `require.resolve('@adhd/sox-analysis')` → `MODULE_NOT_FOUND`, and `npm ls --all` reports `UNMET DEPENDENCY @adhd/sox-analysis@workspace:*` (`ELSPROBLEMS`). **`npm link` fails identically** — it only delays discovery.
- **Impact:** D5 **Option A (publish)** is blocked (needs 6 packages published, one of which is `private:true` by design); **Option B (npm link)** and **Option C (file: path)** are both proven broken while `workspace:*` remains in the producers' manifests.
- **Status:** OPEN — hard blocker on `embedding-substrate` state-start (`human-blockers.json:sox-package-publish`).

---

## Correctness defects in plan prose

### AMA-005 — `_shared.md` asserts all four data packages are `"private": false` (false)
- `@adhd/sox-ingest` is `private: true`, with the explicit invariant *"PRIVATE — never published to npm; **only the memory domain composer may call this package**."*
- `decisions.md` §D5 and `contexts/enrichment-pipeline.md` both state this **correctly**. `_shared.md` is the lone outlier — and it is the file compiled into **every** executor work-order.
- **Deeper architectural conflict:** the plan has `@adhd/agent-registry` (not the memory domain composer) importing `sox-ingest` directly, which violates that package's stated invariant. Needs a sox-ecosystem **owner decision**, not a plan edit.
- **Status:** OPEN.

### AMA-006 — `embedding-substrate.md` contradicts itself on publish status
- Line ~152 (Notes): *"`@adhd/sox-embedding-provider` and `@adhd/sox-vector-store` are NOT on npm."* Line ~174: *"the vector store is already published and tested in the sox-ecosystem."* Both in the same file. The second is false.
- **Status:** OPEN.

### AMA-007 — wrong relative path in D5 Option C and `_shared.md`
- Plan writes `file:../sox-ecosystem/libs/data/embed/embedding-provider`. From `/Users/nix/dev/node/adhd`, `../sox-ecosystem` resolves to `/Users/nix/dev/node/sox-ecosystem`, **which does not exist**. sox-ecosystem is at `/Users/nix/dev/ai/sox-ecosystem`; the correct prefix is `../../ai/sox-ecosystem/`. The sub-paths after the repo root are correct.
- **Status:** OPEN.

### AMA-008 — `human-blockers.json:sox-package-publish` verification is unsatisfiable and mis-scoped
- Verification runs `require('@adhd/sox-embedding-provider')` etc. These packages are ESM (`"type":"module"`, `exports.import`); `require()` is the wrong probe. It also requires `@adhd/sox-ingest` to resolve — which, under D5 Option A, can never happen. It omits `@adhd/sox-analysis` from the probe despite listing it as required.
- **Status:** OPEN.

---

## Staleness / drift

### AMA-009 — plan is unaware of packages that now carry its requirements
- `@adhd/sox-hybrid-search@0.1.0` — listed in D5 as *"optional"* and **omitted entirely from the `_shared.md` table**. It fuses FTS5 text score + vector kNN with normalize-before-fuse (`min_max`/`L2`/`z_score`), degrades gracefully to a single signal, and returns `NodeRecord` fields. `discovery-tools`' `component_search` ("semantic, not substring") is a textbook hybrid-retrieval use case; raw `VectorBackend.knn()` returns only `{id, score}` — no fields to render a capability card, and no keyword channel.
- Entirely unknown to the plan: `@adhd/sox-graph-store`, `@adhd/sox-task-queue`, `@adhd/sox-blob-store`, `@adhd/sox-claim-verification`.
- `memory-core` HEAD is `0.3.0`; the plan records `0.2.1`.
- **Ownership correction:** `sox-analysis` owns the near-dup / importance / clustering **algorithms** (`detectNearDupPairs`, `scoreImportance`, `cluster`); `sox-ingest` owns summarisation/hashing/chunking. `memory-core` owns **none** of the core math — it is DB wiring + determinism glue that imports both.
- **Status:** OPEN.

### AMA-010 — consuming these packages breaks `platform:shared` purity
- `@adhd/sox-embedding-provider` deps: `@huggingface/transformers ^4.2.0`, `fastembed ^2.1.0`. `@adhd/sox-vector-store` deps: `@lancedb/lancedb 0.31.0`, `apache-arrow 18.1.0`, `synckit 0.11.13`, `better-sqlite3`, `sqlite-vec`.
- `embedding-substrate.md` (Notes) argues the registry "remains `platform:shared` since `better-sqlite3` and `sqlite-vec` are already deps" — it accounts for neither `@huggingface/transformers` nor `@lancedb/lancedb`/`apache-arrow`. Per `CLAUDE.md` §2, `platform:shared` must be *"safe to run in both a Node CLI and a Browser window"*; these are node-native.
- With `type:'hash'` gone (AMA-001), the ONNX/transformers path is no longer optional — it becomes the only non-remote provider.
- **Status:** OPEN — architecture decision required.

---

## Plan hygiene (gap-check / tiering)

### AMA-011 — `gap-check.js` FAILs: 4 acceptance criteria have no audit check
- `[embedding-substrate.2]`, `[embedding-substrate.3]`, `[enrichment-pipeline.2]`, `[enrichment-pipeline.3]` have **no matching check ID in any audit script**. These are exactly the four sox-consuming criteria — the ones most in need of teeth. They are currently unenforced.
- **Status:** OPEN.

### AMA-012 — vendored `run-audit.js` is stale
- `scripts/run-audit.js` stamp `workflow@0.8.23+1e4130a84aed` ≠ installed `workflow@0.8.25+961c3053dfab`. Re-vendor so the audit runs current criteria semantics (`audit_at_wrong_ref`-class drift). Note `state.json.schema_version = 2` **is current** for 0.8.25 — this is a re-vendor, **not** a schema migration.
- **Status:** OPEN.

### AMA-013 — all 13 states unrated (no `model` / `effort`)
- `dag.json` nodes carry no tier annotation; the orchestrator cannot honour a declared tier and would have to invent one (wrong-tier = token defect; over-tier = cost defect).
- **Status:** OPEN.

---

## Upstream (sox-ecosystem) defects discovered

### SOX-DOC-001 — `embedding-provider/package.json` documents a provider that does not exist
- `sox.concerns` claims *"deterministic hash provider as first-class alternative"*; `createEmbeddingProvider` implements no such branch. This stale doc is the direct cause of AMA-001.

### SOX-DOC-002 — `ingest/package.json` mis-describes its summariser
- `sox.concerns` says *"extractive summary (sentence-scoring …)"*; the implementation (`src/index.ts:78`) is `sentences.slice(0, maxSentences)` — plain **lead-N**, no scoring. (`extractTags` *is* frequency-scored; the two appear conflated.)

### SOX-PKG-001 — `memory-core@0.3.0` is unpublishable as written
- It declares six `workspace:*` deps, one of which (`sox-ingest`) is `private: true` by design. `changeset publish` would either skip it or emit a manifest with unresolvable deps. The published `0.2.1` still points at `@adhd/sox-memory-enrich@1.1.0`, an architecture no longer present in the workspace.

---

## Post-repair findings (2026-07-08, orchestrator verification pass)

The repair cleared AMA-001..015 (`gap-check` PASSED 0 gaps, `env-pin-check --strict`
all 13 pinned, `integrity-check` clean, `run-audit.js` re-vendored to
`workflow@0.8.25+961c3053dfab`). Verified state-side, not from the repair report.
Two defects survive.

### AMA-016 — `versioning` state has a no-op guard AND an already-green criterion
- **Where:** `dag.json` → `nodes.versioning.guard` = `npx --yes nx build agent-mcp`; `scripts/criteria.json` → `versioning.1` = `present "version": "2\.` in `entrypoint/agent-mcp/package.json`.
- **Evidence:** `entrypoint/agent-mcp/package.json` is **already `2.0.0`** on `main`. The pattern matches today. `nx build agent-mcp` is likewise already green.
- **Impact:** the guard can never go red→green, and `versioning.1` passes **before the state performs any work**. `versioning` can be marked complete having done nothing. This is the identical failure mode already logged as `ENV-PLAN-001`, and it violates the repo rule *"never mark a task complete on proxy evidence."*
- **Note:** the repair report called this "not a defect, just recorded." It is a defect.
- **Fix direction:** either retire `versioning` (the bump already landed) or re-point it at the real remaining deliverable — a CHANGELOG entry + a `nx release` dry-run asserting the 2.0.0 breaking-change notes exist — and confirm the guard is RED at plan start.
- **Status:** OPEN

### AMA-017 — `criteria.json` declares three criteria per state with one identical command
- **Where:** `scripts/criteria.json`
- **Evidence:** `embedding-substrate.1`, `.2`, `.3` all carry the byte-identical `cmd` (`nx test agent-store-prompts --testFile=.../embedding-substrate.test.ts`, `expect: exit0`). Same for `enrichment-pipeline.1/.2/.3`. (`component-define.1 == component-define.2` is a pre-existing instance.) `gap-check` passes because it only verifies a check **ID exists**, not that it discriminates.
- **Mitigating fact (verified):** the real discrimination DOES exist — `audit_authoring.py` emits `embedding-substrate.2.tooth`, `.3.tooth`, `enrichment-pipeline.2.tooth`, `.3.tooth`, and they fail red today with e.g. `pattern not found: openVectorStore|knn|bge-base-en-v1.5`. The `audit-final` guard runs that script, so the teeth are enforced by the actual gate. They are simply absent from `criteria.json` (which `run-audit.js` reads), producing a declaration/implementation asymmetry.
- **Residual risk:** the `.tooth` checks are **grep-based** — they assert the test file *mentions* `reopen|idempotent|trim`, not that its assertions have teeth. A vacuous test passes both the command check and the grep tooth. Per repo rule §6.2, the executor must prove each behavioural assertion FAILS when the fix is reverted (negative control), not merely that the string appears.
- **Fix direction:** give `.2`/`.3` distinct `cmd`s (e.g. `--testNamePattern`), and/or declare the `.tooth` entries in `criteria.json` so both runners agree.
- **Status:** OPEN

---

## Second correction pass (2026-07-08) — plan re-read against the real fastembed code

The first repair swapped `type:'hash'` → `type:'fastembed'` correctly, but described
the fastembed provider from its **interface + `sox.concerns`**, not its implementation.
Re-verified against `libs/data/embed/embedding-provider/src/{index,fastembed,embedWorker,remote}.ts`
and confirmed empirically by constructing `FastembedProvider` from its built `dist/`.

### AMA-018 — FIXED: plan told the executor to pass a `FileSystemModelCache`
- `contexts/embedding-substrate.md`, `decisions.md`, `contexts/_shared.md` all instructed the executor to "pass a `FileSystemModelCache`" for CI model caching.
- **`FileSystemModelCache` is never used by `createEmbeddingProvider` or `FastembedProvider`.** It appears only as a re-export (`index.ts:124`); the `ModelCache` interface (`index.ts:111-120`) has no implementation wired into any code path. Verified by grep across `src/`.
- Reality: the factory resolves a **`cacheDir` string** — `config.options.cacheDir` → `SOX_EMBED_CACHE_DIR` → `$XDG_CACHE_HOME/sox/models` → `~/.cache/sox/models` (`index.ts:162-165`) — and the worker calls `FlagEmbedding.init({model, cacheDir, showDownloadProgress:false})` after `fs.mkdirSync` (`embedWorker.ts:138-160`).
- **Status:** FIXED in all three files.

### AMA-019 — FIXED: plan omitted that the factory eagerly downloads + warms the model
- `createFastembedProvider` `await`s `provider.embedSingle('warmup')` **before returning** (`index.ts:167-174`). Constructing the embedder downloads a ~110M-param ONNX model and runs an inference.
- Consequence the plan never stated: a `beforeEach` that builds a provider re-runs warmup per test. Must build once (module scope / `beforeAll`).
- **Nested, conflicting timeouts:** the outer warmup wrapper defaults to **180 000 ms** (`index.ts:204-207`) but the worker-init promise is bounded at **60 000 ms** (`fastembed.ts:102-105`). Both read `SOX_EMBED_WARMUP_TIMEOUT_MS`. The **inner 60 s** is what a cold download must beat → `Fastembed worker init timed out after 60000ms`.
- **Status:** FIXED — documented in a new "Real-provider behaviour" table.

### AMA-020 — FIXED: `isDeterministic === false` was never stated as the provider's own contract
- Empirically confirmed: `new FastembedProvider('bge-base-en-v1.5',768,…).metadata` → `{"isDeterministic":false,…}`. `RemoteProvider` likewise (`remote.ts:21`).
- The plan's content-hash gating decision was right, but justified as a hedge ("raw output need not be bit-identical") rather than as the provider's declared contract. A test asserting two `embedSingle` calls return identical vectors would be asserting something the provider explicitly does not promise.
- **Status:** FIXED.

### AMA-021 — FIXED: behaviours that change how the test must be written
All now recorded in `embedding-substrate.md`:
- **`warmUp()` is a no-op** on both providers (`fastembed.ts:229-234`, `remote.ts:78-80`).
- **`role` is ignored** by `FastembedProvider.embedSingle(text, _role?)` (`fastembed.ts:163`) — no asymmetric document/query encoding.
- **Vectors are L2-normalised** on every path (`toFloat32Normalised`, `meanPool` re-normalises) → `cosine` ≡ dot product.
- **Chunk-then-mean-pool, no truncation:** `estimateTokens = ceil(len/4)`, `maxTokens = 512` → content over ~2048 chars is split on whitespace, embedded per chunk, mean-pooled, re-normalised. Real component bodies exceed this, so it is the **normal** path. `[embedding-substrate.1]`'s fixture must use realistic-length content.
- **ONNX runs in a worker thread** (`worker.unref()`), specifically so `onnxruntime-node` never shares a thread with `better-sqlite3` + `sqlite-vec` — which `@adhd/agent-store-prompts` uses. Gate the test on exit code, never stdout.
- **Network dependency:** the `embedding-substrate` guard now downloads a model on a cold cache. Per the repo's "live testing is mandatory" rule this does NOT qualify for an env-flag gate; it must fail loudly, never self-skip.
- **Status:** FIXED.

---

## Upstream (sox-ecosystem) defects discovered in this pass

### SOX-BUG-001 — `embedding-provider`: nested warmup timeouts disagree, and the outer one is dead
- `index.ts:204-207` → `warmupTimeoutMs()` defaults **180 000**; `fastembed.ts:102-105` → same-named local defaults **60 000**. Both read `SOX_EMBED_WARMUP_TIMEOUT_MS`. Because worker init is bounded by the inner 60 s, the outer 180 s can never be the effective limit for a cold model download. A user setting `SOX_EMBED_WARMUP_TIMEOUT_MS` unknowingly moves both.

### SOX-BUG-002 — `embedding-provider`: `ModelCache` / `FileSystemModelCache` is dead API surface
- The `ModelCache` interface and `FileSystemModelCache` class are exported but referenced by no factory or provider. Callers who follow the type surface (as this plan did) write code that has no effect.

### SOX-BUG-003 — `embedding-provider`: `warmUp()` is unreachable-by-design on every provider
- Invariant says *"warmUp() is a no-op when `isDeterministic === false`"*. Both `FastembedProvider` and `RemoteProvider` hard-code `isDeterministic: false`, and `type:'hash'` (the only deterministic provider) was removed. Therefore `warmUp()` is a no-op on **every** code path, while `sox.concerns` still advertises *"warmUp cache for hot/topic texts."*

### SOX-DOC-003 — `embedding-provider`: `sox.concerns` claims asymmetric role encoding that is not implemented
- *"asymmetric encoding via role param (document | query)"* — `FastembedProvider.embedSingle(text, _role?)` ignores the parameter entirely.

### SOX-DOC-004 — `embedding-provider`: `FastEmbedPoolConfig.batchSizes` doc says "overrides the default 32"
- Actual `DEFAULT_BATCH_SIZE = 256` (`fastembed.ts:100`, confirmed at runtime). `FastEmbedPoolConfig` is itself unused by the factory.


---

## Architect specs — agent-mcp-authoring audit items (2026-07-11)

Scope: `AMA-001`…`AMA-021`, `BUG-ORCH-001`, `BUG-ORCH-002`, `BUILD-ANY-001`, `BUILD-ANY-002`,
`SEC-001`, `SEC-002`, `ENV-SEC-001`, `ENV-SEC-002`, `ENV-SEC-003`. Every ID above was
triaged; only two are genuinely OPEN and spec-worthy (the credential leaks). All AMA-*
items, including the two (`AMA-016`, `AMA-017`) whose BACKLOG.md status line still reads
"OPEN", were independently re-verified against the live plan files
(`docs/plan/agent-mcp-authoring/{dag,scripts/criteria}.json`, `contexts/_shared.md`,
`human-blockers.json`) and found already remediated — see Regression guards below.

---

### Spec: ENV-SEC-001 (dup: SEC-001) — FontAwesome Pro npm `_authToken` hardcoded and pushed to a PUBLIC repo

**Status.** Open (CRITICAL). **Owner action required: yes — token rotation is a human action** (fontawesome.com account access); no code change can substitute for it.

**Problem.** A live-shaped FontAwesome Pro npm `_authToken` was committed as a literal value (not `${VAR}`) to `.github/scripts/setup-npmrc.sh`, executed by two CI workflows. The credential reached `origin/main` of `github.com/PseudoSky/adhd`, a **PUBLIC** repository, and — per the second correction in `BACKLOG.md` — is served in the file's content on the default branch's current tip today (the local fix commit was never pushed, 226 commits ahead of `origin/main` at time of discovery). Must be treated as harvested.

**Evidence.** `BACKLOG.md` §ENV-SEC-001 (lines 853–861) and §"SEC-001 — SECOND CORRECTION" (lines 1047–1082); `.github/scripts/setup-npmrc.sh:6` (historical, now fixed in the local working tree — verified by `Read`, file now reads `: "${FONTAWESOME_TOKEN:?…}"` with no literal). Introduced `18d980b3`, still present at `faaddc56` (on `origin/main`), fix commit `48ab824f` (local-only, unpushed at audit time). No secret value is reproduced here.

**Remediation design.**
1. **Rotate/revoke at the provider now.** fontawesome.com → Account → Tokens → revoke the exposed token, issue a new one. This is the only step that closes the exposure — deleting the line from git does not un-expose a value already fetched by anyone who cloned the public repo.
2. **Invalidate the old one** as part of step 1 (revocation and issuance are typically the same action at FontAwesome).
3. **History scrubbing — recommendation: not required, optional hygiene.** The repo is public and the secret has been publicly readable since 2026-05-15 (`18d980b3`); rotation alone makes the exposed value worthless going forward, which is what actually stops the risk. A `git filter-repo --replace-text` + force-push rewrites every SHA in a repo other agents and worktrees are actively using, forces every clone to re-clone, and buys no additional safety once rotation has happened — the value is already public and assumed harvested regardless of whether it stays in history. Recommend: **rotate now, defer/skip history rewrite** unless there is an external audit/compliance requirement to prove the string is gone (in which case do it only after rotation, coordinated as a scheduled maintenance event).
4. **Prevention — already landed and confirmed in place:** the working tree now reads `FONTAWESOME_TOKEN` from env behind a `: "${FONTAWESOME_TOKEN:?...}"` guard (`setup-npmrc.sh:18`) with `umask 077` on the written `.npmrc`; a native `adhd-npmrc-auth-token` gitleaks rule was added (`.gitleaks.toml:30`) and a matching `npmrc-auth-token` JS rule exists in `.githooks/check-no-credentials.js:121`. The pre-commit hook (`--staged`) blocks a re-introduction in any new commit; the `secret-scan` CI job (`.github/workflows/pull-request.yml:14-54`, gitleaks pinned to `8.30.1` with a checked-in sha256, `SECRET_SCAN_REQUIRE_GITLEAKS=1` hard-fails if the scanner can't run) blocks it again on every PR via `--range base head`. **Coverage caveat verified by reading the workflow:** the CI job runs `--range`, i.e. it scans only the PR's new commits — it does NOT re-scan full history on every run, so it would not itself have caught this leak retroactively; that requires a manual `--all` pass (already run once for this audit). This is correct and sufficient as an ongoing prevention mechanism; it is not a substitute for the one-time `--all` sweep already performed.

**Acceptance criteria.**
- FontAwesome dashboard shows the old token state = revoked, and a new token exists, before the next scheduled CI run that consumes `FONTAWESOME_TOKEN`.
- `FONTAWESOME_TOKEN` is set as a GitHub Actions repo secret; `setup-npmrc.sh` run in CI succeeds with it set and fails loudly (`:?` guard) with it unset — prove both by running `.github/workflows/publish-embed-cdn.yml` and `build-docker.yml` once each post-rotation.
- Negative control: stage a file containing a synthetic FontAwesome-shaped token literal (`//npm.fontawesome.com/:_authToken=<36-char-uuid-shape>`, not the real value) and confirm `node .githooks/check-no-credentials.js --staged` exits non-zero, rejecting the commit.
- `git push` of the local `48ab824f` fix (or an equivalent commit) to `origin/main`, then re-verify `git show origin/main:.github/scripts/setup-npmrc.sh` no longer contains a literal token — closes the "served at the tip" exposure independent of history rewrite.
- `gitleaks git --config .gitleaks.toml --all` re-run post-rotation still finds the historical hits (expected — rotation doesn't remove history) but the finding is now informational, not actionable.

**Effort / risk.** Rotation: minutes, human-only, zero code risk. Pushing the already-written fix: trivial, low risk (single-line diff, already verified locally). History rewrite (if elected later): high coordination cost (force-push, every clone/worktree must re-clone, breaks any open PRs referencing old SHAs) — correctly deferred.

---

### Spec: ENV-SEC-002 (dup: SEC-002) — `nxCloudAccessToken` committed to `nx.json`, read-write scope

**Status.** Open (CRITICAL). **Owner action required: yes — token rotation is a human action** (nx.app dashboard access); no code change can substitute for it.

**Problem.** An Nx Cloud access token with **read-write** scope (confirmed by decoding the token's base64 trailing segment: `|read-write`) was committed to `nx.json` from the repository's very first commit (`87aac2a3`, 2024-05-04) and remained on `origin/main` for **765 days** before removal (`ce425400`, 2026-06-08). A write-scoped cache token lets an attacker poison remote-cache build artifacts served to every developer and CI run that trusts the cache — a supply-chain risk, not just a read leak. Repo is PUBLIC.

**Evidence.** `BACKLOG.md` §ENV-SEC-002 (lines 863–868) and §"SEC-002 — Nx Cloud token: authoritative timeline" (lines 1017–1045). Value confirmed byte-identical (SHA-256 match) across `87aac2a3`, `a41c2acf`, `51fb123a~1`, `faaddc56`, `ce425400~1` — one credential, the whole exposure window. Note: an earlier claimed removal (`51fb123a`) never actually reached `main` (`git merge-base --is-ancestor 51fb123a HEAD` = false) — verifying removal against local `HEAD`/working tree instead of the *pushed* branch produced a false "fixed" read once already; do not repeat that mistake when confirming this rotation. `nx.json` in the current working tree has zero occurrences (verified via `grep -n "nxCloudAccessToken" nx.json` → no match).

**Remediation design.**
1. **Rotate/revoke at the provider now.** nx.app → workspace → Access Tokens → revoke the exposed read-write token, issue a new one scoped as narrowly as the workflow allows (read-only if write access isn't actually needed by CI).
2. **Invalidate the old one** as part of revocation.
3. **History scrubbing — same recommendation as ENV-SEC-001: optional, not required.** `origin/main`'s current tip is already clean (the value was fully removed from the branch by `ce425400`); only historical commits carry it. Because the value is already public (765 days exposed) and CI no longer references Nx Cloud at all per `ce425400`'s message ("remove all nx cloud references"), rotation fully closes the risk without needing a rewrite. Recommend: **rotate, then optionally batch this scrub together with the ENV-SEC-001 history rewrite if one is ever elected** (single force-push event, don't do two separate ones).
4. **Prevention — already landed and confirmed in place:** a native `nx-cloud-access-token` rule exists in `.githooks/check-no-credentials.js:127`, enforced by the same pre-commit hook + `secret-scan` CI job described under ENV-SEC-001 (`.github/workflows/pull-request.yml`). Same `--range`-only coverage caveat applies (new commits only; the one-time `--all` sweep already found this).

**Acceptance criteria.**
- Nx Cloud dashboard shows the old token revoked and a replacement issued (or confirms Nx Cloud remains fully disabled per `ce425400`, in which case "rotation" = confirming no live token exists anywhere reachable, and documenting that CI does not need one).
- Confirm no unexpected cache writes occurred during the exposure window (nx.app audit log, if retained) — document the check even if the log has since rolled off.
- `nx.json` in the working tree and on `origin/main` both remain free of `nxCloudAccessToken` (already true — verify it stays true post-rotation, since rotation itself should never require re-adding the value to a tracked file; use `NX_CLOUD_ACCESS_TOKEN` env var only).
- Negative control: stage an `nx.json` edit adding a synthetic `"nxCloudAccessToken": "<64-char-base64-shape>"` value and confirm `node .githooks/check-no-credentials.js --staged` exits non-zero.
- `gitleaks git --config .gitleaks.toml --all` re-run post-rotation still finds the two historical introduction commits (expected, informational only).

**Effort / risk.** Rotation: minutes, human-only, zero code risk (the working tree already doesn't use the token — `ce425400` disabled Nx Cloud entirely, so there's no downstream config to update). History rewrite: same deferred-hygiene tradeoff as ENV-SEC-001; batch the two if ever done.

---

### Note on ENV-SEC-003 (INFO, no full spec — not open in the actionable sense)

`ENV-SEC-003` documents 2 gitleaks findings confirmed as false positives: an OAuth **client id**
(`packages/ai/agent-mcp/src/providers/anthropic.ts` — a public identifier by design, not a
secret) and a `curl` doc example with no credential (`packages/ai/agent-mcp/INSTALL.md`). Both
paths (`packages/ai/agent-mcp/...`) no longer exist post-rename, and both patterns are already
allowlisted in `.gitleaks.toml:87` (`OAUTH_CLIENT_ID\s*=\s*["'][0-9a-f-]{36}["']`) — verified by
`Read`. No remediation action required; this closes the "6 further gitleaks findings" tail of
SEC-002 alongside the two real credentials above (3 of the 6 were duplicate/history-only hits on
the same two real secrets, already covered by the specs above; the remaining 2 are these
allowlisted false positives — 2 + 1 dup mentioned in SEC-002's own accounting + 3 covered = 6).

---

### Regression guards (FIXED items)

- **AMA-001** (`type:'hash'` provider doesn't exist) — guarded by `embedding-substrate.1` test (`nx test agent-store-prompts --testFile=embedding-substrate.test.ts`) plus sox-side smoke test confirming `type:'hash'` still throws `ResolutionError`; plan repaired to `type:'fastembed'`.
- **AMA-002** (`extractiveSummary` not exported) — guarded by `enrichment-pipeline.2` + `.2.tooth` (pattern `ingest|summary|100|trim` in `enrichment-pipeline.test.ts`, `scripts/criteria.json:101-118`); plan repointed to `ingest()`/`@adhd/sox-memory-core`.
- **AMA-003** (async factory declared sync) — guarded by `nx build agent-store-prompts` (a `Promise<EmbeddingProvider>` mismatch fails type-check); `embedding-substrate.1` exit0.
- **AMA-004** (no resolvable npm path for sox packages) — guarded by `human-blockers.json:sox-package-publish` verification, now using dynamic `import()` (ESM-correct) instead of `require()`; 3 of 5 packages independently confirmed published+installable via fresh-dir probe (2026-07-09).
- **AMA-005** (`sox-ingest` falsely documented `private:false`) — resolved upstream, commit `f4897aa`; guarded by the same `sox-package-publish` verification's `private === false` check.
- **AMA-006** (self-contradicting publish-status prose) — corrected in `contexts/embedding-substrate.md` during post-repair pass; guarded by `gap-check` (0 gaps).
- **AMA-007** (wrong relative path to sox-ecosystem) — corrected in D5/`_shared.md`; guarded by `env-pin-check --strict` (all 13 pinned, post-repair pass).
- **AMA-008** (unsatisfiable `require()`-based verification) — fixed alongside AMA-004 (dynamic `import()`); guarded by `integrity-check` (clean, post-repair pass).
- **AMA-009** (plan unaware of `sox-hybrid-search` et al.) — `_shared.md` table now lists 5 required packages incl. `sox-hybrid-search`/`sox-graph-store` (verified by `Read`, lines 40-50); guarded by `gap-check` (0 gaps).
- **AMA-010** (platform:shared purity concern) — downgraded to a prose-only fix once `agent-store-prompts` was confirmed already tagged `platform:node` (`project.json`); no re-tag needed.
- **AMA-011** (4 criteria had no audit check) — guarded by `gap-check` PASSED 0 gaps (post-repair verification, 2026-07-08).
- **AMA-012** (stale `run-audit.js` vendor stamp) — re-vendored to `workflow@0.8.25+961c3053dfab`; guarded by the stamp check itself.
- **AMA-013** (13 states unrated, no tier) — confirmed fixed by direct read of `dag.json`: `versioning` node now carries `"model":"haiku","effort":"easy"`.
- **AMA-014** (plan targeted deleted `packages/ai/agent-registry`) — confirmed fixed by direct read of `_shared.md:6-15` (package-identity correction block) and `scripts/criteria.json` (guards now target `agent-store-prompts` / `packages/agent/agent-store-prompts/...`).
- **AMA-015** (stale `_shared.md` env invariants: wrong workflow pin, dead worktree path) — confirmed fixed by direct read: `_shared.md:156-160` now pins `workflow/0.8.25` and points `.mcp.json` at `dist/entrypoint/agent-mcp/src/index.js`.
- **AMA-016** (`versioning` guard was a no-op / already-green criterion) — confirmed fixed by direct read of `dag.json`: guard now AND-chains `nx build` + `CHANGELOG.md` existence + a `2.0.0` heading + a `systemPrompt` mention, and `versioning.1.tooth` (`scripts/criteria.json:192-201`) additionally requires the permanent-compat-shim promise text. Verified genuinely RED today (`entrypoint/agent-mcp/CHANGELOG.md` does not yet exist). *(BACKLOG.md's own status line still reads "OPEN" — stale; the fix is live in `dag.json`/`criteria.json`.)*
- **AMA-017** (3 identical-`cmd` criteria per state, no discrimination) — confirmed fixed by direct read of `scripts/criteria.json`: `embedding-substrate.2/.3`, `enrichment-pipeline.2/.3`, and `component-define.2` each now have a paired `.tooth`/`.tool` criterion with a distinct grep pattern (lines 61-91, 109-139, 236-245), with explicit `(AMA-017)` provenance notes. *(BACKLOG.md's own status line still reads "OPEN" — stale; the fix is live in `criteria.json`.)*
- **AMA-018 / AMA-019 / AMA-020 / AMA-021** (fastembed described from interface, not implementation — `FileSystemModelCache`, eager warmup/timeouts, `isDeterministic` contract, ignored `role`/no-op `warmUp`/L2-norm/chunking) — all four documented as FIXED directly in `contexts/embedding-substrate.md`/`_shared.md`/`decisions.md`; guarded by `gap-check`, `env-pin-check --strict`, `integrity-check`, and a 6/6 architecture audit re-run.
- **BUG-ORCH-001** (`TS2451` redeclare broke `agent-engine-orchestrator`/`agent-mcp` build) — guarded by `nx build agent-engine-orchestrator` + `nx build agent-mcp` (both exit 0) and `nx test agent-engine-orchestrator` (49/49 at time of fix).
- **BUG-ORCH-002** (poisoned MCP client-cache on failed connect, no retry) — guarded by `src/__tests__/registry-connect-retry.test.ts`, a real-component test (no mocks of the unit under test) with a proven negative control (reverting the `.catch` eviction turns the retry assertion red); `nx test agent-engine-orchestrator` 53/53.
- **BUILD-ANY-001 / BUILD-ANY-002** (`any`→`unknown` sweep broke 5 builds) — fully closed via `BUG-LINT-ANY-002`'s completion pass; guarded by `nx build`/`nx test`/`nx lint` exit 0 across all five affected packages (`data-base-transforms` 104/104, `data-query-engine` 37/37, `data-core-structures` 1/1), with no `any` reintroduced (narrowing/generics only).

---

## AMA-D6-FLIP — remaining Option-A reconciliation (decision recorded in decisions.md §D6; artifacts still encode Option B) — Open (2026-07-11)

`decisions.md §D6` now carries the authoritative `⟲ FLIP` (Option B → A). The following artifacts still describe Option B and must be reconciled before the plan is gate-consistent. No `state.json` edits (no state executed; `schema_version` stays 2). Plan-builder made **no** edits (stopped in read phase) — working tree is clean except the D6 flip. Checklist (exact locations from the plan-builder read pass):

1. **`contexts/discovery-tools.md`** — invert retrieval-backend prose: goal para (~L12-20) and the two "Notes for executor" bullets (~L76-93; the bullet at ~L85-93 explicitly says "Do NOT wire SqliteSearchBackend / Option A rejected" and an "own FTS5 virtual table" bullet). Replace with: `component_define` writes a `kind:'component'` graph-store node keyed to `version_id`; `component_search` calls `SqliteSearchBackend(vec, graph).search(query)`; remove `component_fts`; add node↔version parity note. Preserve `[inv:no-slug-on-wire]`, bounded projection, nDCG@5 ≥ 0.70.
2. **`scripts/criteria.json`** — add two teeth mirrored to the .py: `discovery-tools.3.backend` (present `SqliteSearchBackend` in `component-search-ndcg.test.ts`) and `discovery-tools.3.parity` (present `parity` in same file); AND-chain `dod.2.tooth` with `grep -qE 'SqliteSearchBackend'` + `grep -qE 'parity'`.
3. **`scripts/audit_authoring.py`** — mirror the same two `grep_present` teeth (identical patterns/paths) and add the same conjuncts to `dod.2`/`dod.2.tooth` (AMA-017 symmetry: patterns/paths MUST match criteria.json exactly). Keep patterns simple (`SqliteSearchBackend`, `parity`) so JS RegExp (run-audit.js, whole-file) and `grep -rEq` (line-based) agree. gap-check Check 3 folds criteria.json IDs into auditIds — every new tooth ID must exist in criteria.json.
4. **`human-blockers.json:sox-package-publish`** — add graph-store enabling fixes as precondition: BL-295 (extensible `node.kind`), BL-293 (`createGraphBackend` applies schema/fails loudly), BL-294 (fusion degrade signal), BL-303 (drop drizzle), green across memory-core/analysis/hybrid-search. The 3 published packages (embedding-provider, vector-store, ingest) unchanged.
5. **`contexts/_shared.md`** — sox-package table D6 rows (~L49 hybrid-search "consume pure fusion (D6 Option B)"; ~L50 graph-store "transitive only / runtime NEVER loaded") → Option A (graph-store runtime IS loaded; SqliteSearchBackend used); update "deferred" line (~L71).
6. **`README.md`** — dod.2 (~L133-135): change "fused via hybrid-search's pure normalize()+fuse() / own channels" → Option-A `SqliteSearchBackend(vec, graph).search()`. Backend-agnostic parts (nDCG bar, golden set, negative control) stay.

**No change needed:** `contexts/live-model-e2e.md`, `contexts/composition-journey-e2e.md` (reference `component_search` at flow level only — verified).

**Gates to run after reconciliation:** `scripts/gap-check.js` (0 gaps), `scripts/env-pin-check.js --strict`, `scripts/integrity-check.js`, `scripts/run-audit.js` (+ `audit_authoring.py`), criteria.json validity. Fix artifacts (not gates) until green.
