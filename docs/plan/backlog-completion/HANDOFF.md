# FEAT-017 backlog replacement — audit & handoff

Audited 2026-09-14 against `entrypoint/backlog/SPEC.md` (2351 lines, the governing
spec). Every claim below was read from the file or produced by a live command; the
evidence is named inline.

---

## 0. Orientation — read this before touching anything

**The direction of travel is the single most misread fact in this project.** Verified
from git history, not inferred:

| Layer | Files | Commit | Disposition |
|---|---|---|---|
| **NEW** — built against SPEC.md | `src/query/`, `src/write/`, `tools/etl/` | `d4f3a674` | keep, finish |
| **OLD** — the layer being replaced | `src/client.ts`, `src/ops-v1.ts`, `src/v2/` | `0cb37400` | **delete** (§7 wipe) |
| **Transitional** | `src/store/` | mixed | mostly survives; identity machinery deleted |

`src/query/` is unreachable from the live surface today. That is the **expected
mid-build state**, not a defect: `src/index.ts` exports `{get, query, create, update,
relate, admin}` from `client.ts`, which delegates to `src/v2/` — the old layer. The
wipe (§7) and the transport remount (§6.7) are what connect the new layer.

Do not "fix" the new layer's disconnection by wiring it beside the old one. SPEC §0:
*"This is a FULL HARD REPLACEMENT, not a side-by-side rollout... there is no
coexistence, no dual-write bridge, no gradual deprecation window."*

---

## 1. Acceptance criteria — SPEC §9, item by item

23 numbered criteria. Coverage determined by `AC-<n>` markers in new-layer source
plus reading the sibling specs.

### Covered in the new layer (12)

| AC | Criterion | Where |
|---|---|---|
| AC-1 | `rg 'humanId'` over the layer is empty; identity is `uid` | see §2 — **not yet true globally** |
| AC-2 | identical-content + `force` ⇒ two distinct `uid`s | `src/write/create-issue.ts` |
| AC-3 | automatic audit node per write | `src/write/audit.ts` |
| AC-4 | on-write embedding; invalidate removes it | `src/store/semantic-search.ts` |
| AC-5 | uniqueness: project/component name policy | `src/write/catalog.ts` |
| AC-13 | `get` default five-field card | `src/query/get.ts` |
| AC-14 | `update` touch + no silent discard | `src/write/update.ts` + spec |
| AC-15 | `transition` `closedAt` stamp + reopen clears | `src/write/transition.ts` + spec |
| AC-16 | `claim` CAS lease, cross-process | `src/write/claim.ts` + spec |
| AC-17 | `relate`/`move` outcomes | `src/write/relate.ts`, `move.ts` + specs |
| AC-22 | **BUG-039 cross-process write safety** | `src/write/cross-process-write-safety.spec.ts` |
| AC-23 | no-`component` create defaults to `(root)` | `src/write/create-issue.ts`, `catalog.ts` |

**AC-22 is in good shape** and was the gate blocking the ETL. The §10.4 harness was
relocated out of `src/store/concurrency-scale.spec.ts` (which is scheduled for
deletion) onto the `createIssue`/`queryIssues` surface, and **un-skipped** — the
`describe.skip` that SPEC §10.4 point 1 warns about is gone. Both repointing
requirements in §10.4 are satisfied.

### Not evidenced — the real remaining acceptance work (11)

| AC | Criterion | Status |
|---|---|---|
| AC-6 | ETL parity: counts, 100 sampled citation sets, `getSubgraph` | ETL exists with restart/run specs; **the parity gate itself is not evidenced** |
| AC-7 | `searchRanked` returns text+vec fused results | markers only in `src/store/`, not the new layer |
| AC-8 | keyset `queryNodes({after, limit})` pages with no gaps/dupes | no marker, **no `query.spec.ts`** |
| AC-9 | `view:projects/components/locations` list | `registry.spec.ts` exists — verify it asserts this |
| AC-10 | `lookup("memory_ping")` one-call resolution | 18 `lookup` refs in `registry.spec.ts` — likely covered, confirm |
| AC-11 | registry detail + worktree resolves to same project (no phantom row) | **worktree case not evidenced** |
| AC-12 | registry CRUD idempotent on its OWN key, concurrent from 2 OS processes | upsert refs present; **concurrent-process half not evidenced** |
| AC-18 | `delete` is soft | `delete.spec.ts` has 9 `invalidated`/`getNodeByUid` refs — likely covered |
| AC-19 | `create` duplicate gate: suppress / force / comment | **no `create-issue.spec.ts` at all** |
| AC-20 | `query({after, sort})` throws naming the incompatibility | no marker, **no `query.spec.ts`** |
| AC-21 | `rmLocation` invalidates; uid still addressable | 2 refs in `registry.spec.ts` — confirm the bi-temporal half |

### Untested modules — the biggest quality gap

These new-layer sources have **no sibling spec**:

```
src/write/audit.ts      src/write/catalog.ts    src/write/create-issue.ts
src/write/errors.ts     src/write/tx.ts
src/query/card.ts       src/query/get.ts        src/query/index.ts
src/query/query.ts      src/query/resolve.ts    src/query/types.ts
```

`create-issue.ts` and `tx.ts` are the write layer's core, and `query.ts` is the whole
read path. AC-2, AC-8, AC-13, AC-19 and AC-20 all land in these files. **Write these
specs before the wipe**, not after — once the old layer is gone there is no fallback
surface to compare behaviour against.

---

## 2. humanId removal — §7 wipe, scoped

SPEC §0 anti-antipattern 1: *"No humanId / composite identity. Identity is the
DB-generated `uid` (UUID); `rowid` is internal. No allocator, no dedupe-scan, no
`idOverride`, no `importedFrom`, no repo-string identity."* AC-1 makes it a gate.

**2,124 sites across 74 files.** The distribution is the good news:

| Area | Sites | How it goes away |
|---|---|---|
| Old layer (`src/v2/`, `ops-v1.ts`, `client.ts` + specs) | **768** | **free** — deleted by the §7 wipe |
| `src/store/` + `src/model.ts` | **774** | the real work |
| New layer (`src/query/`, `src/write/`) | **5** | trivial; 3 are prose/comparison, see below |
| `tools/web-ui/index.html` | 33 | UI rewrite |
| remaining specs/fixtures | rest | follows its subject |

**The new layer is already uid-native** — 5 humanId mentions total, against heavy `uid`
use (`update.spec.ts` 75, `semantic.spec.ts` 54, `claim.spec.ts` 43…). Of the 5:
`src/query/types.ts:16` and `src/write/cross-process-write-safety.spec.ts:6,19` are
docblocks *asserting the absence*; `types.ts:196` and `query.ts:463` note that v1's
`humanIds` is renamed `uids` for `view:'overlap'`. None is live identity machinery.

**The store-layer 774 is the actual project.** It includes the allocator and its
guards: `src/store/ids.ts`, `structure.ts`, `crud.ts`, `repo-migration.ts`,
`humanid-collision.spec.ts`, `id-uniqueness.spec.ts`, `epic-a-backfill.ts`.

**Sequencing that saves the most work:** do the §7 wipe FIRST. It removes 768 sites
and ~2,500 lines from the surface before you touch the store layer by hand.

### Two open bugs are resolved-by-removal, not fix-in-place

Filed this session before this was understood — annotate, do not "fix":

- **BUG-011** — `filter.humanId` silently accepted and ignored (returns all 622 items
  with `ok:true`). The defect is in `src/v2/query.ts`, on a field being deleted. **But
  the transferable lesson must not be lost:** confirm the NEW `src/query/query.ts`
  validates unknown filter keys with a typed error. It was not verified in this audit.
- **BUG-BACKLOG-REPO-SPLIT-001** (CRITICAL, pre-existing) — same repo under two `repo`
  strings (`adhd` 52 / `PseudoSky/adhd` 348), halving every repo-scoped query and
  breaking dedupe. §7 deletes repo-string identity outright, so this dies with the
  wipe. It is currently causing real damage: **DEBT-006 exists twice** with the same
  humanId under both repo strings.

---

## 3. Remaining work, in dependency order

### S-wave (build)
1. **Specs for the 11 untested modules** — before the wipe, while the old layer is
   still there to compare against.
2. **§6.7 transports** — mount the new layer. `server.ts` extracts `dist/client.d.ts`
   (old surface); it must extract the new one.
3. **§8 ETL run** — gated on AC-22, which is now green. The ETL code and its
   restart/run specs exist; the **§8.8 / AC-6 parity gate** is the missing piece.

### Pipeline (close out)
4. **S10 acceptance** — drive AC-1…AC-23; the 11 above are the work.
5. **S11 wipe** — delete `client.ts`, `ops-v1.ts`, `src/v2/`, plus the store-layer
   identity machinery. Satisfies AC-1 and the zero-v1/v2/humanId/migration criterion.
6. **S12 vocabulary gate**
7. **S13 fresh extract + ETL + parity**
8. **S14 publish + blind test of the public package**

### Known defects to fix inside the above
- `assertNonBlank` null-crash: `claim.ts:62`, `delete.ts:58`, `create-issue.ts:110`,
  `move.ts:105`, `relate.ts:106`
- SPEC gap `SPEC.md:1479-1483` — `IMoveIssueInput.toComponent` required, no `toProject`
- `s5b-semantic-views` frozen-foundation violation on `query.ts`
- 9 pre-existing TS errors in spec files
- DEBT-005 — non-compliant `RUN_NEGATIVE_CONTROL` gate, `src/store/id-uniqueness.spec.ts:137`
- DEBT-006 — vitest workers never call `initTelemetry()`
- BUG-012 — `duplicate_candidate` returns empty `details`, naming no candidate
- Test-lane pattern (`tools/nx-plugins/test/lib/spec-lanes.mjs`) applied nowhere;
  43 spawn-based specs across 13 projects
- D8 — ~11 comments describing a sqlite adapter as a supported substrate

---

## 4. State as of this handoff

**Green.** Full suite: 74 files, 862 passed, 1 skipped, **0 failed**.

**Committed this session** (~9,400 lines that were sitting untracked and at risk):
`d1c39809` write layer · `3d5ffb55` query views · `d7251f5e` ETL · `698e93c9` tracker
· `2dfda482` backlog items.

**Zero-sqlite criterion: met** for dependencies and imports. Remaining textual hits are
factual (Turso *is* a SQLite-format substrate; `SQLITE_BUSY` is a real code matched at
`model.ts:1090`) — scrubbing them would make the comments wrong.

**Dependency note.** `@adhd/sox-hybrid-search@0.4.4` carries the `AsyncVectorBackend`
widening the semantic view needs. `store-adapter@0.9.2` published; **0.4.4 did not**
(registry shows 0.4.3 latest, doc modified 2026-09-05 — genuinely absent, not cache
lag). Until it ships, `node_modules/@adhd/sox-hybrid-search` is a **local overlay**:
`package.json` says 0.4.3 but `dist/` holds the 0.4.4 code. **The suite's green result
above is against that overlay.** Finish with one `pnpm exec changeset publish
--otp=<code>` from `/Users/nix/dev/ai/sox-ecosystem`, then bump backlog to `^0.4.4`,
drop the overlay, and re-run. Backup of the original dist is in the session scratchpad.

**Left deliberately untracked:** `tools/etl/_profile.ts` — a one-shot profiler, correct
as a throwaway per the convention.
