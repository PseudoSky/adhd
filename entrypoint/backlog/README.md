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
{"ok":true,"data":{"uid":"49ec673b-…","created":true,"project":{"uid":"49ec673b-…","name":"demo-project","path":"/tmp/demo"}}}
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
{"ok":true,"data":{"created":true,"uid":"b3b2da0e-…","item":{"uid":"b3b2da0e-…","title":"Query pagination drops the last page under offset paging","kind":"issue","status":"open","priority":"HIGH","project":"49ec673b-…","component":"65c4e373-…","createdAt":"2026-09-24T00:14:38.802Z","author":"agent:worker-1","gitContext":"feat/backlog-hard-replacement @ 4bf902fc"}}}
```

> `project` and `component` in the result are `uid`s, not names. `gitContext`
> is described under [Citations & git context](#citations--git-context).

Query for it:

```bash
adhd-backlog query --input '{"filter":{"project":"demo-project","status":"open"}}'
```

```json
{"ok":true,"data":{"view":"list","items":[{"uid":"b3b2da0e-…","title":"Query pagination drops the last page under offset paging","kind":"issue","status":"open","priority":"HIGH"}],"hasMore":false},"meta":{"total":1,"returned":1,"limit":50}}
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
{"ok":true,"data":{"uid":"b3b2da0e-…","fromStatus":"open","toStatus":"in-progress","transitionUid":"9bcb9844-…"}}
```

A failed call returns the same envelope with `ok:false` instead of throwing:

```json
{"ok":false,"error":{"code":"item_not_found","message":"No live issue found for uid \"does-not-exist\"","details":{"retryable":false}}}
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
{"ok":true,"data":{"uid":"b3b2da0e-…","status":"claimed","claimedBy":"agent:worker-1","claimedAt":"2026-09-24T00:14:39.978Z"}}
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
{"ok":true,"data":{"uid":"49ec673b-…","name":"demo-project","path":"/tmp/demo","components":[{"name":"(root)"}],"locations":[]}}
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
{"ok":false,"error":{"code":"conflict","message":"Issue \"63c2f57e-…\" was superseded by a body edit and is no longer the live issue; it now lives under \"e3b32183-…\"","details":{"retryable":false}}}
```

## Command surface

Every verb but `embedding-status` takes a single `--input` flag carrying one JSON
object; there are no per-field flags. Nineteen operations (the 18 verbs plus
`batch`):

| Verb              | CLI                             | MCP tool                   |
| ----------------- | ------------------------------- | -------------------------- |
| `get`             | `adhd-backlog get`              | `backlog_get`              |
| `query`           | `adhd-backlog query`            | `backlog_query`            |
| `priorityMatrix`  | `adhd-backlog priority-matrix`  | `backlog_priority_matrix`  |
| `partOfRollup`    | `adhd-backlog part-of-rollup`   | `backlog_part_of_rollup`   |
| `openCurve`       | `adhd-backlog open-curve`       | `backlog_open_curve`       |
| `embeddingStatus` | `adhd-backlog embedding-status` | `backlog_embedding_status` |
| `lookup`          | `adhd-backlog lookup`           | `backlog_lookup`           |
| `create`          | `adhd-backlog create`           | `backlog_create`           |
| `update`          | `adhd-backlog update`           | `backlog_update`           |
| `transition`      | `adhd-backlog transition`       | `backlog_transition`       |
| `claim`           | `adhd-backlog claim`            | `backlog_claim`            |
| `relate`          | `adhd-backlog relate`           | `backlog_relate`           |
| `move`            | `adhd-backlog move`             | `backlog_move`             |
| `delete`          | `adhd-backlog delete`           | `backlog_delete`           |
| `upsertProject`   | `adhd-backlog upsert-project`   | `backlog_upsert_project`   |
| `upsertComponent` | `adhd-backlog upsert-component` | `backlog_upsert_component` |
| `upsertLocation`  | `adhd-backlog upsert-location`  | `backlog_upsert_location`  |
| `rmLocation`      | `adhd-backlog rm-location`      | `backlog_rm_location`      |
| `batch`           | `adhd-backlog batch action`     | `batch_action`             |

`--help` prints these as `backlog <verb>`; the CLI also accepts the bare
`adhd-backlog <verb>` form shown above, and accepts the explicit namespace
prefix at any position. `get`/`query`/`lookup`/`embedding-status` are reads.
`create`/`update`/`transition`/`claim`/`relate`/`move`/`delete` mutate one
issue. The four `upsert*`/`rmLocation` verbs manage the **registry** —
projects, components, and locations. `batch action` fans any one of them out
over many items.

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
{ ok: true,  data: T, warnings?: string[], meta?: { total, returned, limit?, offset?, truncated? } }
{ ok: false, error: { code, message, details? }, warnings?: string[] }
```

`meta` is present on list-shaped reads (`query`) and its `total` is the true
match count _before_ `limit`/`offset` are applied; a truncated page sets
`data.hasMore: true` and `data.nextCursor`, so a short result never silently
looks complete.

### Error codes

| Code                  | Meaning                                                                                                                         | CLI exit code |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `not_found`           | A referenced catalog entry (project/component/kind/status/priority) doesn't exist                                               | 4             |
| `item_not_found`      | The addressed issue doesn't exist                                                                                               | 1             |
| `invalid_argument`    | Malformed flag or parameter shape                                                                                               | 2             |
| `validation`          | Schema rejection — unknown filter key, unknown projection field, over-limit                                                     | 2             |
| `store_busy`          | Store contention (a lease or a write conflict); `details.retryable` and `details.retryAfterMs` indicate whether/how to retry    | 1             |
| `rag_not_configured`  | A semantic/similarity read was requested but no embedding backend is configured, or the vector space is empty                   | 1             |
| `conflict`            | Someone else holds the claim, a single-valued relation is already taken, or a supersede raced                                   | 1             |
| `precondition_failed` | A gate refused the write — a terminal transition missing its required citation/note, or a citation that couldn't be verified against a known project path | 1             |
| `internal`            | Unclassified server-side failure                                                                                                | 1             |

Success always exits 0. `item_not_found` and `internal` are deliberately
distinct codes even though they share exit code 1 — a caller distinguishes
"this uid doesn't exist" from "something broke" by `error.code`, not by exit
code alone.

### Citations & git context

A citation is `{ file, lines?, context?, symbol? }`. Pass `citations` on
`create`, or on the `transition` that moves an issue into a terminal status
when the project's policy requires it.

The item-level **`gitContext`** is separate from a citation's own `context`:
it records the repo disclosure contract's `<active git context>` — the first
element of a `Citations:` block (`Citations: [<active git context>, …]`).
Pass it on `create`, or on a `transition` to update it. It is stored on the
issue itself, and a `format:'markdown'` query renders it once at the head of
the item's `Citations:` block. Omit it and nothing is stored.

### Which build these docs describe

These docs describe `entrypoint/backlog/dist/index.js` built from revision
`9df2a5c7`, whose `create`/`transition` inputs include `gitContext`. A
**globally installed** `adhd-backlog` may be an older build (it is whatever was
last published/installed); on such a build `gitContext` is not in the schema
and is rejected with `invalid_argument`, and the stats/rollup ops
(`priority-matrix` / `part-of-rollup` / `open-curve`) are absent. Run
`adhd-backlog --help` and compare the `backlog create` / `backlog
priority-matrix` lines against this page if a documented field or verb is
refused.

## Library API

Beyond the CLI/MCP/HTTP surface, the package exports its query layer
(`src/query/index.ts`), including three rollup/stats read views that are **not**
members of `query.view`:

- `priorityMatrix(handle, { filter? })` — a status-aware per-priority count
  breakdown (defaults to open work; `filter.status` may be `'open'`, `'closed'`,
  `'all'`, or a status name).
- `partOfRollup(handle, { uid })` — transitive `part_of` descendants of an
  issue, counted once each regardless of chain depth.
- `openCurve(handle, { filter?, at })` — per-sampled-instant counts of issues
  that existed and how many were open, reconstructed from the audit trail.

Reach them by importing `@adhd/backlog` in-process. The same three are also
mounted as operations — `priority-matrix` / `part-of-rollup` / `open-curve` on
the CLI (`backlog_priority_matrix` / `backlog_part_of_rollup` /
`backlog_open_curve` on MCP); see the command surface above.

## Configuration

Configuration cascades over `@adhd/environment`, prefixed `ADHD_BACKLOG_`
(later layers override earlier: built-in default → config file → environment
variable). The store defaults to a single shared **global** scope — one backlog
spanning every project on the machine, not one per repository — so an agent
working across repos sees the same graph everywhere unless it explicitly opts
into a narrower scope.

| Setting            | Env var                                               | Default                    | Notes                                                        |
| ------------------ | ----------------------------------------------------- | -------------------------- | ------------------------------------------------------------ |
| Database path      | `ADHD_BACKLOG_DATABASE_PATH`                          | resolved under the scope root | Where the graph store's data file lives                   |
| Write busy timeout | `ADHD_BACKLOG_DATABASE_BUSY_TIMEOUT_MS`               | `5000`                     | How long a write waits on a contended lock before giving up  |
| Log level          | `ADHD_BACKLOG_LOG_LEVEL`                              | `info`                     | `trace`\|`debug`\|`info`\|`warn`\|`error`\|`fatal`\|`silent` |
| Scope              | `ADHD_BACKLOG_SCOPE` (falls back to `ADHD_ENV_SCOPE`) | `global`                   | Which store root to resolve against                          |
| Namespace          | `--namespace <value>` CLI flag (no env var)           | `production`               | Which path segment under the scope root to resolve against (`<root>/backlog/<namespace>/…`) — one of `production`\|`test`\|`sandbox`. `--namespace sandbox` ALSO mints a fresh throwaway root and writes a real `config.yaml` there with `embedding.enabled: false`, so a sandboxed invocation is isolated along two independent axes plus a deliberate config, never an accident of an empty directory |
| Semantic search    | `ADHD_BACKLOG_EMBEDDING_ENABLED`                      | `false`                    | See below                                                    |
| Embedding provider | `ADHD_BACKLOG_EMBEDDING_PROVIDER`                     | `fastembed`                | Only consulted when embedding is enabled                     |
| Embedding model    | `ADHD_BACKLOG_EMBEDDING_MODEL`                        | `bge-base-en-v1.5` (768-dim) | Only consulted when embedding is enabled                   |

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
