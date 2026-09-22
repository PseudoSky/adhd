# `@adhd/backlog` — Technical Design

**Version:** 0.2.0
**Companion:** `SPEC.md` (functional spec — personas, operation surface, status
vocabulary, Definition of Done). This document covers layering, the graph mapping,
the claim protocol, env/apigen wiring, the RAG seam, dependencies, concurrency, and
the package layout. Code blocks below mirror the real signatures in `src/`; where a
block is simplified for exposition, the real file is named so the implementer reads
that file for the exact shape.

---

## 1. Layering

```
entrypoint/backlog/
├── src/
│   ├── index.ts          # public barrel — re-exports api.ts + server/cli/serve bootstraps
│   ├── api.ts             # THE apigen extraction surface — plain async fns, ctx first param
│   │                       # (mirrors entrypoint/dispatch-cli/src/api.ts's role exactly)
│   ├── envelope.ts        # {ok:true,data} / {ok:false,error} outcome envelope + BACKLOG_ERROR_CODES
│   ├── env.ts             # @adhd/environment spec + scope resolution (§6 below)
│   ├── server.ts          # apigen mount: extract() -> composeSchemas() -> plugin.run() (HTTP/MCP)
│   ├── cli.ts             # apigen mount: THIRD transport, @adhd/apigen-plugin-cli-output (§7a)
│   ├── serve.ts           # `backlog serve` host command (no lock — any number of concurrent instances, §12)
│   ├── install.ts / install-skill.ts   # scaffolding commands for consumers of the CLI
│   ├── search-shortcut.ts # `backlog search <text>` convenience argv rewrite
│   ├── version-info.ts
│   ├── query/
│   │   ├── types.ts        # IIssueQueryFilter/IIssueQueryFormat/... query-surface types
│   │   ├── query.ts         # queryIssues — filters, views (e.g. `ready`), semantic/keyword routing, paging
│   │   ├── get.ts           # getIssue — single-item projection
│   │   ├── card.ts          # batched edge resolution for one query page (status/priority/citations/...)
│   │   ├── resolve.ts       # catalog-reference resolution (component/edge_kind/...)
│   │   └── views/           # registry.ts, semantic.ts, stats.ts — named view + stats implementations
│   └── write/
│       ├── create-issue.ts  # createIssue — dedupe scan + mint (SPEC.md §6.4)
│       ├── update.ts        # updateIssue — supersede-on-body-change CAS (SPEC.md §4c)
│       ├── transition.ts    # transitionStatus — citation-gated status changes
│       ├── claim.ts         # claim/release/renew (§4 below)
│       ├── move.ts          # move — component reassignment
│       ├── relate.ts        # relate — blocks/relates_to edge maintenance
│       ├── delete.ts        # delete — invalidate(), never a hard row delete
│       ├── catalog.ts       # upsertProject/upsertComponent/upsertLocation/rmLocation
│       ├── audit.ts         # writeAudit — the audit-trail node written by every mutating verb
│       ├── bootstrap.ts     # bootstrapSemanticStoreMembers — THE per-adapter semantic seam (§9)
│       ├── embedding-observer.ts   # scheduleIssueEmbedding — post-commit embed/delete round-trip (§9)
│       ├── errors.ts        # the named E_VALIDATION/E_CONSTRAINT/E_CONTENTION/E_IO error classes
│       └── tx.ts            # hand-composed, transaction-scoped SQL primitives (§3/§4.3 below)
│   └── store/
│       ├── graph-backlog-store.ts  # opens the store via @adhd/sox-store-adapter + createGraphBackend()
│       ├── type-policy.ts          # the one open-vocabulary TypePolicy every store is opened with
│       ├── immediate-retry.ts      # bounded, jittered retry around a busy/locked `.immediate()` call
│       ├── vocabulary-guard.ts     # refuse an unrecognized-vocabulary store at open (read-only)
│       └── signal-cleanup.ts       # SIGINT/SIGTERM store teardown for long-running hosts
├── SPEC.md
├── DESIGN.md
└── (package.json / project.json / vite.config.ts / tsconfig.*.json — §10)
```

Dependency direction (strictly downward, per `AGENTS.md` §2): `api.ts`/`server.ts`/
`cli.ts`/`serve.ts` depend on `query/*` + `write/*` + `store/*` + `env.ts` +
`envelope.ts`; `write/*` depends on `store/*` (for the store handle shape and the
retry/lock primitives) and on its own `tx.ts` for every transaction-scoped SQL
statement; `query/*` depends on `store/*` for the store handle shape; `store/*`
depends on the external `@adhd/sox-graph-store` and `@adhd/sox-store-adapter`;
nothing depends upward. This mirrors dispatch-cli's own split (a thin extraction
surface calling into an implementation layer, `entrypoint/dispatch-cli/src/api.ts`)
generalized to a real persistence layer instead of just DAG I/O — `@adhd/backlog`
has no internal store _package_ (nothing else in the monorepo imports it — see the
"should this be a package at all?" checklist, `AGENTS.md` §1) so the store, query,
and write layers live as internal module trees inside the one entrypoint, not
separate `packages/` libraries.

## 2. Domain → graph mapping

### 2.1 Node kinds

The store is opened with an unconditionally permissive, open-vocabulary
`TypePolicy` (`store/type-policy.ts`) — `kind`, `status`, and `priority` are open
vocabularies (every distinct string observed in the corpus becomes its own catalog
row, no allow-list), so a validating default policy would reject legitimate data
the moment a new kind appears. The application layer's own node kinds sit outside
`@adhd/sox-graph-store`'s closed default vocabulary entirely, which is exactly why
this policy exists and is injected at every `openGraphBacklogStore` call.

The kinds the write layer actually mints (`write/*.ts`):

| Node kind                      | Minted by                                                      | Purpose                                                                                           |
| ------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `issue`                        | `createIssue` / `updateIssue` (on a body-changing supersede)   | The backlog item itself — `content` = `${title}\n\n${body}` for FTS/embedding, `name` = title.    |
| `project`                      | `upsertProject`                                                | Top-level scope container.                                                                        |
| `component`                    | `upsertComponent` / `upsertProject`'s root-component bootstrap | Package/module grouping under a project.                                                          |
| `location`                     | `upsertLocation`                                               | A citation target scope (repo path, doc, etc).                                                    |
| `citation`                     | `createIssue` / `update`                                       | One verified evidence pointer attached to an issue.                                               |
| `note`                         | `createIssue` and other verb-attached freeform notes           | Freeform commentary attached to an issue.                                                         |
| `audit`                        | `write/audit.ts`'s `writeAudit`, called by every mutating verb | The audit-trail entry for one mutation.                                                           |
| `transition`                   | `transitionStatus`                                             | One recorded status change, carrying its citation evidence.                                       |
| `status` / `priority` / `kind` | `upsertProject` policy bootstrap / first observed value        | Per-project catalog rows for the open status/priority/kind vocabularies.                          |
| `edge_kind`                    | catalog bootstrap                                              | Metadata row for a relation type (e.g. `SUPERSEDES`), consulted by `resolve.ts`.                  |
| `agent`                        | first-seen `by`/`assignee` identity                            | The claimant/author/assignee identity a `has_*`/`authored_by`/`assigned_to`-style edge points at. |

### 2.2 `content` / `metadata` field placement

- **`content`** (fed to FTS, and to the embedding pipeline once RAG is enabled —
  §9): `` `${title}\n\n${body}` ``. This is the only field carrying searchable
  natural-language text, so the embedding pipeline has exactly one field to encode.
- **`metadata`** carries every other issue field as JSON, and is always read in
  full and written in full (never a partial patch) — see §4.3 for why.

### 2.3 Edges

The write layer's relation vocabulary (`query/card.ts`, `query/query.ts`,
`write/relate.ts`, `write/catalog.ts`) uses lower-case, verb-phrase relation
names, each resolved against an `edge_kind` catalog row:

| Relationship          | `rel`            | Direction (`src → dst`)                 | Written by                                |
| --------------------- | ---------------- | --------------------------------------- | ----------------------------------------- |
| Blocking dependency   | `blocks`         | blocker → blocked issue                 | `relate`                                  |
| Non-blocking relation | `relates_to`     | itemA → itemB (queried both directions) | `relate`                                  |
| Duplicate merge       | `duplicate_of`   | dropped item → kept item                | `createIssue`'s duplicate handling        |
| Split / part relation | `part_of`        | child item → parent item                | (catalog/relate surface)                  |
| Replacement           | `supersedes`     | new issue → superseded issue            | `updateIssue`'s body-change CAS           |
| Status assignment     | `has_status`     | issue → status catalog row              | `createIssue` / `transitionStatus`        |
| Priority assignment   | `has_priority`   | issue → priority catalog row            | `createIssue` / `update`                  |
| Kind assignment       | `has_kind`       | issue → kind catalog row                | `createIssue` / `update`                  |
| Authorship            | `authored_by`    | issue → agent entity                    | `createIssue`                             |
| Citation attachment   | `has_citation`   | issue → citation node                   | `createIssue` / `update`                  |
| Note attachment       | `has_note`       | issue → note node                       | `createIssue`                             |
| Transition history    | `has_transition` | issue → transition node                 | `transitionStatus`                        |
| Audit trail           | `audits`         | audit node → issue                      | every mutating verb, via `write/audit.ts` |
| Project → component   | `owns_project`   | component → project                     | `upsertComponent` / project bootstrap     |
| Component → issue     | `owns_component` | issue → component                       | `createIssue` / `move`                    |

**Why the claim lease (`claimedBy`/`claimedAt`) is metadata-only, not an edge:**
the lease is high-churn (rewritten on every renewal) and the graph contract's edge
primitives are bi-temporal `invalidate`, never an in-place update — representing a
lease as an edge would either spam invalidated edges on every renewal or require
an edge-update-in-place operation the contract doesn't offer. A plain metadata
field mutated through the single atomic primitive (§4.3) is the correct fit for a
fast-moving scalar lease.

### 2.4 `uid` allocation and dedupe (`createIssue`)

Every issue is identified by a single global `uid`, minted by `createIssue` at
write time inside the same transaction that writes the node — there is no
separate pre-allocation step and no caller-suppliable id.

`createIssue`'s dedupe scan (`write/create-issue.ts`, SPEC.md §6.4) runs before
minting and combines full-text search over `title`/`body` with, once the
embedding pipeline is enabled (§9), a nearest-neighbor pass over `content`
embeddings — candidates are filtered and ranked against the project's own
`dedupe_threshold` policy value, and returned to the caller (never silently
merged) unless the caller passes `duplicateAction: 'force'`. A dedupe scan racing
a concurrent create is an accepted soft guarantee — the human/agent reviewing the
returned candidates catches it on the next `query` pass — never a hard constraint
enforced by a transaction.

## 3. Store adapter — owning the raw store-adapter handle

The single most important design decision in this document: **the backlog store
opens its own `@adhd/sox-store-adapter` connection (Turso substrate, resolved by
the adapter itself — nothing in this package names or hard-codes a particular
driver) and hands it to `createGraphBackend(adapter)`, keeping the adapter handle
for itself.** `@adhd/sox-graph-store`'s own methods (`writeNode`/`writeEdge`/
`touch`/`invalidate`/`getNodeByUid`/...) each run against the adapter directly and
autocommit — none of them accept an already-open transaction handle. Every
compare-and-swap the write layer needs (claim/renew, uid-mint dedupe, supersede,
citation-gated transition) is therefore composed by hand, inside one
`adapter.transaction(fn, { mode: 'immediate' })` block, against SQL shapes that
mirror the library's own primitives byte-for-byte (`write/tx.ts`) — never a new,
invented shape.

```ts
// store/graph-backlog-store.ts (real shape, abbreviated)
import { createStoreAdapter, type StoreAdapter } from '@adhd/sox-store-adapter';
import { createGraphBackend, type GraphBackend, type TypePolicy } from '@adhd/sox-graph-store';
import { OPEN_TYPE_POLICY } from './type-policy.js';

export interface GraphBacklogStore {
  readonly adapter: StoreAdapter; // ONLY for the CAS transaction wrapper
  readonly graph: GraphBackend; // all non-CAS reads/writes go through this
  readonly typePolicy: TypePolicy; // the SAME instance graph was constructed with
}

export async function openGraphBacklogStore(dbPath: string, busyTimeoutMs = 5000): Promise<GraphBacklogStore> {
  const adapter = await createStoreAdapter({ dbPath });
  await adapter.pragmaSet('busy_timeout', busyTimeoutMs); // AFTER graph construction — see the gotcha in §12
  const graph = createGraphBackend(adapter, { typePolicy: OPEN_TYPE_POLICY });
  return { adapter, graph, typePolicy: OPEN_TYPE_POLICY };
}
```

`.transaction(fn, { mode: 'immediate' })` (not the default deferred `BEGIN`) is
load-bearing: a deferred transaction only acquires the write lock at the moment
its FIRST write statement executes, which leaves a window where two processes can
both pass a read-check under their own deferred transaction before either
escalates to a write lock — exactly the race a CAS protocol must not have.
`BEGIN IMMEDIATE` acquires the write lock at transaction start, so a second
process's own immediate transaction blocks (up to `busy_timeout`) rather than
interleaving.

## 4. Claim protocol

The ephemeral multi-agent lease against a live `issue` node's
`meta.metadata.claimedBy`/`claimedAt` pair (`write/claim.ts`, SPEC.md §4c/§6.3.5).

### 4.1 State carried per issue (in `metadata`, §2.2)

```ts
interface ClaimMeta {
  claimedBy?: string; // absent ⇒ unclaimed
  claimedAt?: string; // ISO — set/bumped on every claim/renewal
}
```

### 4.2 Semantics

| Caller `by` vs current `claimedBy` | Staleness                    | Result                                                                                     |
| ---------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------ |
| unclaimed                          | —                            | `claimed`                                                                                  |
| `by === claimedBy`                 | —                            | `renewed` — no contention check, ever (you can always renew your own lease)                |
| `by !== claimedBy`                 | not stale                    | refused — the response carries the current holder and since-when, no write                 |
| `by !== claimedBy`                 | stale, or `opts.force: true` | proceeds, and the response names the previous claimant for audit — never a silent takeover |

`release` on an already-unclaimed issue is a no-op, never an error — every exit
path (done/error/abandon) should be able to call it unconditionally. Releasing
someone else's non-stale claim without `force` is refused.

### 4.3 The atomic mutation primitives

Two distinct primitives now cover this, not one:

1. **`write/tx.ts`'s transaction-scoped SQL functions** — used by every write
   verb (`claim`, `createIssue`, `update`, `transitionStatus`, `move`, `relate`,
   `delete`, the catalog upserts). Each verb's `executeWriteTransaction` opens one
   `adapter.transaction(fn, { mode: 'immediate' })`, re-fetches the current node
   INSIDE that transaction (`getNodeByUidTx`/`getNodeByRowidTx` — never the bare,
   un-transacted `graph.getNodeByUid`, which would autocommit outside it),
   evaluates the verb's rule against that fresh read, and issues the write against
   the SAME transaction handle before it commits. Two concurrent calls against the
   same `uid` therefore serialize through the transaction's write lock: the loser
   blocks until the winner commits, then its own read executes against the
   winner's already-committed state.
2. **Every metadata mutation now goes through `write/tx.ts`.** The former
   read-full-compute-full-write `mutateMetadata` helper
   (`store/mutate-metadata.ts`) is deleted — its last consumer was the dead RAG
   write path. Where a caller previously used it, the verb's own
   `executeWriteTransaction` re-fetches the node inside the transaction and
   writes the complete metadata object through the tx-scoped primitives. The
   reason it existed still holds and is recorded here: `touch(id,
   Partial<NodeMeta>)` is a wholesale REPLACE, not a merge (verified against
   `@adhd/sox-graph-store`'s published `dist/`), so any caller that does go
   through `touch` must read the CURRENT full node, compute a full new metadata
   object, and pass the COMPLETE object.

Both primitives are wrapped in `withImmediateRetry` (`store/immediate-retry.ts`)
— a bounded, jittered exponential backoff that retries only a busy/locked
transaction start, never any other error and never a semantic "claim held" result
(a normal return value, not an exception).

### 4.4 Identity — never a bare role literal

`by` is always caller-supplied, never defaulted inside the tool (SPEC.md's
opening rule for every mutating verb: a missing/blank `by` throws
`InvalidArgumentError('by', ...)` before any write runs). A CLI wrapper or MCP
host is expected to pass a caller identity distinguishable from every other
concurrent caller (e.g. `<agent-name>:<instance-id>`); enforcing a specific shape
is deliberately left to the caller rather than validated inside `claim` itself, so
an orchestrator with its own identity source is never forced through a helper.

## 5. `api.ts` — the apigen extraction surface

**The exported surface of this file IS the mounted surface** (`server.ts`'s
extraction step reads the built `api.d.ts` with no allow-list, so every exported
function becomes a CLI command, an MCP tool, a Fastify route, and an OpenAPI
path). `ctx: BacklogCtx` is the sole non-serializable parameter, excluded from the
generated JSON Schema by the `ctx-name-only` rule (the first parameter named
exactly `ctx`); every other parameter/return type is plain and JSON-serializable.

`api.ts` exists as a thin adapter, not a reimplementation: `query/*` and `write/*`
are written against store handles (`IWriteStoreHandle`, `IQueryStoreHandle`, or a
bare `GraphBackend`), never against a transport `ctx`, because that is the right
seam for tests (which open a store directly) and for any future non-apigen
consumer. `api.ts` is the one module that owns `BacklogCtx`, derives each handle
shape from it, and presents the mounted verb surface — `get, query, lookup,
create, update, transition, claim, relate, move, upsertProject, upsertComponent,
upsertLocation, rmLocation, delete` — in the single shape every transport
projects from. The implementation layer throws named `BacklogWriteError`
subclasses carrying one of the closed `E_VALIDATION`/`E_CONSTRAINT`/
`E_CONTENTION`/`E_IO` codes (`write/errors.ts`); `api.ts` maps those into the
outcome envelope's nine closed error codes (`envelope.ts`) rather than letting a
transport see a raw exception.

## 6. `env.ts` — `@adhd/environment` wiring

```ts
// env.ts (real shape, abbreviated)
export interface BacklogConfig {
  readonly db: { readonly path: string | undefined; readonly busyTimeoutMs: number };
  readonly logging: { readonly level: string };
  readonly embedding: { readonly enabled: boolean; readonly provider: string; readonly model: string };
}

export const backlogEnvironmentSpec: EnvironmentSpec<BacklogConfig> = {
  envPrefixOverride: 'ADHD_BACKLOG',
  namespaces: ['production', 'test'], // 'production' MUST stay first — see below
  dirs: { data: { kind: 'data' }, cache: { kind: 'cache' } },
  files: { db: { in: 'data', name: 'backlog.db' } },
  config: {
    'db.path': { type: 'string', env: 'ADHD_BACKLOG_DATABASE_PATH' },
    'db.busyTimeoutMs': { type: 'integer', env: 'ADHD_BACKLOG_DATABASE_BUSY_TIMEOUT_MS', default: 5000 },
    'logging.level': { type: 'string', env: 'ADHD_BACKLOG_LOG_LEVEL', default: 'info' },
    'embedding.enabled': { type: 'boolean', env: 'ADHD_BACKLOG_EMBEDDING_ENABLED', default: false },
    'embedding.provider': { type: 'string', env: 'ADHD_BACKLOG_EMBEDDING_PROVIDER', default: 'fastembed' },
  },
};
```

Deliberately defaults to `global` scope, not the generic `Environment`
auto-detect default (project-marker-found ⇒ `project`) — one shared graph
spanning every repo on the machine, by default. `db.path` has no default; unset
falls back to `env.files.db` under the resolved scope root
(`~/.adhd/backlog/production/data/backlog.db` at global scope,
`<project>/.adhd/backlog/production/data/backlog.db` at project scope) — never
the memory-server MCP's own store, by construction of `@adhd/environment`'s
per-project namespacing.

`embedding.enabled` defaults to `false`: an unconfigured build behaves exactly as
if the embedding pipeline did not exist (every semantic query input answers a
typed "not configured" error), so a host opts in deliberately and nothing is ever
switched on implicitly (§9).

### 6a. Namespace selection — explicit-parameter-first, never ambient

Every store-open site resolves `scope` (global/project/system) through
`resolveBacklogScope`'s documented precedence cascade (explicit param →
`ADHD_BACKLOG_SCOPE` → `ADHD_ENV_SCOPE` → `'global'`), but `namespace` — the
sibling axis `@adhd/environment` uses to pick a trailing path segment under
that scope root (`<root>/backlog/<namespace>/…`) — had no selector at all
originally: `buildBacklogEnv` hardcoded `namespace: 'production'` and
`backlogEnvironmentSpec.namespaces` declared only that one value.

`BuildBacklogEnvOptions.namespace` is a real function parameter, threaded CLI
flag → `RunBacklogCliOpts`/`RunServeCommandOpts`/`StartOpts` →
`BuildBacklogEnvOptions` → `EnvironmentOptions.namespace`. It is deliberately
**explicit-parameter-first with no env-var fallback** — unlike `scope`'s
cascade, there is no `ADHD_BACKLOG_NAMESPACE` env var, on purpose: an env var
leaks across an entire shell session and inherits into every spawned child
process, which is exactly the class of ambient state that caused real
confusion in this codebase's own history (a persisted
`embedding.enabled: true` config, a forgotten `ADHD_ROOT`). A namespace
selection that can only ever come from an explicit parameter cannot be
silently defeated by a stray environment variable the caller forgot was set.
Omitted ⇒ `'production'` (`backlogEnvironmentSpec.namespaces`' first
declared entry, per `@adhd/environment`'s own `options.namespace ??
namespaces[0]` fallback — every existing caller that never passes this
keeps resolving there, unchanged).

**SPEC.md §5c superseded the original `--sandbox` boolean with an explicit
`--namespace <value>` flag** — the surface described below is the CURRENT
one; `--sandbox` no longer exists (hard removal, no deprecated alias, D7).
`backlogEnvironmentSpec.namespaces` declares THREE values:
`['production', 'test', 'sandbox']`. `'test'` is a deliberately-persisted,
non-ephemeral namespace (e.g. a shared CI/team store expected to accumulate
state over time); `'sandbox'` is its own, separately-declared namespace —
not an alias for `'test'` — because it carries an entirely different
lifecycle: `--namespace sandbox` layers ephemeral-root-minting on top of
namespace selection (a freshly-minted `adhdRoot`, `BuildBacklogEnvOptions`'s
broader test-isolation knob the whole test suite depends on, and the one
`resolveIrCacheFile`'s own leak fix is guarded on), so the resulting store
path carries two independent, structural isolation layers
(`<fresh-tmpdir>/backlog/sandbox/data/backlog.db`) rather than one. This
closes `BUG-BACKLOG-SANDBOX-SILENT-BYPASS-001`'s bug *class* (an already-set
`ADHD_ROOT` silently defeating the sandbox flag, since nothing read
`process.env['ADHD_ROOT']` and the isolation swap ran unconditionally): even
if a future regression reintroduces an unconditional `adhdRoot` bypass, an
explicit `namespace: 'sandbox'` parameter still cannot be silently overridden
the way a `process.env` read can, so `--namespace sandbox` would still
resolve under the `sandbox` namespace segment rather than `production`.

`--namespace sandbox` additionally writes a REAL `config.yaml` (not an
in-code override) at the resolved sandbox root with `embedding.enabled:
false`, on every invocation, before `buildBacklogEnv` ever reads file layers
(SPEC.md §5c, D8) — this closes the gap where an isolated invocation's
`embedding.enabled: false` was previously an ACCIDENT of an empty directory
(no `config.yaml` existed yet), not a deliberate guarantee: a stray
pre-existing `config.yaml` at that exact path would otherwise silently
reintroduce the config-cascade bleed-through this whole mechanism exists to
prevent. `ADHD_BACKLOG_EMBEDDING_ENABLED` (the env var) still outranks this
written file — an explicit env var is a deliberate ask, a stray file is not.

An unrecognized `--namespace` value is rejected BEFORE dispatch with the same
`{ok:false,error:{code:'invalid_argument',...}}` envelope every other CLI
failure uses (SPEC.md §5c, D3) — never silently falling through to the
default or propagating an ungoverned namespace string into
`EnvironmentOptions.namespace`.

One remaining, deliberately out-of-scope precedence hole: an ambient
`ADHD_BACKLOG_DATABASE_PATH` (→ `config.db.path`, `resolveBacklogDbPath`'s
first-precedence source) still overrides namespace selection outright,
since it short-circuits path derivation entirely before `namespace` is ever
consulted. That is pre-existing `db.path` precedence (`§6`'s config table
above), not a namespace-selection concern.

Real, dedicated architecture review of this design against what actually
shipped is tracked in `STATE.md` (item A11) as an explicit follow-up.

## 7. `server.ts` / `cli.ts` — apigen mount wiring

Follows the "MOUNT, do NOT codegen" pattern exactly — `extract()` →
`composeSchemas()` → `plugin.run()`. `createClient` is invoked fresh on every
dispatched call by the apigen runtime, so it must be a closure returning the SAME
already-open `BacklogCtx` on every call (one store, opened once, for the process
lifetime) — never something that re-opens the store per request.

`extract()` targets the BUILT `dist/api.d.ts`, not the source `.ts` file: a
shipped npm package's `dist/api.js` is stripped JavaScript with no type
information, but the emitted `.d.ts` carries the same type graph via ambient
declarations — a documented, anticipated apigen extraction path. The live
function references come from a plain static `import` of `api.js` (resolved by
the bundler at build/load time), avoiding a runtime dynamic import of a computed
path entirely.

### 7a. `cli.ts` — the third transport

Same mount pattern as `server.ts`, extended to `@adhd/apigen-plugin-cli-output`,
reusing the identical `buildBacklogApigenPackage(ctx)` `server.ts` calls (never a
re-derived copy). It diverges from `server.ts` on one point deliberately: the
store is opened LAZILY, only once a dispatched command actually reaches a real
`api.ts` function — a bare `--help`/no-args/unknown-command invocation must never
open a real store through the adapter before `argv` has even been inspected.

Every operation's canonical projected path carries a fixed namespace prefix
derived from the extraction step (HTTP routes, MCP tool names, and the
cli-output plugin's own internal command table all key off it). The CLI is the
one transport that hides this prefix from its human caller: it derives the real
prefix from the live `operations` list at runtime (never a hard-coded literal)
and transparently prepends it, so a human types the clean `backlog get …` and the
plugin still resolves it against its real, prefixed table.

**Bin mechanism** (`package.json`'s `"bin": { "adhd-backlog": "./dist/index.js"
}`): `index.ts` is both the CLI entry and the public library barrel
(`startBacklogServer`/`runBacklogCli` are imported programmatically by test
fixtures and any other Node consumer), so `dist/index.js` carries an entry-guard
that runs the CLI only when this file is itself the process's executed entry
point, and does nothing when merely imported — using `realpathSync` rather than a
bare `argv[1]` comparison, since pnpm/npm always install a package's `bin` as a
symlink and Node resolves symlinks for the executing module's own
`import.meta.url` while leaving `process.argv[1]` unresolved.

## 8. Markdown interop

`'markdown'` is a reserved value of the query surface's output-format type
(`query/types.ts`'s `IIssueQueryFormat`), not an implemented rendering path: a
query call with `format: 'markdown'` currently throws `InvalidArgumentError`,
documenting that markdown rendering is not implemented in this slice — the query
layer returns `json`, and a markdown projection is expected to compose that JSON
result with a separate renderer. There is no markdown parsing/rendering module in
this package today, and no porting relationship to any external script.

## 9. The RAG seam (embeddings — opt-in, lazy, decoupled by default)

The embedding/vector pipeline is a real, shipping seam, off by default
(`embedding.enabled`, §6). An unconfigured build has zero hard dependency on an
embedding/vector substrate: every semantic query input (`filter.semantic`,
`filter.anchor`, a `similar` view, relevance sort, a `_vector` field) answers a
typed "not configured" error, never a silently-wrong keyword substitute.

- **`write/bootstrap.ts` — `bootstrapSemanticStoreMembers`** is THE per-adapter
  semantic path. Given the store's already-open `StoreAdapter`/`GraphBackend`
  pair, it constructs the real stack from the `optionalDependencies`
  `@adhd/sox-vector-store` + `@adhd/sox-embedding-provider` (loaded through a
  non-literal dynamic `import()`, so neither is required at build time) and
  returns two members:
  - `embedding: IEmbeddingBackend` (`embedDocument` / `upsertVector` /
    `deleteVector`) — the write-side handle, keyed on the graph node's rowid.
  - `search: { backend: StoreSearchBackend, embedQuery, spacePopulated }` — the
    read-side handle. `spacePopulated()` is a **bounded** `hasVectors` probe
    (`SELECT 1 … LIMIT 1`), per-query truth read from the durable vector table —
    never a process-lifetime latch (BUG e19bc9d0).

  The derive is memoized per `StoreAdapter` (only a successful, member-ful
  result is retained), so a process pays the cold model load once. Absent
  members are the honest degrade: `scanForDuplicates` reports "scan unavailable"
  and semantic reads report as unconfigured, never a stub returning empty.
- **`api.ts` — `ensureSemanticReady`** is the sole call site: `writeHandle` /
  `queryHandle` invoke it only under their `needsSemantic` gate, so a plain
  `claim`/`transition`/`query` never pays the cold load (SPEC.md §5b). A bare
  `text:` query additionally resolves `search.spacePopulated()` and snapshots it
  onto the handle, because `resolveTextInput` is synchronous.
- **Write-side (`write/embedding-observer.ts` — `scheduleIssueEmbedding`):**
  `createIssue`/`updateIssue`/`deleteIssue` write the node inside their own CAS
  transaction with NO embedding call inside it — the node is FTS-searchable the
  instant that transaction commits. `scheduleIssueEmbedding` runs strictly AFTER
  that commit, off the write lock, and writes its own
  `embedding_upserted`/`embedding_deleted`/`embedding_failed` audit row in a
  follow-up `immediate` transaction. A failed embed degrades that one item to
  FTS-only reachability; it never fails the write that already committed, and
  the returned promise never rejects into the caller. `awaitEmbed: true` awaits
  that promise before the verb returns — the durability guarantee for a
  short-lived process. There is no store-level drain: the old
  `flushEmbeds`/in-flight-set mechanism was deleted with `store/embed-queue.ts`,
  and `closeGraphBacklogStore` no longer drains.
- **Dedupe (§2.4):** once embeddings are enabled, `createIssue`'s dedupe scan
  gains a nearest-neighbor candidate source over `content` embeddings, ranked
  against the project's `dedupe_threshold` policy value — `force` still lets a
  caller override.

## 10. Package layout

`entrypoint/backlog` is the canonical entrypoint shape: `package.json` is public
(`publishConfig.access: "public"`), ships `main`/`module`/`typings` pointing at
`./dist/...`, and its `bin` exposes the `adhd-backlog` command. `project.json` is
a real Nx library project with `build`, `test`, `typecheck`, and
`nx-release-publish` (`dependsOn: ["build","test","verify-dist-load"]`) targets,
tagged per `.adhd/workspace.json`'s `defaults.entrypoint` block (`domain:
entrypoint, pkg-kind: entrypoint, pkg-class: entrypoint, layer: entrypoints,
platform: node, access: domain`). The Vite build externalizes the store
adapter's native driver dependency rather than bundling it (§12).

## 11. Dependencies

```json
{
  "dependencies": {
    "@adhd/apigen-core-client": "^0.3.0",
    "@adhd/apigen-engine-naming": "^0.2.2",
    "@adhd/apigen-plugin-api-fastify": "^0.2.3",
    "@adhd/apigen-plugin-batch": "^0.2.2",
    "@adhd/apigen-plugin-cli-output": "^0.2.3",
    "@adhd/apigen-plugin-ir-cache": "^0.1.0",
    "@adhd/apigen-plugin-mcp": "^0.2.3",
    "@adhd/apigen-plugin-openapi": "^0.2.2",
    "@adhd/environment": "^0.1.0",
    "@adhd/environment-base-spec": "^0.1.0",
    "@adhd/sox-graph-store": "^0.9.1",
    "@adhd/sox-hybrid-search": "^0.4.2",
    "@adhd/sox-semantic": "^0.1.2",
    "@adhd/sox-store-adapter": "^0.9.1",
    "@adhd/sox-telemetry": "^0.3.0"
  },
  "optionalDependencies": {
    "@adhd/sox-embedding-provider": "^0.4.1",
    "@adhd/sox-vector-store": "^0.6.0"
  }
}
```

`@adhd/sox-store-adapter` is the store substrate (Turso by resolution) — no
direct database driver is a dependency of this package at all, runtime or dev;
the adapter is the only place a driver is named. The two `optionalDependencies`
back the RAG seam (§9) and are never installed unless a host opts in.

## 12. Concurrency & native-module gotchas

- **Node ≥ 22**, pinned in CI.
- **The store adapter's native driver** is pulled in transitively via
  `@adhd/sox-store-adapter`; a fresh `git worktree`/CI runner installs it like
  any other npm dependency (prebuilt binaries, no per-ABI rebuild) — it must stay
  external in the Vite build (§10), never bundled.
- **WAL mode + `busy_timeout`** is required, not optional — the global-scope
  store is, by construction, opened by many concurrent processes/agents/repos.
  Without WAL, a writer blocks all readers; without `busy_timeout`, a blocked
  `.immediate()` throws a busy error immediately instead of waiting out a brief
  contention window.
- **Bounded busy-retry + configurable `busy_timeout`** — `store/immediate-retry.ts`'s
  `withImmediateRetry` wraps every `.immediate()` call in a bounded, jittered
  exponential backoff that retries only a busy/locked transaction start — never
  any other error, and never the semantic "held" claim-contention result (a
  normal return value, not an exception). `busy_timeout` is configurable via
  `BacklogConfig.db.busyTimeoutMs` (§6, default 5000) and must be set on the
  adapter AFTER `createGraphBackend()` constructs the graph backend — the graph
  backend's own constructor unconditionally re-runs its own default pragmas,
  which would otherwise silently clobber a caller-supplied value back to its
  default.
- **Every store in this ecosystem is parallel-process enabled** — multiple
  processes hold concurrent write connections to the same store, serialized
  through the store adapter's own locking (WAL + `busy_timeout` + `BEGIN
IMMEDIATE`), which is exactly what makes the CAS design in §3/§4 correct. This
  applies to `backlog serve` (the long-running HTTP/MCP host) exactly as it
  applies to any other caller: any number of `serve` processes may run
  concurrently against the SAME store, with no singleton guard of any kind —
  a hard requirement for this rewrite (never a PID-file lock, port lock, or any other
  serialization gate on `serve` itself). An earlier PID-file mutex
  (`store/serve-lock.ts`) briefly existed after a real incident where two
  stray concurrent `serve` processes corrupted a production store; deeper
  investigation found the actual root cause was a since-fixed store-adapter
  bug (non-canonicalized quiescence check racing a TRUNCATE checkpoint — see
  STATE.md A16/A17) reachable with no real concurrency hazard at all, and
  that lock was removed once that was proven and re-verified empirically
  (three real two-process sustained-write trials, zero failures — STATE.md
  A17; durable coverage in `src/serve.singleton.spec.ts`). Ad-hoc CLI/MCP-tool
  callers and `serve` processes all write concurrently exactly as §3/§4
  describe, with no special case for `serve`.
- **The embedding pipeline never shares the store's write-lock transaction** —
  every embed call happens strictly after the subject write has committed (§9),
  so an embedding backend's own thread/process model is never this package's
  concern.
- **Separate DB file from other stores** — `env.files.db` resolves under
  `~/.adhd/backlog/production/data/backlog.db` (global scope) or
  `<project>/.adhd/backlog/production/data/backlog.db` (project scope), never
  another tool's own operational store — no writer-lease conflict is possible
  because the two never open the same file, by construction of
  `@adhd/environment`'s per-project namespacing.

## 13. Testing strategy (implements SPEC.md's DoD)

| DoD clause                 | Test location                                                                                           | Real components exercised                                                                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CAS claim race             | `src/write/claim.spec.ts`                                                                               | Concurrent `claim` calls against one real store, driven through a barrier so both are in-flight before either commits — never a `sleep`.                                                                              |
| Cross-process write safety | `src/write/cross-process-write-safety.spec.ts`, `src/test/fixtures/cross-process-*.ts`                  | Real separate Node processes writing/claiming against one shared temp store file.                                                                                                                                     |
| Live HTTP mount            | `src/server.spec.ts`                                                                                    | `startBacklogServer({transport:'http', signal})` against a real temp store file, then a real `fetch()` call — unflagged/default-running per `AGENTS.md`'s "Live testing is mandatory" (no paid third party involved). |
| Live MCP mount             | `src/server.mcp.spec.ts`                                                                                | `startBacklogServer({transport:'mcp', signal})`, driven by a real MCP SDK client over stdio.                                                                                                                          |
| Scope isolation            | `src/env.spec.ts`                                                                                       | Real `Environment` instances at `project` scope over temp `.git` dirs and at `global` scope over a temp `HOME`.                                                                                                       |
| Ready/blocked view         | `src/query/query.ready.spec.ts`                                                                         | Real `blocks` edges written via `relate`, `view:'ready'` asserted against the real store.                                                                                                                             |
| RAG opt-in / opt-out       | `src/write/rag-optional-deps.spec.ts`, `src/api.semantic-production-seam.spec.ts`, `src/api.semantic-laziness.spec.ts`, `src/query/views/semantic.spec.ts` | The default-disabled path answers the typed "not configured" error; the opted-in path drives a real (or injected fake, per test) embedding member end to end. |
| Concurrent serve (no lock) | `src/serve.singleton.spec.ts`                                                                           | Two real, simultaneously-live `backlog serve` invocations against one store file, driven by real MCP clients issuing sustained concurrent writes — no lock coordinates them, and a fresh reopen finds exactly what was reported `ok:true`. |
| Dist-load                  | `nx run backlog:verify-dist-load`                                                                       | Builds real `dist/`, imports it, calls a real verb against a real temp store — not source resolution.                                                                                                                 |

Every test above uses a real store under `tmp/backlog/<test-name>/` per
`AGENTS.md` §10, removed on teardown.

## 14. Verified facts feeding implementation

- **`touch()` metadata merge is a wholesale REPLACE**, not a deep merge
  (verified against `@adhd/sox-graph-store`'s published `dist/`). Every caller
  that goes through `touch` (§4.3) must therefore always pass the complete
  metadata object — passing a partial object would silently drop every other
  field.
- **`invalidate()` (nodes) and `invalidateEdgeTx` (edges) merge, rather than
  replace**, the invalidation fields (`invalidatedAt`/`invalidatedReason`) into
  the existing metadata — a different, narrower primitive than `touch()`, used
  by `delete` and by every edge-retirement path in `write/tx.ts`.
  "Already invalidated or absent" is a no-op on both, matching the library's own
  idempotent behavior.
- **None of `writeNode`/`writeEdge`/`invalidateEdge`/`getNodeByUid` accept an
  already-open transaction handle** — each runs against the bare, un-transacted
  adapter and autocommits. This is why `write/tx.ts` exists at all: every write
  verb that needs a true compare-and-swap hand-composes the identical SQL shape
  those library methods use, issued against the verb's own open transaction,
  rather than calling the library methods from inside one (which would
  autocommit outside it).
- **`getEdges({ src?, dst?, rel? })`** is the primitive `query/card.ts` and
  `query/query.ts` use for every edge lookup (blockers, catalog assignment
  resolution, audit trail, ...) — batched per query page rather than resolved
  edge-by-edge, so a page's cost does not grow with how many relations any one
  issue carries.
- Invalidated/superseded nodes are excluded from default views; a soft-deleted or
  superseded issue does not appear in `query` results unless explicitly
  requested.
