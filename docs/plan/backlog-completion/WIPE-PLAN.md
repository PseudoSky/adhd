# §7 wipe — execution plan

Staged per SPEC §10 point 2 ("there is no intermediate state where both
compile"): the deletion and the transport remount are ONE change.

## 0. Blast radius (measured)

Old layer: `src/client.ts` (563) + `src/ops-v1.ts` (570) + `src/v2/` (11 files)
= **10,331 lines**. 24 import sites outside `src/v2/` itself.

Production consumers (3): `src/server.ts:56-57`, `src/cli.ts:30`,
`src/index.ts:58,64,65`.

## 1. Descriptor — DONE (`bfaa88ca`)

`src/api.ts` owns `BacklogCtx`, derives the three store-handle shapes, maps
thrown `BacklogWriteError` → outcome envelope, exports ten verbs. Typechecks.
Not yet mounted.

## 2. Spec classification

The discriminating question is per-spec: does it TEST the old surface, or
merely SEED through it? An import of `ops-v1` is not evidence either way.

### Dies with the old layer (uncontested — §7 names the subject)

| Spec | Tests | Why |
|---|---|---|
| `client.spec.ts` | 36 | the v1 verbs themselves (`createItem`/`getItem`/`listItems`/claim/structure) |
| `migration-admin.spec.ts` | 6 | migration-phase machinery — named in §7 |
| `store/repo-migration.spec.ts` | 15 | the repo-migration module — named in §7 |
| `store/repo-lookup-ux.spec.ts` | 23 | repo/humanId mismatch + `repoWarning` + `importFromMarkdown` — all named in §7 |

### Must be REPLACED, not merely deleted

| Spec | Tests | Why |
|---|---|---|
| `server.v2.spec.ts` | 12 | pins AC-0's **six**-verb surface on every mount. The new surface is ten (fourteen with §3a's registry writes), so its central assertion is *intentionally* invalidated — but the property it guards (all four transports agree, host carve-out holds) is exactly what the remount must keep. Rewrite against the new verb list; do not drop the guard. |

### Ports to the new layer (asserts surviving product behaviour)

| Spec | Tests | Why |
|---|---|---|
| `stats-surface.spec.ts` | 11 | `citationCount`, `closedAt` buckets, time-windowed throughput. §6.7 keeps stats views — they just read through `query`'s `view`/`groupBy` axes now. Real behaviour; re-point, don't delete. |
| `markdown.spec.ts` | 15 | **splits.** §7 wipes the markdown *import* action, so the import/provenance/diagnostics cases die. §6.7 keeps the markdown *projection* ("renders issue titles as headers"), so the render/round-trip cases port. |

### Seeds through the old layer only — rewire the seed, keep the assertions

| Spec | Tests | Why |
|---|---|---|
| `cli.spec.ts` | 38 | CLI mount + `--sandbox` isolation; survives §6.7 |
| `env.spec.ts` | 9 | env cascade + `BUG-CACHE-CWD-001`; untouched by the wipe |
| `server.spec.ts` | 2 | live HTTP mount; survives |
| `server.mcp.spec.ts` | 2 | live MCP stdio mount; survives |

## 3. Known blockers before the switch-over

1. **`query`'s search channel has no production construction path.** Nothing
   builds a `StoreSearchBackend` outside `query/views/semantic.spec.ts`; the
   production seam is a differently-shaped `SemanticBackend` singleton.
   `api.ts` omits `search` so a semantic filter fails loudly (BUG-045's rule)
   rather than silently returning the wrong rows.
2. **Four §6.7 verbs are unimplemented** — `upsertProject`,
   `upsertComponent`, `upsertLocation`, `rmLocation`. Only an ETL-private
   `upsertProjectTx` exists. Ten of fourteen are mountable today.
3. ~~**`delete` is a JS reserved word.**~~ **RESOLVED and PROVEN.** An export
   CLAUSE may alias to any IdentifierName, reserved words included, and
   apigen resolves the mounted name from `sf.getExportedDeclarations()` —
   ts-morph's rename/re-export resolver, which `extract.ts` documents as
   covering "named exports — local, renamed, AND re-exported". `api.ts` keeps
   a legal `remove` identifier and does `export { remove as delete }`.

   Verified empirically by running the real extractor against the built
   `dist/api.d.ts` and projecting the result — not by reading:

   ```
   operations: 10
     backlog/get        mcp=backlog_get        cli="backlog get"        POST /backlog/get
     backlog/query      mcp=backlog_query      cli="backlog query"      POST /backlog/query
     backlog/lookup     mcp=backlog_lookup     cli="backlog lookup"     POST /backlog/lookup
     backlog/create     mcp=backlog_create     cli="backlog create"     POST /backlog/create
     backlog/update     mcp=backlog_update     cli="backlog update"     POST /backlog/update
     backlog/transition mcp=backlog_transition cli="backlog transition" POST /backlog/transition
     backlog/claim      mcp=backlog_claim      cli="backlog claim"      POST /backlog/claim
     backlog/relate     mcp=backlog_relate     cli="backlog relate"     POST /backlog/relate
     backlog/move       mcp=backlog_move       cli="backlog move"       POST /backlog/move
     backlog/delete     mcp=backlog_delete     cli="backlog delete"     POST /backlog/delete
   ```

   Exactly §6.7's list. The replacement for `server.v2.spec.ts` must assert
   this surface so a refactor to `export async function remove` — which
   silently renames the tool on all four transports — fails a test.
4. **`IIssueCard` is declared twice with different shapes** — DOWNGRADED
   from blocker to a real but non-blocking defect, on evidence.

   The two are genuinely different: `query/types.ts`'s has 20 fields, all
   optional but `uid` (it is field-projected); `write/create-issue.ts`'s has
   11, mostly required. But the extractor INLINES both rather than hoisting
   either under the name — a definitions-walk over all ten extracted
   operations returns no `IIssueCard` entry at all — so there is no schema
   collision and no ambiguity on the wire. Neither is re-exported from
   `index.ts`, so no published type is ambiguous either.

   What remains is a source-level hazard: one mounted surface carries two
   different `IIssueCard` contracts (`get` returns query's, `create.item`
   returns write's), which will mislead a maintainer. Narrow write's to
   query's, or rename it. Not a mount blocker.
5. **The open `TypePolicy` injection is deferred into the wipe.** Injecting
   it standalone turns `repo-nodes.spec.ts`'s negative control red
   ("IN_REPO is rejected by the store default policy") — that control is
   correct for the v1 design, and dies with `repo-nodes.ts`.

## 4. Order of execution

1. ~~Resolve blocker 3~~ (done). Resolve blocker 4 (duplicate type) —
   non-blocking, may follow the mount.
2. Replace `server.v2.spec.ts`'s six-verb assertion with the new verb list.
3. Repoint `server.ts` (`client.d.ts` → `api.d.ts`, incl. the three
   `backlogDistDir()` probe strings), `cli.ts`, `index.ts`.
4. Port / reseed / delete the specs per §2.
5. Inject `OPEN_TYPE_POLICY` into `openGraphBacklogStore`.
6. `git rm -r` `src/client.ts`, `src/ops-v1.ts`, `src/v2/`.
7. Full suite **and** `nx run backlog:verify-dist-load` — a green `nx test`
   resolves to source and will pass while the mount is empty.
