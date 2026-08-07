# `@adhd/backlog` — Technical Design

**Version:** v0.1.0
**Date:** 2026-07-22
**Companion:** `SPEC.md` (functional spec — personas, operation surface, status
vocabulary, Definition of Done). This document covers layering, the graph mapping,
the claim protocol, env/apigen wiring, the RAG seam, dependencies, concurrency, and
the package-layout upgrade. DESIGN ONLY — no `client.ts`/`server.ts` exists yet; code
blocks below are illustrative signatures/pseudocode for the implementer, not shipped
source.

---

## 1. Layering

```
entrypoint/backlog/
├── src/
│   ├── index.ts        # public barrel — re-exports client.ts + server.ts bootstrap
│   ├── client.ts        # THE apigen extraction surface — plain async fns, ctx first param
│   │                     # (mirrors entrypoint/dispatch-cli/src/api.ts's role exactly:
│   │                     #  entrypoint/dispatch-cli/src/api.ts:1-29 — "plain, JSDoc'd
│   │                     #  async functions ONLY... every real dependency wire-up lives
│   │                     #  in ./lib/core.ts instead")
│   ├── server.ts         # apigen mount: extract() -> composeSchemas() -> plugin.run()
│   ├── model.ts          # BacklogItem/BacklogStatus/Citation/... types (SPEC.md §4)
│   ├── env.ts            # @adhd/environment spec + scope resolution (§6 below)
│   ├── markdown.ts        # parse()/render() — ported from tools/util/backlog.mjs (§8)
│   └── store/
│       ├── graph-backlog-store.ts   # opens better-sqlite3 db + createGraphBackend()
│       ├── mapping.ts                 # BacklogItem <-> graph node/edge (§2 below)
│       ├── mutate-metadata.ts         # THE single atomic read-modify-write primitive (§4.3)
│       ├── claim.ts                   # claimItem/renewClaim/releaseClaim (§4)
│       ├── query.ts                   # listItems/stats/readyItems/topoOrder/... (§2.5)
│       └── ids.ts                     # human-id allocation (§2.5, same CAS primitive)
├── SPEC.md
├── DESIGN.md
└── (package-layout files — §7)
```

Dependency direction (strictly downward, per `AGENTS.md` §2): `client.ts`/`server.ts`
depend on `store/*` + `model.ts` + `env.ts` + `markdown.ts`; `store/*` depends on
`model.ts` and the external `@adhd/sox-graph-store`; nothing depends upward. This
mirrors dispatch-cli's own split (`api.ts` calling into `lib/core.ts`,
`entrypoint/dispatch-cli/src/api.ts:9-17`) generalized to a real persistence layer
instead of just DAG I/O — dispatch-cli has no store package because it delegates to
`@adhd/dispatch-core-client`; `@adhd/backlog` has no internal store *package* (nothing
else in the monorepo would import it — see the "should this be a package at all?"
checklist, `AGENTS.md` §1) so the store lives as an internal module tree inside the one
entrypoint, not a separate `packages/` library.

## 2. Domain → graph mapping

### 2.1 Node kinds

| Domain concept | `kind` | `namespace` | `tags` | `name` |
|---|---|---|---|---|
| Backlog item | `'generic'` | `repo` slug (§3 of SPEC.md) | `['backlog-item', kind, family, ...userTags]` | `` `${repo}::${humanId}` `` |
| Plan | `'generic'` | `repo` slug | `['backlog-plan']` | `` `${repo}::plan:${planSlug}` `` |
| Assignee identity | `'entity'` | *(none — identities are cross-repo)* | `['backlog-assignee']` | the raw identity string (e.g. `implementer:abc123`) |

`kind:'generic'` is used for both items and plans (the closed `NodeMeta.kind` enum has
no `'backlog-item'`/`'plan'` variant — the contract summary's guidance: *"use
`kind:'generic'` + `'backlog-item'` in tags; carry structured fields in `metadata`"*).
Assignees use `kind:'entity'` because they are exactly the "named, cross-cutting thing
other nodes point at" concept `entity` already models in the sox/memory ecosystem.

### 2.2 `content` / `summary` / `metadata` field placement

- **`content`** (fed to FTS5, and later to embeddings — see §8 RAG seam): `` `${title}\n\n${body}` ``.
  This is the ONLY field that should carry natural-language searchable text; nothing
  else duplicates it, so a future embedding pass has exactly one field to encode.
- **`summary`**: `title` verbatim (already short; no extractive summarization needed for
  a backlog item — unlike a long conversational episode).
- **`importance`**: derived deterministically from `priority` — `CRITICAL→10, HIGH→8,
  MEDIUM→5, LOW→2`, absent priority `→1`. Recomputed on every `setPriority` call.
  `confidence`: always `1.0` (backlog items are asserted facts, not inferred).
- **`metadata`** carries every other `BacklogItem` field verbatim as JSON:
  `{ humanId, kind, family, status, priority, repo, projectPath, plan, assignee,
  claimedBy, claimedAt, citations, notes, archivedAt? }`. `tags`/`namespace`/`name` are
  ALSO derivable from `metadata` — they are denormalized onto the node's first-class
  columns purely so `queryNodes({ tags, namespace })` (the columns `sox-graph-store`
  indexes) stays fast without a metadata JSON scan for the common filters.

`projectPath` is metadata-only (no first-class column) — package-level filtering
(`listItems({ projectPath })`) is a metadata-equality scan, acceptable at the ~100
package / few-thousand-item scale in requirement #4 (see §9 for the explicit
assumption this depends on).

### 2.3 Edges

| Relationship | `EdgeRel` | Direction (`src → dst`) | Written by |
|---|---|---|---|
| Blocking dependency | `DEPENDS_ON` | item → the item it depends on | `addDependency` |
| Non-blocking relation | `RELATES_TO` | itemA → itemB (queried both directions via `getNeighbors({direction:'both'})`) | `linkRelated` |
| Replacement | `SUPERSEDES` | **new item → old item** *(assumed direction — see §9)* | `supersedeItem` |
| Duplicate merge | `SAME_AS` | **dropped item → kept item** *(assumed direction — see §9)* | `mergeItems` |
| Split | `PART_OF` | child item → parent item | `splitItem` |
| Plan membership | `MEMBER_OF` | item → plan node | `attachToPlan` |
| Durable ownership | `ASSIGNED_TO` | item → assignee entity node | `assignItem` |
| *(reserved, unused v0.1)* | `MENTIONS` | item → concept/symbol entity | future RAG-derived concept extraction (§8) |

**Why `ASSIGNED_TO` is an edge but `claimedBy`/`claimedAt` are metadata-only (not an
edge):** assignment is planner-decided, low-churn (set once, changed rarely), and
benefits from being a first-class graph traversal — "show me everything assigned to
`implementer-x`" is `getNeighbors(assigneeEntityId, {rel:['ASSIGNED_TO'], direction:'in'})`,
a real graph query, not a metadata scan. The claim lease is the opposite: high-churn
(rewritten on every renewal — the plan-state-machine precedent renews every wave,
`state-transition.js:589-591` "STALE_CLAIM_S is sized to comfortably exceed one wave's
worst-case single-dispatch duration"), and the graph contract exposes no "delete an
edge" primitive — only `invalidate()` (bi-temporal, permanent) — so representing a
lease as an edge would either (a) spam invalidated edges every renewal (defeats the
point of bi-temporal history being meaningful, not noise) or (b) require inventing an
edge-update-in-place operation the contract doesn't offer. A plain metadata field
mutated through the single atomic primitive (§4.3) is the correct fit for a fast-moving
scalar lease.

### 2.4 Human-id allocation and dedupe (createItem)

Both problems — "don't double-issue `BUG-APIGEN-015`" and "don't file a duplicate of
`BUG-APIGEN-014`" — are solved by the same mechanism family used for claims (§4): a
single write happens inside one `db.transaction(...).immediate()` block so no other
process can interleave.

```ts
// store/ids.ts (design sketch)
function allocateHumanId(db: Database, graph: GraphBackend, repo: string, family: string): string {
  // .immediate() takes the SQLite write lock (BEGIN IMMEDIATE) before the SELECT even
  // runs — a concurrent process's own .immediate() transaction blocks (respecting
  // busy_timeout) until this one commits. This is the same correctness mechanism
  // claimItem uses (§4.3) — reuse literally the same helper, not a parallel one.
  return db.transaction(() => {
    const existing = graph.queryNodes({
      kind: 'generic', tags: ['backlog-item'], namespace: repo,
      metadata: { family },
    });
    const maxN = existing.reduce((max, n) => {
      const m = /-(\d+)$/.exec(String((n.metadata as any)?.humanId ?? ''));
      return m ? Math.max(max, Number(m[1])) : max;
    }, 0);
    return `${family}-${String(maxN + 1).padStart(3, '0')}`;
  }).immediate()();
}
```

`createItem`'s dedupe scan (SPEC.md §5.1) runs BEFORE this allocation, and does not
need the same transactional guarantee — a dedupe scan racing a concurrent create is a
"maybe I'll miss a just-created near-duplicate," an acceptable soft guarantee (the
human/planner reviewing `duplicateCandidates` catches it on the next `listItems` pass;
this mirrors the global CLAUDE.md dedupe rule's own framing as a scan-and-review step,
not a hard constraint):

```ts
async function dedupeScan(store: GraphBacklogStore, repo: string, input: CreateItemInput): Promise<BacklogItem[]> {
  const candidates = new Map<number, BacklogItem>();
  // 1. FTS over title + body — catches "same bug, different words" (searchNodes uses FTS5).
  for (const hit of store.graph.searchNodes(input.title, {
    limit: 10, filter: { tags: ['backlog-item'], namespace: repo },
  })) candidates.set(hit.id, toBacklogItem(hit));
  // 2. Exact metadata match on symbol/path/errorText — per the global CLAUDE.md rule
  //    "Search by symbol name, file path, and error string — never by title alone."
  if (input.dedupeScan?.symbol) {
    for (const hit of store.graph.queryNodes({
      kind: 'generic', tags: ['backlog-item'], namespace: repo,
      metadata: { dedupeSymbol: input.dedupeScan.symbol },
    })) candidates.set(hit.id, toBacklogItem(hit));
  }
  // ... same pattern for .path / .errorText
  return [...candidates.values()];
}
```

## 3. Store adapter — owning the raw `better-sqlite3` handle

The single most important design decision in this document: **the backlog store opens
its OWN `better-sqlite3` connection and hands it to `createGraphBackend(db)`, and keeps
the raw `db` handle for itself.** `@adhd/sox-graph-store`'s documented surface
(`writeNode`/`touch`/`queryNodes`/...) has no read-modify-write transaction primitive of
its own — every mutation described in the contract summary is a single atomic call, not
a compose-then-commit unit. Claims and id allocation both need "read current state,
decide, write" as ONE atomic unit across processes. Rather than asking
`@adhd/sox-graph-store` to grow a transaction API it doesn't have, the backlog package
constructs the `Database` itself and wraps `db.transaction(fn).immediate()` around the
graph calls it needs atomically — `createGraphBackend` still gets the exact same `db`
object, so every other (non-CAS) operation behaves identically to using the library
standalone.

```ts
// store/graph-backlog-store.ts (design sketch)
import Database from 'better-sqlite3';
import { createGraphBackend, type GraphBackend } from '@adhd/sox-graph-store';

export interface GraphBacklogStore {
  readonly db: Database.Database;  // raw handle — ONLY for the CAS transaction wrapper
  readonly graph: GraphBackend;     // all non-CAS reads/writes go through this
}

export function openGraphBacklogStore(dbPath: string): GraphBacklogStore {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');      // required for safe concurrent readers+writer
  db.pragma('busy_timeout = 5000');     // a blocked .immediate() waits, doesn't throw immediately
  const graph = createGraphBackend(db);
  graph.applySchema();                  // idempotent — safe on every process start
  return { db, graph };
}
```

`.immediate()` (not the default deferred `BEGIN`) is load-bearing: a deferred
transaction only acquires SQLite's write lock at the moment its FIRST write statement
executes, which leaves a window where two processes can both pass a read-check under
their own deferred transaction before either escalates to a write lock — exactly the
race a CAS protocol must not have. `BEGIN IMMEDIATE` acquires the RESERVED lock at
transaction start, so a second process's own `.immediate()` call blocks (up to
`busy_timeout`) rather than interleaving.

## 4. Claim protocol

Mirrors the plan-state-machine skill's plan-level claim/renew/release lease exactly
(`state-transition.js:566-680`), generalized from "one plan" to "one backlog item, one
of potentially thousands, across a shared multi-process, multi-repo SQLite file."

### 4.1 State carried per item (in `metadata`, §2.2)

```ts
interface ClaimMeta {
  claimedBy?: string;   // absent ⇒ unclaimed
  claimedAt?: string;   // ISO — set/bumped on every claim/renewal
}
```

### 4.2 Semantics (identical branches to `state-transition.js:603-650`)

| Caller `by` vs current `claimedBy` | Staleness | Result |
|---|---|---|
| unclaimed | — | `claimed` |
| `by === claimedBy` | — | `renewed` — **no contention check, ever** (you can always renew your own lease; `state-transition.js:614-623`) |
| `by !== claimedBy` | age ≤ `staleAfterMin` | `held` (refuse; return `heldBy`/`heldSince`, no write) |
| `by !== claimedBy` | age > `staleAfterMin` | `reclaimed-stale` (proceeds; `previousClaimant` returned for audit — mirrors the loud, never-silent warning at `state-transition.js:639-641`) |
| `by !== claimedBy`, not stale, `opts.force: true` | — | proceeds anyway, same warning-not-silent posture as `state-transition.js:643` |

Default `staleAfterMin`: **30**, matching `STALE_CLAIM_S = 30 * 60` at
`state-transition.js:601` ("renew every wave, well inside this"). A caller doing
long-running work should call `renewClaim` periodically, exactly as a plan orchestrator
renews every wave.

**`releaseClaim`** mirrors `cmdRelease` (`state-transition.js:654-680`): releasing an
already-unclaimed item is a no-op (`release-noop`), never an error — every exit path
(done/error/abandon) should be able to call it unconditionally. Releasing someone
else's claim without `force:true` is refused.

### 4.3 The single atomic mutation primitive

Every metadata-touching operation in the whole tool — claim, renew, release, citation,
note, transition, priority, assignment — funnels through ONE function. This solves two
problems at once: (1) the CAS/race problem (§3), and (2) an unresolved ambiguity in the
`touch(id, Partial<NodeMeta>)` contract — it is unclear whether passing a `metadata` key
performs a deep merge into the existing JSON blob or replaces it wholesale. Rather than
depend on unconfirmed merge semantics, every caller reads the CURRENT full node,
computes a full new metadata object in application code, and passes the COMPLETE object
to `touch` — correct regardless of which merge behavior `touch` actually implements.

```ts
// store/mutate-metadata.ts (design sketch)
export function mutateMetadata<M extends Record<string, unknown>>(
  store: GraphBacklogStore,
  nodeId: number,
  updater: (current: M) => M,
): M {
  const txn = store.db.transaction(() => {
    const node = store.graph.getNode(nodeId);
    if (!node) throw new NotFoundError(nodeId);
    const next = updater(node.metadata as M);
    store.graph.touch(nodeId, { metadata: next });
    return next;
  }).immediate();
  return txn();
}
```

`claimItem` becomes a thin `updater` over this primitive:

```ts
// store/claim.ts (design sketch)
export function claimItem(store: GraphBacklogStore, nodeId: number, by: string, opts: ClaimOpts = {}): ClaimResult {
  const staleAfterMs = (opts.staleAfterMin ?? 30) * 60_000;
  let result!: ClaimResult;
  mutateMetadata<BacklogMeta>(store, nodeId, (meta) => {
    const now = Date.now();
    if (!meta.claimedBy || meta.claimedBy === by) {
      result = { status: meta.claimedBy ? 'renewed' : 'claimed', claimedBy: by, claimedAt: new Date(now).toISOString() };
      return { ...meta, claimedBy: by, claimedAt: result.claimedAt };
    }
    const ageMs = now - Date.parse(meta.claimedAt!);
    if (ageMs <= staleAfterMs && !opts.force) {
      result = { status: 'held', claimedBy: by, claimedAt: new Date(now).toISOString(), heldBy: meta.claimedBy, heldSince: meta.claimedAt };
      return meta; // no write — held
    }
    result = { status: 'reclaimed-stale', claimedBy: by, claimedAt: new Date(now).toISOString(), previousClaimant: meta.claimedBy };
    return { ...meta, claimedBy: by, claimedAt: result.claimedAt };
  });
  return result;
}
```

(The `'held'` branch still runs inside the transaction — it just returns the unchanged
metadata object, so `touch` is called with identical content. This keeps ONE code path
instead of a special early-return that skips the transaction, which would reintroduce
a TOCTOU gap between the check and a caller's subsequent action.)

### 4.4 Identity — never a bare role literal

Per SPEC.md §5.3, `by` is always caller-supplied, never defaulted inside the tool. The
**recommended** (not enforced — enforcement would require rejecting arbitrary strings,
which is more restrictive than the plan-state-machine precedent, which only documents
the guidance rather than validating it) identity shape mirrors `env.instanceId`
(`packages/environment/ARCHITECTURE.md:65` — "pid + short random"):

```ts
export function suggestClaimantIdentity(env: Environment<BacklogConfig>, agentName: string): string {
  return `${agentName}:${env.instanceId}`;
}
```

A CLI wrapper or MCP host SHOULD pass this as the default `by` when the calling agent
doesn't have a more specific identity of its own; it is exposed as a plain helper, not
baked into `claimItem` itself, so a caller with a better identity source (e.g. an
orchestrator's own agent-registry id) is never forced through it.

## 5. `client.ts` — the apigen extraction surface

Mirrors `entrypoint/dispatch-cli/src/api.ts`'s shape: plain, JSDoc'd async exports,
`ctx` as the sole non-serializable parameter, all real wiring delegated elsewhere
(`store/*`). Every function signature in `SPEC.md` §5 is exported verbatim from this
file. `BacklogCtx` is the one type apigen must special-case via the `ctx-name-only`
rule:

```ts
// client.ts (design sketch — signature only)
export interface BacklogCtx {
  store: GraphBacklogStore;
  env: Environment<BacklogConfig>;
}

export async function createItem(ctx: BacklogCtx, input: CreateItemInput): Promise<CreateItemResult> { /* delegates to store/* */ }
export async function claimItem(ctx: BacklogCtx, repo: string, humanId: string, by: string, opts?: ClaimOpts): Promise<ClaimResult> { /* ... */ }
// ... every SPEC.md §5 signature, no business logic inline (matches dispatch-cli's
// api.ts:1-11 comment: "This CLI does no business logic of its own")
```

All params must be JSON-serializable (per the contract summary) — `BacklogFilter`,
`CreateItemInput`, etc. are all plain JSON-shaped objects; no class instances, no
function-typed parameters, matching `entrypoint/dispatch-cli/src/api.ts:3-9`'s stated
constraint for apigen's ts-morph/ts-json-schema-generator extraction.

## 6. `env.ts` — `@adhd/environment` wiring

```ts
// env.ts (design sketch)
import { Environment } from '@adhd/environment';
import type { EnvironmentSpec, Scope } from '@adhd/environment-base-spec';

export interface BacklogConfig {
  readonly db: { readonly path: string | undefined };
  readonly logging: { readonly level: string };
}

export const backlogEnvironmentSpec: EnvironmentSpec<BacklogConfig> = {
  envPrefixOverride: 'ADHD_BACKLOG',
  namespaces: ['production'],
  dirs: { data: { kind: 'data' } },
  files: {
    // Deliberately a DIFFERENT file name/dir than agent-mcp's operational db AND
    // memory-server's store (normally ~/.memory/memory.db, per the memory-server MCP
    // tool's own db_path doc — writer-lease conflict requirement #3) — no shared
    // SQLite file between unrelated servers, ever.
    db: { in: 'data', name: 'backlog.db' },
  },
  config: {
    'db.path': {
      type: 'string',
      env: 'ADHD_BACKLOG_DATABASE_PATH',
      description: 'SQLite backlog-graph DB path. Unset ⇒ falls back to env.files.db under the resolved scope root.',
    },
    'logging.level': {
      type: 'string', env: 'ADHD_BACKLOG_LOG_LEVEL', default: 'info',
      enum: ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'],
    },
  },
};

/** Resolves scope per SPEC.md §3 — deliberately defaults to 'global', NOT the generic
 *  Environment auto-detect default (project-marker-found ⇒ 'project'). */
export function resolveBacklogScope(explicit?: Scope): Scope {
  if (explicit) return explicit;
  const fromBacklogVar = process.env['ADHD_BACKLOG_SCOPE'] as Scope | undefined;
  if (fromBacklogVar) return fromBacklogVar;
  const fromGenericVar = process.env['ADHD_ENV_SCOPE'] as Scope | undefined;
  if (fromGenericVar) return fromGenericVar;
  return 'global';
}

export function buildBacklogEnv(scope?: Scope): Environment<BacklogConfig> {
  return new Environment<BacklogConfig>('backlog', backlogEnvironmentSpec, {
    namespace: 'production',
    scope: resolveBacklogScope(scope),
  });
}
```

This is a direct structural copy of `entrypoint/agent-mcp/src/config.ts:63-189`'s
pattern (spec-in-code, one `db.path` field with no default, `env.files.db` as the
zero-config fallback — `entrypoint/agent-mcp/src/config.ts:75-79`), minus the
provider-credential machinery agent-mcp needs and backlog does not. `resolveRegistryDbPath`
(`packages/agent/agent-core-env/src/resolve-registry-db-path.ts:52-78`) is the other
precedent for "a package needs a canonical, cross-consumer DB path resolved
synchronously" — backlog's simpler case (one consumer, no legacy env-var precedence
chain to honor) only needs the plain `Environment` construction, not that function's
multi-fallback precedence ladder.

## 7. `server.ts` — apigen mount wiring

Follows `packages/apigen/apigen-core-client/README.md:138-187`'s documented pattern
exactly — extract → composeSchemas → import → `plugin.run()`. The critical detail for
`ctx` injection: `createClient` is invoked **fresh on every dispatched call**
(`packages/apigen/apigen-engine-runtime/src/lib/dispatch.ts:149-155`
`schema.hasCtx ⇒ const ctx = await createClient(envelope); … fns[fnName](ctx, ...args)`),
not once at server startup — so `createClient` must be a closure that returns the
SAME already-open `BacklogCtx` on every call (one store, opened once, for the process
lifetime), not something that re-opens the DB per request.

```ts
// server.ts (design sketch)
import { extract, composeSchemas } from '@adhd/apigen-core-client';
import { apiFastifyPlugin } from '@adhd/apigen-plugin-api-fastify';
import { openapiPlugin } from '@adhd/apigen-plugin-openapi';
import { mcpPlugin } from '@adhd/apigen-plugin-mcp';
import * as clientMod from './client.js';
import { openGraphBacklogStore } from './store/graph-backlog-store.js';
import { buildBacklogEnv } from './env.js';

export interface StartOpts {
  transport: 'http' | 'mcp' | 'both';
  port?: number;
  scope?: Scope;
  signal: AbortSignal;
}

export async function startBacklogServer(opts: StartOpts): Promise<void> {
  const env = buildBacklogEnv(opts.scope);
  env.ensureDirs();
  const store = openGraphBacklogStore(env.files.db);
  const ctx: BacklogCtx = { store, env };

  const sourceFile = new URL('./client.js', import.meta.url).pathname;
  const ops = await extract({ sourceFile, namespace: 'backlog' });
  const generated = {
    metadata: { namespace: 'backlog', phase: '' },
    schemas: Object.fromEntries(
      ops.filter(o => o.kind === 'action').map(op => [
        op.path[op.path.length - 1].raw,
        { input: op.input, output: op.output, hasCtx: op.hasCtx, 'x-apigen-safe': op.safe },
      ])
    ),
  };
  const schemas = composeSchemas(generated, []);
  const mod = await import(sourceFile);

  const pkg = [{
    id: 'backlog', schemas, importPath: sourceFile, fns: mod,
    createClient: async () => ctx,   // same ctx object every call — see note above
  }];

  const runs: Promise<void>[] = [];
  if (opts.transport === 'http' || opts.transport === 'both') {
    runs.push(apiFastifyPlugin.run!({
      packages: pkg, outputDir: '',
      options: { port: opts.port ?? 3300, usePlugins: [openapiPlugin] },
      signal: opts.signal, operations: ops,
    }));
  }
  if (opts.transport === 'mcp' || opts.transport === 'both') {
    runs.push(mcpPlugin.run!({
      packages: pkg, outputDir: '',
      options: { transport: 'stdio' },
      signal: opts.signal, operations: ops,
    }));
  }
  await Promise.all(runs);
}
```

No `apigen generate`, no nx codegen executor, no reimplemented API — exactly the
"MOUNT, do NOT codegen" requirement. `index.ts` re-exports `client.ts`'s functions
(for a Node consumer that wants to call them in-process, e.g. a test),
`startBacklogServer` (HTTP/MCP host entry), and `runBacklogCli` (the third, CLI
transport — §7a).

### 7a. `cli.ts` — THIRD transport, `@adhd/apigen-plugin-cli-output` mount

Same mount pattern as §7, extended to the CLI plugin, and factored to reuse the
ACTUAL `buildBacklogApigenPackage(ctx)` this file's `startBacklogServer` calls
(not a re-derived copy):

```ts
// cli.ts (real shape — see the actual file for full doc comments)
import { cliPlugin } from '@adhd/apigen-plugin-cli-output';
import { project } from '@adhd/apigen-engine-naming';
import { buildBacklogApigenPackage, requireRun } from './server.js';
import { buildBacklogEnv } from './env.js';
import { openGraphBacklogStore, closeGraphBacklogStore } from './store/graph-backlog-store.js';

export function resolveCommandPrefix(operations) {
  const first = operations.find((op) => op.kind === 'action');
  return project(first).cli.path.slice(0, -1); // ['backlog', 'client-d'] today
}

export function prefixCommand(userArgv, prefix) {
  if (userArgv.length === 0 || userArgv[0]?.startsWith('-')) return [...userArgv];
  if (prefix.every((seg, i) => userArgv[i] === seg)) return [...userArgv]; // already prefixed
  return [...prefix, ...userArgv];
}

export async function runBacklogCli(argv, opts = {}) {
  const env = buildBacklogEnv({ scope: opts.scope, adhdRoot: opts.adhdRoot, cwd: opts.cwd });
  env.ensureDirs();
  const store = openGraphBacklogStore(env.files.db);
  try {
    const { pkg, operations } = await buildBacklogApigenPackage({ store, env });
    const userArgv = argv ?? process.argv.slice(2);
    await requireRun(cliPlugin)({
      packages: [pkg], operations, outputDir: '',
      options: { argv: prefixCommand(userArgv, resolveCommandPrefix(operations)) },
      signal: opts.signal ?? new AbortController().signal,
    });
  } finally {
    closeGraphBacklogStore(store);
  }
}
```

**The `client-d` segment (empirically verified, not assumed — see
`cli.spec.ts`'s "namespace-prefix derivation" suite).** `@adhd/apigen-core-client`'s
`extract()` unconditionally builds every operation's `path` as
`[fileSegment, exportSegment]`; `fileSegment` is derived from the extracted
source file's own name. `extractClientOperations()` (§7, above) always extracts
from the BUILT `client.d.ts` (a deliberate workaround for a separate apigen
`$ref`-resolution bug — see that function's own doc comment), so
`normalizeFileName('client.d.ts')` → `'client-d'`, and that segment becomes part
of EVERY canonical projected name: HTTP routes (`/backlog/client-d/get-item`),
MCP tool names (`backlog_client_d_get_item`), and the cli-output plugin's
internal command-table keys (`backlog client-d get-item`). HTTP and MCP now
both consult this canonical projection too (as of commit `a6e895e2`, landed
after this package's original commit) and so both expose the `client-d`
segment verbatim to their callers — that is an accepted, if inelegant,
consequence of the `.d.ts`-extraction workaround (tracked as BACKLOG
`BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001`). The **CLI is the one
transport that hides it**: `resolveCommandPrefix` derives the real prefix from
the live `operations` list at runtime (never hardcoded to a literal
`'backlog'`), and `prefixCommand` transparently prepends it, so a human types
the clean `backlog get-item …` and the plugin still resolves it against its
real, `client-d`-qualified table.

**Bin mechanism** (`package.json`'s `"bin": { "backlog": "./dist/index.js" }`,
mirroring `entrypoint/apigen-cli`'s proven mechanism — shebang via a rollup
`output.banner`): unlike `apigen-cli` (a CLI-only package whose `index.ts`
unconditionally runs the program), `@adhd/backlog`'s `index.ts` is ALSO the
public library barrel (`startBacklogServer`/`runBacklogCli` are `require()`'d
programmatically by `src/test/fixtures/mcp-stdio-entry.js` and any other Node
consumer), so `dist/index.js` needs an entry-guard: run `runBacklogCli()` only
when this file is itself the process's executed entry point, do nothing when
merely imported. The guard is Node's own documented "no `require.main` in
ESM" idiom — `import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href`
— using `realpathSync` (not a bare `argv[1]` comparison) specifically because
pnpm/npm always install a package's `bin` as a SYMLINK
(`node_modules/.bin/backlog` → the real `dist/index.js`), and Node resolves
symlinks for the executing module's own `import.meta.url`/`__filename` by
default while leaving `process.argv[1]` unresolved — see `index.ts`'s own doc
comment for the full reasoning.

## 8. Markdown interop implementation note

`markdown.ts` **ports** (does not import) `tools/util/backlog.mjs`'s parsing algorithm
(`HEADER_RE`, `classifyStatus`, `detectStatus`, `detectPriority`, `parse` —
`tools/util/backlog.mjs:34-155`) because that file is a standalone `tools/` script, not
a built/importable package — there is nothing to `import` from it. This is a real,
acknowledged duplication (flagged in `BACKLOG.md` as
`DEBT-BACKLOG-MARKDOWN-DUP-001`, filed alongside this design) that should be resolved
by deprecating `tools/util/backlog.mjs` once `@adhd/backlog importFromMarkdown` /
`renderToMarkdown` are proven equivalent (SPEC.md §7 DoD item 2 IS that proof) — not by
this design attempting to extract a shared package prematurely for a two-line parser
duplicated exactly once.

## 9. The RAG seam (embeddings — future, decoupled)

Nothing in `store/*` calls out to `@adhd/sox-embedding-provider` in v0.1. The seam is
entirely structural, so adding it later touches zero `client.ts` signatures:

- **Where it plugs in:** `openGraphBacklogStore` would additionally construct an
  embedding provider and pass it to `createGraphBackend(db, { embeddingProvider })` (or
  whatever the real construction signature is — verify against the actual package
  before implementing) so every `writeNode`/`touch` call transparently gets an
  embedding computed over `content` (§2.2 — the ONE field carrying searchable text,
  chosen specifically so there is exactly one embedding target, not several).
- **Query-side:** `searchNodes` already exists in the base contract as FTS5-only;
  adding vector/hybrid search means `sox-graph-store` (or `sox-memory-core`, the
  heavier RAG-complete façade alternative named in the brief) upgrades `searchNodes`'s
  own implementation — `@adhd/backlog`'s `listItems({ grep })` call site does not
  change at all, since it already treats `searchNodes` as a black box.
- **Semantic dedupe:** `dedupeScan` (§2.4) currently does FTS + exact-metadata matching
  only. Once embeddings exist, it gains a third candidate source (nearest-neighbor over
  `content` embeddings) with zero change to `CreateItemInput`'s public shape — `force`
  still lets a caller override.
- **The ONNX-thread gotcha** (contract summary) — "ONNX embeddings must not share the
  SQLite thread" — is a `sox-embedding-provider`-internal concern once adopted; nothing
  in `@adhd/backlog`'s design touches threading today because there is no embedding
  provider constructed yet. Flagging it here only so the eventual RAG-adoption PR
  doesn't have to rediscover it.

## 10. Package-layout upgrade checklist

The current skeleton (`entrypoint/backlog/package.json:1-5` — `private:true`, no
`main`/`exports`; `entrypoint/backlog/project.json:1-22` — `projectType:"application"`,
a bare `tsc` run-commands build target, no test/lint/typecheck/publish targets) must be
upgraded to the canonical entrypoint shape, using `entrypoint/dispatch-cli` as the
reference (already an nx entrypoint library with a full target set):

- [ ] `package.json`: un-`private`, add `main`/`module`/`typings` pointing at `./dist/...`,
  `publishConfig.access:"public"`, `files:["dist","CHANGELOG.md"]`, and the real
  `dependencies` list (§11) — mirror `entrypoint/dispatch-cli/package.json:1-23`.
- [ ] `project.json`: `projectType:"library"` (not `"application"` — `entrypoint/dispatch-cli/project.json:5`),
  add `build` via `@nx/vite:build` with in-tree `outputPath: entrypoint/backlog/dist`
  (`entrypoint/dispatch-cli/project.json:50-63`), `test` via `@nx/vite:test`
  (`entrypoint/dispatch-cli/project.json:19-33`), `typecheck` via `tsc --noEmit`
  (`entrypoint/dispatch-cli/project.json:34-49`), and `nx-release-publish` with
  `dependsOn:["build","test","verify-dist-load"]` (`entrypoint/dispatch-cli/project.json:72-84`).
  **Do NOT copy dispatch-cli's `tags` array** (`entrypoint/dispatch-cli/project.json:14-18`
  — `["entrypoint:cli","pkg-class:entrypoint","platform:node"]`) — that is a
  pre-convention, stale tag set on an older entrypoint. `entrypoint/backlog/project.json:6-13`'s
  EXISTING tags (`domain:entrypoint, pkg-kind:entrypoint, pkg-class:entrypoint,
  layer:entrypoints, platform:node, access:domain`) already match the current
  generator's documented output (`AGENTS.md:135` "Tags the generator emits (verified)")
  and `.adhd/workspace.json`'s `defaults.entrypoint` block (`nxLayer:"entrypoints",
  platform:"node", access:"domain", publish:false`) — keep them as-is; copy
  dispatch-cli's *target structure*, not its *tags*.
- [ ] Add `vite.config.ts` (mirror `entrypoint/dispatch-cli/vite.config.ts:1-64` — note
  its `rollupOptions.external` excludes `@modelcontextprotocol/sdk`; backlog's build
  should externalize `better-sqlite3` the same way, since it is a native module that
  must not be bundled).
- [ ] Add `tsconfig.lib.json` / `tsconfig.spec.json` (mirror
  `entrypoint/dispatch-cli/tsconfig.lib.json:1-10` /
  `entrypoint/dispatch-cli/tsconfig.spec.json:1-27` verbatim, adjusted for backlog's
  `src/` layout — no `bin/` needed unless a standalone CLI wrapper is added).
- [ ] Add `.eslintrc.json` (mirror `entrypoint/dispatch-cli/.eslintrc.json:1-38`).
- [ ] Add `CHANGELOG.md` (empty `## Unreleased` section, per repo convention).
- [ ] Un-TODO `README.md` (currently a placeholder, `entrypoint/backlog/README.md:1-8`).

## 11. Dependencies (exact package names + ranges)

```json
{
  "dependencies": {
    "@adhd/sox-graph-store": "^0.3.0",
    "better-sqlite3": "^12.10.0",
    "@adhd/environment": "0.0.1",
    "@adhd/environment-base-spec": "0.0.2",
    "@adhd/apigen-core-client": "^0.1.1",
    "@adhd/apigen-plugin-api-fastify": "^0.1.2",
    "@adhd/apigen-plugin-openapi": "^0.1.3",
    "@adhd/apigen-plugin-mcp": "^0.1.2"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13"
  }
}
```

Version pins taken directly from sibling packages already in the tree:
`better-sqlite3@12.10.0` and `@types/better-sqlite3@^7.6.13` (every `packages/agent/*`
family package, e.g. `packages/agent/agent-core-env/package.json:25,29`),
`@adhd/environment@0.0.1` + `@adhd/environment-base-spec@0.0.2`
(`entrypoint/agent-mcp/package.json:25-26`), apigen plugin versions from their own
`package.json`s (`packages/apigen/apigen-core-client/package.json:3` → `0.1.1`,
`apigen-plugin-api-fastify/package.json:3` → `0.1.2`,
`apigen-plugin-mcp/package.json:3` → `0.1.2`, `apigen-plugin-openapi/package.json:3` →
`0.1.3`). `@adhd/sox-graph-store@^0.3.0` per the task brief (external, not yet a repo
dependency anywhere — this will be the first consumer in this monorepo).

## 12. Concurrency & native-module gotchas

- **Node ≥ 22** — `.github/workflows/ci.yml` and `pull-request.yml`'s `test` job both pin
  Node 22 (`DEBT-BACKLOG-CI-NODE22-001`, resolved).
- **`better-sqlite3` is a native module** — a fresh `git worktree`/CI runner needs it
  rebuilt for the current Node ABI (standard monorepo gotcha, already true for every
  `packages/agent/*` package that depends on it).
- **WAL mode + `busy_timeout`** (§3) is required, not optional — the global-scope store
  is, by construction, opened by many concurrent processes/agents/repos. Without WAL, a
  writer blocks all readers; without `busy_timeout`, a blocked `.immediate()` throws
  `SQLITE_BUSY` immediately instead of waiting out a brief contention window.
- **Bounded busy-retry + configurable `busy_timeout`** (resolved,
  `DEBT-BACKLOG-CONCURRENCY-BUSY-RETRY-001`) — `store/immediate-retry.ts`'s
  `withImmediateRetry` wraps every `.immediate()` call (`mutate-metadata.ts`, `ids.ts`)
  in a bounded (5 attempts), jittered exponential backoff (20/40/80/160ms, capped at
  500ms) that retries ONLY `SQLITE_BUSY`/`SQLITE_BUSY_TIMEOUT`/`SQLITE_BUSY_SNAPSHOT` —
  never any other error, and never the semantic `'held'` claim-contention RESULT (a
  normal return value, not an exception). `busy_timeout` itself is configurable via
  `BacklogConfig.db.busyTimeoutMs` (`env.ts`, default 5000, env override
  `ADHD_BACKLOG_DATABASE_BUSY_TIMEOUT_MS`) and threaded through
  `openGraphBacklogStore(dbPath, busyTimeoutMs)`. **Gotcha (fixed, see `graph-backlog-
  store.ts`'s comment):** `@adhd/sox-graph-store`'s `createGraphBackend(db)` constructor
  unconditionally re-runs its own `PRAGMAS` (including a hardcoded `busy_timeout =
  5000`) — setting the pragma BEFORE constructing the graph backend gets silently
  clobbered back to 5000; it must be set AFTER.
- **Single-writer-per-scope is NOT enforced at the DB layer** — WAL supports multiple
  writers serialized through SQLite's own locking, which is sufficient correctness-wise
  (that's the whole point of the CAS design in §4), but `@adhd/environment`'s
  `env.lock('singleton')` (`packages/environment/ARCHITECTURE.md:65`) is available if a
  future requirement needs to guarantee only one **server process** (not agent) binds a
  given scope+port — out of scope for v0.1, noted for the implementer.
- **ONNX embedding thread isolation** — not applicable until §9's RAG seam is adopted;
  noted here only for forward reference.
- **Separate DB file from memory-server** — `env.files.db` resolves under
  `~/.adhd/backlog/production/data/backlog.db` (global scope) or
  `<project>/.adhd/backlog/production/data/backlog.db` (project scope), never
  `~/.memory/memory.db` (the memory-server MCP's default store) — no writer-lease
  conflict is possible because the two tools never open the same file, by construction
  of `@adhd/environment`'s per-project namespacing (`ARCHITECTURE.md §4` "Everything
  nests under `<root>/.adhd/<project>/<namespace>/`").

## 13. Testing strategy (implements SPEC.md §7's DoD)

| DoD clause | Test location | Real components exercised |
|---|---|---|
| CAS claim race | `src/store/claim.spec.ts` | Two real `better-sqlite3` connections to one temp file; a barrier (e.g. a second process's readiness pipe, or two `Worker` threads) ensures both `claimItem` calls are in-flight before either commits — never a `sleep`. |
| Markdown round-trip | `src/markdown.spec.ts` | Real `BACKLOG.md`-fixture file → `importFromMarkdown` → `renderToMarkdown` → the OLD `tools/util/backlog.mjs` invoked as a real subprocess (`execFileSync('node', ['tools/util/backlog.mjs', 'json', '--file', renderedTmpPath])`) — proves compatibility against the actual legacy tool, not a copy of its logic. |
| Live HTTP mount | `src/server.spec.ts` | `startBacklogServer({transport:'http', signal})` against a real temp SQLite file, then a real `fetch()` HTTP call — per `AGENTS.md`'s "Live testing is mandatory," this test is unflagged/default-running (no paid third party is involved, so no env-gate qualifies). |
| Live MCP mount | `src/server.mcp.spec.ts` | `startBacklogServer({transport:'mcp', signal})`, driven by a real `@modelcontextprotocol/sdk` client over stdio — per `AGENTS.md`'s "drive the real tools, never a bypass." |
| Scope isolation | `src/env.spec.ts` | Two real `Environment` instances at `project` scope over two temp `.git` dirs + one at `global` scope over a temp `HOME` — real file-system roots, no mocked path resolution. |
| Cycle detection | `src/store/query.spec.ts` | Real `addDependency` calls forming A→B→C→A against a real store; `topoOrder` asserted against the exact `{ok:false, cycle:[...]}` shape. |
| Citation gate | `src/store/lifecycle.spec.ts` | `transitionStatus(..., 'FIXED', {by, note})` with no citations asserted to reject; the guard is then commented out as the negative control to prove the test goes red. |
| Dist-load | `nx run backlog:verify-dist-load` | Builds real `dist/`, `require()`/`import()`s it, calls `listItems` against a real temp DB — not source resolution. |

Every test above uses a real DB under `tmp/backlog/<test-name>/` per `AGENTS.md` §10
("one canonical root: `tmp/`"), removed on teardown.

## 14. Open questions / assumptions — VERIFIED against the real `@adhd/sox-graph-store` source (2026-07-22)

All four assumptions below were verified by reading
`~/dev/ai/sox-ecosystem/libs/data/graph/graph-store/src/index.ts` directly. Results:

1. **`queryNodes({ metadata: {...} })` matching semantics — CONFIRMED as assumed.**
   `buildNodeFilterClause` (index.ts:623-625) emits `json_extract(meta, ?) = ?` per
   metadata key, AND-combined — top-level key equality, exactly the assumption. No
   in-process fallback needed. **Bonus:** `NodeFilter` also exposes first-class
   `projectPath`, `agentId`, `namespace`, and `tags`/`tagsMatchAll` columns (index.ts:
   NodeFilter, BL-294) — so `listItems({ projectPath })` and repo filtering (`namespace`)
   are indexed column matches, NOT metadata JSON scans. Prefer these first-class filters
   over `metadata` where a column exists (repo→`namespace`, package→`projectPath`).
2. **`SUPERSEDES` edge direction — CONFIRMED `new → old`.** `supersede(oldId, newContent,
   meta)` (index.ts:865-896) writes `writeEdge(newId, oldId, 'SUPERSEDES', …)`, sets
   `is_superseded=1` on the old node, and mints the new node — ALL in one internal
   transaction. So `supersedeItem` calls `graph.supersede(...)` directly (do not
   hand-roll the edge). For `SAME_AS` (no lib primitive), write `writeEdge(dropId,
   keepId, 'SAME_AS')` (obsolete→canonical, matching the supersede convention) then
   `invalidate(dropId, reason)`.
3. **Cross-scope aggregation is unsupported in v0.1** (SPEC.md §3) — a real product
   decision, not a technical limitation. Unchanged.
4. **`touch()` metadata merge — CONFIRMED wholesale REPLACE**, not deep-merge
   (index.ts:922-979: `if (meta.metadata !== undefined) { … meta = ? … }` sets the
   whole `meta` column to `JSON.stringify(meta.metadata)`). The `mutateMetadata`
   read-full-compute-full-write primitive (§4.3) is therefore REQUIRED, not just
   defensive — passing a partial metadata object to `touch` would silently drop every
   other field. Always pass the complete metadata object.

**Additional verified facts feeding implementation:**
- **No edge/node delete primitive exists** in `GraphBackend` (only `invalidate` for
  nodes, which is bi-temporal). `removeDependency` (SPEC.md §5.5) therefore does a raw
  `DELETE FROM edge WHERE src = ? AND dst = ? AND rel = 'DEPENDS_ON'` on the
  store-owned `db` handle (the store already owns the raw handle for CAS, §3) — the one
  place the adapter reaches past the `GraphBackend` API, justified and isolated to
  `store/mapping.ts`. Confirm the `edge` table column names (`src`/`dst`/`rel`) via
  `getEdges`'s own query before writing the DELETE.
- **`getEdges({ src?, dst?, rel? })`** exists (not in the original brief) — use it for
  `dependencyGraph`/`blockers`/`removeDependency` edge lookups instead of only
  `getNeighbors`.
- **`searchNodes(query, {limit, filter})`** is FTS5 `MATCH` over node content
  (index.ts:1043-1067) and accepts the same `NodeFilter` — used for `listItems({grep})`
  and `dedupeScan`.
- `NodeRecord` carries `isSuperseded`/`isStale`/`tInvalid` — exclude invalidated nodes
  from default views (`invalidate` sets `t_invalid`; a soft-deleted/superseded item must
  not appear in `listItems` unless explicitly requested).
