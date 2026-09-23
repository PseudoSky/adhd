## 1.0.0 (Unreleased)

The first stable release. `@adhd/backlog` is a self-contained backlog system: one store, mounted live to a CLI, an MCP server, and an HTTP surface with zero duplicated logic across hosts. Every operation returns an outcome envelope — `{ok:true, data}` or `{ok:false, error:{code,message,details}}` — so a caller never has to guess whether a call succeeded from a thrown exception.

### 🚀 Features

- **backlog:** the application layer settles on 14 verbs — `get`, `query`, `lookup`, `create`, `update`, `transition`, `claim`, `relate`, `move`, `upsertProject`, `upsertComponent`, `upsertLocation`, `rmLocation`, `delete` — each mounted identically to CLI, MCP, and HTTP.
- **backlog:** `create` takes a flat `{ title, body, project, by }` input plus optional `component`, `kind`, `status`, `priority`, `citations`, `author`, `assignee`, and `duplicateAction` (`'abort' | 'force' | 'comment'`, default `'abort'`); a resolved `project` is required — `create` never mints one.
- **backlog:** `query` accepts a natural-language `text` that routes to semantic or keyword search, and pages results by `limit`/`after` with `hasMore`/`nextCursor`.
- **backlog:** on-write embeddings, with an audit row per write, back semantic search.
- **backlog:** citations are persisted on every item, and repo moves apply their rename plan in two passes so a rename can't cascade mid-write.
- **backlog:** `buildBacklogEnv` now accepts an explicit `namespace` option (`BuildBacklogEnvOptions.namespace`, defaulting to `'production'`), threaded through the CLI (`RunBacklogCliOpts`), `serve` (`RunServeCommandOpts`), and the server library (`StartOpts`) down to `EnvironmentOptions.namespace` — mirroring how `scope` already resolves via an explicit-parameter-first cascade. `backlogEnvironmentSpec.namespaces` declares three values, `['production', 'test', 'sandbox']` (added, `'production'` stays first — every existing caller that omits `namespace` is unaffected). Deliberately no `ADHD_BACKLOG_NAMESPACE` env var: namespace selection is explicit-parameter-only, so it can never be silently overridden by an ambient shell variable.
- **backlog:** a new CLI flag, `--namespace <value>` (SPEC.md §5c), recognized anywhere in argv (like `--help`), selects which declared namespace an invocation resolves under — `production` (default), `test` (a persisted, non-ephemeral store), or `sandbox`. `--namespace sandbox` layers ephemeral-root-minting on top of namespace selection: it mints a fresh throwaway `adhdRoot`, and writes a REAL `config.yaml` there with `embedding.enabled: false` on every invocation, before any config file layer is ever read (D8) — an isolated invocation's embeddings are now off DELIBERATELY, never as an accident of an empty directory (a stray pre-existing `config.yaml` at that path is overwritten, not silently honored). An unrecognized `--namespace` value is rejected before dispatch with the same `invalid_argument` envelope every other CLI failure uses, naming all three valid values and suggesting the nearest match on a near-miss typo. `sandbox-path`'s JSON payload reports `{adhdRoot, namespace, dbPath, embeddingEnabled}`.

### 🩹 Fixes

- **backlog:** the cutover ETL's component mint (`tools/etl/catalog-upsert.ts`'s `upsertComponentTx`) now writes the `owns_project` edge back to its project in the same transaction, matching real `upsertComponent`. Previously a minted component had no incoming `owns_project` edge, leaving it (and every issue under it) unreachable from a project→component→issue two-hop walk — found and root-caused during the cutover tooling's own proving run (SPEC.md §7a): 108 of 145 target components affected, 502 issues unreachable, 0 issues incorrectly written (status/kind/priority/citations/notes all matched).
- **backlog:** the ETL's hand-rolled `upsertProjectTx`/`upsertComponentTx` (`tools/etl/catalog-upsert.ts`) — a duplicate reimplementation of the real registry verbs' find-then-create logic, predating those verbs' existence — are gone. `src/write/catalog.ts`'s `upsertProject`/`upsertComponent` are now split into a transaction-PARTICIPANT core (`upsertProjectTx`/`upsertComponentTx`, taking the caller's own open `tx`) and a thin `executeWriteTransaction`-opening public wrapper, the same shape `claim.ts`/`transition.ts` already use; the ETL's `catalog-upsert.ts` is now a thin adapter that calls the real `*Tx` cores (re-fetching `rowid` via `getNodeByUidTx`, since neither outcome type carries it) instead of hand-rolling the SQL. This closes the exact duplication class that caused the `owns_project`-edge bug above — a future divergence between the two registry verbs and the ETL's own copy is no longer possible, because there is only one copy. Re-proven: an 1788-item re-run against the current corpus into a fresh target reproduces all four parity comparisons clean, including the `owns_project` reachability walk.
- **backlog:** editing an issue's body no longer discards the rest of its graph. The supersede path carried exactly five edges onto the successor — the set the issue CARD reads — so a single body edit silently detached the issue's blockers, dependencies, notes, citations, transitions and entire audit trail. Every remaining edge is now carried forward in both directions, since an issue is the source of some relations and the target of others.
- **backlog:** a burndown no longer inflates after an edit. The open-curve view counted every row alive at a sampled instant, so one logical issue appeared twice after one edit and three times after two; it now resolves each identity chain to its head per instant.
- **backlog:** a ranked or semantic result no longer returns an issue alongside its own stale copy. The relevance path hands its filter to a search backend whose contract cannot express the current-row predicate, so superseded rows stayed rankable — and outranked the live row, since their text is what the query resembled. Those rows are now dropped from the ranked page, with over-fetch so the page stays full.
- **backlog:** the outcome envelope and its error codes now live in one module, mapped by error class rather than by retry bucket.
- **backlog:** id collisions on concurrent `create` are hardened, alongside repo-lookup UX and install/skill packaging.
- **backlog:** superseded ids are rejected on `claim`/`relate`/`move`/`delete` instead of silently operating on a stale record.
- **backlog:** avoid opening the graph store for status-only CLI paths (`--help`, no-args) (DEBT-BACKLOG-CLI-EAGER-STORE-OPEN-001, DEBT-BACKLOG-CLI-STORE-OPEN-001).
- **backlog:** `--namespace sandbox` routes through an explicit `namespace: 'sandbox'` parameter, on top of (never instead of) its throwaway `adhdRoot` swap, closing `BUG-BACKLOG-SANDBOX-SILENT-BYPASS-001`'s bug class structurally — an explicit function parameter cannot be silently overridden by an ambient `ADHD_ROOT` the way a `process.env` read previously could. Also fixes `BUG-BACKLOG-SANDBOX-SERVE-TELEMETRY-001`, found while proving the sandbox flag against `serve`: `runServeCommand`'s own telemetry re-init (BUG-014, re-stamping the process `role:'live-service'` before request handling starts) carried no `logDir` override at all, silently undoing the bin-entry guard's own sandbox-telemetry redirect the moment a long-lived `--namespace sandbox serve` session re-stamped its role — a sandboxed `serve` invocation's telemetry ended up written to the real, HOME-anchored `~/.adhd/sox-ecosystem/backlog/logs` after all. `runServeCommand` now mints its own sandbox log dir the same way `index.ts`'s bin-entry guard does, keyed off `opts.namespace === 'sandbox'`.
- **backlog:** a failed audit write must not fail an already-committed claim.
- **backlog:** a live claim now actually protects an issue. `transition` previously ignored `claimedBy` entirely, so any agent could change an issue's status out from under a claim someone else was actively holding — `claim` was advisory-only. `transition` now blocks with the same `ClaimHeldError`/`conflict` a competing `claim` call would get, unless the claim is stale or held by the same agent, matching `claim`'s own staleness rule (the shared staleness logic moved into `claim-lease.ts` so both verbs stay in sync).
- **backlog:** `claim` no longer accepts a claim on an already-closed issue. There was nothing to lease on a terminal issue, so this now rejects with a new `IssueTerminalError` (`precondition_failed`) — release/renew are unaffected, since cleaning up a claim on an issue that closed out from under you must still succeed.
- **backlog:** a per-verb `--help` (e.g. `backlog create --help`) now points at `batch action` when it exists as a bulk alternative — real usage testing showed agents doing many one-at-a-time calls in a row without ever discovering the batch primitive, because per-verb help had no cross-reference to it.
- **backlog:** `query --input '{"filter":{"kind":"typo"}}'` (or `status`/`priority`) now rejects with a `BacklogValidationError` naming the unresolved value and suggesting the nearest existing catalog name, instead of silently returning `{total:0, items:[]}` indistinguishable from filtering by a real, sparse (currently zero-issue) value. `kind`/`status`/`priority` are validated against the catalog's own live rows — the real, dynamic value space those open vocabularies have (DATA_MODEL.md §0.2/§2) — never a fixed enum, so a legitimate sparse filter still returns cleanly empty.
- **backlog:** `query`'s `format:'markdown'` is now implemented (`src/query/markdown.ts`) instead of unconditionally rejecting as "not implemented in this slice." Every item-list view (`list`/`ready`/`stale`/`similar`) supports it; `graph`/`order`/`overlap`/`projects`/`components`/`locations` reject it with a clear `InvalidArgumentError` naming why (no item-list shape to render).
- **backlog:** `query --help` and SPEC.md now document that `view:"similar"` requires `filter.anchor` OR `filter.semantic` — previously a caller had to hit the runtime error to discover this.
- **backlog:** `backlog get --help` no longer collapses its mounted `uid`-vs-`registry` union input to the useless `{ input: union }`. The shared apigen `--help`/tool-description generator (`describeParams` in `@adhd/apigen-engine-runtime`) now expands a top-level union's member shapes (`{ uid: string, fields?: ... } | { registry: ..., name: ..., filter?: ... }`) and renders an enum's actual allowed values (`view?: 'list'|'similar'|'projects'|'components'|'locations'|...`) instead of the bare, contentless words `union`/`enum` — this fixes every apigen-mounted CLI/MCP tool's `--help`/description across the monorepo, not just `backlog`.
- **backlog:** `query --help` and `skill/SKILL.md` now surface `view:"projects"`/`"components"`/`"locations"` (the project/component/location registry LIST views) — previously undiscoverable short of reading source, since `view?`'s allowed values rendered as the bare word `enum`.
- **backlog (BUG-BACKLOG-QUERY-REGISTRY-VIEW-STRIPPED-001, root-caused while verifying the above against the real built binary — the prior claim that these three views "already work correctly" was wrong):** `query --input '{"view":"projects"}'` (and `"components"`/`"locations"`) silently stripped every field but `uid` over EVERY transport (CLI/MCP/HTTP) — `{"items":[{"uid":"..."}]}`, with `name`/`path`/`projectUid`/`locType`/`value`/`componentUid` all gone. Root cause was one level up the stack, in `@adhd/apigen-base-logical`'s shared response encoder: `IIssueQueryResult`'s `view`-tagged members declare no `discriminator`, and several branches (`ready`/`stale`/`similar`/`projects`/`components`/`locations`) share identical top-level property names (`view`, `items`), so the encoder's structural tie-break silently re-encoded every one of them through whichever branch was declared earliest (an `items: IIssueCard[]` shape) — correct by coincidence for `ready`/`stale`/`similar` (their items genuinely are `IIssueCard`s) and silently wrong for the three registry views. Fixed at the root in `apigen-base-logical`'s `pickUnionBranch` (an implicit literal-discriminator fallback, before structural scoring) — this fixes every apigen-mounted verb across the monorepo whose response union has this shape, not just `backlog query`.
- **backlog:** the `[inv:singleton]` PID-file writer lock added for `serve` in 0.1.8 (BUG-020) is REMOVED. A deeper read of the currently-pinned `@adhd/sox-store-adapter@0.9.1` found the lock guards a path real `backlog` code cannot reach (the adapter's WAL-checkpoint strategy is hardcoded `'gated'` in production; the adapter's own 1,180-trial internal safety experiment found zero crashes through that gated path) and that the original incident traced to a separate, since-fixed adapter bug (`BUG-STOREADAPTER-COORDINATION-PATH-ASYMMETRY` — a non-canonicalized quiescence check, not a concurrency hazard requiring application-level mutual exclusion). Re-verified empirically: three real two-process sustained-concurrent-write trials via the actual built MCP server, zero failures, exact persisted counts every trial (see STATE.md A17). `backlog serve` now supports any number of concurrent instances against the same store with no coordination between them, matching every other write path in this package (SPEC.md §3/§4's parallel-process-enabled design) — a hard requirement for this rewrite. Durable proof: `src/serve.singleton.spec.ts`.

### 📖 Documentation & tests

- **backlog:** `SPEC.md` describes one surface and nothing else. The data-load section and every reference to it are gone, along with the superseded interface and graph-model documents the package's own source still cited.
- **backlog:** two acceptance criteria were corrected against the shipped design rather than left contradicting it — uniqueness now states the edge-scoped resolve-then-create the write layer performs (it never rejected a duplicate name), and the concurrency gate now names a negative control that is deterministically reachable.
- **backlog:** the audit contract is proven end to end: `actor`, `action` and a **recomputed** `sha` are read off the raw audit node for all six write verbs.
- **backlog:** the banned-terms gate now scans the package's own documents, not just `src/`. Scoping it to source is how a whole stale spec section survived an earlier sweep.

### ❤️ Thank You

- pseudosky

## 0.1.10 (2026-08-20)

### 🩹 Fixes

- **backlog:** don't open the graph store for status-only CLI paths (DEBT-BACKLOG-CLI-STORE-OPEN-001)

- **backlog:** a failed audit write must not fail an already-committed claim

### ❤️ Thank You

- pseudosky

## 0.1.9 (2026-08-20)

### 🩹 Fixes

- **release:** global-CLI currency gate (BUG-027) + assets/build output-scope cache bug (BUG-026)

- **backlog:** converge @adhd/sox-telemetry to a single instance (BUG-BACKLOG-TELEMETRY-001)

- **backlog:** don't open the graph store for --help/version (DEBT-BACKLOG-CLI-EAGER-STORE-OPEN-001)

### ❤️ Thank You

- pseudosky

## 0.1.8 (2026-08-19)

### 🩹 Fixes

- **backlog:** singleton writer lock for `serve` — two concurrent servers against one store corrupted the db (BUG-020). O_EXCL PID-file lock keyed on the canonical realpath'd db path, held from before the store opens until after it is fully closed, so a second `serve` during shutdown drain is refused rather than admitted. Dead holders reclaimed; refusal names the holder pid and lock path.
- **backlog:** consume `@adhd/sox-store-adapter` 0.7.0. The dependency was pinned `^0.5.8`, and a caret on a 0.x pins the MINOR — so it could never resolve past 0.6.0 and none of the WAL/durability work reached this store. Brings the adaptive idle-flush debounce (BL-590), baseline-relative WAL cap (BL-587), and verified busy-error classification in the wal-cap backstop (BUG-019).

### ❤️ Thank You

- pseudosky

## 0.1.7 (2026-08-14)

### 🩹 Fixes

- **backlog:** persist citations, atomic repo moves, signal cleanup

### ❤️ Thank You

- pseudosky

## 0.1.6 (2026-08-12)

### 🩹 Fixes

- **backlog:** honor ADHD_BACKLOG_DATABASE_PATH env override (BUG-002)

### ❤️ Thank You

- pseudosky

## 0.1.5 (2026-08-12)

### 🚀 Features

- **backlog:** swap the raw embedded-database handle for the sox store adapter (F-01)

- **backlog:** F-01 adopt the turso store adapter (resolves blockers)

- **backlog:** convert store to turso store-adapter (F-01+F-02)

### 🩹 Fixes

- **backlog:** dedupe-scan weak FTS match + required-field completeness

- **apigen-cli:** restore 2768 files mass-deleted by 0117eb22 (BUG-APIGEN-052)

- **backlog:** drop the embedded-database dependency — turso-native concurrency fixtures (substrate invariant)

- **backlog:** best-effort store close in finally paths (close error must not mask command outcome)

- **backlog:** init telemetry at CLI composition root (stop silent record drop, role:'cli')

### ❤️ Thank You

- parity-harness-self-test
- pseudosky

## 0.1.3 (2026-07-30)

### 🚀 Features

- **apigen:** generic batch/bulk fan-out operations (FEAT-APIGEN-BULK-OPS-001)

### 🩹 Fixes

- **backlog:** id collision hardening + repo-lookup UX + install/skill packaging

### ❤️ Thank You

- pseudosky

## 0.1.2 (2026-07-27)

### 🚀 Features

- **backlog:** add `backlog install` command — installs the skill AND registers the MCP server into host configs (Claude Code `~/.claude.json` + project `.mcp.json`; opencode `~/.config/opencode/opencode.json` + project) idempotently, at user/project scopes; `install-skill` retained as an alias.

### 🩹 Fixes

- **backlog:** ship `skill/SKILL.md` into `dist/` via a vite `writeBundle` copy plugin (project.json `build.options.assets` is a no-op under `@nx/vite:build`); fix `install-skill` packaged-skill path escaping to `@adhd/skill` in the published rebased layout (BUG-013, BUG-012 class). Harden the inferred `assets` nx target with explicit `outputs` so a `build` cache-hit can't wipe copied assets.

## 0.1.1 (2026-07-27)

### 🩹 Fixes

- **backlog:** fix published tarball crashing at mount — `backlogDistDir()` resolved `client.d.ts` via `import.meta.url + '../dist'`, which escaped to the nonexistent `node_modules/@adhd/dist` once `dist-manifest` rebased the package to its root; now probes for the sibling `client.d.ts` (BUG-012). Adds `server.published-layout.spec.ts` reproducing the published rebased-to-root layout.

### ❤️ Thank You

- pseudosky

## 0.0.3 (2026-07-25)

### 🩹 Fixes

- **apigen,backlog:** killable serve, configurable namespace, flaky test + log spam

- **backlog:** match archived-item exclusion between render and its verify

### ❤️ Thank You

- pseudosky

## 0.0.2 (2026-07-24)

### 🚀 Features

- **backlog:** add CLI entrypoint + bin (live apigen cli-output mount)

- **backlog:** Phase 1/2 apigen import + CI parity gate

- **backlog:** author backlog-usage skill + install-skill CLI

- **backlog:** add `serve` CLI command so .mcp.json has a real entry to spawn

- **backlog:** rootLevel projection filter so new tool items reach root

### 🩹 Fixes

- **backlog:** close out CI Node floor, content-hash collision verification, FTS content immutability, and bounded busy-retry; plus import provenance/silent-drop fixes

- **backlog:** runBacklogCli no longer eagerly opens the store for --help/no-args (DEBT-BACKLOG-CLI-EAGER-STORE-OPEN-001)

- **backlog:** concurrent createItem id-collision + FTS sanitizer gap

- **backlog:** implement real transition/claim audit-log (DEBT-BACKLOG-AUDIT-TRAIL-PARTIAL-001)

- **backlog:** importFromMarkdown upserts on re-import instead of insert-only

- **backlog:** sourcepath-ownership gate for importFromMarkdown (DEBT-BACKLOG-IMPORT-SCOPE-CROSSFILE-001)

- **backlog:** re-import backfills ownership + resurrects superseded ids

### ❤️ Thank You

- pseudosky
