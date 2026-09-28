# @adhd/backlog

A structured, queryable, concurrent-safe backlog for bugs, debt, features, and
investigations — served from one graph store over a CLI, an MCP server, an HTTP
API, and an in-process client.

## Why

The problem this solves: a plain `BACKLOG.md` file has no way to represent
"someone is already working on this," no way to enforce that a closed item
cites the fix that closed it, no structured way to ask "what's open in this
component," and no safe way for two agents to edit it at once. `@adhd/backlog`
replaces that file with a real store: issues are addressed by a stable `uid`,
every mutation is audited, claims are leases with staleness detection, and
queries are structured filters instead of `grep`.

## Install

```bash
pnpm add -g @adhd/backlog
adhd-backlog --help
```

This installs the `adhd-backlog` CLI binary. The same package also runs as an
MCP server, an HTTP API, and an importable client library — see
[Transports](#transports).

## Quickstart

Issues live under a **project** (and, optionally, a **component**), both
resolved by name or `uid`. File the project first — `create` never mints one.
File every issue with the correct project **and component**: a component-less
item lands on the project's reserved `(root)` component and is invisible to
component-scoped queries. The agent-facing filing rules and the real misfiling
hazards live in [`skill/SKILL.md` §4](skill/SKILL.md).

```bash
adhd-backlog upsert-project --input '{
  "name": "demo-project",
  "path": "/tmp/demo",
  "by": "agent:worker-1"
}'
```

```json
{ "ok": true, "data": { "uid": "49ec673b-…", "created": true, "project": { "uid": "49ec673b-…", "name": "demo-project", "path": "/tmp/demo" } } }
```

File an issue against it:

```bash
adhd-backlog create --input '{
  "title": "Query pagination drops the last page under offset paging",
  "body": "offset+limit near the end of a result set silently returns fewer rows than `total` implies.",
  "project": "demo-project",
  "priority": "HIGH",
  "gitContext": "feat/backlog-hard-replacement @ 4bf902fc",
  "by": "agent:worker-1"
}'
```

```json
{ "ok": true, "data": { "created": true, "uid": "b3b2da0e-…", "item": { "uid": "b3b2da0e-…", "title": "Query pagination drops the last page under offset paging", "kind": "issue", "status": "open", "priority": "HIGH", "project": "49ec673b-…", "component": "65c4e373-…", "createdAt": "2026-09-24T00:14:38.802Z", "author": "agent:worker-1", "gitContext": "feat/backlog-hard-replacement @ 4bf902fc" }, "placementResolved": "default-root" } }
```

> `project` and `component` in the result are `uid`s, not names. `gitContext`
> is described under [Citations & git context](#citations--git-context).
> `placementResolved` is `"default-root"` when the omitted `component` fell
> back to the project's reserved `(root)` component, or `"explicit"` when a
> supplied one resolved — a `default-root` item is invisible to
> component-scoped scans. A create result may additionally carry
> `duplicateScanDegraded: true` plus `duplicateScanDegradedReason`
> (`"no-search-backend"` / `"no-embed-query"` / `"no-vector-scores"`) when the
> pre-write dedupe scan could not run a calibrated comparison; both are absent
> on a healthy scan and never imply the write failed. Full field notes are in
> [`skill/SKILL.md` §3](skill/SKILL.md).

Query for it:

```bash
adhd-backlog query --input '{"filter":{"project":"demo-project","status":"open"}}'
```

```json
{ "ok": true, "data": { "view": "list", "items": [{ "uid": "b3b2da0e-…", "title": "Query pagination drops the last page under offset paging", "kind": "issue", "status": "open", "priority": "HIGH" }], "hasMore": false }, "meta": { "total": 1, "returned": 1, "limit": 50 } }
```

Move it forward — a `transition` records the status change in the issue's audit
trail. A non-empty `note` is required by default
(`project_policy.transition_requires_note`); a terminal status additionally
requires verifiable `citations` **only if** the project's policy turns citation
enforcement on (`citationRequired`, default `false`):

```bash
adhd-backlog transition --input '{
  "uid": "b3b2da0e-…",
  "toStatus": "in-progress",
  "note": "reproduced with limit:10, offset:95 against a 100-row set",
  "by": "agent:worker-1"
}'
```

```json
{ "ok": true, "data": { "uid": "b3b2da0e-…", "fromStatus": "open", "toStatus": "in-progress", "transitionUid": "9bcb9844-…" } }
```

A failed call returns the same envelope with `ok:false` instead of throwing:

```json
{ "ok": false, "error": { "code": "item_not_found", "message": "No live issue found for uid \"does-not-exist\"", "details": { "retryable": false } } }
```

Every output above was captured from the built binary
(`entrypoint/backlog/dist/index.js`); `uid`s are truncated with `…`. See
[Which build these docs describe](#which-build-these-docs-describe).

## Key features

### 1. One shared graph store, concurrent-safe by design

The store is not a file you edit — it is a graph database that many processes
read and write at once. There is no single-writer lock; concurrency is bounded
by real transactions and leases. File the same item from two agents and one
wins cleanly, with correct audit rows. (SPEC.md §3/§4; `src/write/tx.ts`.)

### 2. Leased claims for multi-agent work

`claim` is a lease, not a flag: it is idempotent for the same claimant
(`renew`), self-healing when stale, and it protects the item — a competing
`transition` by another agent is refused with `conflict` until the lease is
released or goes stale.

```bash
adhd-backlog claim --input '{"uid":"b3b2da0e-…","by":"agent:worker-1","action":"claim"}'
```

```json
{ "ok": true, "data": { "uid": "b3b2da0e-…", "status": "claimed", "claimedBy": "agent:worker-1", "claimedAt": "2026-09-24T00:14:39.978Z" } }
```

### 3. Structured, verifiable citations

A citation is `{ file, lines?, context?, symbol? }`, not hand-typed markdown.
When a project enforces citations, a terminal transition is rejected with
`precondition_failed` unless every cited file resolves inside the project's own
registered path. Name a `symbol` and the store shells out to
`gitnexus impact <symbol>` at write time to stamp a best-effort `blastRadius`
on the citation.

### 4. A registry that answers "where does this live?"

`lookup` resolves a tool name, file path, or URL to its owning
project/component — before you reach for `find`. `query` also lists the
registry directly:

```bash
adhd-backlog get --input '{"registry":"project","name":"demo-project"}'
```

```json
{ "ok": true, "data": { "uid": "49ec673b-…", "name": "demo-project", "path": "/tmp/demo", "components": [{ "name": "(root)" }], "locations": [] } }
```

### 5. Optional semantic search, optional Markdown rendering

With embeddings off (the default), keyword filtering (`filter.grep`),
exact/registry lookup, and every write verb work fully. Turn them on and
`query`'s natural-language `text` routes to semantic ranking; ask for a semantic
read with no backend and you get a precise `rag_not_configured` error rather
than a silent empty result. `query --input '{"format":"markdown", …}'` renders
every item-list view as Markdown.

### 6. N-way fan-out with `batch action`

Run one operation over many items instead of N one-at-a-time calls. `operation`
is the mounted id (`backlog/create`, …); each item wraps its payload under
`input`; `mode` (`parallel`/`serial`/`chained`), `onItemError`, `concurrency`,
and `itemTimeoutMs` govern the run.

```bash
adhd-backlog batch action --input '{
  "operation": "backlog/get",
  "items": [{"input": {"uid": "does-not-exist"}}]
}'
```

### 7. Supersede-safe history

A `body` edit does not mutate in place — it mints a successor issue and carries
the previous node's edges (claims, citations, notes, transitions, relations)
forward to it. The old `uid` remains queryable history: addressing it returns
`conflict` and names the live successor, so a stale uid can never silently
resolve to the wrong record.

```json
{ "ok": false, "error": { "code": "conflict", "message": "Issue \"63c2f57e-…\" was superseded by a body edit and is no longer the live issue; it now lives under \"e3b32183-…\"", "details": { "retryable": false } } }
```

### 8. Obligation-gated transitions and the actionability verdict

Declare a typed requirement on an issue with `obligate`; the store then refuses
any transition that would violate it until the requirement is met. A
`block`-severity `evidence` obligation, for example, keeps a `closed`
transition refused until a matching verified attestation exists — and `get`
predicts that refusal before you act:

```bash
adhd-backlog get --input '{"uid":"1d9b77e5-…","fields":["verdict","obligations"]}'
```

```json
{ "ok": true, "data": { "uid": "1d9b77e5-…", "obligations": [{ "uid": "fbcee200-…", "applies_to": { "to": "closed" }, "requirement": { "op": "evidence", "kind": "published-artifact", "min": 1 }, "on_fail": "block" }], "verdict": { "actionable": false, "evaluated_at": "…", "revision": 0, "conditions": [{ "type": "Evidence", "status": "True", "severity": "block", "code": "EvidenceUnverified", "subject": "fbcee200-…", "message": "obligation unsatisfied: EvidenceUnverified" }] } } }
```

Attempt the close and the gate refuses with a typed `precondition_failed`,
writing nothing:

```json
{ "ok": false, "error": { "code": "precondition_failed", "message": "Transition refused: EvidenceUnverified (requires \"published-artifact\") — no verified attestation of kind \"published-artifact\" satisfies this obligation", "details": { "retryable": false } } }
```

`actionable` is tri-state (`true` / `false` / `"unknown"`) — `"unknown"` is
never a green light. The full declare → read → refuse → attest → close
workflow, the closed predicate grammar, and the permitted-override path are in
[`skill/SKILL.md` §4](skill/SKILL.md).

### 9. Compare-and-swap spec revisions

A ticket's work product is a sequence of immutable spec revisions.
`spec-append` appends a fragment and advances the pointer in place, and its
required `base_revision` makes the append a compare-and-swap: a stale base is
refused with `precondition_failed` and nothing is written. `spec-check` tells a
reader whether the token it holds is still current — an absent token is
`stale`, never `fresh` — and `annotate` records a comment keyed to an exact
revision (never to the ticket body):

```bash
adhd-backlog spec-check --input '{"uid":"c79b52b0-…"}'
```

```json
{ "ok": true, "data": { "current_revision": "58b5dfd8-…", "current_token": "sha256:d0bcba4a…", "state": "stale", "method": "none", "reason": "no-token-supplied" } }
```

See [`skill/SKILL.md` §5](skill/SKILL.md) for the append/check worked example.

### 10. Live catalogs and dependency-ordered plans

`query --input '{"view":"catalogs"}'` returns every vocabulary the store
enforces (kinds, statuses, priorities, relations, fields, error codes, location
types, and the mounted verbs), each term naming the in-code source it was
generated from. Note that **`kind` is open/free-form, not an enumerable
allowlist**: `create` accepts any `kind` string and the `kind` catalog is a
usage census (`source: "store"`), so it is **empty on a fresh store** and then
lists what has actually been filed (`"issue"` is the default; `"plan"` is the
conventional parent kind). `filter.kind` is validated against that live census,
so filtering by a never-used kind is a `validation` error naming the values
that do exist. This mirrors `status`, which is likewise an open catalog.

`query --input '{"view":"order","filter":{"plan":"<uid>"}}'`
returns a plan's members topologically ordered by their `blocks` edges. Note
the trap: the `catalog` selector is honoured only with `view:"catalogs"` —
`{"catalog":"status"}` without it silently returns the ordinary `list` view
(never catalog `terms`). See
[`skill/SKILL.md` §6](skill/SKILL.md).

## Command surface

Every verb but `embedding-status` takes a single `--input` flag carrying one JSON
object; `embedding-status` takes **no** options at all. **There are no per-field
flags** — a per-field option (`get --uid …`, `query --view list`, `create
--title …`, `batch action --operation …`) fails with `invalid_argument` (exit 2)
and `Unknown option: --<field>. Available: --input`. (`--help` prints a
"per-field flags are also accepted" footer line; it is generated boilerplate
that does not hold for these commands — `--input` is the only option they
accept. The special commands `serve`, `install-skill`, and `search` are the
exception: they take argv flags and no `--input`.) Twenty-nine operations (the
28 verbs plus `batch`):

| Verb              | CLI                             | MCP tool                   |
| ----------------- | ------------------------------- | -------------------------- |
| `get`             | `adhd-backlog get`              | `backlog_get`              |
| `query`           | `adhd-backlog query`            | `backlog_query`            |
| `priorityMatrix`  | `adhd-backlog priority-matrix`  | `backlog_priority_matrix`  |
| `partOfRollup`    | `adhd-backlog part-of-rollup`   | `backlog_part_of_rollup`   |
| `openCurve`       | `adhd-backlog open-curve`       | `backlog_open_curve`       |
| `report`          | `adhd-backlog report`           | `backlog_report`           |
| `embeddingStatus` | `adhd-backlog embedding-status` | `backlog_embedding_status` |
| `lookup`          | `adhd-backlog lookup`           | `backlog_lookup`           |
| `create`          | `adhd-backlog create`           | `backlog_create`           |
| `update`          | `adhd-backlog update`           | `backlog_update`           |
| `transition`      | `adhd-backlog transition`       | `backlog_transition`       |
| `attest`          | `adhd-backlog attest`           | `backlog_attest`           |
| `recheck`         | `adhd-backlog recheck`          | `backlog_recheck`          |
| `obligate`        | `adhd-backlog obligate`         | `backlog_obligate`         |
| `unobligate`      | `adhd-backlog unobligate`       | `backlog_unobligate`       |
| `specAppend`      | `adhd-backlog spec-append`      | `backlog_spec_append`      |
| `annotate`        | `adhd-backlog annotate`         | `backlog_annotate`         |
| `specCheck`       | `adhd-backlog spec-check`       | `backlog_spec_check`       |
| `claim`           | `adhd-backlog claim`            | `backlog_claim`            |
| `relate`          | `adhd-backlog relate`           | `backlog_relate`           |
| `move`            | `adhd-backlog move`             | `backlog_move`             |
| `delete`          | `adhd-backlog delete`           | `backlog_delete`           |
| `upsertProject`   | `adhd-backlog upsert-project`   | `backlog_upsert_project`   |
| `upsertComponent` | `adhd-backlog upsert-component` | `backlog_upsert_component` |
| `upsertLocation`  | `adhd-backlog upsert-location`  | `backlog_upsert_location`  |
| `rmLocation`      | `adhd-backlog rm-location`      | `backlog_rm_location`      |
| `mergeProject`    | `adhd-backlog merge-project`    | `backlog_merge_project`    |
| `rmProject`       | `adhd-backlog rm-project`       | `backlog_rm_project`       |
| `batch`           | `adhd-backlog batch action`     | `batch_action`             |

`--help` prints these as `backlog <verb>`; the CLI also accepts the bare
`adhd-backlog <verb>` form shown above, and accepts the explicit namespace
prefix at any position. `get`/`query`/`lookup`/`embedding-status` and the four
stats/rollup ops are reads. `create`/`update`/`transition`/`claim`/`relate`/
`move`/`delete` mutate one issue; `attest`/`recheck` record anchored evidence,
and `obligate`/`unobligate` declare or retire a typed requirement that gates a
transition ([SKILL.md §4](skill/SKILL.md)); `specAppend`/`annotate`/`specCheck`
advance, annotate, and verify a ticket's spec revisions ([SKILL.md
§5](skill/SKILL.md)). The
`upsert*`/`rmLocation` verbs manage the **registry** (projects, components,
locations), and `mergeProject`/`rmProject` collapse or retire project rows.
`batch action` fans any one of them out over many items.

## Transports

`adhd-backlog` mounts one set of operation descriptors onto every host — there
is no per-transport reimplementation, so a change to a verb's behavior is
simultaneously true everywhere:

- **CLI** — `adhd-backlog <verb> --input '<json>'`
- **MCP** — tools named `backlog_<verb>` (e.g. `backlog_create`, `backlog_query`)
- **HTTP** — a REST API generated from the same descriptors, with an OpenAPI document
- **In-process** — the package's exported client library, for embedding the store in a Node process

## Envelope

Every verb call returns one of two shapes, on every transport:

```ts
{ ok: true,  data: T, warnings?: string[],
  meta?: { total, returned, limit?, offset?, truncated?, total_relation?, has_more?, next_cursor? } }
{ ok: false, error: { code, message, details? }, warnings?: string[] }
```

`meta` is present on the four **item-list** reads (`query`'s `list`/`ready`/
`stale`/`similar` views). `total` is the match count; on `list` it is the exact
count _before_ `limit`/`offset`, while on `ready`/`stale`/`similar` a true
pre-limit total is unknowable at bounded cost, so `meta` reports
`has_more` (derived by fetching one row beyond the page) and labels `total`
with `total_relation: 'gte'` — a lower bound, never a fabricated exact number
(`'eq'` means exact). `graph`/`order`/`overlap` are a graph, a topological
order, and an axis grouping — they deliberately carry **no** `meta`, because
none of them is a filtered row set with an honest "how many matched" count.

> **`view:"ready"` is not an actionability filter.** It selects the `open`
> issues that are unclaimed and whose every live incoming `blocks` blocker is
> terminal — a pure claim/`blocks` predicate that never evaluates obligations
> or evidence. An item with an unsatisfied `block`-severity obligation
> (`fields:["verdict"]` reports `actionable:false`) still appears in `ready`.
> To find actionable work, read `fields:["verdict"]`; do not use `ready`.
> Full definition: [`skill/SKILL.md` §3](skill/SKILL.md).

A derived `_score` always carries its provenance: `_score_kind` is `'rrf'`
(the fused text+vec rank `view:'similar'` and semantic list reads use),
`'bm25'` (a grep-only FTS score), `'cosine'`, `'rank'`, or `'priority'`. A
rank-derived `_score` is **ordinal** — never read it as a similarity or a
confidence.

Sub-collections can be bounded: `get { fields:["auditTrail"], lastN:5 }`
returns at most the newest 5 audit rows (oldest-first order preserved);
`part-of-rollup { uid, countOnly:true }` returns the counts and omits
`childrenOpenUids` entirely, while `part-of-rollup { uid, limit, after }` pages
the open-descendant uid list (`nextCursor`/`hasMore`).

The `report` verb is a grouped rollup whose every number is computed from the
store in that call: `byKind`, `byPriority` (composed from `priority-matrix`),
`byStatus`, and `avgAgeDays` of open in-scope items, with `statusScope` naming
exactly what was counted (`'open'` when the filter omits `status`).

### Error codes

| Code                  | Meaning                                                                                                                                                   | CLI exit code |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `not_found`           | A referenced catalog entry (project/component/kind/status/priority) doesn't exist                                                                         | 4             |
| `item_not_found`      | The addressed issue doesn't exist                                                                                                                         | 1             |
| `invalid_argument`    | Malformed flag or parameter shape                                                                                                                         | 2             |
| `validation`          | Schema rejection — unknown filter key, unknown projection field, over-limit                                                                               | 2             |
| `store_busy`          | Store contention (a lease or a write conflict); `details.retryable` and `details.retryAfterMs` indicate whether/how to retry                              | 1             |
| `rag_not_configured`  | A semantic/similarity read was requested but no embedding backend is configured, or the vector space is empty                                             | 1             |
| `conflict`            | Someone else holds the claim, a single-valued relation is already taken, or a supersede raced                                                             | 1             |
| `precondition_failed` | A gate refused the write — a terminal transition missing its required citation/note, or a citation that couldn't be verified against a known project path | 1             |
| `internal`            | Unclassified server-side failure                                                                                                                          | 1             |

Success always exits 0. `item_not_found` and `internal` are deliberately
distinct codes even though they share exit code 1 — a caller distinguishes
"this uid doesn't exist" from "something broke" by `error.code`, not by exit
code alone.

### Citations & git context

A citation is `{ file, lines?, context?, symbol? }`. Pass `citations` on
`create`, or on the `transition` that moves an issue into a terminal status
when the project's policy requires it. `file` must name a file, not a
directory: a directory target is rejected as a non-retryable `validation`
error.

The item-level **`gitContext`** is separate from a citation's own `context`:
it records the repo disclosure contract's `<active git context>` — the first
element of a `Citations:` block (`Citations: [<active git context>, …]`).
Pass it on `create`, or on a `transition` to update it. It is stored on the
issue itself, and a `format:'markdown'` query renders it once at the head of
the item's `Citations:` block. Omit it and nothing is stored.

### Which build these docs describe

These docs describe `entrypoint/backlog/dist/index.js` built from the revision
captured here, which mounts 28 verbs — including the obligation
(`obligate`/`unobligate`), spec-pointer (`spec-append`/`annotate`/`spec-check`),
and catalog (`query --input '{"view":"catalogs"}'`) surfaces. A **globally
installed** `adhd-backlog` may be an older build (it is whatever was last
published/installed); on such a build `gitContext` may be rejected with
`invalid_argument`, and the stats/rollup ops (`priority-matrix` /
`part-of-rollup` / `open-curve` / `report`) and the obligation/spec verbs may be
absent. Run `adhd-backlog --help` and compare it against
[§1 of SKILL.md](skill/SKILL.md) if a documented field or verb is refused.

## Build & startup

`nx build backlog` emits TWO things into `dist/`: the compiled
`index.js` + `api.d.ts`, and `api.ir.json` — the extracted operation
descriptors for `api.d.ts`, produced by the build's own hidden `ir-artifact`
subcommand:

```bash
node dist/index.js ir-artifact --out dist/api.ir.json
```

Startup (the CLI, an MCP `initialize`, `--help`) reads `api.ir.json` and
derives the mounted surface from it **without loading the type extractor**, so
a cold start is fast without any warm cache — the fix for a startup path that
previously paid a multi-second synchronous extraction on every invocation.

`api.ir.json` is trusted only while it still matches the built declarations
beside it: the artifact records content hashes of the WHOLE `dist/**.d.ts`
surface it was extracted from (not just `api.d.ts` — extraction resolves types
through `api.d.ts`'s sibling imports), and startup re-hashes that surface
before using it. A missing, corrupt, or stale artifact (any `.d.ts` changed
since the bake) is refused, and startup falls back to a live extraction through
the extract-stage IR cache, which persists the result for the next run.

`ir-artifact` is a build step, not a user command — it is absent from `--help`
and store-free (it never opens the graph store and never writes under
`~/.adhd`).

| Setting          | Env var                   | Default                               | Notes                                                                                                                                                 |
| ---------------- | ------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| IR cache enabled | `APIGEN_IR_CACHE_ENABLED` | `1`                                   | Governs ONLY the **runtime fallback** cache. It does **not** bypass the baked `api.ir.json` artifact — that artifact is the startup path, not a cache |
| IR cache file    | `APIGEN_IR_CACHE_FILE`    | a machine-global path under `~/.adhd` | Where a fallback extraction's result is cached                                                                                                        |

## Library API

Beyond the CLI/MCP/HTTP surface, the package exports its query layer
(`src/query/index.ts`), including four rollup/stats read ops that are **not**
members of `query.view`:

- `priorityMatrix(handle, { filter? })` — a status-aware per-priority count
  breakdown (defaults to open work; `filter.status` may be `'open'`, `'closed'`,
  `'all'`, or a status name).
- `partOfRollup(handle, { uid, countOnly?, limit?, after? })` — transitive
  `part_of` descendants of an issue, counted once each regardless of chain
  depth; `countOnly` omits the uid list, `limit`/`after` page it.
- `openCurve(handle, { filter?, at })` — per-sampled-instant counts of issues
  that existed and how many were open, reconstructed from the audit trail.
- `report(handle, { filter? })` — a grouped rollup (`byKind`/`byPriority`/
  `byStatus`/`avgAgeDays`) composed from live reads in the same call.

Reach them by importing `@adhd/backlog` in-process. The same four are also
mounted as operations — `priority-matrix` / `part-of-rollup` / `open-curve` /
`report` on the CLI (`backlog_priority_matrix` / `backlog_part_of_rollup` /
`backlog_open_curve` / `backlog_report` on MCP); see the command surface above.

## Configuration

Configuration cascades over `@adhd/environment`, prefixed `ADHD_BACKLOG_`
(later layers override earlier: built-in default → config file → environment
variable). The store defaults to a single shared **global** scope — one backlog
spanning every project on the machine, not one per repository — so an agent
working across repos sees the same graph everywhere unless it explicitly opts
into a narrower scope.

| Setting            | Env var                                               | Default                       | Notes                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------ | ----------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database path      | `ADHD_BACKLOG_DATABASE_PATH`                          | resolved under the scope root | Where the graph store's data file lives                                                                                                                                                                                                                                                                                                                                                                 |
| Write busy timeout | `ADHD_BACKLOG_DATABASE_BUSY_TIMEOUT_MS`               | `5000`                        | How long a write waits on a contended lock before giving up                                                                                                                                                                                                                                                                                                                                             |
| Log level          | `ADHD_BACKLOG_LOG_LEVEL`                              | `info`                        | `trace`\|`debug`\|`info`\|`warn`\|`error`\|`fatal`\|`silent`                                                                                                                                                                                                                                                                                                                                            |
| Scope              | `ADHD_BACKLOG_SCOPE` (falls back to `ADHD_ENV_SCOPE`) | `global`                      | Which store root to resolve against                                                                                                                                                                                                                                                                                                                                                                     |
| Namespace          | `--namespace <value>` CLI flag (no env var)           | `production`                  | Which path segment under the scope root to resolve against (`<root>/backlog/<namespace>/…`) — one of `production`\|`test`\|`sandbox`. `--namespace sandbox` ALSO mints a fresh throwaway root and writes a real `config.yaml` there with `embedding.enabled: false`, so a sandboxed invocation is isolated along two independent axes plus a deliberate config, never an accident of an empty directory. It also **ignores a foreign `ADHD_ROOT`**: if the variable names a path this tool did not mint as a sandbox it warns `… is not a sandbox this tool created — ignoring it …` and mints a fresh store instead, so a stray `ADHD_ROOT` can never redirect a sandboxed run into an unrecognized location. `adhd-backlog sandbox-path` reports the resolved store without opening it; its `adhdRoot` key is present only when a root was explicitly resolved (`ADHD_ROOT` set, or `--namespace sandbox`) and is omitted for the default `production`/`test` namespaces |
| Semantic search    | `ADHD_BACKLOG_EMBEDDING_ENABLED`                      | `false`                       | See below                                                                                                                                                                                                                                                                                                                                                                                               |
| Embedding provider | `ADHD_BACKLOG_EMBEDDING_PROVIDER`                     | `fastembed`                   | Only consulted when embedding is enabled                                                                                                                                                                                                                                                                                                                                                                |
| Embedding model    | `ADHD_BACKLOG_EMBEDDING_MODEL`                        | `bge-base-en-v1.5` (768-dim)  | Only consulted when embedding is enabled                                                                                                                                                                                                                                                                                                                                                                |

**Embedding (semantic search) is entirely optional.** With it left at its
default (`false`), `@adhd/backlog` works fully — every verb, keyword filtering
(`filter.grep`), and exact/registry lookup all function with no embedding
backend at all. Turning `filter.semantic`, `filter.anchor`, `view:"similar"`,
`sort:"relevance"`, or `fields:["_vector"]` on without an embedding backend
configured doesn't crash anything — it returns a `rag_not_configured` error
that says exactly that, so a caller can tell "not available" apart from "no
matches." Enabling embedding requires two optional dependencies to be
installed alongside the package and a store backend that supports native
vector storage; if either is missing, backlog logs the reason and leaves
semantic search unconfigured rather than failing to start.

## Further docs

- [`skill/SKILL.md`](skill/SKILL.md) — the full agent-facing command surface, worked examples, and filing rules.
- [`SPEC.md`](SPEC.md) — the functional specification: operation surface, status vocabulary, acceptance criteria.
- [`DATA_MODEL.md`](DATA_MODEL.md) — the node/edge model this package reads and writes.
- [`CHANGELOG.md`](CHANGELOG.md) — version history.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). This package is MIT-licensed under
[`LICENSE`](LICENSE); security policy: [`SECURITY.md`](../../SECURITY.md).
