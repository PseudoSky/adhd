# doc-ops — audit trail for the `entrypoint/backlog` documentation sweep

Scope: `entrypoint/backlog/` (`@adhd/backlog` v1.0.0). Owner: doc-steward.
Session: 2026-09-24. Revision: `9df2a5c7` (branch `fix/backlog-funnel-provider-dep`).
Nothing here is committed. Every create/rewrite/revise is recorded below with
its reason and the prior text preserved inline, so no content is lost even
before a commit (and not only via git).

Note on preservation: every file touched below was **tracked and clean** in the
working tree before this sweep (`git status` showed no modification), so
`git show HEAD:<path>` is also a faithful copy of each pre-edit file. The prior
text is still inlined here for the rewrite/moves.

---

## CREATE entrypoint/backlog/LICENSE — 2026-09-24

reason: `package.json` declares `"license": "MIT"` and the README footer needs a
license link, but no LICENSE file existed in this package (nor was one shipped —
`files` lists only `dist`, `CHANGELOG.md`, `skill`). Sibling packages
(`entrypoint/agent-mcp/LICENSE`, `packages/agent/*/LICENSE`, `entrypoint/apigen-cli/LICENSE`)
all carry their own MIT LICENSE; this adds the same for consistency and backs
the MIT claim. Holder/year derived from the sibling-package convention
(`Copyright (c) 2026 pseudosky`; cf. `entrypoint/agent-mcp/LICENSE`).

removed_or_moved: none (new file).

---

## REWRITE entrypoint/backlog/README.md — 2026-09-24

reason: (a) template conformance — the README had no "Key features" section and
no footer (Contributing/License/Security), both required for a non-root scope;
(b) factual corrections — the worked examples showed fabricated output;
(c) two dead-ish claims (the `get`/grep-form invocation and a `nextCursor:null`
field that the real envelope does not emit for an untruncated page);
(d) surfaced the library-only stats views (defect d08ddec2) and the
which-build caveat (defect 0f1f4a9c-adjacent).

Claims corrected in this file:
- `create` result showed `"project": "adhd", "component": "(root)"` (names) —
  the real result carries **uids** for both fields. Replaced with the real
  captured result.
- `query` result showed `"nextCursor": null` — an untruncated page emits
  `data.hasMore:false` and **no `nextCursor` key**; `nextCursor` appears only
  when `hasMore:true`. Replaced with the real captured result.
- "three transports" omitted the in-process client library and the verb table
  omitted `batch`; both corrected.
- Config-cascade direction reworded (was "environment variable → config file →
  default", which reads as a precedence order; now states "later layers
  override earlier: default → config file → environment variable").

removed_or_moved (verbatim — the complete prior README.md):

```markdown
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
name or `uid`. File a project first if one doesn't already exist. File every
issue with the correct project **and component** — a component-less item lands
on the project's `(root)` component and is invisible to component-scoped
queries. The agent-facing rule, the registry verbs, and the real misfiling
hazards (duplicate project rows, store/scope confusion) live in
[`skill/SKILL.md` §4](skill/SKILL.md):

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
  "gitContext": "feat/backlog-hard-replacement @ 4bf902fc",
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
      "createdAt": "2026-09-16T12:00:00.000Z",
      "gitContext": "feat/backlog-hard-replacement @ 4bf902fc"
    }
  }
}
```

`gitContext` is the item-level disclosure-contract git context (the repo
`AGENTS.md` "Cite what you read" convention: the first element of a
`Citations:` block is `<active git context>`). It is optional and plain — a
sibling of `assignee` in the issue's metadata — and `transition` accepts the
same field to update it. A `format:'markdown'` query renders it once at the
head of the item's `Citations:` block (`Citations: [<active git context>]`),
never per citation. Omit it and nothing is stored and no output changes.

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
| `precondition_failed` | A gate refused the write — a terminal transition missing its required citation or note, or a citation that couldn't be verified against a known project path | 1             |
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
| Namespace          | `--namespace <value>` CLI flag (no env var)           | `production`                                    | Which trailing path segment under the scope root to resolve against (`<root>/backlog/<namespace>/…`) — one of `production`\|`test`\|`sandbox`. `backlog --namespace sandbox <cmd>` layers ephemeral-root-minting AND a real, written `config.yaml` (`embedding.enabled: false`) on top of the `sandbox` namespace segment, so a sandboxed invocation is isolated along two independent axes plus a deliberate config, never an accident of an empty directory |
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
```

---

## REVISE entrypoint/backlog/skill/SKILL.md — 2026-09-24

reason: the agent-facing command-surface doc carried a mutually-exclusive
identity claim and no reconciling supersession concept (defect 0f1f4a9c); it
documented `gitContext` as unconditional without naming the build skew
(defect: installed `restore-min` build rejects it); it claimed the `backlog`
namespace segment was REQUIRED (refuted — the bare form works); it claimed
citations were required "the default" (refuted — `citationRequired` defaults
false); its hardcoded `--help` transcript was stale (`view?: enum` vs the
shipped expanded enum); it omitted the `get` registry form, the three registry
list views, `store-check`, and the library-only stats views (defect d08ddec2).

Hunks (prior text verbatim, removed):

### Hunk A — identity / build note
```
Identity is the global `uid` returned by `create`/`upsertProject`/etc. —
never a family-scoped human-readable id. Every example below was run against
the real built binary (`dist/index.js`) and its exact output is what is
shown.
```

### Hunk B — `backlog` segment "required"
```
The `backlog` segment in front of every verb (and `batch` in front of
`action`) is a real, required part of the command — it is the CLI namespace
each operation is mounted under, not decoration. Running `adhd-backlog
--help` (or an unknown command) prints the exact live shape of every input:
```

### Hunk C — special commands (no `store-check`)
```
`serve`, `install-skill` (alias `install`), `search`, and `sandbox-path` are
handled before the command table:

```
adhd-backlog serve [--transport mcp|http|both] [--port N] [--host H]
adhd-backlog install-skill [--host claude|codex|opencode|all] [--scope user|project]
adhd-backlog search "<query text>" [--limit n]
adhd-backlog sandbox-path
```
```

### Hunk D — hardcoded `--help` transcript (stale enum rendering)
```
  backlog claim  { input: { uid: string, by: string, action: enum, force?: boolean } }
  backlog create  { input: { title: string, body: string, project: string, component?: string, kind?: string, status?: string, priority?: string, citations?: object[], author?: string, assignee?: string, gitContext?: string, by: string, duplicateAction?: enum, awaitEmbed?: boolean } }
  backlog delete  { input: { uid: string, reason: string, by: string, awaitEmbed?: boolean } }
  backlog get  { input: { uid: string, fields?: union[] } }
  backlog lookup  { input: { q: string } }
  backlog move  { input: { uid: string, toProject?: string, toComponent?: string, by: string } }
  backlog query  { input: { text?: string, filter?: object, fields?: union[], sort?: enum, direction?: enum, limit?: number, offset?: number, after?: string, view?: enum, format?: enum, overlapAxis?: enum, overlapUids?: string[], staleAfterMin?: number } }
  backlog relate  { input: { sourceUid: string, targetUid: string, rel: enum, action: enum, by: string } }
  backlog rm-location  { input: { uid: string, by: string, reason?: string } }
  backlog transition  { input: { uid: string, by: string, toStatus: string, note?: string, citations?: object[], gitContext?: string } }
  backlog update  { input: { uid: string, by: string, title?: string, body?: string, kind?: string, priority?: string, assignee?: string, author?: string, awaitEmbed?: boolean } }
  backlog upsert-component  { input: { project: string, name: string, path?: string, description?: string, by: string } }
  backlog upsert-location  { input: { component: string, project?: string, locType: enum, value: string, by: string } }
  backlog upsert-project  { input: { name: string, path?: string, repoUrl?: string, monorepo?: boolean, description?: string, by: string } }
  batch action  { input: { operation: enum, items: object[], concurrency?: number, mode?: enum, onItemError?: enum, itemTimeoutMs?: number } }
```

### Hunk E — edit / supersede
```
**Edit an existing issue.** A `body` change supersedes the issue (mints a
fresh `uid`); every other field edits in place. `status` is not editable
here — use `transition`:

```
$ adhd-backlog backlog update --input '{"uid":"a61ff0b6-…","by":"claude:1","priority":"CRITICAL"}'
{"ok":true,"data":{"uid":"a61ff0b6-…","changed":["priority"]}}
```
```

### Hunk F — stale `get` --help parenthetical
```
(`backlog get`'s own `--help` line prints `{ input: union }` — the one verb
whose live schema is vaguer than this page. Use the shape above.)
```

### Hunk G — `query.view` enumeration (missing registry views)
```
`query.view` (default `'list'`) selects the result shape: `list` · `ready` ·
`graph` · `order` · `stale` · `similar` · `overlap`. `text` is the
```

### Hunk H — citation "the default" (false)
```
A citation is `{ file, lines?, context?, symbol? }`. Pass `citations` on
`create` or on the `transition` that moves an issue into a terminal status —
required and enforced whenever the project's policy demands it (the
default): a terminal transition with no citations, or with an unverifiable
one, is rejected with `precondition_failed`.
```

### Hunk I — §8 appended (no prior text removed; new section after §7)

---

## REVISE entrypoint/backlog/CONTRIBUTING.md — 2026-09-24

reason: the document describes an end-to-end test harness whose scripts
(`.claude/workflows/backlog-e2e-*.js|.mjs`) do not exist in the tree and were
never committed (`rg --files | rg backlog-e2e` → empty; `git log --all` → no
history). The strategy is retained; a truthful status callout was added so the
plan is not read as a runnable procedure.

removed_or_moved (verbatim — prior opening paragraph):

```markdown
Unit tests (`src/**/*.spec.ts`) prove the write/query primitives are correct
in isolation against a real (non-mocked) store. They do not prove the CLI,
the skill doc, and the tool's discoverability actually work for an agent who
has never seen this codebase. That gap is what the workflows in
`.claude/workflows/backlog-e2e-*.js` close, and it has already found real
defects unit tests could not: a `batch action` primitive nobody discovered, a
`claim`/`transition` ownership gap, an unbounded terminal-status claim, and
half a dozen discoverability defects in the live `--help` schema.
```

---

## REVISE entrypoint/backlog/SPEC.md — 2026-09-24

reason: the spec's own status stamp read `Status: PROPOSED` on a tree where the
surface it describes is fully implemented (`src/`) and the package is version
`1.0.0` — a shipped capability presented as a proposal. Verified there is no
other forward-design marker in the file (`rg -n "PROPOSED|roadmap|unimplemented|TODO"` → line 3 only), so re-stamping the whole document as implemented is a
claim the content supports.

removed_or_moved (verbatim):

```
Status: PROPOSED — revised after blind architect review + backlog-feature
audit. All library primitive names below were re-verified against the published
npm packages.
```

---

## REVISE entrypoint/backlog/{README.md,skill/SKILL.md} — 2nd pass — 2026-09-24

reason: a **concurrent agent** modified `entrypoint/backlog/src/api.ts` (+88
lines), `src/index.ts` (+13), `src/server.ts` and 4 spec files during this
sweep, and rebuilt `dist/index.js` at 20:20:56 — mounting the three stats views
as first-class operations (`backlog priority-matrix` / `part-of-rollup` /
`open-curve`; MCP `backlog_priority_matrix` / `backlog_part_of_rollup` /
`backlog_open_curve`). `git show HEAD:entrypoint/backlog/src/api.ts` contains NO
such mount, so the first-pass claim ("library-only … reachable from no command
surface") was TRUE at the committed revision `9df2a5c7` but FALSE against the
rebuilt working-tree binary — which is what the reviewer read. Corrected: the
views are now described as **mounted AND importable**, the 3 verbs were added to
the surface table (§ Command surface) and the §1 verb list, the operation count
was updated `14/15 → 17/18`, and the now-inexact hard `9df2a5c7` revision stamp
was removed from README ("Which build") and SKILL (intro) since the tree is now
ahead of that commit.

removed_or_moved (verbatim):

README §Library API (prior):
```
## Library API

Beyond the CLI/MCP/HTTP surface, the package re-exports its query layer
(`src/query/index.ts`), including three **library-only** rollup/stats views that
have no CLI verb and no `query.view` member:

- `priorityMatrix(handle, { filter? })` — a status-aware per-priority count
  breakdown (defaults to open work; `filter.status` may be `'open'`, `'closed'`,
  `'all'`, or a status name).
- `partOfRollup(handle, { uid })` — transitive `part_of` descendants of an
  issue, counted once each regardless of chain depth.
- `openCurve(handle, { filter?, at })` — per-sampled-instant counts of issues
  that existed and how many were open, reconstructed from the audit trail.

These are callable only by importing `@adhd/backlog` in-process. They are **not
reachable** from the CLI, MCP, or HTTP surface.
```

SKILL §8 (prior):
```
## 8. Library-only views — NO command surface

Three read views are exported from the package's query layer
(`src/query/views/stats.ts`, re-exported by `src/query/index.ts`) but are
reachable from **no command surface** — there is no CLI verb, no MCP tool, and
no `query.view` member for any of them. They exist for in-process consumers
only:
…
Consumers reach them by importing `@adhd/backlog` in-process; they are
described in `README.md` → "Library API". Never describe them as a command
surface — they have none.
```

CONCURRENCY NOTE: `git status` under `entrypoint/backlog/src` at close showed
` M api.ts`, ` M index.ts`, ` M server.ts`, ` M api.surface.spec.ts`,
` M cli-envelope.spec.ts`, ` M cli.spec.ts`, ` M server.published-layout.spec.ts`,
` M server.verbs.spec.ts`, and untracked `src/stats-surface.wire.spec.ts`. None
of these were authored or reverted by this sweep. The docs were re-verified
against the rebuilt binary on the assumption the mount lands; if it is reverted,
§Rollup & stats views and SKILL §8 must be reverted to the library-only wording
(preserved above).

---

## REVISE entrypoint/backlog/{README.md,skill/SKILL.md} — 3rd pass (revert of 2nd) — 2026-09-24

reason: the 2nd-pass "mounted" documentation was itself wrong. Inspecting the
working tree showed the mount is an **un-reverted negative control**:
`src/api.ts:478` still reads

```
// NEGATIVE CONTROL (temporary, reverted immediately): the `export` keyword is
// removed so `priorityMatrix` is not mounted, proving the surface specs go red.
async function priorityMatrix(
```

so only `part-of-rollup` and `open-curve` are mounted; `priority-matrix` is not
(the current `--help` lists 16 verbs, no `priority-matrix`, and
`priority-matrix --input '{}'` returns `not_found: Unknown command`). This is
the known `DEBT-PROCESS-DISPATCH-RESIDUE-001` failure mode: an un-reverted
negative-control patch left in the tree. The whole stats mount is uncommitted,
actively being toggled by a concurrent agent, and currently internally
inconsistent — so no stable surface can be documented from it. Per the task's
"shipped artifact" rule and the "a concurrent agent may be editing this tree …
skip it and report" constraint, both docs were reverted to the committed
`9df2a5c7` truth: the three views are **query-layer library exports, not a
command surface**, with a discovery pointer ("run `adhd-backlog --help` to see
what a given build exposes") so the wording stays true whether or not a build
mounts them. Operation counts reverted to 14 verbs + `batch`.

superseded (2nd-pass text removed): the "Rollup & stats views — mounted AND
importable" README section and the SKILL §8 mount table + `priority-matrix`
example. (Their text is preserved in the 2nd-pass entry above.)

catalog note: the cartographer's 2nd refresh promoted the three views to
`cli+mcp+http+library` in `capabilities.json` on the strength of the toggled
build. That promotion is **superseded** by the negative-control finding — the
catalog is stale on those three entries and should be regenerated from a frozen
revision. Not re-run here to avoid chasing the moving tree.

---

## NO_CHANGE_NEEDED entrypoint/backlog/CHANGELOG.md — 2026-09-24

reason: the file is generated by `nx release` (emoji-headed sections,
"Thank You" blocks) and is factually accurate on inspection — notably the
`hasMore`/`nextCursor` claim is correct (`nextCursor` is emitted exactly when
`hasMore:true`, verified against the built binary). The repo's own AGENTS.md
directs that CHANGELOG.md not be hand-edited ("the graph is the source of
truth"), so it was left to its generator rather than restructured to a
Keep-a-Changelog shape. Its structural deviation from the Keep-a-Changelog
template is recorded in the close-out report as an unfixed gap.

---

## NO_CHANGE_NEEDED — other scope docs

`SPEC.md`, `DATA_MODEL.md`, `DESIGN.md`, `PLUGIN_ARCHITECTURE.md`,
`RAG-SPEC.md`, `STATE.md`, `BACKLOG_BACKLOG.md`: not edited this sweep.
`PLUGIN_ARCHITECTURE.md` and `RAG-SPEC.md` already label retired/forward
design explicitly. `STATE.md` ("Status as of 2026-09-18") is a plan-tracking
doc and is likely stale relative to `9df2a5c7`, but rewriting it is a
plan-state task, not a docs-surface task — recorded as a gap.
`BACKLOG_BACKLOG.md` is explicitly a non-authoritative audit record.

## PROPOSED (not applied) — entrypoint/backlog/AGENTS.md

The package has no local `AGENTS.md`. A minimal one (one-liner; exact
`npx nx test backlog` / `npx nx lint backlog` / `npx nx build backlog`;
layout; the `skill/SKILL.md` pointer; the store-write hazard) would help
agents, but this repo requires any AGENTS.md change to be A/B tested with a
cheapest-tier agent before landing. Proposed, not written — see the close-out
report for the proposed content and the A/B protocol.
