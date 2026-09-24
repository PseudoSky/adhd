---
name: backlog-usage
description: 'Use whenever filing, reading, claiming, transitioning, relating, or resolving a backlog issue — or registering a project/component/location — in ANY repo on this machine, via the `adhd-backlog` CLI / `mcp__backlog__*` tools, never by hand-editing a `BACKLOG.md` file. Examples: "log this bug", "file a debt item for the flaky test", "claim that issue", "what''s still open in this repo", "where does this tool live".'
---

# `@adhd/backlog` usage

`backlog` is a graph-backed, multi-agent backlog tool: issues, a project/
component/location registry, and the relationships between them, all served
from one store over four transports (CLI, MCP, HTTP, and in-process). This
skill is the ONLY place the command surface and calling convention are
documented — `AGENTS.md`/`CLAUDE.md` carry just a pointer to it.

Identity is the global `uid` returned by `create`/`upsertProject`/etc. —
never a family-scoped human-readable id. A `uid` is stable for the life of its
node, but a `body` edit replaces that node: as §3 below spells out, `update`
with a `body` mints a successor with a fresh `uid` and joins the two with a
`SUPERSEDES` edge. A uid you persisted earlier therefore stays *resolvable* but
may no longer be the *live* one — addressing it returns `conflict` and names
the successor. Never treat a stored uid as immutable across edits.

Every example below was run against `entrypoint/backlog/dist/index.js` built
from revision `9df2a5c7`, and its exact output is what is shown. A *globally
installed* `adhd-backlog` may be an older build: in particular `gitContext` on
`create`/`transition` (§6) exists in the `9df2a5c7` build but an older
installed build rejects it with `invalid_argument`. Compare the `backlog
create` line of `adhd-backlog --help` with §1 before relying on a field.

## 1. Command surface — 14 verbs (plus `batch`), one calling convention

**Every verb takes a single `--input` flag carrying one JSON object.** There
are no per-field flags.

```
adhd-backlog backlog get                --input '<IIssueGetInput json>'
adhd-backlog backlog query              --input '<IIssueQueryInput json>'
adhd-backlog backlog lookup             --input '{"q": "<tool, file path, or URL>"}'
adhd-backlog backlog create             --input '<ICreateIssueInput json>'
adhd-backlog backlog update             --input '<IUpdateIssueInput json>'
adhd-backlog backlog transition         --input '<ITransitionInput json>'
adhd-backlog backlog claim              --input '<IClaimInput json>'
adhd-backlog backlog relate             --input '<IRelateInput json>'
adhd-backlog backlog move               --input '<IMoveIssueInput json>'
adhd-backlog backlog upsert-project     --input '<IUpsertProjectInput json>'
adhd-backlog backlog upsert-component   --input '<IUpsertComponentInput json>'
adhd-backlog backlog upsert-location    --input '<IUpsertLocationInput json>'
adhd-backlog backlog rm-location        --input '<IRmLocationInput json>'
adhd-backlog backlog delete             --input '<IDeleteIssueInput json>'
adhd-backlog batch action               --input '<IBatchActionInput json>'
```

The `backlog` segment in front of every verb (and `batch` in front of
`action`) is the CLI namespace each operation is mounted under, and is the
form `adhd-backlog --help` prints. The leading segment is optional: the CLI
accepts both `adhd-backlog get --input …` and
`adhd-backlog backlog get --input …` (identical). Running `adhd-backlog
--help` (or an unknown command) prints the exact live shape of every input:

```
$ adhd-backlog --help
Available commands:

  backlog claim  { input: { uid: string, by: string, action: 'claim'|'release'|'renew', force?: boolean } }
  backlog create  { input: { title: string, body: string, project: string, component?: string, kind?: string, status?: string, priority?: string, citations?: object[], author?: string, assignee?: string, gitContext?: string, by: string, duplicateAction?: 'abort'|'force'|'comment', awaitEmbed?: boolean } }
  backlog delete  { input: { uid: string, reason: string, by: string, awaitEmbed?: boolean } }
  backlog get  { input: { uid: string, fields?: union[] } | { registry: 'project'|'component'|'location', name: string, filter?: object } }
  backlog lookup  { input: { q: string } }
  backlog move  { input: { uid: string, toProject?: string, toComponent?: string, by: string } }
  backlog query  { input: { text?: string, filter?: object, fields?: union[], sort?: 'priority'|'updated'|'created'|'relevance'|'textMatch', direction?: 'asc'|'desc', limit?: number, offset?: number, after?: string, view?: 'list'|'ready'|'graph'|'order'|'stale'|'similar'|'overlap'|'projects'|'components'|'locations', format?: 'json'|'markdown', overlapAxis?: 'file'|'project'|'component'|'author', overlapUids?: string[], staleAfterMin?: number } }
  backlog relate  { input: { sourceUid: string, targetUid: string, rel: 'relates_to'|'supersedes'|'blocks'|'duplicate_of'|'part_of', action: 'add'|'remove', by: string } }
  backlog rm-location  { input: { uid: string, by: string, reason?: string } }
  backlog transition  { input: { uid: string, by: string, toStatus: string, note?: string, citations?: object[], gitContext?: string } }
  backlog update  { input: { uid: string, by: string, title?: string, body?: string, kind?: string, priority?: string, assignee?: string, author?: string, awaitEmbed?: boolean } }
  backlog upsert-component  { input: { project: string, name: string, path?: string, description?: string, by: string } }
  backlog upsert-location  { input: { component: string, project?: string, locType: 'path'|'url'|'tool', value: string, by: string } }
  backlog upsert-project  { input: { name: string, path?: string, repoUrl?: string, monorepo?: boolean, description?: string, by: string } }
  batch action  { input: { operation: 'backlog/get', items: object[], concurrency?: number, mode?: 'parallel'|'serial'|'chained', onItemError?: 'continue'|'abort', itemTimeoutMs?: number } }
```

Trust that output over anything hardcoded here — it is the live schema, not
a stale copy of it.

### Special commands — no `--input`, and not verbs

`serve`, `install-skill` (alias `install`), `search`, `sandbox-path`, and
`store-check` are handled before the command table:

```
adhd-backlog serve [--transport mcp|http|both] [--port N] [--host H]
adhd-backlog install-skill [--host claude|codex|opencode|all] [--scope user|project]
adhd-backlog search "<query text>" [--limit n]
adhd-backlog sandbox-path
adhd-backlog store-check
```

`store-check` reports the store vocabulary this build expects versus the kinds
actually present in the resolved store, exiting non-zero on a mismatch — useful
after pointing a build at a store written by a different build.

`sandbox-path` prints the resolved store location and exits without opening
it — `{"namespace":"production"|"test"|"sandbox","adhdRoot":"…","dbPath":"…","embeddingEnabled":bool}`.
Use it to confirm WHICH store a command would touch before running a write.
Combined with the global `--namespace sandbox` flag (valid before any
command) it reports the throwaway store that flag would mint, so you can
check isolation without creating anything.

Two conventions apply to every transcript below. **Uids are truncated with
`…` for readability** — always pass the FULL value the previous call
returned, never the ellipsis form. And **every invocation prints warnings on
stderr** (telemetry, the embedding backend, onnxruntime) whether or not it
succeeded; stdout carries the JSON envelope alone. Parse stdout, key on the
exit code, and ignore stderr — it is noise, not a failure signal.

`search "x" --limit 2` is the argv-flag shortcut for `backlog query --input
'{"text":"x","limit":2}'` — same envelope, same exit codes, verified:

```
$ adhd-backlog search "auth module" --limit 5
{"ok":true,"data":{"view":"list","items":[{"uid":"…","title":"Flaky test in auth module","kind":"issue","status":"closed","priority":"CRITICAL"}],"hasMore":false},"meta":{"total":1,"returned":1,"limit":5}}
```

`--namespace <value>` is a global flag valid before ANY command — it selects
which declared store instance to resolve against: `production` (default),
`test` (a persisted, non-ephemeral store), or `sandbox`. `--namespace
sandbox` additionally diverts the invocation into a fresh throwaway store
(`mkdtemp` + its own DB) instead of the real one, writes a real `config.yaml`
there with `embedding.enabled: false` so a sandboxed run never pays a real
model-load cost, and prints the path so you can pass `ADHD_ROOT=<path>` to
reuse it across calls. Use it whenever you want to try a command without
touching production data — verified:

```
$ adhd-backlog --namespace sandbox backlog upsert-project --input '{"name":"sandbox-demo","by":"claude:1"}'
[backlog] --namespace sandbox: isolated store at /var/folders/.../backlog-sandbox-AL1cJH (not auto-deleted — pass ADHD_ROOT=... to reuse it, or remove it yourself when done)
{"ok":true,"data":{"uid":"3ec19363-cd8c-4479-8d7f-c8e4e9f0948b","created":true,"project":{"uid":"3ec19363-cd8c-4479-8d7f-c8e4e9f0948b","name":"sandbox-demo"}}}
```

## 2. The outcome envelope — every verb, every transport

Every verb returns one of exactly two shapes, always the same envelope
regardless of transport:

```jsonc
{ "ok": true,  "data": { /* verb-specific payload */ }, "warnings": [], "meta": {} }
{ "ok": false, "error": { "code": "item_not_found", "message": "…", "details": {} } }
```

Never assume an unwrapped payload — always read `envelope.data`. **This holds
for every error a VERB itself reports** — a validation failure the operation's
own logic detects (bad `limit`, unknown filter key, a terminal transition
missing its citation) always comes back as `{"ok":false,"error":{...}}` on
stdout, exit non-zero.

It does NOT hold for a malformed `--input` on the CLI: a request that fails
the outer ajv schema check — missing a required field, an unknown property,
invalid JSON — never reaches a verb's own logic at all. That class prints an
UNWRAPPED `{"code":"invalid_argument","message":"…","details":[...]}` (no
`ok` key) to **stderr**, not stdout, still with the matching `invalid_argument`
exit code below. A caller that only reads stdout per the envelope contract
gets nothing at all for this — the single most common error shape a bad
caller hits — so read stderr too whenever stdout is empty and the exit code
is non-zero. There are exactly nine error codes for a verb's own reported
failures, and the CLI's process exit code is derived from `error.code`:

| code                  | exit | meaning                                                                                                          |
| --------------------- | ---- | ---------------------------------------------------------------------------------------------------------------- |
| `not_found`           | 4    | a referenced catalog entry (project/component/kind/status/priority) does not exist                               |
| `item_not_found`      | 1    | the addressed issue `uid` does not exist                                                                         |
| `invalid_argument`    | 2    | malformed flag or parameter shape                                                                                |
| `validation`          | 2    | schema rejection — unknown filter key, unknown projection field, over-limit                                      |
| `store_busy`          | 1    | store contention (busy/lease) — `details.retryable`/`retryAfterMs` say whether and how to retry; never hot-loop  |
| `rag_not_configured`  | 1    | a semantic/similarity read with no embedding backend, or an empty vector space                                   |
| `conflict`            | 1    | someone else holds the claim, a single-valued relation is taken, or a supersede raced                            |
| `precondition_failed` | 1    | a gate refused the write — a terminal transition missing its required citation/note, or an unverifiable citation |
| `internal`            | 1    | unclassified server-side failure                                                                                 |

Success is always exit `0`.

### MCP tool names

Each verb is also an MCP tool once `.mcp.json` wires the server, named
`backlog_<verb>` with the verb's own words snake_cased: `backlog_get`,
`backlog_query`, `backlog_lookup`, `backlog_create`, `backlog_update`,
`backlog_transition`, `backlog_claim`, `backlog_relate`, `backlog_move`,
`backlog_upsert_project`, `backlog_upsert_component`,
`backlog_upsert_location`, `backlog_rm_location`, `backlog_delete`, plus the
un-namespaced `batch_action`.

## 3. Issue verbs — worked examples

Every mutating verb requires `by` — the acting identity, always
`${agentName}:${instanceId}`, never a bare role literal like `"agent"`. A
missing/blank `by` is rejected with `invalid_argument` before any write
runs.

**File a new issue.** `project` is RESOLVE-ONLY — `create` never mints one;
register it first with `upsert-project` (§4). `component` is also resolve-only
and defaults to the project's reserved `(root)` component when omitted — pass
it, or the item is invisible to component-scoped scans (§4, "The filing rule"):

```
$ adhd-backlog backlog create --input '{
  "title": "Flaky test in auth module",
  "body": "The auth integration test times out intermittently.",
  "project": "demo-project",
  "by": "claude:1",
  "priority": "HIGH"
}'
{"ok":true,"data":{"created":true,"uid":"a61ff0b6-a0f1-4189-9923-671f6cbacd4e","item":{"uid":"a61ff0b6-a0f1-4189-9923-671f6cbacd4e","title":"Flaky test in auth module","kind":"issue","status":"open","priority":"HIGH","project":"020e87f2-…","component":"dcf134ab-…","createdAt":"2026-09-17T01:22:56.056Z","author":"claude:1"}}}
```

Filing more than a handful of similar issues in a row? Use `batch action`
(§5) instead of repeating this call.

`create` runs a dedupe scan (FTS + semantic, when embeddings are configured)
BEFORE writing. `duplicateAction` (default `'abort'`) controls what happens
when the scan surfaces a candidate at/above the project's dedupe threshold:
`'abort'` — nothing is written, `{created:false, reason:'duplicate-suppressed',
duplicateCandidates}`; `'force'` — writes a genuinely new issue anyway,
still reporting `duplicateCandidates`; `'comment'` — no new issue is
written, a note is attached to the top-scoring candidate instead. A
zero-candidate scan proceeds to a normal create regardless of
`duplicateAction`. **Always inspect `duplicateCandidates` before forcing.**

**Read one issue.** `get` returns a terse five-field card
(`uid`/`kind`/`title`/`status`/`priority`) by default — ask for more
explicitly:

```
$ adhd-backlog backlog get --input '{"uid":"a61ff0b6-…"}'
{"ok":true,"data":{"uid":"a61ff0b6-…","title":"Flaky test in auth module","kind":"issue","status":"open","priority":"HIGH"}}

$ adhd-backlog backlog get --input '{"uid":"a61ff0b6-…","fields":["body","citations"]}'
{"ok":true,"data":{"uid":"a61ff0b6-…","body":"The auth integration test times out intermittently.","citations":[]}}
```

`get`'s own `--help` now renders its full union —
`{ uid, fields? } | { registry, name, filter? }`. The second form reads one
registry entry by name directly, e.g.
`{"registry":"project","name":"demo-project"}` returns the project's
`{uid, name, path, components, locations}` — the same data `query`'s
`view:"projects"`/`"components"`/`"locations"` list in bulk (§4).

The full field vocabulary is `uid, title, kind, status, priority, project,
component, createdAt, updatedAt, assignee, author, closedAt` (cheap/plain)
plus `body, citations, notes, auditTrail, blockers, related, _score,
_vector` (opt-in only — each costs a genuine extra read, so none is in the
default card).

**Search/filter/page issues:**

```
$ adhd-backlog backlog query --input '{"filter":{"project":"demo-project","status":"open"},"limit":10}'
{"ok":true,"data":{"view":"list","items":[{"uid":"a61ff0b6-…","title":"Flaky test in auth module","kind":"issue","status":"open","priority":"HIGH"}],"hasMore":false},"meta":{"total":1,"returned":1,"limit":10}}
```

`query.view` (default `'list'`) selects the result shape: `list` · `ready` ·
`graph` · `order` · `stale` · `similar` · `overlap` · `projects` · `components`
· `locations` (the last three are the registry LIST views — §4). `text` is the
natural-language form — routed to `filter.semantic` when a populated vector
space can rank it, or `filter.grep` (keyword FTS) otherwise; never set
`text` alongside `filter.semantic`/`filter.grep` yourself. Pagination is
truthful: `meta.total` is the count before `limit`/`offset`, `meta.returned`
is `data.items.length`, and a page cut short for any reason other than your
own `limit` sets `meta.truncated`.

**Edit an existing issue.** Every field edits in place **except `body`**: a
`body` change SUPERSEDES the issue, minting a successor node with a fresh
`uid` and carrying the old node's edges forward. The response's `uid` is the
successor; the old `uid` becomes a `SUPERSEDES`-linked history node, and
addressing it returns `conflict` naming the successor (see the example below).
A caller that persists uids must follow that pointer after any body edit.
`status` is not editable here — use `transition`:

```
$ adhd-backlog backlog update --input '{"uid":"a61ff0b6-…","by":"claude:1","priority":"CRITICAL"}'
{"ok":true,"data":{"uid":"a61ff0b6-…","changed":["priority"]}}
```

A `body` edit returns the successor's `uid`, and the pre-edit `uid` then
resolves to a redirect (never to the stale record):

```
$ adhd-backlog backlog update --input '{"uid":"a61ff0b6-…","by":"claude:1","body":"new body"}'
{"ok":true,"data":{"uid":"e3b32183-…","changed":["body"]}}

$ adhd-backlog backlog get --input '{"uid":"a61ff0b6-…"}'
{"ok":false,"error":{"code":"conflict","message":"Issue \"a61ff0b6-…\" was superseded by a body edit and is no longer the live issue; it now lives under \"e3b32183-…\"","details":{"retryable":false}}}
```

**Move an issue to a new status.** A terminal `toStatus` REQUIRES `citations`
only when the project's policy turns citation enforcement ON — `citationRequired`
defaults to `false`, so out of the box no citation is required. When a project
HAS turned it on, citations must be verifiable against the project's own
filesystem path — an unverifiable citation is rejected with `precondition_failed`:

```
$ adhd-backlog backlog transition --input '{
  "uid": "a61ff0b6-…", "by": "claude:1", "toStatus": "closed",
  "note": "fixed",
  "citations": [{ "file": "packages/auth/src/index.ts", "lines": "1-1" }]
}'
{"ok":true,"data":{"uid":"a61ff0b6-…","fromStatus":"open","toStatus":"closed","transitionUid":"8b802b1b-…"}}
```

**`toStatus` is an open catalog, not a fixed enum.** `open`/`claimed`/
`closed` are the conventional names, not the permitted set. An unresolved
NAME is not an error — it MINTS a new status (`terminal:false`) and the
transition succeeds, exactly as `create`'s own `status` field behaves. Only a
uid-SHAPED reference resolving to nothing is rejected, with `not_found`:

```
$ adhd-backlog backlog transition --input '{"uid":"a61ff0b6-…","by":"claude:1","toStatus":"awaiting-review","note":"n"}'
{"ok":true,"data":{"uid":"a61ff0b6-…","fromStatus":"open","toStatus":"awaiting-review","transitionUid":"f52b0f50-…"}}
```

So a typo becomes a real status rather than an error, and the issue silently
leaves the set `filter.status:"open"` returns. Treat the status name as
load-bearing input: pass one you can spell, or read the catalog first.

**Claim / renew / release protocol (multi-agent use).** Claiming is
idempotent for the SAME claimant — a second `action:"claim"` from the same
`by` returns `status:"renewed"` rather than a contention error, so retrying
after a lost response is always safe. A
long-running task renews periodically; every exit path releases
unconditionally (a no-op if already unclaimed):

```
$ adhd-backlog backlog claim --input '{"uid":"a61ff0b6-…","by":"claude:1","action":"claim"}'
{"ok":true,"data":{"uid":"a61ff0b6-…","status":"claimed","claimedBy":"claude:1","claimedAt":"2026-09-17T01:24:31.896Z"}}

$ adhd-backlog backlog claim --input '{"uid":"a61ff0b6-…","by":"claude:1","action":"renew"}'
{"ok":true,"data":{"uid":"a61ff0b6-…","status":"renewed","claimedBy":"claude:1","claimedAt":"2026-09-17T01:24:33.468Z"}}

$ adhd-backlog backlog claim --input '{"uid":"a61ff0b6-…","by":"claude:1","action":"release"}'
{"ok":true,"data":{"uid":"a61ff0b6-…","status":"released"}}
```

**Link two issues.** `rel` is one of `relates_to`, `supersedes`, `blocks`,
`duplicate_of`, `part_of` — NOT the bare word `"related"`:

```
$ adhd-backlog backlog relate --input '{"sourceUid":"777c5e33-…","targetUid":"a61ff0b6-…","rel":"relates_to","action":"add","by":"claude:1"}'
{"ok":true,"data":{"sourceUid":"777c5e33-…","targetUid":"a61ff0b6-…","rel":"relates_to","action":"add","noop":false}}
```

`noop:true` means `add` found an already-live matching edge, or `remove`
found none — no edge was written and no audit row produced; never assume
every call was a fresh write. `targetUid` may belong to a different project
than `sourceUid`.

**Move an issue to a different project/component.** `toProject`/
`toComponent` are RESOLVE-ONLY, never minted — register the destination
first with `upsert-project`/`upsert-component` if it doesn't exist yet:

```
$ adhd-backlog backlog move --input '{"uid":"777c5e33-…","toProject":"demo-project","by":"claude:1"}'
{"ok":true,"data":{"uid":"777c5e33-…","noop":false,"fromProject":"38b9af5d-…","toProject":"020e87f2-…","fromComponent":"22113591-…","toComponent":"dcf134ab-…"}}
```

**Soft-delete an issue.** `reason` is REQUIRED. The node is closed off
bi-temporally, never physically removed — its audit trail and every edge
pointing at it remain readable:

```
$ adhd-backlog backlog delete --input '{"uid":"777c5e33-…","reason":"duplicate of tracked work","by":"claude:1"}'
{"ok":true,"data":{"uid":"777c5e33-…","invalidated":true}}
```

## 4. Registry — project / component / location

The registry answers **"where does this live, and what do I file the bug
against?"** in one call, before you `rg`/search for it.

### The model

- **project** — one repo/workspace root, registered with its filesystem `path`
  and/or git `repoUrl`. ONE canonical row per logical repo (`adhd`,
  `sox-ecosystem`). Every issue verb RESOLVES a project by name or `uid` and
  **never mints one** — an unknown project name is `not_found` (exit 4).
- **component** — a path *within* that project (`entrypoint/backlog`,
  `tools/nx-plugins/build`), resolved-only within its project. `upsert-project`
  mints exactly ONE reserved component, `(root)`, per project; `create`
  defaults an omitted `component` to it. **No other component is ever
  auto-created** — an unknown component name is `not_found`, never a new row.
- **location** — a tool name, file path, or URL owned by a component; the thing
  `lookup` resolves.

### The filing rule — file every item with the right project AND component

A component-less item is not an error: it lands on `(root)` and is then
**invisible to every component-scoped query** (`filter.component:"…"`), while
still appearing in a project-scoped one. That is the misfiling signature —
`get <uid>` finds the item, but the component scan that should list it never
does. So, before filing:

1. Discover the exact registered names:
   `adhd-backlog query --input '{"view":"projects"}'` and
   `adhd-backlog query --input '{"view":"components","filter":{"project":"<p>"}}'`.
2. Register anything missing with `upsert-project`/`upsert-component` FIRST.
3. `create` with both `project` and `component`.

A component-scoped scan is how a repo's own work is found (e.g.
`filter.component:"entrypoint/backlog"` for this repo's own items, or project
`adhd`); an item filed on `(root)` is invisible to it.

### When to use each registry verb

| verb | use it when | idempotent key |
| --- | --- | --- |
| `upsert-project` | registering/updating a repo or workspace root; also mints its `(root)` component | `name` |
| `upsert-component` | registering/updating a path *inside* an already-registered project | `(project, name)` |
| `upsert-location` | pointing a tool/file/URL at its owning component so `lookup` resolves it | `(component, locType, value)` |
| `rm-location` | retiring a location (soft-invalidate) | `uid` |

All four are create-or-update by that key — never a duplicate row — and all
require `by`.

**Register or update a project** (create-or-update by `name`; also mints the
project's reserved default component `(root)` on first creation):

```
$ adhd-backlog backlog upsert-project --input '{"name":"demo-project","path":"/tmp/demo","by":"claude:1"}'
{"ok":true,"data":{"uid":"020e87f2-…","created":true,"project":{"uid":"020e87f2-…","name":"demo-project","path":"/tmp/demo"}}}
```

**Register or update a component** (create-or-update by `(project, name)`;
`project` is resolve-only):

```
$ adhd-backlog backlog upsert-component --input '{"project":"demo-project","name":"auth-service","path":"packages/auth","by":"claude:1"}'
{"ok":true,"data":{"uid":"41a61c6d-…","created":true,"component":{"uid":"41a61c6d-…","name":"auth-service","projectUid":"020e87f2-…","path":"packages/auth"}}}
```

**Register a location** — a tool name, file path, or URL owned by a
component. A bare component NAME requires `project` to disambiguate it (a
`uid` never does):

```
$ adhd-backlog backlog upsert-location --input '{"component":"auth-service","project":"demo-project","locType":"path","value":"packages/auth/src/index.ts","by":"claude:1"}'
{"ok":true,"data":{"uid":"a4b0dd6b-…","created":true,"location":{"uid":"a4b0dd6b-…","locType":"path","value":"packages/auth/src/index.ts","componentUid":"41a61c6d-…"}}}
```

**Resolve a tool, file, or URL to its owning project/component** — the
go-to before searching for "which repo owns this?":

```
$ adhd-backlog backlog lookup --input '{"q":"packages/auth/src/index.ts"}'
{"ok":true,"data":{"project":{"uid":"020e87f2-…","name":"demo-project","path":"/tmp/demo"},"component":{"uid":"41a61c6d-…","name":"auth-service","path":"packages/auth"},"location":{"uid":"a4b0dd6b-…","locType":"path","value":"packages/auth/src/index.ts"}}}
```

`lookup` classifies `q` automatically as a tool name, file path, or URL —
it only resolves against LOCATIONS already registered via `upsert-location`,
never against a bare project/component name. An unregistered value returns
`not_found` (exit 4); a path miss falls back to a suffix/prefix scan before
giving up, and reports a `hint` when only a partial match was found — never
a silent empty result.

**Remove a location** (soft-invalidate by `uid`):

```
$ adhd-backlog backlog rm-location --input '{"uid":"a4b0dd6b-…","by":"claude:1","reason":"tool renamed"}'
{"ok":true,"data":{"uid":"a4b0dd6b-…","invalidated":true}}
```

**List every project/component/location in the registry** — the go-to for
"what does this repo have registered?" without hand-rolling a scan. This is
`query`'s `view:"projects"`/`"components"`/`"locations"` (not a separate
verb): every live row of that kind, optionally scoped by `filter.project`
(and, for `locations`, `filter.component`):

```
$ adhd-backlog backlog query --input '{"view":"projects"}'
{"ok":true,"data":{"view":"projects","items":[{"uid":"020e87f2-…","name":"demo-project","path":"/tmp/demo"}]}}

$ adhd-backlog backlog query --input '{"view":"components","filter":{"project":"demo-project"}}'
{"ok":true,"data":{"view":"components","items":[{"uid":"41a61c6d-…","name":"auth-service","projectUid":"020e87f2-…","path":"packages/auth"},{"uid":"…","name":"(root)","projectUid":"020e87f2-…"}]}}

$ adhd-backlog backlog query --input '{"view":"locations","filter":{"component":"auth-service","project":"demo-project"}}'
{"ok":true,"data":{"view":"locations","items":[{"uid":"a4b0dd6b-…","locType":"path","value":"packages/auth/src/index.ts","componentUid":"41a61c6d-…"}]}}
```

### Filing hazards (real, observed on this machine)

1. **Duplicate project identities.** The same repo can exist as TWO project
   rows — one path-derived, one repo-derived — and an item lands under
   whichever name you pass. Observed split (2026-09-22): `sox-ecosystem` (path)
   vs `PseudoSky/sox-ecosystem` (no path); `claude-agents` (path) vs
   `PseudoSky/claude-agents`; `claude-tools` vs `QuSecure/claude-tools`;
   `dot` vs `id8/dot`. Prefer the row that carries a `path` (and, for an
   active repo, the bulk of the items) — an item under the other row is
   invisible to a query scoped to the first. (`adhd` is already reconciled to
   one row; `PseudoSky/adhd` does not exist.)
2. **Store/scope confusion — an item can land in a store nobody reads.**
   `adhd-backlog sandbox-path` reports the store a command will touch. The
   production store is `~/.adhd/backlog/production/data/backlog-v2.db`;
   `--namespace test` resolves a DIFFERENT file (`…/test/data/backlog.db`).
   `ADHD_BACKLOG_SCOPE=project` relocates the store under `<repo>/.adhd/…`
   only for the FALLBACK path: an absolute `db.path` set in any config layer
   wins over it (`db.path ?? files.db`), and this machine's production config
   sets one — so here the scope does NOT move the store. Never infer the store
   from the environment; run `sandbox-path` and read the path it prints. A
   build that writes a per-repo namespace (e.g. `entrypoint/backlog` on
   `main`) files items that are silently absent from production — no error,
   just a missing row (filed as 49ce83b8). Run `sandbox-path` before a write
   you care about, and file through the production CLI only.

## 5. Batch — N-way fan-out over one operation

`batch action` runs the SAME operation over many items. `operation` is the
mounted operation id, namespaced as `backlog/<verb>` (not the bare verb
name), and each entry in `items` wraps its payload under `input`:

```
$ adhd-backlog batch action --input '{
  "operation": "backlog/create",
  "items": [
    { "input": { "title": "Batch item one", "body": "first",  "project": "demo-project", "by": "claude:1" } },
    { "input": { "title": "Batch item two", "body": "second", "project": "demo-project", "by": "claude:1" } }
  ]
}'
[{"index":0,"status":"fulfilled","value":{"ok":true,"data":{"created":true,"uid":"874dfa26-…", …}}},
 {"index":1,"status":"fulfilled","value":{"ok":true,"data":{"created":true,"uid":"e071b0b8-…", …}}}]
```

Each result is `{index, status:'fulfilled', value}` or `{index,
status:'rejected', reason}` — `value`/`reason` is the SAME outcome envelope
`backlog/<verb>` would return standalone, so a batched item's own `ok`/
`error.code` still applies. `mode` (`'parallel'` default · `'serial'` ·
`'chained'`), `onItemError` (`'continue'` default · `'abort'`), and
`concurrency`/`itemTimeoutMs` govern how the fan-out runs. The valid
`operation` values are exactly the 14 issue/registry verbs above, each
prefixed `backlog/` — passing a bare verb name (`"create"`) is rejected with
`invalid_argument` naming the full list.

## 6. Citations — structured, not hand-typed markdown

A citation is `{ file, lines?, context?, symbol? }`. Pass `citations` on
`create` or on the `transition` that moves an issue into a terminal status.
They are required and enforced only when the project's policy demands it:
`citationRequired` defaults to `false`, so out of the box a terminal
transition needs no citation (what IS required by default is a `note` —
`transitionRequiresNote`). When a project HAS turned `citationRequired` on, a
terminal transition with no citations, or with an unverifiable one, is
rejected with `precondition_failed`. "Unverifiable" means the file
could not be confirmed to exist under the project's own registered path —
never resolved outside it. The verification gate applies only when the
project HAS a registered path; a project with no `path` cannot hash any
citation target at all, so its citations are accepted and recorded with
`sha: "unverified"`.

Name a `symbol` on a citation to get best-effort blast-radius enrichment for
free — the store shells out to `gitnexus impact <symbol>` at write time
(bounded timeout, never blocks or fails the write) and stamps the citation's
`blastRadius` when gitnexus is installed and the repo is indexed. Absence of
`blastRadius` on a citation that named a `symbol` means "not enriched," never
"confirmed zero blast radius."

The item-level **`gitContext`** is separate from a citation's own `context`.
Pass `gitContext` on `create` (or on a `transition` to update it) to record
the repo disclosure contract's `<active git context>` — the FIRST element of a
`Citations:` block (`Citations: [<active git context>, …]`, per the repo
`AGENTS.md` "Cite what you read"). It is stored on the issue itself, never per
citation, and a `format:'markdown'` query renders it once at the head of the
item's `Citations:` block (`Citations: [<active git context>]`, then the
citation lines). Omit it and nothing is stored and no output changes. A
citation's own `context` is free-text prose and is never rendered by the
markdown projection — it cannot carry the git context.

## 7. Verify writes from a NEW process

An MCP `backlog_get` served by a long-lived `serve` process can answer out
of that process's own in-memory/uncheckpointed state. After a write you
care about, verify by running the `adhd-backlog` CLI in a fresh shell — a
genuinely new process — rather than re-reading through the same live MCP
session.

## 8. Library-only views — query-layer exports, not a command surface

Three aggregate read views are exported from the package's query layer
(`src/query/views/stats.ts`, re-exported by `src/query/index.ts`) and are **not**
members of `query.view`. In the committed `9df2a5c7` build there is no CLI verb
or MCP tool for them — reach them by importing `@adhd/backlog` in-process. (A
development build may mount some of them; run `adhd-backlog --help` to see what
a given build exposes.)

- `priorityMatrix(handle, { filter? })` — per-priority issue counts, scoped by
  `project`/`component`/`kind`/`status`. An omitted `status` scopes to OPEN
  work (unlike `list`, where an omitted status means no restriction); pass
  `filter.status:'all'` to remove that default, and read the applied scope off
  the result's `statusScope`.
- `partOfRollup(handle, { uid })` — every TRANSITIVE `part_of` descendant of an
  issue (not just direct children), counted exactly once each regardless of
  chain depth.
- `openCurve(handle, { filter?, at })` — for each sampled ISO-8601 instant, how
  many in-scope issues existed and how many are reconstructed as open.

Described for consumers in `README.md` → "Library API".
