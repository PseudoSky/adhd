---
name: backlog-usage
description: "Use whenever filing, claiming, transitioning, or resolving a backlog item (bug/debt/feature/investigation) in ANY repo on this machine — via the `adhd-backlog` CLI/MCP, never by hand-editing a BACKLOG.md file. Also use to check current migration status before assuming markdown vs. the tool is authoritative. Examples: \"log this bug\", \"file a debt item for the flaky test\", \"claim BUG-042\", \"what's still open in this repo\", \"is BACKLOG.md still the source of truth here\"."
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
adhd-backlog admin --input '{"action":"migration_status"}'
```

The status object is nested one level under `action` — the full envelope is
`{"ok":true,"data":{"action":"migration_status","status":{ phase, description,
toolIsAuthoritative }}}`. Read `data.status.phase`/`data.status.toolIsAuthoritative`,
not `data.phase` (verified live against the built CLI). While
`toolIsAuthoritative` is `false` (phases `not-started`/`phase-1`/`phase-2`),
`BACKLOG.md` (root, per-plan, per-package) is still the real source of truth
in this repo — read/file there by hand as usual, but still prefer `adhd-backlog
query`/`adhd-backlog create` for querying and filing so items are visible
cross-repo and get FTS/symbol dedup for free. Once `toolIsAuthoritative` is
`true` (`phase-3` and later), **never hand-edit a `BACKLOG.md` file** — every
one is a generated projection at that point, and a hand-edit will be silently
overwritten (or, once the parity gate is blocking, rejected in CI).

## 2. Command surface — six verbs, one calling convention

There are exactly six verbs plus one batch mount. **Every verb takes a single
`--input` flag carrying one JSON object** — there are no per-field flags any
more (`--repo`, `--human-id`, `--by`, … are all gone; passing one exits `2`).

```
adhd-backlog get     --input '<IBacklogGetOptions json>'
adhd-backlog query   --input '<IBacklogQueryOptions json>'
adhd-backlog create  --input '<IBacklogCreateInput json>'
adhd-backlog update  --input '<IBacklogUpdateInput json>'
adhd-backlog relate  --input '<IBacklogRelateInput json>'
adhd-backlog admin   --input '<IBacklogAdminInput json>'
batch action         --operation <op> --items '<json[]>' [--concurrency <n>]
```

Two special commands are handled before the command table and do NOT take
`--input`: `adhd-backlog serve [--transport http|mcp|both]` and
`adhd-backlog install-skill [--host claude|opencode|codex|all] [--scope user|project]`.

**`install-skill` and `install` are NOT plain aliases of each other — do not
treat them as interchangeable.** (The CLI's own `--help` text calls
`install-skill` "alias: install", which is misleading in exactly the
dangerous direction — verified against `install.ts`/`install-skill.ts`
source and a real run.)

- `adhd-backlog install-skill` is filesystem-only: it copies this packaged
  `SKILL.md` to the target host(s)' skill directory. It never touches any
  MCP/host config file.
- `adhd-backlog install [--host …] [--scope …] [--skill-only | --mcp-only]`
  is the richer superset. **Run bare (no flags), it does BOTH**: it copies
  the skill AND writes/overwrites a `backlog` MCP server entry (the
  registered key name — unchanged by the `adhd-backlog` binary rename) into
  the live host config (`.mcp.json`/`~/.claude.json` for Claude,
  `opencode.json` for OpenCode, `.codex/config.toml`/`config.toml` for
  Codex) at the selected scope.
- If you only mean to (re)install the skill file and must NOT touch any
  agent host's live MCP configuration, use `install-skill` or
  `install --skill-only` explicitly — never bare `install`.

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
`create` nests one level further, `data.input.item`, because
`IBacklogCreateInput.item` carries the item payload).

### Verb inputs

| verb | required | common optional |
|---|---|---|
| `get` | `humanId` | `repo`, `fields[]`, `includeDeleted` |
| `query` | — | `view`, `filter`, `sort`, `direction`, `limit`, `offset`, `groupBy`, `humanIds[]`, `text`, `format` |
| `create` | `item{family,title,body,repo}`, `by` | `item.priority`, `item.projectPath`, `item.author`, `item.reporter`, `duplicateAction`, `supersedes`, `splitFrom`, `children[]`, `reason` |
| `update` | `humanId`, `repo`, `by` | `patch`, `status`, `priority`, `citations[]`, `reason`, `claim`, `claimOpts`, `assignedTo`, `addNote`, `addCitation`, `softDeleteReason` |
| `relate` | `sourceId`, `targetId`, `relation`, `action`, `repo`, `by` | `sourceRepo`, `targetRepo` |
| `admin` | `action` | `params`, `by` |

- `query.view`: `list` (default) · `ready` · `order` · `graph` · `stale` ·
  `summary` · `grouped`. The v1 ops `ready-items`, `topo-order`,
  `dependency-graph`, `stale-claims`, and `stats` are all views now.
- `relate.relation`: `dependency` · `related` · `plan`;
  `relate.action`: `add` · `remove`. This one verb replaces
  `add-dependency`, `remove-dependency`, `link-related`, and `attach-to-plan`.
  `sourceId` resolves in `repo` unless `sourceRepo` overrides it; `targetId`
  resolves in `repo` unless `targetRepo` overrides it — pass both to link two
  items that live in different repos. The response's `noop` is `true` when
  the edge already existed (`add`) or already didn't exist (`remove`) —
  never assume every call was a fresh write.
- `update.claim`: `claim` · `release` · `renew` — replaces `claim-item`,
  `renew-claim`, `release-claim`.
- **`update.patch` only applies FIVE fields: `title`, `body`, `tags`,
  `projectPath`, `importedFrom`.** The `IUpdatePatch` type also *declares*
  `priority`, `status`, `plan`, `assignee`, `humanId`, `kind`, `repo`,
  `files`, `author`, `reporter` — but every one of those is explicitly
  **rejected** (`invalid_argument`/`unsupported`, not silently dropped) if
  you pass it inside `patch`, each with a message naming the real path to
  use instead. Verified live: `patch:{"priority":"LOW"}` returns
  `{"ok":false,"error":{"code":"invalid_argument","message":"patch.priority
  is not applied by updateItem — priority changes go through
  setPriority…"}}`.
  - **Priority reassignment IS reachable — through a SEPARATE top-level
    `priority` field on `update`, not `patch.priority`.**
    `adhd-backlog update --input '{"humanId":"BUG-042","repo":"…","by":"me:1","priority":"CRITICAL"}'`
    goes through the dedicated `setPriority` store primitive (same pattern
    as `status` going through `transitionStatus`) and returns
    `{"ok":true,"data":{"humanId":"BUG-042","changed":["priority"]}}` —
    verified live. This closes the gap `BUG-BACKLOG-UPDATE-ITEM-SILENT-DISCARD-001`
    used to describe; `patch.priority` is rejected specifically so a raw
    patch can never silently no-op a priority change instead of using the
    real field.
  - `update`'s TOP-LEVEL `status` field (sibling of `patch`, not inside it)
    is the real way to transition status — it goes through the citation/
    reason evidence gate. `patch.status` exists only to be rejected, so a
    raw patch can never bypass that gate.
- `admin.action`: `archive` · `export` · `import` · `render` · `merge` ·
  `migration_status` · `set_migration_phase` · `version` · `skill` · `batch` ·
  `doctor` · `prune` · `reconcile_repo` · `run_dedup_sweep` ·
  `cluster_into_plans` · `promote_cluster_to_plan` · `embedding_backfill` ·
  `embedding_health` · `list_near_duplicates`.

Every `<repo>` value is this machine's stable git-remote-derived slug (e.g.
`PseudoSky/adhd`) — never a bare directory name. A worktree agent
(`<repo>/.worktrees/*`) resolves to the SAME main-repo `repo` slug, not a
phantom per-worktree repo.

**`repo` is a free-text string, but a case/whitespace variant of a repo
already known to this store is now a HARD REJECT on `create`, not a soft
warning.** Verified live: creating with `repo:"Iso/chk"` succeeds, then
creating with `repo:"  Iso/Chk  "` (same value modulo case/whitespace)
instead returns `{"ok":false,"error":{"code":"invalid_argument","message":"repo
'  Iso/Chk  ' differs from the existing canonical value 'Iso/chk' only by
case/whitespace — use 'Iso/chk' instead."}}`. Use the EXACT existing
casing/spacing for a repo you've already filed under. A genuinely new repo
string (never seen before, even normalized) is still always allowed to file
its first item — it gets a soft `repoWarning` in the success response
instead of a rejection, never a hard block.

**`get` returns a terse card by default** (`humanId`/`kind`/`title`/`status`/
`priority`). Ask for more explicitly: `{"humanId":"BUG-001","fields":["body","repo","citations"]}`.
The full field vocabulary includes `related` (BUG-025 read side — the
humanIds of every OTHER live item linked via `relate`, in either direction)
and every other pseudo-field the response reports back as `omittedFields`
when you didn't ask for it — so `card.body === undefined` never has to mean
"actually empty," you can check whether `"body"` is in `omittedFields`
instead. Looking up a humanId that was **renamed** (a data-repair action, not
part of normal use) still resolves: `get` redirects to the current item and
says so in `warnings`, rather than 404ing on an id an old citation still
names.

## 3. Claim/renew/release protocol (multi-agent use)

- Identity (`by`) is always `${agentName}:${instanceId}` — NEVER a bare role
  literal like `"agent"`. Two concurrent agents both claiming as
  `"implementer"` defeats the CAS protocol entirely. `by` is required on
  every mutating verb and a blank value is rejected with `invalid_argument`.
- Claiming is idempotent for the SAME claimant — always `renewed`, no
  contention check.
- A long-running task must renew periodically (default staleness: 30 min):
  `adhd-backlog update --input '{"humanId":"BUG-042","by":"me:1","claim":"renew"}'`
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
adhd-backlog update --input '{
  "humanId": "BUG-MYAREA-001",
  "by": "claude:1",
  "status": "RESOLVED",
  "reason": "fixed in <commit sha>",
  "citations": [{ "file": "packages/x/src/y.ts", "lines": "40-58" }]
}'
```

Use `addCitation` on an `update` to attach evidence without a status change.

Optionally name the symbol a citation is about (`{ file, lines?, context?,
symbol? }`) to get best-effort blast-radius enrichment for free — the store
shells out to `gitnexus impact <symbol>` at write time (bounded timeout,
never blocks or fails the write) and stamps the citation's `blastRadius`
(`risk`/`impactedCount`/`direction`) if gitnexus is installed and the repo is
indexed. Absence of `blastRadius` on a citation that named a `symbol` means
"not enriched" (gitnexus unavailable, unindexed, timed out, symbol not
found) — never "confirmed zero blast radius."

## 5. Dedupe before filing — via the tool, not eyeballing

`create` runs a dedupe scan (FTS over title+body, plus exact symbol/path/
errorText metadata match) BEFORE writing. A likely match does **not** return
a success envelope with `created: false` — it **intercepts the write
entirely** and comes back as an ERROR arm, `code: "duplicate_candidate"`:

```
{"ok":false,"error":{"code":"duplicate_candidate","message":"create intercepted: 1 possible duplicate of \"…\" — resolve one, or re-issue with action:'file' to force","details":{}}}
```

**`error.details.candidates` is currently empty (`{}`) over the CLI transport**
(verified live against a real `create` round trip over the CLI; HTTP/MCP not
independently tested here) — even though
`client.ts` populates the candidate list in-process before throwing
(`DuplicateCandidateError`). This is a known open bug (BUG-032): a caller
cannot read the matched item's `humanId` off the `create` response alone.
**Always follow up a `duplicate_candidate` error with a `query`/`get` by
title** to find the existing item before deciding whether to enrich it or
force a new one. Only set `"duplicateAction":"file"` on the retry to force a
write after confirming — via that follow-up query — the match is genuinely a
distinct issue, never as a way to skip looking.

## 6. Worked examples

File a new item:

```
adhd-backlog create --input '{
  "item": {
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
If the response is instead the `duplicate_candidate` error (see §5), `query`
by title/family to find the existing item before deciding whether to force or
to enrich it instead. `item.author` defaults to the caller identity (`by`,
canonicalised) when omitted, and `item.reporter` defaults to `item.author`
when omitted.

What's still open in this repo:

```
adhd-backlog query --input '{"filter":{"repo":"PseudoSky/adhd","status":"OPEN"},"limit":50}'
```

Read one item in full:

```
adhd-backlog get --input '{"humanId":"BUG-MYAREA-001","repo":"PseudoSky/adhd","fields":["body","citations","notes"]}'
```

Reprioritize an item:

```
adhd-backlog update --input '{"humanId":"BUG-MYAREA-001","repo":"PseudoSky/adhd","by":"claude:1","priority":"CRITICAL"}'
```

Link two items in the SAME repo:

```
adhd-backlog relate --input '{"sourceId":"BUG-A-001","targetId":"BUG-B-002","relation":"related","action":"add","repo":"PseudoSky/adhd","by":"claude:1"}'
```

Link two items across DIFFERENT repos:

```
adhd-backlog relate --input '{"sourceId":"BUG-A-001","targetId":"BUG-B-002","relation":"dependency","action":"add","repo":"PseudoSky/adhd","targetRepo":"PseudoSky/other-repo","by":"claude:1"}'
```

## 7. Verify writes from a NEW process

An MCP `backlog_get` is answered by the same long-lived server process that
did the write, out of its own uncheckpointed WAL — so it can confirm rows
that will never exist on disk. After any write you care about, verify by
running the `adhd-backlog` CLI in a shell (a fresh process), not by re-reading
through the same MCP session.
