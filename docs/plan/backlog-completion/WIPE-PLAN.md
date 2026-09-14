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
3. **`delete` is a JS reserved word.** §6.7 requires the MCP tool
   `backlog_delete`; `export async function delete` is a syntax error, and
   apigen derives the operation name from the exported function name with no
   override mechanism. `api.ts` currently exports `remove` → `backlog_remove`.
   Resolve at mount time (export alias vs. an apigen naming hook) — do not
   ship the mismatch silently.
4. **`IIssueCard` is declared twice with different shapes** —
   `query/types.ts` (field-projected) and `write/create-issue.ts` (full plain
   card). Same name, different contract, both reachable from `api.ts`'s type
   graph; apigen extracts one `.d.ts`, so this needs resolving before the
   mount or the generated schema is ambiguous.
5. **The open `TypePolicy` injection is deferred into the wipe.** Injecting
   it standalone turns `repo-nodes.spec.ts`'s negative control red
   ("IN_REPO is rejected by the store default policy") — that control is
   correct for the v1 design, and dies with `repo-nodes.ts`.

## 4. Order of execution

1. Resolve blockers 3 and 4 (naming + duplicate type).
2. Replace `server.v2.spec.ts`'s six-verb assertion with the new verb list.
3. Repoint `server.ts` (`client.d.ts` → `api.d.ts`, incl. the three
   `backlogDistDir()` probe strings), `cli.ts`, `index.ts`.
4. Port / reseed / delete the specs per §2.
5. Inject `OPEN_TYPE_POLICY` into `openGraphBacklogStore`.
6. `git rm -r` `src/client.ts`, `src/ops-v1.ts`, `src/v2/`.
7. Full suite **and** `nx run backlog:verify-dist-load` — a green `nx test`
   resolves to source and will pass while the mount is empty.
