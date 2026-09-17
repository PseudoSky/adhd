# @adhd/backlog

A structured, queryable, multi-agent-safe backlog for bugs, debt, features, and
investigations. Every item is a node in a shared graph store — not a row in a
flat markdown file — so it can be filed, searched, claimed, and transitioned by
many agents and humans working concurrently without stepping on each other's
edits or losing an audit trail.

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
MCP server and an HTTP API — see "Transports" below.

## Transports

`adhd-backlog` mounts one set of operation descriptors onto three transports
at once, using the same live-mount mechanism for each — there is no
per-transport reimplementation, so a change to a verb's behavior is
simultaneously true on all three:

- **CLI** — `adhd-backlog <verb> --input '<json>'`
- **MCP** — tools named `backlog_<verb>` (e.g. `backlog_create`, `backlog_query`)
- **HTTP** — a REST API generated from the same descriptors, with an OpenAPI document

All three project from the exact same 14 verbs:

| Verb              | CLI                             | MCP tool                   |
| ----------------- | ------------------------------- | -------------------------- |
| `get`             | `adhd-backlog get`              | `backlog_get`              |
| `query`           | `adhd-backlog query`            | `backlog_query`            |
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

`get`/`query`/`lookup` are reads. `create`/`update`/`transition`/`claim`/
`relate`/`move`/`delete` mutate one issue. The four `upsert*`/`rmLocation`
verbs manage the **registry** — projects, components, and locations — the
navigation index that answers "where does this live?" (which project, which
component, which file/URL/tool) without an agent falling back to a filesystem
search.

Every verb, on every transport, returns the same envelope shape (see
"Envelope" below) — a mutation never throws a bare stack trace at a caller,
and a read failure is always structured.

## Worked example: file, query, transition

Issues live under a project and (optionally) a component, both resolved by
name or `uid`. File a project first if one doesn't already exist:

```bash
adhd-backlog upsert-project --input '{
  "name": "adhd",
  "path": "/Users/me/dev/adhd",
  "by": "agent:worker-1"
}'
```

```json
{ "ok": true, "data": { "uid": "9f2c...", "created": true, "project": { "uid": "9f2c...", "name": "adhd", "path": "/Users/me/dev/adhd" } } }
```

File an issue against it:

```bash
adhd-backlog create --input '{
  "title": "Query pagination drops the last page under offset paging",
  "body": "offset+limit near the end of a result set silently returns fewer rows than `total` implies.",
  "project": "adhd",
  "by": "agent:worker-1"
}'
```

```json
{
  "ok": true,
  "data": {
    "created": true,
    "uid": "a1b2c3d4-...",
    "item": {
      "uid": "a1b2c3d4-...",
      "title": "Query pagination drops the last page under offset paging",
      "kind": "issue",
      "status": "open",
      "project": "adhd",
      "component": "(root)",
      "createdAt": "2026-09-16T12:00:00.000Z"
    }
  }
}
```

Query for it:

```bash
adhd-backlog query --input '{"filter":{"project":"adhd","status":"open"}}'
```

```json
{
  "ok": true,
  "data": {
    "items": [{ "uid": "a1b2c3d4-...", "kind": "issue", "title": "Query pagination drops the last page under offset paging", "status": "open", "priority": null }],
    "nextCursor": null
  },
  "meta": { "total": 1, "returned": 1 }
}
```

Move it forward — a `transition` records the status change in the issue's
audit trail and requires a `note` unless the project's policy has disabled
that requirement:

```bash
adhd-backlog transition --input '{
  "uid": "a1b2c3d4-...",
  "toStatus": "in-progress",
  "note": "reproduced with limit:10, offset:95 against a 100-row set",
  "by": "agent:worker-1"
}'
```

```json
{
  "ok": true,
  "data": {
    "uid": "a1b2c3d4-...",
    "fromStatus": "open",
    "toStatus": "in-progress",
    "transitionUid": "e5f6..."
  }
}
```

A failed call returns the same envelope shape with `ok: false` instead of
throwing — for example, transitioning a `uid` that doesn't exist:

```json
{ "ok": false, "error": { "code": "item_not_found", "message": "..." } }
```

## Envelope

Every verb call returns one of two shapes:

```ts
{ ok: true,  data: T, warnings?: string[], meta?: { total, returned, limit?, offset?, truncated? } }
{ ok: false, error: { code, message, details? }, warnings?: string[] }
```

`meta` is present on list-shaped reads (`query`) and its `total` is the true
match count _before_ `limit`/`offset` are applied — a truncated result always
says so rather than silently looking complete.

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
| `precondition_failed` | A gate refused the write — a terminal transition missing its required citation or note, or a citation that couldn't be verified | 1             |
| `internal`            | Unclassified server-side failure                                                                                                | 1             |

Success always exits 0. `item_not_found` and `internal` are deliberately
distinct codes even though they share exit code 1 — a caller distinguishes
"this uid doesn't exist" from "something broke" by `error.code`, not by exit
code alone.

## Configuration

Configuration cascades (environment variable → config file → default) via
`@adhd/environment`, prefixed `ADHD_BACKLOG_`. The store defaults to a single
shared **global** scope — one backlog spanning every project on the machine,
not one per repository — so an agent working across repos sees the same
graph everywhere unless it explicitly opts into a narrower scope.

| Setting            | Env var                                               | Default                                         | Notes                                                        |
| ------------------ | ----------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------ |
| Database path      | `ADHD_BACKLOG_DATABASE_PATH`                          | resolved under the scope root                   | Where the graph store's data file lives                      |
| Write busy timeout | `ADHD_BACKLOG_DATABASE_BUSY_TIMEOUT_MS`               | `5000`                                          | How long a write waits on a contended lock before giving up  |
| Log level          | `ADHD_BACKLOG_LOG_LEVEL`                              | `info`                                          | `trace`\|`debug`\|`info`\|`warn`\|`error`\|`fatal`\|`silent` |
| Scope              | `ADHD_BACKLOG_SCOPE` (falls back to `ADHD_ENV_SCOPE`) | `global`                                        | Which store root to resolve against                          |
| Semantic search    | `ADHD_BACKLOG_EMBEDDING_ENABLED`                      | `false`                                         | See below                                                    |
| Embedding provider | `ADHD_BACKLOG_EMBEDDING_PROVIDER`                     | `fastembed`                                     | Only consulted when embedding is enabled                     |
| Embedding model    | `ADHD_BACKLOG_EMBEDDING_MODEL`                        | a 768-dimension general-purpose embedding model | Only consulted when embedding is enabled                     |

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
