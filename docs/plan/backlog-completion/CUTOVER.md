# Phase B cutover — the measured file inventory

Derived by walking every `import` in `entrypoint/backlog/src/**` and classifying each
module by whether it reaches into the layer SPEC §7 deletes. Supersedes the
WIPE-PLAN's "delete `src/store/*` except `type-policy.ts`", which is wrong — see
§3.

## 1. Scale

| | files | lines |
|---|---|---|
| doomed (`src/v2/`, most of `src/store/`, `client.ts`, `ops-v1.ts`, `model.ts`, `cli.ts`) | 70 | — |
| surviving | 76 | — |
| `src/store/` v1-coupled (dies) | 43 | 14,330 |
| `src/store/` uncoupled | 10 | 1,444 |

## 2. Surviving files that still import INTO the doomed layer

Exactly 14. Only **five** are production; the other nine are specs of the doomed
layer and go with it (three of them reseeded per §7).

### Production (must be reworked in the cutover commit)

| file | pulls from doomed layer | disposition |
|---|---|---|
| `src/api.ts` | `IOutcomeEnvelope`, `IOutcomeFailure`, `BacklogErrorCode`, `errorEnvelope`, `okEnvelope` (`model.ts`); `GraphBacklogStore` *type* (`store/graph-backlog-store.ts`) | move the envelope machinery into the new layer; swap the store type for the new handle |
| `src/index.ts` | `runBacklogCli`, `stripSandboxFlag` (`cli.ts`) | repoint at the new CLI |
| `src/markdown.ts` | 6 *types* only (`model.ts`) | **deleted** — see §5 |
| `src/server.ts` | `clientMod`, `BacklogCtx` (`client.ts`); store open/close + `semantic-search` (doomed); `serve-lock`, `signal-cleanup` (**not** doomed) | remount on `dist/api.d.ts` per §6.7 |
| `src/test/helpers/tmp-store.ts` | `openGraphBacklogStore` | superseded by `open-test-issue-store.ts` |

### Specs of the doomed layer

`cli.spec.ts`, `client.spec.ts`, `env.spec.ts`, `markdown.spec.ts`,
`model.v2.spec.ts`, `server.mcp.spec.ts`, `server.spec.ts`, `server.v2.spec.ts`,
`stats-surface.spec.ts`. Per §7: reseed `cli`/`env`/`server`, port
`stats-surface`, delete the rest.

## 3. CORRECTION — `src/store/` is not uniformly doomed

Four modules under `src/store/` have **zero** coupling to the v1 layer and are
load-bearing for the surviving server. Deleting them would destroy working
infrastructure and break `server.ts` for no reason.

| file | lines | internal imports | consumer |
|---|---|---|---|
| `type-policy.ts` | 31 | none | `test/helpers/open-test-issue-store.ts`, `tools/etl/store-bootstrap.ts` |
| `serve-lock.ts` (+ `serve-lock.spec.ts`) | 290 (+259) | none | `server.ts` |
| `signal-cleanup.ts` (+ `signal-cleanup.spec.ts`) | 114 (+142) | none | `server.ts`, `cli.ts` |

**These four modules and their two specs are PRESERVED.** They are generic
node-level infrastructure (`node:fs`, `node:path`, `node:os`) that was merely
filed under `src/store/`; nothing about them is v1.

Everything else under `src/store/` dies, including three uncoupled-but-obsolete
modules: `graph-backlog-store.ts` (the v1 handle itself), `immediate-retry.ts`
and `embed-queue.ts` (reachable only from it), `backup-manifest.ts` (reachable
only from the doomed `store-backup.ts`), and
`humanid-counter-concurrency.spec.ts` (tests the identity machinery the
acceptance criterion forbids).

## 4. Resolved questions

**The 14-file inventory is closed.** The walk above followed relative specifiers
only. Re-running it without the `.` anchor and including dynamic `import()`,
`require()`, and `export … from` returns no additional doomed-layer edges — the
only non-relative hits are genuine external packages
(`@modelcontextprotocol/sdk/*`, `@adhd/apigen-core-client`), which merely match
the `client` substring.

**`immediate-retry.ts` may die.** The new write layer does not depend on it. It
carries its own complete retry path in `src/write/tx.ts`:
`CONTENTION_RETRY_BACKOFFS_MS = [250, 500]` (3 attempts, linear backoff, §4c)
and `resolveTransactionMode()`, which defaults to `immediate` and rejects any
unrecognized `ADHD_BACKLOG_UNSAFE_TX_MODE` value loudly rather than silently
falling back. That env var is the built-in mechanism for AC-22's negative
control — setting it to `deferred` strips the `BEGIN IMMEDIATE` RESERVED lock —
so deleting the v1 helper does not make AC-22 unprovable.

## 5. `markdown.ts` is deleted, not re-homed

Its exported surface is overwhelmingly the markdown **import** action that §7
removes: `parseBacklogMarkdown`, `parseBacklogMarkdownWithDiagnostics`,
`toImportItems`, `ParsedImportItem`, `normalizeLegacyStatus`, `parseChangelogIds`,
`classifyStatus`, `detectStatus`, `detectPriority`, `matchesFilter`.

It has exactly two non-spec consumers:

- `src/ops-v1.ts` — doomed, and the only *functional* caller
  (`buildChangelogSection`, `parseBacklogMarkdownWithDiagnostics`,
  `renderItemsToMarkdown`, `toImportItems`).
- `src/index.ts:91-102` — a pure pass-through re-export, part of the v1 public
  surface §7 replaces with the 10 verbs plus the registry verbs.

So nothing survives that calls it, and its six `model.ts` types die with the
module. `markdown.spec.ts` and `markdown-changelog-ids.spec.ts` go with it.

## 6. Ordering

The wipe is one commit — §10 point 2 admits no intermediate state where both
layers compile. It therefore runs only once every in-flight agent's work is
committed; there is no stash and no hard reset to recover from a wipe layered on
top of uncommitted edits.

---

## The 1.0.0 public surface — decided before deletion, not after

`src/index.ts` is the published API. Today it re-exports five things that are all
on the deletion list, so "repoint it at the new CLI" is not a compile-error fix —
it is an API decision. Taken here, deliberately.

### Ships in 1.0.0

**The 14 verbs, from `api.ts`** — this is the entire real API, and it is exactly
the set `api.surface.spec.ts` gates and §6.7 requires every transport to mount:

  get · query · lookup · create · update · transition · claim · relate · move ·
  delete · upsertProject · upsertComponent · upsertLocation · rmLocation

**The envelope machinery**, rehomed out of `model.ts` (shrink, do not copy — see
the rehome note below). **`BacklogCtx`.** **The store bootstrap**
(`write/bootstrap.ts`), which replaces `openGraphBacklogStore` as the supported
way to open a store. **The host entrypoints** that survive the wipe:
`startBacklogServer`/`buildBacklogApigenPackage`/`resolveExpectedMcpToolNames`,
`runServeCommand`, the `env.ts` resolvers, the reseeded CLI runner,
`installSkill`/`runInstallSkillCommand`, and the search-shortcut helpers.

### Does NOT ship

- **The 37 v1 ops** re-exported from `ops-v1.js`. The whole module dies.
- **The 9 markdown functions + 3 types.** `markdown.ts` is deleted outright, not
  re-homed: BACKLOG.md as a projection is the deprecated surface, and shipping
  its parser/renderer in 1.0.0 would re-publish the thing being retired.
- **`openGraphBacklogStore`/`closeGraphBacklogStore`/`GraphBacklogStore`** —
  superseded by the bootstrap.
- **`export * from './model.js'` (line 104).** This is the widest and least
  deliberate line in the file: a star-export that publishes whatever `model.ts`
  happens to contain. It goes, and what survives from `model.ts` is named
  explicitly.

### Rehome note — shrink, don't copy

Moving out of `model.ts`: `okEnvelope`, `errorEnvelope`, `IOutcomeEnvelope`,
`IOutcomeSuccess`, `IOutcomeFailure`, `IOutcomeError`, `IOutcomeErrorDetails`,
`IQueryEnvelopeMeta`, `BACKLOG_ERROR_CODES`, `BacklogErrorCode`, `isOutcomeOk`,
`isBacklogErrorCode`.

`BACKLOG_ERROR_CODES` shrinks on the way: `duplicate_candidate`,
`dedupe_suppressed`, and `soft_deleted` have zero uses in the new layer, and
`ambiguous` is documented in terms of `(repo, humanId)` — vocabulary that dies
with the gate. Carrying the full enum across would re-publish dead codes as
public API.
