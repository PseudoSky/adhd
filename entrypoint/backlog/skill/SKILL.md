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
`SUPERSEDES` edge. A uid you persisted earlier therefore stays _resolvable_ but
may no longer be the _live_ one — addressing it returns `conflict` and names
the successor. Never treat a stored uid as immutable across edits.

Every example below was run against `entrypoint/backlog/dist/index.js` and its
exact output is what is shown. The obligations/verdict (§4), spec-pointer (§5),
and catalog/order (§6) examples were run on the build that mounts all 27 verbs;
the §11 stats/rollup examples on the build that first mounted those ops. A
_globally installed_ `adhd-backlog` may be an older build: in particular
`gitContext` on `create`/`transition` (§9) exists in the `9df2a5c7` build but
an older installed build rejects it with `invalid_argument`, and the §11 stats
ops (`priority-matrix`/`part-of-rollup`/`open-curve`/`report`) exist only in a build at
or after the one that mounted them. Compare the `backlog create`, `backlog
priority-matrix`, and `backlog obligate` lines of `adhd-backlog --help` with §1
before relying on a field.

## 1. Command surface — 27 verbs (plus `batch`), one calling convention

**Every verb except `embedding-status` takes a single `--input` flag carrying
one JSON object** (`embedding-status` takes no options at all). There
are no per-field flags: a per-field option (`get --uid …`, `query --view
list`, `create --title …`, `batch action --operation …`) is rejected with
`invalid_argument` (exit 2) and the message
`Unknown option: --<field>. Available: --input`. The generated `--help`
footer's "per-field flags are also accepted" line is boilerplate that does
**not** hold for these commands — `--input` is the only option any verb
accepts, verified by running it. (The special commands `serve`,
`install-skill`, and `search` are the exception: they take argv flags and no
`--input`.)

Any verb that takes a `uid` also accepts a **unique uid prefix** (8+ hex
characters — the first UUID block, e.g. `4fc3704e`). An exact uid always wins;
a prefix matching two or more live nodes is refused with `ambiguous_reference`
(exit 1) naming every candidate, and an unmatched prefix is `item_not_found`.
A prefix shorter than 8 characters is refused as too short.

```
adhd-backlog backlog attest             --input '<IAttestInput json>'
adhd-backlog backlog claim              --input '<IClaimInput json>'
adhd-backlog backlog create             --input '<ICreateIssueInput json>'
adhd-backlog backlog delete             --input '<IDeleteIssueInput json>'
adhd-backlog backlog embedding-status                (no options — takes neither --input nor any flag)
adhd-backlog backlog get                --input '<IIssueGetInput json>'
adhd-backlog backlog lookup             --input '<ILookupInput json>'
adhd-backlog backlog merge-project      --input '<IMergeProjectInput json>'
adhd-backlog backlog move               --input '<IMoveIssueInput json>'
adhd-backlog backlog obligate           --input '<IObligateInput json>'
adhd-backlog backlog open-curve         --input '<IOpenCurveInput json>'
adhd-backlog backlog part-of-rollup     --input '<IPartOfRollupInput json>'
adhd-backlog backlog priority-matrix    --input '<IPriorityMatrixInput json>'
adhd-backlog backlog query              --input '<IIssueQueryInput json>'
adhd-backlog backlog recheck            --input '<IRecheckInput json>'
adhd-backlog backlog relate             --input '<IRelateInput json>'
adhd-backlog backlog report             --input '<IReportInput json>'
adhd-backlog backlog rm-location        --input '<IRmLocationInput json>'
adhd-backlog backlog rm-project         --input '<IRmProjectInput json>'
adhd-backlog backlog spec-append        --input '<ISpecAppendInput json>'
adhd-backlog backlog spec-check         --input '<ISpecCheckInput json>'
adhd-backlog backlog transition         --input '<ITransitionInput json>'
adhd-backlog backlog unobligate         --input '<IUnobligateInput json>'
adhd-backlog backlog update             --input '<IUpdateIssueInput json>'
adhd-backlog backlog upsert-component   --input '<IUpsertComponentInput json>'
adhd-backlog backlog upsert-location    --input '<IUpsertLocationInput json>'
adhd-backlog backlog upsert-project     --input '<IUpsertProjectInput json>'
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

Namespaced verbs (namespace + verb, per-field flags):
  batch action  { input: { operation: 'backlog/get', items: object[], concurrency?: number, mode?: 'parallel'|'serial'|'chained', onItemError?: 'continue'|'abort', itemTimeoutMs?: number } }

Verbs (one-token, --input JSON envelope):
  backlog attest  { input: { subject: object, claim: object, anchor: object, by: string } }
  backlog claim  { input: { uid: string, by: string, action: 'claim'|'release'|'renew', force?: boolean } }
  backlog create  { input: { title: string, body: string, project: string, component?: string, kind?: string, status?: string, priority?: string, citations?: object[], author?: string, assignee?: string, gitContext?: string, dedupeExcludeUid?: string, by: string, duplicateAction?: 'abort'|'force'|'comment', awaitEmbed?: boolean } }
  backlog delete  { input: { uid: string, reason: string, by: string, awaitEmbed?: boolean } }
  backlog embedding-status
  backlog get  { input: { uid: string, fields?: union[], lastN?: number, after?: string, deriveThrough?: 1|2|3|4|5 } | { registry: 'project'|'component'|'location', name: string, filter?: object } }
  backlog lookup  { input: { q: string, kind?: string } }
  backlog merge-project  { input: { fromUid: string, toUid: string, by: string } }
  backlog move  { input: { uid: string, toProject?: string, toComponent?: string, by: string } }
  backlog obligate  { input: { uid: string, applies_to: object, requirement: union, on_fail: 'block'|'warn', override?: object, by: string } }
  backlog open-curve  { input: { filter?: object, at: string[] } }
  backlog part-of-rollup  { input: { uid: string, countOnly?: boolean, limit?: number, after?: string } }
  backlog priority-matrix  { input: { filter?: object } }
  backlog query  { input: { text?: string, filter?: object, fields?: union[], sort?: 'priority'|'updated'|'created'|'relevance'|'textMatch', direction?: 'asc'|'desc', limit?: number, offset?: number, after?: string, view?: 'list'|'ready'|'graph'|'order'|'stale'|'similar'|'overlap'|'projects'|'components'|'locations'|'kinds'|'catalogs', format?: 'json'|'markdown', overlapAxis?: 'file'|'project'|'component'|'author', overlapUids?: string[], staleAfterMin?: number, catalog?: 'kind'|'status'|'priority'|'relation'|'field'|'error_code'|'location_type'|'verb' } }
  backlog recheck  { input: { attestationUid: string, by: string } }
  backlog relate  { input: { sourceUid: string, targetUid: string, rel: 'relates_to'|'supersedes'|'blocks'|'duplicate_of'|'part_of'|'similar_to', action: 'add'|'remove', by: string } }
  backlog report  { input: { filter?: object } }
  backlog rm-location  { input: { uid: string, by: string, reason?: string } }
  backlog rm-project  { input: { uid: string, reason: string, by: string } }
  backlog spec-append  { input: { uid: string, fragment: string, anchor?: object, base_revision: string, by: string } }
  backlog spec-check  { input: { uid: string, token?: string } }
  backlog transition  { input: { uid: string, by: string, toStatus: string, note?: string, citations?: object[], gitContext?: string, override?: object } }
  backlog unobligate  { input: { obligationUid: string, by: string } }
  backlog update  { input: { uid: string, by: string, title?: string, body?: string, kind?: string, priority?: string, assignee?: string, author?: string, awaitEmbed?: boolean } }
  backlog upsert-component  { input: { project: string, name: string, path?: string, description?: string, by: string } }
  backlog upsert-location  { input: { component: string, project?: string, locType: 'path'|'url'|'tool', value: string, by: string } }
  backlog upsert-project  { input: { name: string, path?: string, repoUrl?: string, monorepo?: boolean, description?: string, by: string } }
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

The **`adhdRoot` key is present only when a root was explicitly resolved** —
the `ADHD_ROOT` env var is set, or `--namespace sandbox` minted one — and is
**omitted** for the default `production`/`test` namespaces. Verified: plain
`sandbox-path` prints
`{"namespace":"production","dbPath":"/…/backlog-v2.db","embeddingEnabled":true}`
with no `adhdRoot`, while the same call with `ADHD_ROOT=/tmp/foreign-root` (or
`--namespace sandbox`) adds the key.

`--namespace sandbox` also **ignores a foreign `ADHD_ROOT`** rather than
writing to it: if the variable names a path this tool did not mint as a
sandbox, it warns
`[backlog] --namespace sandbox: ADHD_ROOT=<path> is set but is not a sandbox this tool created — ignoring it and minting a fresh isolated store instead, so --namespace sandbox never writes into an unrecognized (possibly production) location.`
and mints a fresh throwaway store. So a stray `ADHD_ROOT` can never redirect a
sandboxed run into an unrecognized location — but it also means a sandbox you
want to *reuse* must be the exact path printed when it was created, not any
directory you set `ADHD_ROOT` to.

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
`backlog_<verb>` with the verb's own words snake_cased: `backlog_attest`,
`backlog_claim`, `backlog_create`, `backlog_delete`,
`backlog_embedding_status`,
`backlog_get`, `backlog_lookup`, `backlog_merge_project`, `backlog_move`,
`backlog_obligate`, `backlog_open_curve`, `backlog_part_of_rollup`,
`backlog_priority_matrix`, `backlog_query`, `backlog_recheck`, `backlog_relate`,
`backlog_report`, `backlog_rm_location`, `backlog_rm_project`,
`backlog_spec_append`, `backlog_spec_check`, `backlog_transition`,
`backlog_unobligate`, `backlog_update`, `backlog_upsert_component`,
`backlog_upsert_location`, `backlog_upsert_project`, plus the un-namespaced
`batch_action` — 27 verbs + `batch`.

The tool list a session sees is the MCP **server process's** build, which can
lag the CLI: a long-lived `serve` started before a verb was mounted does not
expose it until restarted. If a verb works on the CLI but its
`mcp__backlog__*` tool is absent, restart the server rather than assuming the
verb is unmounted.

## 3. Issue verbs — worked examples

Every mutating verb requires `by` — the acting identity, always
`${agentName}:${instanceId}`, never a bare role literal like `"agent"`. A
missing/blank `by` is rejected with `invalid_argument` before any write
runs.

**File a new issue.** `project` is RESOLVE-ONLY — `create` never mints one;
register it first with `upsert-project` (§7). `component` is also resolve-only
and defaults to the project's reserved `(root)` component when omitted — pass
it, or the item is invisible to component-scoped scans (§7, "The filing rule"):

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

`data` carries three more fields beyond `created`/`uid`/`item`:

- **`placementResolved`** — `'explicit'` when a caller-supplied `component`
  resolved, or `'default-root'` when the omitted `component` fell back to the
  project's reserved `(root)` component. A supplied component that does NOT
  resolve still throws before this field is reached, so `'default-root'` is
  the only signal that an item was silently filed on `(root)` (and is thus
  invisible to component-scoped scans — §7's filing rule).
- **`duplicateScanDegraded` / `duplicateScanDegradedReason`** — present iff
  the pre-write dedupe scan could not run a calibrated comparison, on EVERY
  outcome (even a successful write). The reason is a concrete
  `'no-search-backend' | 'no-embed-query' | 'no-vector-scores'`, never a
  generic "unavailable". Verified: with embeddings off, a `create` against a
  non-empty store returns
  `"duplicateScanDegraded":true,"duplicateScanDegradedReason":"no-search-backend"`.
  Both fields are **absent on a healthy scan**. When the scan is degraded in
  the never-resolvable `'no-embed-query'` way AND `duplicateAction` is the
  default `'abort'`, nothing is written and the result is
  `{created:false, reason:"duplicate-scan-degraded", duplicateScanDegraded:true,
  duplicateScanDegradedReason:"no-embed-query"}` instead.

Filing more than a handful of similar issues in a row? Use `batch action`
(§8) instead of repeating this call.

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
`view:"projects"`/`"components"`/`"locations"` list in bulk (§7).

The full field vocabulary is `uid, title, kind, status, priority, project,
component, createdAt, updatedAt, assignee, author, closedAt, gitContext`
(cheap/plain) plus `body, citations, notes, auditTrail, blockers, related,
blocksOut, dependents, partOf, obligations, verdict, spec, similar, _score,
_vector` (opt-in only — each costs a genuine extra read, so none is in the
default card). `similar` is the reviewed `similar_to` links touching an item,
both directions (`{similarTo:[…], similarFrom:[…]}`) — a different relation
from the reserved `duplicate_of`, so a card that does not ask for it is
unchanged. `blocksOut` is the outbound `blocks` refs; `dependents` is the
transitive count of nodes that reach this one via `blocks`; `partOf` is the
single `part_of` parent (or `null`); `obligations` is the declared obligation
views (§4); `verdict` is the derived actionability verdict (§4); `spec` is the
spec-revision pointer (§5). `_score_kind` is **not** a requestable field — it
is a provenance tag emitted automatically alongside `_score` whenever a score
is requested (`'rrf'` for a fused semantic rank, `'bm25'` for a grep-only FTS
score, `'cosine'`/`'rank'`/`'priority'` otherwise); passing it in `fields`
rejects as an unknown field. A rank-derived score is ordinal, never a
similarity. `get { fields:["auditTrail"], lastN:5 }` bounds the
sub-collection to its newest tail; `after` continues from the last returned
uid of a bounded sub-collection, and `deriveThrough:1..5` caps the verdict
ladder rung (§4).

**Search/filter/page issues:**

```
$ adhd-backlog backlog query --input '{"filter":{"project":"demo-project","status":"open"},"limit":10}'
{"ok":true,"data":{"view":"list","items":[{"uid":"a61ff0b6-…","title":"Flaky test in auth module","kind":"issue","status":"open","priority":"HIGH"}],"hasMore":false},"meta":{"total":1,"returned":1,"limit":10}}
```

`query.view` (default `'list'`) selects the result shape: `list` · `ready` ·
`graph` · `order` · `stale` · `similar` · `overlap` · `projects` · `components`
· `locations` (the last three are the registry LIST views — §7). **`ready` is
NOT an actionability filter** — it selects the `open` issues that are
**unclaimed** and whose every live incoming `blocks` blocker is **terminal**
(a pure claim/`blocks` predicate; it never evaluates obligations, evidence, or
attestations). An item whose `block`-severity obligation is unsatisfied —
`fields:["verdict"]` returns `actionable:false` — still appears in `ready`,
while an item with an open `blocks` source does not. **To find actionable
work, read `fields:["verdict"]`; do not send an actionable-work query to
`view:"ready"`.** `text` is the
natural-language form — routed to `filter.semantic` when a populated vector
space can rank it, or `filter.grep` (keyword FTS) otherwise; never set
`text` alongside `filter.semantic`/`filter.grep` yourself. Pagination is
truthful: `meta.total` is the count before `limit`/`offset`, `meta.returned`
is `data.items.length`, and a page cut short for any reason other than your
own `limit` sets `meta.truncated`. The four item-list views
(`list`/`ready`/`stale`/`similar`) also carry `meta.has_more`; where a true
pre-limit total is unknowable at bounded cost (`ready`/`stale`/`similar`),
`meta.total_relation: 'gte'` labels `meta.total` as a lower bound.
`graph`/`order`/`overlap` carry no `meta` by design.

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
`duplicate_of`, `part_of`, `similar_to` — NOT the bare word `"related"`:

```
$ adhd-backlog backlog relate --input '{"sourceUid":"777c5e33-…","targetUid":"a61ff0b6-…","rel":"relates_to","action":"add","by":"claude:1"}'
{"ok":true,"data":{"sourceUid":"777c5e33-…","targetUid":"a61ff0b6-…","rel":"relates_to","action":"add","noop":false}}
```

`noop:true` means `add` found an already-live matching edge, or `remove`
found none — no edge was written and no audit row produced; never assume
every call was a fresh write. `targetUid` may belong to a different project
than `sourceUid`.

**Similarity (advisory scan, reviewed link).** Cross-project similarity is a
two-step, deliberately non-automatic flow:

- The scan surfaces **candidates**; it never writes a link. `create` reports
  them on `similarCandidates` (scope-controlled by the project policy's
  `similarityScope`: `same-project` default · `multi-project` · `store-wide`),
  and `query {view:"similar", filter:{project}}` returns a `clusters` block
  (`candidate` = advisory scan output, `linked` = existing links).
- A reviewed link is the **existing `relate`** verb with
  `rel:"similar_to"` (there is **no** `link-duplicate` verb). `similar_to` is
  `n:m` issue→issue. `duplicate_of` stays **reserved** for the reviewed
  actual-same judgement and is never written by a scan.
- Filter reads with `filter.similarTo` (items linked `similar_to` X) or
  `filter.hasSimilar:true` (items with ≥1 incoming link).

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

**Attest anchored evidence.** `attest` creates a SEPARATE `attestation` node
keyed to an issue — it never changes the issue's `uid` or revision. The anchor
is a `locator` (`path:<file>[:<line>]`, `url:<url>`, `query:<cql>`,
`registry:<ref>`) plus a `digest`; a `path:` anchor is checked against the
project's git tree by a cheap-first ladder and its `check.state` is one of
`verified` / `stale` / `unknown` / `unverified` (always present, with a
`reason`). `recheck` APPENDS a fresh check to the record's `checks[]` history:

```
$ adhd-backlog backlog attest --input '{"subject":{"id":"777c5e33-…","revision":0},"claim":{"kind":"published-artifact"},"anchor":{"locator":"path:dist/index.js","digest":"<sha256>"},"by":"claude:1"}'
{"ok":true,"data":{"attestationUid":"…","subject":{"id":"777c5e33-…","revision":0},"check":{"state":"verified","method":"changed_since","checked_at":"…","checked_by":"claude:1"}}}
$ adhd-backlog backlog recheck --input '{"attestationUid":"<attestationUid>","by":"claude:1"}'
{"ok":true,"data":{"attestationUid":"…","checks":[{"state":"verified",…},{"state":"stale",…}]}}
```

**Prerequisite for `path:` anchors — the subject project's registered `path`
must be a git work tree.** The anchor ladder resolves a `path:` locator by
running git against that project path, so `check.state:"verified"` is produced
only when the path is a real git work tree containing the file. With a
**non-git** registered project path the real result is
`{"state":"unknown","method":"none","reason":"no git work tree at \"<path>\""}`
— `verified` is never produced, so a `block`-severity `evidence` obligation of
that kind **stays unsatisfied and the close stays refused**. A `url:` anchor is
likewise only `unverified`
(`reason:"no mechanical checker is wired for \"url:\" anchors yet"`), and a
`revision:` anchor (a spec-revision annotation, recorded through `attest`) is
`unverified` too. Without a git
work tree to verify against, satisfy such an obligation another way: register
the project with a `path` that **is** the real git work tree, use
`on_fail:"warn"` (a warn obligation never gates a transition), or list your
actor in the obligation's `override.actors` and pass a recorded
`override.reason` (§4 "Overriding a refusing obligation").

## 4. Obligations, attestations & the actionability verdict

An **obligation** is a typed, stored requirement on an issue, scoped to a
transition. `obligate` declares one; the write gate REFUSES a transition that
would violate it; `fields:["verdict"]` predicts that gate ON READ. Nothing is
evaluated at `obligate` time — the gate and the verdict do the evaluating.

### Declaring an obligation

`obligate { uid, applies_to, requirement, on_fail, override?, by }`:

- `applies_to.to` — REQUIRED. Scopes a TRANSITION into that status: a concrete
  status name, or `'*'` for "any terminal transition". `applies_to.from`
  optionally narrows the source status; absent ⇒ any from-status.
- `requirement` — the CLOSED predicate core (six productions; no CEL, no
  dynamic leaf, no timeout). It is validated recursively BEFORE the write lock,
  so a malformed predicate never holds it:
  - `{ "op": "evidence", "kind": <string>, "min"?: <int ≥1> }` — at least
    `min ?? 1` distinct **verified** attestations of `kind` (a `check.state` of
    `verified`).
  - `{ "op": "blockers_terminal" }` — every incoming live `blocks` source is
    terminal (a missing status is non-terminal, fail-closed).
  - `{ "op": "relation", "type": <edge kind>, "direction": "in"|"out" }` — a
    live edge of `type` touches the subject (`in` = subject is `dst`, `out` =
    `src`).
  - `{ "op": "all_of", "of": [ … ] }` — empty list ⇒ `true`.
  - `{ "op": "any_of", "of": [ … ] }` — empty list ⇒ `false`.
  - `{ "op": "not", "of": { … } }`.
- `on_fail` — `'block'` refuses the transition; `'warn'` records the shortfall
  but allows it. A `warn` obligation never affects `actionable`.
- `override` — `{ "actors": [<identity>, …] }`: the identities permitted to
  override THIS obligation. An override ALWAYS requires a recorded reason
  (below); it is never a configurable boolean.

Read the obligations back with `get … fields:["obligations"]` — the STORED
predicate, never an evaluation:

```
$ adhd-backlog get --input '{"uid":"1d9b77e5-…","fields":["obligations"]}'
{"ok":true,"data":{"uid":"1d9b77e5-…","obligations":[{"uid":"fbcee200-…","applies_to":{"to":"closed"},"requirement":{"op":"evidence","kind":"published-artifact","min":1},"on_fail":"block"}]}}
```

### The verdict (derived on read, never stored)

`fields:["verdict"]` returns the actionability verdict:

```jsonc
{ "actionable": true | false | "unknown",  // TRI-STATE — never a bare boolean
  "evaluated_at": "…",
  "revision": 0,                            // the issue's content revision
  "conditions": [                           // block-severity first, then warn
    { "type": "Evidence", "status": "True", "severity": "block",
      "code": "EvidenceUnverified", "subject": "<obligationUid>", "message": "…" } ] }
```

`actionable` is `false` iff at least one `block` condition is `True`;
`"unknown"` iff a `block` condition is `Unknown` and none is `True` (the honest
"could not decide" — **never a green light**); otherwise `true`. `status` says
whether the NAMED condition HOLDS (`{type:"Blocked",status:"True"}` ⇒ the item
IS blocked). `type` ∈ `Blocked | Obligation | Evidence | Claim | Reference |
Budget`; `severity` ∈ `block | warn`; the governed `code`s are `BlockedBy`,
`MissingObligation`, `EvidenceUnverified`, `EvidenceStale`, `ClaimStale`,
`ReferenceUnresolved`, `Unknown`, plus a `<domain>/<Code>` extension namespace.
An obligation-free item reports a `warn` `MissingObligation` — reported, never
blocking.

The verdict runs a cheap-first ladder with a per-read budget (`deriveThrough`
on `get`, 1–5). `get` defaults to rung 3; the list views always run rung 2:

| rung | what runs                                                    | produces                                       |
| ---- | ------------------------------------------------------------ | ---------------------------------------------- |
| 1    | incoming live `blocks` (indexed in-degree)                   | `Blocked`/`BlockedBy` per non-terminal blocker |
| 2    | obligation presence + predicate evaluation + claim staleness | `Obligation`/`Evidence`/`Claim`                |
| 3    | anchor existence at HEAD                                     | `EvidenceStale` when absent                    |
| 4    | changed-since-filing                                         | `EvidenceStale` when moved since filing        |
| 5    | full anchor re-resolve (digest match)                        | `EvidenceStale` on digest mismatch             |

Where a rung was not run the condition is `Unknown`, so the list and `get`
paths can never disagree `true` vs `false` for the same item.

### End-to-end: declare → read → refuse → attest → close

Declare the obligation, then read the verdict it predicts (`block`-severity
`EvidenceUnverified`, because the required evidence has not been attested):

```
$ adhd-backlog obligate --input '{"uid":"1d9b77e5-…","applies_to":{"to":"closed"},"requirement":{"op":"evidence","kind":"published-artifact","min":1},"on_fail":"block","by":"agent:worker-1"}'
{"ok":true,"data":{"uid":"1d9b77e5-…","obligationUid":"fbcee200-…"}}

$ adhd-backlog get --input '{"uid":"1d9b77e5-…","fields":["verdict","obligations"]}'
{"ok":true,"data":{"uid":"1d9b77e5-…","obligations":[{"uid":"fbcee200-…","applies_to":{"to":"closed"},"requirement":{"op":"evidence","kind":"published-artifact","min":1},"on_fail":"block"}],"verdict":{"actionable":false,"evaluated_at":"…","revision":0,"conditions":[{"type":"Evidence","status":"True","severity":"block","code":"EvidenceUnverified","subject":"fbcee200-…","message":"obligation unsatisfied: EvidenceUnverified"}]}}}
```

Attempt the close — the gate refuses with `precondition_failed` and NOTHING is
written (the throw rolls the transaction back; a re-read shows the status
unchanged):

```
$ adhd-backlog transition --input '{"uid":"1d9b77e5-…","by":"agent:worker-1","toStatus":"closed","note":"attempted close before evidence"}'
{"ok":false,"error":{"code":"precondition_failed","message":"Transition refused: EvidenceUnverified (requires \"published-artifact\") — no verified attestation of kind \"published-artifact\" satisfies this obligation","details":{"retryable":false}}}
```

Attest the evidence. `attest` mints a SEPARATE `attestation` node — the issue's
`uid` and revision are untouched. The anchor is `locator + digest`; a `path:`
anchor is resolved against the subject project's registered `path` by the
cheap-first anchor ladder, and its `check.state` is one of
`verified | stale | unknown | unverified` with a `reason` when not verified.
`recheck { attestationUid, by }` APPENDS a fresh check to the record's
`checks[]` history (`attest` itself returns the single `check`):

```
$ adhd-backlog attest --input '{"subject":{"id":"1d9b77e5-…","revision":0},"claim":{"kind":"published-artifact"},"anchor":{"locator":"path:README.md","digest":"sha256:<hex>"},"by":"agent:worker-1"}'
{"ok":true,"data":{"attestationUid":"8f3604b9-…","subject":{"id":"1d9b77e5-…","revision":0},"check":{"state":"verified","method":"changed_since","checked_at":"…","checked_by":"agent:worker-1"}}}
```

That `verified` requires the subject project's registered `path` to be a **git
work tree** containing the file. Against a non-git project path the same call
returns `state:"unknown"`, `method:"none"`,
`reason:"no git work tree at \"<path>\""`, and the transition below stays
refused — see §3's `attest` note for the remedies.

Now the close succeeds:

```
$ adhd-backlog transition --input '{"uid":"1d9b77e5-…","by":"agent:worker-1","toStatus":"closed","note":"evidence published"}'
{"ok":true,"data":{"uid":"1d9b77e5-…","fromStatus":"open","toStatus":"closed","closedAt":"…","transitionUid":"f42dd635-…"}}
```

At the default `get` rung (3) the predicate is satisfied but its anchor
freshness was not re-resolved, so `actionable` is honestly `"unknown"`; raise
`deriveThrough:5` to re-resolve it to `true`:

```
$ adhd-backlog get --input '{"uid":"1d9b77e5-…","fields":["verdict"]}'
{"ok":true,"data":{"uid":"1d9b77e5-…","verdict":{"actionable":"unknown","evaluated_at":"…","revision":0,"conditions":[{"type":"Evidence","status":"Unknown","severity":"block","code":"Unknown","subject":"fbcee200-…","message":"the \"published-artifact\" anchor presence was confirmed but freshness was not re-resolved at this rung"}]}}}

$ adhd-backlog get --input '{"uid":"1d9b77e5-…","fields":["verdict"],"deriveThrough":5}'
{"ok":true,"data":{"uid":"1d9b77e5-…","verdict":{"actionable":true,"evaluated_at":"…","revision":1,"conditions":[]}}}
```

### Overriding a refusing obligation

If the obligation lists your identity in `override.actors`, the transition is
allowed with a recorded `override.reason` (a reason is ALWAYS required):

```
$ adhd-backlog obligate --input '{"uid":"34219cf9-…","applies_to":{"to":"closed"},"requirement":{"op":"evidence","kind":"never-produced","min":1},"on_fail":"block","override":{"actors":["agent:worker-1"]},"by":"agent:worker-1"}'
{"ok":true,"data":{"uid":"34219cf9-…","obligationUid":"7dbcc8b6-…"}}

$ adhd-backlog transition --input '{"uid":"34219cf9-…","by":"agent:worker-1","toStatus":"closed","note":"override recorded","override":{"reason":"reviewed by owner"}}'
{"ok":true,"data":{"uid":"34219cf9-…","fromStatus":"open","toStatus":"closed","closedAt":"…","transitionUid":"9a006480-…"}}
```

A non-listed actor (or a blank reason) is refused:

```
$ adhd-backlog transition --input '{"uid":"c66f7368-…","by":"agent:other","toStatus":"closed","note":"not listed","override":{"reason":"trying anyway"}}'
{"ok":false,"error":{"code":"precondition_failed","message":"Override not permitted: actor \"agent:other\" may not override obligation \"f85373dd-…\" (the actor is not listed in override.actors, or no override reason was recorded — an override always requires a reason)","details":{"retryable":false}}}
```

### Retiring an obligation

`unobligate { obligationUid, by }` soft-invalidates the obligation
(bi-temporal, never a hard delete): it stops appearing on the card and the gate
stops refusing.

```
$ adhd-backlog unobligate --input '{"obligationUid":"fbcee200-…","by":"agent:worker-1"}'
{"ok":true,"data":{"obligationUid":"fbcee200-…","invalidated":true}}
```

## 5. Spec revisions — the spec pointer

A work product is a REVISION of its ticket (DESIGN §12). `spec-append` mints a
new immutable `SPEC` node holding a fragment and advances the ticket's
`meta.spec_revision` pointer IN PLACE — the ticket's `uid` is preserved and no
prior revision is rewritten. `spec-check` tells a reader whether the token it
holds is still current.

### `spec-append { uid, fragment, anchor?, base_revision, by }`

- `uid` — the ticket; any uid on its `SUPERSEDES` chain is resolved forward.
- `fragment` — the delta appended at this revision. The base document is the
  base revision's own fragment; the document is the fold over the chain.
- `anchor?` — `{ locator, digest }` for the long-form file export (a
  `revision:<uid>` locator addresses the revision itself).
- `base_revision` — REQUIRED CAS token: the current `spec_revision` uid the
  caller read, or `''` when the ticket has no spec yet. A stale value is
  refused with `precondition_failed` and NOTHING is written.

Outcome: `{ uid (UNCHANGED), spec_revision (the NEW revision uid),
spec_revision_token ('sha256:<hex>'), revision_seq }`.

### `spec-check { uid, token? }`

- `state` ∈ `fresh | stale | unknown`; `method` ∈
  `token | content_hash | ancestry | none`.
- **An ABSENT `token` is `stale`** (`method:"none"`,
  `reason:"no-token-supplied"`) — never `fresh`. A reader that holds no token
  must not treat the spec as current.
- A non-matching token is `stale` (`method:"token"`, `reason:"older-token"`).

### The `spec` field

`get … fields:["spec"]` projects the pointer onto the card — the revision uid,
its `'sha256:<hex>'` token, and the sequence; never the revision body. Absent
when the item has no spec.

### Worked example

A ticket with no spec yet passes `base_revision:""` (the appended fragment is
`# Design\nFirst cut of the design.`):

```
$ adhd-backlog spec-append --input '{"uid":"c79b52b0-…","fragment":"# Design\nFirst cut of the design.","base_revision":"","by":"agent:worker-1"}'
{"ok":true,"data":{"uid":"c79b52b0-…","spec_revision":"58b5dfd8-…","spec_revision_token":"sha256:d0bcba4a…","revision_seq":1}}

$ adhd-backlog get --input '{"uid":"c79b52b0-…","fields":["spec"]}'
{"ok":true,"data":{"uid":"c79b52b0-…","spec":{"spec_revision":"58b5dfd8-…","spec_revision_token":"sha256:d0bcba4a…","revision_seq":1}}}
```

Check it, with the token and then without:

```
$ adhd-backlog spec-check --input '{"uid":"c79b52b0-…","token":"sha256:d0bcba4a…"}'
{"ok":true,"data":{"current_revision":"58b5dfd8-…","current_token":"sha256:d0bcba4a…","state":"fresh","method":"token"}}

$ adhd-backlog spec-check --input '{"uid":"c79b52b0-…"}'
{"ok":true,"data":{"current_revision":"58b5dfd8-…","current_token":"sha256:d0bcba4a…","state":"stale","method":"none","reason":"no-token-supplied"}}
```

Appending against a stale base is refused; appending against the current
revision advances the pointer to `revision_seq:2` while the ticket `uid` stays
the same:

```
$ adhd-backlog spec-append --input '{"uid":"c79b52b0-…","fragment":"# Design\nSecond cut.","base_revision":"stale-rev-uid","by":"agent:worker-1"}'
{"ok":false,"error":{"code":"precondition_failed","message":"spec revision conflict: base_revision \"stale-rev-uid\" does not match the current revision \"58b5dfd8-…\" — re-read the ticket's spec_revision and retry","details":{"retryable":false}}}

$ adhd-backlog spec-append --input '{"uid":"c79b52b0-…","fragment":"# Design\nSecond cut.","base_revision":"58b5dfd8-…","by":"agent:worker-1"}'
{"ok":true,"data":{"uid":"c79b52b0-…","spec_revision":"20efdc96-…","spec_revision_token":"sha256:149a2200…","revision_seq":2}}
```

### Annotating a revision (through `attest`)

There is no dedicated `annotate` verb: a comment on a spec REVISION is a plain
`attest` call whose `subject.id` is the revision uid, whose `subject.revision`
is its opaque `'sha256:<hex>'` token, and whose `claim.kind` is
`"spec-annotation"`. The `anchor` is `{ locator: "revision:<revision uid>",
digest: <token> }`. The comment is a separate `attestation` node keyed to the
exact revision and is never written into any body, so a comment on revision _n_
can never drift onto _n+1_.

```
$ adhd-backlog attest --input '{"subject":{"id":"20efdc96-…","revision":"sha256:149a2200…"},"claim":{"kind":"spec-annotation","body":"Reviewed: add the failure-mode section."},"anchor":{"locator":"revision:20efdc96-…","digest":"sha256:149a2200…"},"by":"agent:worker-1"}'
{"ok":true,"data":{"attestationUid":"0fa85138-…","subject":{"id":"20efdc96-…","revision":"sha256:149a2200…"},"check":{"state":"unverified","method":"none","checked_at":"…","checked_by":"agent:worker-1","reason":"no mechanical checker is wired for \"revision:\" anchors yet"}}}
```

No mechanical checker is wired for `revision:` anchors yet, so `check.state` is
`unverified` — the token is RECORDED, not validated.

## 6. Read views — catalogs, registry lists, and dependency order

`query.view` (default `'list'`) selects the result shape: `list` · `ready` ·
`graph` · `order` · `stale` · `similar` · `overlap` · `projects` · `components`
· `locations` · `kinds` · `catalogs`. The registry list views
(`projects`/`components`/`locations`) are §7. The catalog views and `order` are
below. (`ready`'s exact predicate — `open` ∧ unclaimed ∧ every live incoming
`blocks` blocker terminal — is defined in §3; it is **not** actionability, for
which read `fields:["verdict"]`.)

### Catalogs — the live vocabularies

`view:"kinds"` returns EVERY catalog: the catalog names, a `terms[]` array, and
a case-collision flag:

```
$ adhd-backlog query --input '{"view":"kinds"}'
{"ok":true,"data":{"view":"kinds","catalogs":{"catalogs":["kind","status","priority","relation","field","error_code","location_type","verb"],"terms":[{"name":"issue","uid":"fcfc79f5-…","catalog":"kind","source":"store","lifecycle":"active","usageCount":6},{"name":"closed","catalog":"status","source":"reserved_terminal_status_names","lifecycle":"active"},{"name":"blocks","catalog":"relation","source":"edge_kind_table","lifecycle":"active"},{"name":"verdict","catalog":"field","source":"issue_field_union","lifecycle":"active"},{"name":"precondition_failed","catalog":"error_code","source":"error_code_union","lifecycle":"active"},{"name":"path","catalog":"location_type","source":"valid_location_types","lifecycle":"active"},{"name":"obligate","catalog":"verb","source":"mounted_verb_surface","lifecycle":"active"}, …],"hasCaseCollisions":false}}}
```

`view:"catalogs"` returns the same `terms[]` at the top level, and the
`catalog` selector narrows to ONE vocabulary (`kind` | `status` | `priority` |
`relation` | `field` | `error_code` | `location_type` | `verb`):

```
$ adhd-backlog query --input '{"view":"catalogs","catalog":"relation"}'
{"ok":true,"data":{"view":"catalogs","terms":[{"name":"attests","catalog":"relation","source":"edge_kind_table","lifecycle":"active"}, …]}}
```

Each term is `{ name, uid?, catalog, source, lifecycle, replacedBy?,
usageCount? }`. `source` names the validating source it was generated from at
call time (`store` for `kind`/`status`/`priority` — live rows with a
`usageCount`; `edge_kind_table`, `reserved_terminal_status_names`,
`issue_field_union`, `error_code_union`, `valid_location_types`,
`mounted_verb_surface` for the in-code vocabularies). A `deprecated` term
carries `replacedBy`.

> **`kind` is an OPEN, free-form vocabulary — the `kind` catalog is a usage
> CENSUS, not an allowlist.** `create`/`update` accept ANY `kind` string with
> no validation: it is stored verbatim and the name then appears as a `kind`
> term with `source:"store"` and a `usageCount` (verified: creating with
> `"kind":"totally-made-up-kind"` succeeds and the term shows up on the next
> `view:"catalogs"`). On a **fresh store the `kind` catalog is EMPTY**
> (`{"terms":[]}`) — it reflects what has been filed, not what is permitted.
> The conventional names are `issue` (the default, and the read path's item
> scope) and `plan` (a plan is an ordinary issue with `kind:"plan"`; see
> "Dependency order" below). Unlike `create`, **`filter.kind` IS validated
> against this live census**: filtering by a name that has never been used is
> a `validation` error naming the existing values
> (`existing kind values: …`), so file one item with a kind before filtering
> by it. This mirrors §3's note that `status` is an open catalog — neither is
> a fixed enum.

> **Trap — `catalog` is silently ignored without `view:"catalogs"`.** The
> selector is honoured ONLY on `view:"catalogs"`. `{"catalog":"status"}` with
> no `view` falls back to the default `list` view — the ordinary issue page,
> filtered by nothing — at exit 0, with no `terms` and no error. It is not a
> "no matches" result, and the list contents are whatever your store holds:

```
$ adhd-backlog query --input '{"catalog":"status"}'
{"ok":true,"data":{"view":"list","items":[{"uid":"1d9b77e5-…","title":"Rebuild backlog agent docs","kind":"issue","status":"closed","priority":"HIGH"}, …],"hasMore":false},"meta":{"total":7,"returned":7,"limit":50}}
```

> Always pass `view:"catalogs"`. (`catalog` is likewise ignored on
> `view:"kinds"`, which always returns every catalog.)

### Dependency order — a plan's members

A "plan" is not a separate node kind: it is an `issue` (commonly
`kind:"plan"`) that members attach to with
`relate(childUid, planUid, "part_of", "add")`. Three reads answer plan
questions:

- **Members:** `filter.plan` (uid or name) returns every issue with a live
  `part_of` edge into the plan.
- **Dependency order:** `view:"order"` + `filter.plan` returns the members
  topologically ordered by `blocks` — `{order:{ok:true,order:[uid,…]}}`, or
  `{ok:false,cycle:[…]}` when the `blocks` edges form a cycle.
- **Transitive rollup:** `part-of-rollup` (§11) counts every transitive
  `part_of` descendant, not just the direct members.

```
$ adhd-backlog query --input '{"filter":{"plan":"850f1921-…"}}'
{"ok":true,"data":{"view":"list","items":[{"uid":"7b21007d-…","title":"Write SKILL.md inventory","kind":"issue","status":"open"},{"uid":"d56fa59f-…","title":"Write README table","kind":"issue","status":"open"}],"hasMore":false},"meta":{"total":2,"returned":2,"limit":50}}

$ adhd-backlog query --input '{"view":"order","filter":{"plan":"850f1921-…"}}'
{"ok":true,"data":{"view":"order","order":{"ok":true,"order":["7b21007d-…","d56fa59f-…"]}}}

$ adhd-backlog part-of-rollup --input '{"uid":"850f1921-…"}'
{"ok":true,"data":{"uid":"850f1921-…","childrenTotal":2,"childrenOpen":2,"childrenClosed":0,"childrenOpenUids":["7b21007d-…","d56fa59f-…"],"hasMore":false}}
```

(In the example above `7b21007d` `blocks` `d56fa59f`, so the order is
`[7b21007d, d56fa59f]`.)

## 7. Registry — project / component / location

The registry answers **"where does this live, and what do I file the bug
against?"** in one call, before you `rg`/search for it.

### The model

- **project** — one repo/workspace root, registered with its filesystem `path`
  and/or git `repoUrl`. ONE canonical row per logical repo (`adhd`,
  `sox-ecosystem`). Every issue verb RESOLVES a project by name or `uid` and
  **never mints one** — an unknown project name is `not_found` (exit 4).
- **component** — a path _within_ that project (`entrypoint/backlog`,
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

| verb               | use it when                                                                      | idempotent key                |
| ------------------ | -------------------------------------------------------------------------------- | ----------------------------- |
| `upsert-project`   | registering/updating a repo or workspace root; also mints its `(root)` component | `name`                        |
| `upsert-component` | registering/updating a path _inside_ an already-registered project               | `(project, name)`             |
| `upsert-location`  | pointing a tool/file/URL at its owning component so `lookup` resolves it         | `(component, locType, value)` |
| `rm-location`      | retiring a location (soft-invalidate)                                            | `uid`                         |
| `merge-project`    | collapsing a DUPLICATE project into the canonical one (reviewed, one-way)        | `(fromUid, toUid)`            |
| `rm-project`       | retiring a project with no survivor (reviewed, one-way)                          | `uid`                         |

The four `upsert*`/`rm-location` rows are create-or-update by that key — never a
duplicate row — and all require `by`. The two project-retirement verbs are
explicit, reviewed, one-way operations (see "Consolidating duplicate projects"
below).

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

`lookup` routes `q` by shape, in order: (1) a **uid or unique uid prefix**
returns `{"redirect":{"verb":"get","uid":…}}`; (2) an **issue title** with
exactly one match returns the same `get` redirect, and a title matching two or
more issues is refused (`ambiguous_reference`); (3) a **location** is
classified as a tool name / file path / URL and resolved as before; (4) a
**project name or `repoUrl`** resolves to its project. Pass an optional
`"kind":"location"|"project"|"component"|"issue"` to force one branch; the
mounted schema now types `kind` as a plain `string` (it was a closed enum), and
only those four names select a branch. Only an
unregistered location is still a bare `not_found` (exit 4); a path miss falls
back to a suffix/prefix scan before giving up, and reports a `hint` when only a
partial match was found — never a silent empty result.

**Consolidating duplicate projects** — two rows registered for the same repo
(same `repoUrl`, different `name`) split every `owns_project` read. Merge the
duplicate INTO the canonical survivor (one `BEGIN IMMEDIATE`; every component
is re-pointed, the duplicate is soft-retired with a one-hop redirect so its old
NAME still resolves, and its id is never reused):

```
$ adhd-backlog backlog merge-project --input '{"fromUid":"020e87f2-…","toUid":"41a61c6d-…","by":"claude:1"}'
{"ok":true,"data":{"survivorUid":"41a61c6d-…","retiredUid":"020e87f2-…","movedIssues":7,"retired":true}}
```

A second identical `merge-project` is an idempotent no-op. Retire a project
with no survivor (its old name then resolves to nothing) with:

```
$ adhd-backlog backlog rm-project --input '{"uid":"020e87f2-…","reason":"stale duplicate","by":"claude:1"}'
{"ok":true,"data":{"uid":"020e87f2-…","retired":true}}
```

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
   `adhd-backlog sandbox-path` reports the store a command will touch. Each
   namespace resolves to its OWN file under `~/.adhd/backlog/<namespace>/data/`
   (default `backlog.db`; that namespace's `config.yaml` may pin another name),
   so the `production` store is never the `test` store. `ADHD_BACKLOG_SCOPE`
   only changes the scope ROOT; an absolute `db.path` from any config layer
   still wins (`db.path ?? files.db`) — run `sandbox-path` to confirm. A build
   that writes a per-repo namespace (e.g. `entrypoint/backlog` on
   `main`) files items that are silently absent from production — no error,
   just a missing row (filed as 49ce83b8). Run `sandbox-path` before a write
   you care about, and file through the production CLI only.

## 8. Batch — N-way fan-out over one operation

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
`operation` values are exactly the 28 mounted verbs above, each prefixed
`backlog/` — passing a bare verb name (`"create"`) is rejected with
`invalid_argument` naming the full list (the live error enumerates all 28).

## 9. Citations — structured, not hand-typed markdown

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

`file` must name a FILE, never a directory. In a project with a registered
path, a directory target is rejected with `validation` (not retryable); the
message names the target. Cite a file inside it instead, with `lines` if you
can. A citation that exists but cannot be read (e.g. permissions) is an
`internal` error whose message ends with the raw OS error.

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

## 10. Verify writes from a NEW process

An MCP `backlog_get` served by a long-lived `serve` process can answer out
of that process's own in-memory/uncheckpointed state. After a write you
care about, verify by running the `adhd-backlog` CLI in a fresh shell — a
genuinely new process — rather than re-reading through the same live MCP
session.

## 11. Stats & rollups

Four aggregate read ops are first-class mounted ops — `backlog
priority-matrix`, `backlog part-of-rollup`, `backlog open-curve`, and `backlog
report` (MCP: `backlog_priority_matrix` / `backlog_part_of_rollup` /
`backlog_open_curve` / `backlog_report`). All four are read-only and take no
`by`, and each returns its own shape — a matrix, a rollup tree, a time series,
a grouped aggregate — so none is a `query.view` member.

**Priority matrix** — per-priority counts, scoped by
`project`/`component`/`kind`/`status`. An omitted `filter.status` scopes to
OPEN work (unlike `list`, where an omitted status means no restriction); the
applied scope is echoed on `data.statusScope`, and `unassigned` counts in-scope
issues carrying no priority:

```
$ adhd-backlog backlog priority-matrix --input '{}'
{"ok":true,"data":{"rows":[{"priority":"HIGH","priorityUid":"fb9d525e-…","rank":0,"count":1}],"unassigned":1,"statusScope":"open"}}
```

**Part-of rollup** — every TRANSITIVE `part_of` descendant of the root issue
(not just direct children), counted once each regardless of chain depth, split
into `childrenOpen`/`childrenClosed` (plus the open descendants' uids).
`countOnly:true` omits `childrenOpenUids` entirely (counts only); `limit`/`after`
page the uid list (`nextCursor`/`hasMore`; default 50, max 1000):

```
$ adhd-backlog backlog part-of-rollup --input '{"uid":"74c22c35-…"}'
{"ok":true,"data":{"uid":"74c22c35-…","childrenTotal":1,"childrenOpen":1,"childrenClosed":0,"childrenOpenUids":["db4587ba-…"],"hasMore":false}}
```

**Open curve** — for each sampled ISO-8601 instant, how many in-scope issues
EXISTED then (exact, via `validAt`) and, of those, how many were OPEN then
(reconstructed from the audit trail, never the issue's current status):

```
$ adhd-backlog backlog open-curve --input '{"at":["2020-01-01T00:00:00.000Z"]}'
{"ok":true,"data":{"points":[{"at":"2020-01-01T00:00:00.000Z","existed":0,"open":0,"closed":0}]}}
```

**Report** — a grouped rollup whose every number is computed from the store in
that call: `byKind`, `byPriority` (composed from `priority-matrix`), `byStatus`,
and `avgAgeDays` of open in-scope items, with `statusScope` naming what was
counted (`'open'` when `filter.status` is omitted):

```
$ adhd-backlog backlog report --input '{}'
{"ok":true,"data":{"byKind":[{"kind":"issue","count":2}],"byPriority":[{"priority":"HIGH","rank":0,"count":1}],"byStatus":[{"status":"open","terminal":false,"count":2}],"avgAgeDays":0.01,"statusScope":"open","computedAt":"…"}}
```

The same functions are also exported from the package's query layer
(`src/query/views/stats.ts` + `src/query/views/report.ts`, re-exported by
`src/query/index.ts`) for in-process consumers — `priorityMatrix(handle, {
filter? })`, `partOfRollup(handle, { uid, countOnly?, limit?, after? })`,
`openCurve(handle, { filter?, at })`, `report(handle, { filter? })`. That
in-process surface is described in `README.md` → "Library API".

## 12. Hard rule — file a feature request when the tool is the friction

**Never silently work around the tool.** If a value or grouping you were asked for had no verb to produce it — you got it by reshaping raw output yourself (a client-side group-by, join, filter, count, or field-extract) — you MUST file a feature request before you finish. Two or more such reshapes in one dispatch, even inside a single command, is already more than enough. No task scope overrides this: a read-only task, "only add links", or "do not create items" does NOT exempt you.
Inside the adhd repo: `create` a `FEAT` on project `adhd`, component `entrypoint/backlog`, with `duplicateAction:"comment"` (attaches your reproduction when it is already filed — never force); body = the exact command, the exact output, the workaround, and the outcome you wanted.
Outside the adhd repo: file the same four things with `gh issue create --repo PseudoSky/adhd` (https://github.com/PseudoSky/adhd); if `gh` is unusable, report it instead of dropping it.
One per dispatch; report the uid (or issue URL). Reporting friction is not designing the fix — no invented change, no priority, no `claim`, no `plan` field.
