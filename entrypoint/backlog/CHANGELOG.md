## 1.0.0 (Unreleased)

The first stable release. `@adhd/backlog` is a self-contained backlog system: one store, mounted live to a CLI, an MCP server, and an HTTP surface with zero duplicated logic across hosts. Every operation returns an outcome envelope — `{ok:true, data}` or `{ok:false, error:{code,message,details}}` — so a caller never has to guess whether a call succeeded from a thrown exception.

### 🚀 Features

- **backlog:** the application layer settles on 14 verbs — `get`, `query`, `lookup`, `create`, `update`, `transition`, `claim`, `relate`, `move`, `upsertProject`, `upsertComponent`, `upsertLocation`, `rmLocation`, `delete` — each mounted identically to CLI, MCP, and HTTP.
- **backlog:** `create` takes a flat `{ title, body, project, by }` input plus optional `component`, `kind`, `status`, `priority`, `citations`, `author`, `assignee`, and `duplicateAction` (`'abort' | 'force' | 'comment'`, default `'abort'`); a resolved `project` is required — `create` never mints one.
- **backlog:** `query` accepts a natural-language `text` that routes to semantic or keyword search, and pages results by `limit`/`after` with `hasMore`/`nextCursor`.
- **backlog:** on-write embeddings, with an audit row per write, back semantic search.
- **backlog:** citations are persisted on every item, and repo moves apply their rename plan in two passes so a rename can't cascade mid-write.

### 🩹 Fixes

- **backlog:** editing an issue's body no longer discards the rest of its graph. The supersede path carried exactly five edges onto the successor — the set the issue CARD reads — so a single body edit silently detached the issue's blockers, dependencies, notes, citations, transitions and entire audit trail. Every remaining edge is now carried forward in both directions, since an issue is the source of some relations and the target of others.
- **backlog:** a burndown no longer inflates after an edit. The open-curve view counted every row alive at a sampled instant, so one logical issue appeared twice after one edit and three times after two; it now resolves each identity chain to its head per instant.
- **backlog:** a ranked or semantic result no longer returns an issue alongside its own stale copy. The relevance path hands its filter to a search backend whose contract cannot express the current-row predicate, so superseded rows stayed rankable — and outranked the live row, since their text is what the query resembled. Those rows are now dropped from the ranked page, with over-fetch so the page stays full.
- **backlog:** the outcome envelope and its error codes now live in one module, mapped by error class rather than by retry bucket.
- **backlog:** id collisions on concurrent `create` are hardened, alongside repo-lookup UX and install/skill packaging.
- **backlog:** superseded ids are rejected on `claim`/`relate`/`move`/`delete` instead of silently operating on a stale record.
- **backlog:** avoid opening the graph store for status-only CLI paths (`--help`, no-args) (DEBT-BACKLOG-CLI-EAGER-STORE-OPEN-001, DEBT-BACKLOG-CLI-STORE-OPEN-001).
- **backlog:** a failed audit write must not fail an already-committed claim.
- **backlog:** a live claim now actually protects an issue. `transition` previously ignored `claimedBy` entirely, so any agent could change an issue's status out from under a claim someone else was actively holding — `claim` was advisory-only. `transition` now blocks with the same `ClaimHeldError`/`conflict` a competing `claim` call would get, unless the claim is stale or held by the same agent, matching `claim`'s own staleness rule (the shared staleness logic moved into `claim-lease.ts` so both verbs stay in sync).
- **backlog:** `claim` no longer accepts a claim on an already-closed issue. There was nothing to lease on a terminal issue, so this now rejects with a new `IssueTerminalError` (`precondition_failed`) — release/renew are unaffected, since cleaning up a claim on an issue that closed out from under you must still succeed.
- **backlog:** a per-verb `--help` (e.g. `backlog create --help`) now points at `batch action` when it exists as a bulk alternative — real usage testing showed agents doing many one-at-a-time calls in a row without ever discovering the batch primitive, because per-verb help had no cross-reference to it.

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
