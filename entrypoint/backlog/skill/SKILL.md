---
name: backlog-usage
description: "Use whenever filing, claiming, transitioning, or resolving a backlog item (bug/debt/feature/investigation) in ANY repo on this machine — via the `backlog` CLI/MCP, never by hand-editing a BACKLOG.md file. Also use to check current migration status before assuming markdown vs. the tool is authoritative. Examples: \"log this bug\", \"file a debt item for the flaky test\", \"claim BUG-042\", \"what's still open in this repo\", \"is BACKLOG.md still the source of truth here\"."
---

# `@adhd/backlog` usage

`@adhd/backlog` is a graph-backed, multi-agent, cross-repo backlog tool. It is
migrating every repo on this machine off hand-edited `BACKLOG.md` files onto
itself as the source of truth, with `BACKLOG.md` demoted to a generated,
git-visible *projection* of the graph. This skill is the ONLY place the
command surface, protocol, and migration-state mechanism are documented —
the global `CLAUDE.md`/`AGENTS.md` carry just one pointer line to this file.

> **INTERFACE_v2.** The surface below is the six-verb consolidation. The ~36
> flat v1 verbs (`create-item`, `get-item`, `list-items`, `transition-status`,
> …) are **retired and no longer mounted** — they survive only as in-process
> library exports. A v1 command name now exits `4` (unknown command). Every
> example in this file was verified against the real built binary.

## 1. Check migration status FIRST, every time

Never trust a hardcoded phase number in this document — it goes stale the
moment a phase advances. Before deciding whether `BACKLOG.md` or the tool is
authoritative for the CURRENT repo, run:

```
backlog admin --input '{"action":"migration_status"}'
```

It reports `{ phase, description, toolIsAuthoritative }`. While
`toolIsAuthoritative` is `false` (phases `not-started`/`phase-1`/`phase-2`),
`BACKLOG.md` (root, per-plan, per-package) is still the real source of truth
in this repo — read/file there by hand as usual, but still prefer `backlog
query`/`backlog create` for querying and filing so items are visible
cross-repo and get FTS/symbol dedup for free. Once `toolIsAuthoritative` is
`true` (`phase-3` and later), **never hand-edit a `BACKLOG.md` file** — every
one is a generated projection at that point, and a hand-edit will be silently
overwritten (or, once the parity gate is blocking, rejected in CI).

## 2. Command surface — six verbs, one calling convention

There are exactly six verbs plus one batch mount. **Every verb takes a single
`--input` flag carrying one JSON object** — there are no per-field flags any
more (`--repo`, `--human-id`, `--by`, … are all gone; passing one exits `2`).

```
backlog get     --input '<IBacklogGetOptions json>'
backlog query   --input '<IBacklogQueryOptions json>'
backlog create  --input '<IBacklogCreateInput json>'
backlog update  --input '<IBacklogUpdateInput json>'
backlog relate  --input '<IBacklogRelateInput json>'
backlog admin   --input '<IBacklogAdminInput json>'
batch action    --operation <op> --items '<json[]>' [--concurrency <n>]
```

Two special commands are handled before the command table and do NOT take
`--input`: `backlog serve [--transport http|mcp|both]` and
`backlog install-skill` (alias `install`).

### The outcome envelope — every call, every transport

Every verb returns the same envelope on stdout as one JSON line:

```jsonc
{ "ok": true,  "data": { /* verb-specific payload */ }, "warnings": [], "meta": {} }
{ "ok": false, "error": { "code": "item_not_found", "message": "…", "details": {} } }
```

Never assume an unwrapped payload — always read `envelope.data`. Exit codes
are derived from `error.code`:

| exit | codes |
|---|---|
| `0` | success (`ok: true`) |
| `1` | `item_not_found`, `ambiguous`, `duplicate_candidate`, `dedupe_suppressed`, `store_busy`, `soft_deleted`, `conflict`, `precondition_failed`, `internal` |
| `2` | `invalid_argument`, `validation`, `unsupported` |
| `4` | `not_found` (unknown command) |

`error.details.retryable`/`retryAfterMs` tell you whether to retry a
`store_busy` and with what backoff — never hot-loop.

### MCP tool names

Each verb is also an MCP tool once `.mcp.json` wires the server:
`backlog_get`, `backlog_query`, `backlog_create`, `backlog_update`,
`backlog_relate`, `backlog_admin`, plus the un-namespaced `batch_action`.
MCP wraps the single non-`ctx` parameter under `data`, and that parameter is
itself named `input` — so the argument path is `data.input.<field>` (and
`create` nests one level further, `data.input.input`, because
`IBacklogCreateInput.input` is itself the item payload).

### Verb inputs

| verb | required | common optional |
|---|---|---|
| `get` | `humanId` | `repo`, `fields[]`, `includeDeleted` |
| `query` | — | `view`, `filter`, `sort`, `direction`, `limit`, `offset`, `groupBy`, `humanIds[]`, `text`, `format` |
| `create` | `input{family,title,body,repo}`, `by` | `input.priority`, `input.projectPath`, `duplicateAction`, `supersedes`, `splitFrom`, `children[]`, `reason` |
| `update` | `humanId`, `by` | `patch`, `status`, `citations[]`, `reason`, `claim`, `claimOpts`, `assignedTo`, `addNote`, `addCitation`, `softDeleteReason`, `repo` |
| `relate` | `sourceId`, `targetId`, `relation`, `action`, `by` | `repo` |
| `admin` | `action` | `params`, `by` |

- `query.view`: `list` (default) · `ready` · `order` · `graph` · `stale` ·
  `summary` · `grouped`. The v1 ops `ready-items`, `topo-order`,
  `dependency-graph`, `stale-claims`, and `stats` are all views now.
- `relate.relation`: `dependency` · `related` · `plan`;
  `relate.action`: `add` · `remove`. This one verb replaces
  `add-dependency`, `remove-dependency`, `link-related`, and `attach-to-plan`.
- `update.claim`: `claim` · `release` · `renew` — replaces `claim-item`,
  `renew-claim`, `release-claim`.
- `admin.action`: `archive` · `export` · `import` · `render` · `merge` ·
  `migration_status` · `set_migration_phase` · `version` · `skill` · `batch` ·
  `doctor` · `prune` · `reconcile_repo` · `run_dedup_sweep` ·
  `cluster_into_plans` · `promote_cluster_to_plan` · `embedding_backfill` ·
  `embedding_health` · `list_near_duplicates`.

Every `<repo>` value is this machine's stable git-remote-derived slug (e.g.
`PseudoSky/adhd`) — never a bare directory name. A worktree agent
(`<repo>/.worktrees/*`) resolves to the SAME main-repo `repo` slug, not a
phantom per-worktree repo.

**`get` returns a terse card by default** (`humanId`/`kind`/`title`/`status`/
`priority`). Ask for more explicitly: `{"humanId":"BUG-001","fields":["body","repo","citations"]}`.

## 3. Claim/renew/release protocol (multi-agent use)

- Identity (`by`) is always `${agentName}:${instanceId}` — NEVER a bare role
  literal like `"agent"`. Two concurrent agents both claiming as
  `"implementer"` defeats the CAS protocol entirely. `by` is required on
  every mutating verb and a blank value is rejected with `invalid_argument`.
- Claiming is idempotent for the SAME claimant — always `renewed`, no
  contention check.
- A long-running task must renew periodically (default staleness: 30 min):
  `backlog update --input '{"humanId":"BUG-042","by":"me:1","claim":"renew"}'`
- Every exit path (done/error/abandoned) releases unconditionally — it is a
  no-op on an already-unclaimed item, never an error. Never leave an item
  claimed after you stop working on it.

## 4. Citations — via tool calls, never hand-typed markdown

The `Citation` type (`{ file, lines?, context? }`) is the structured form of
one bracketed citation entry in the old hand-edited convention. Instead of
typing a `Citations: [...]` line by hand, pass `citations` on the `update`
that moves an item into any terminal-done/terminal-workaround status — this
is REQUIRED and enforced (such a transition without citations is rejected):

```
backlog update --input '{
  "humanId": "BUG-MYAREA-001",
  "by": "claude:1",
  "status": "RESOLVED",
  "reason": "fixed in <commit sha>",
  "citations": [{ "file": "packages/x/src/y.ts", "lines": "40-58" }]
}'
```

Use `addCitation` on an `update` to attach evidence without a status change.

## 5. Dedupe before filing — via the tool, not eyeballing

`create` runs a dedupe scan (FTS over title+body, plus exact symbol/path/
errorText metadata match) BEFORE writing, and returns `duplicateCandidates`
alongside `created: false` when a likely match exists. **Always inspect
`duplicateCandidates` first.** Only set `duplicateAction` to force a write
after confirming the candidates are genuinely a distinct issue — never as a
way to skip reading them.

## 6. Worked examples

File a new item:

```
backlog create --input '{
  "input": {
    "family": "BUG-MYAREA",
    "title": "Short, specific summary",
    "body": "Full description, root cause if known, evidence.",
    "repo": "PseudoSky/adhd",
    "projectPath": "packages/domain/my-package",
    "priority": "HIGH"
  },
  "by": "claude:1"
}'
```

Response: `{"ok":true,"data":{"created":true,"humanId":"BUG-MYAREA-001","item":{…}}}`.
If `created` is `false` with non-empty `duplicateCandidates`, read them before
deciding whether to force or to enrich the existing item instead.

What's still open in this repo:

```
backlog query --input '{"filter":{"repo":"PseudoSky/adhd","status":"OPEN"},"limit":50}'
```

Read one item in full:

```
backlog get --input '{"humanId":"BUG-MYAREA-001","repo":"PseudoSky/adhd","fields":["body","citations","notes"]}'
```

Link two items:

```
backlog relate --input '{"sourceId":"BUG-A-001","targetId":"BUG-B-002","relation":"related","action":"add","repo":"PseudoSky/adhd","by":"claude:1"}'
```

## 7. Verify writes from a NEW process

An MCP `backlog_get` is answered by the same long-lived server process that
did the write, out of its own uncheckpointed WAL — so it can confirm rows
that will never exist on disk. After any write you care about, verify by
running the `backlog` CLI in a shell (a fresh process), not by re-reading
through the same MCP session.
