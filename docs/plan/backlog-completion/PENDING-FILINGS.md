# Pending filings — four findings awaiting a writable store

These are filed here rather than in the graph because the live store at
`~/.adhd/backlog/production/data/backlog.db` currently **rejects every write**:

```
{"ok":false,"error":{"code":"internal","message":"Write I/O failure: an unclassified
driver/connection error surfaced from the underlying transaction",
"details":{"retryable":true}}}
```

The same command against `--sandbox` succeeds, so this is store state, not a code
defect. The data dir holds several abandoned connection files
(`backlog.db-shm.stale-*`, `backlog.db-tshm.stale-*`, newest 2026-09-17T03:38),
consistent with processes that died holding the store. Reads work; only writes fail.
**Move each item below into the graph once the store is healthy.**

---

## 1. A body edit mints a fresh uid, breaking every citation to the issue

`bug` / `high` / project `backlog`

`update` does not mutate in place. Given `input.body` it CASes `is_superseded = 1`
on the old row, mints a NEW node, points an uppercase `SUPERSEDES` edge new→old, and
reassigns `currentUid = newNode.uid`[1]; `update` returns that new uid[2].

So an issue's uid is not stable across a description edit. Every citation, doc
reference and `[[ref]]` naming the old uid now names a superseded row, not the live
issue. That is load-bearing here: the disclosure protocol cites items *by uid*, so
the citation format assumes a stability the write layer does not provide.

Filed rather than fixed because the write path is otherwise deliberate and coherent:
every identity-chain edge (`owns_component`, `has_status`, `has_kind`, `has_priority`,
`authored_by`) is re-pointed onto the new node on each supersede[3], and a shared
`resolveLiveIssueTx` guard makes all six write verbs reject a stale uid loudly rather
than acting on the zombie[4]. Whether an issue is a versioned fact or a mutable record
is a SPEC-level identity decision, not a local fix.

Two candidate resolutions: (a) carry the uid forward onto the replacement, so identity
is stable and the old row becomes pure history; (b) keep uid churn but make it
non-silent — resolve a superseded uid to its successor on read, so an old citation
still lands on the live issue.

Citations: [worktree .worktrees/backlog-v2, sox:typescript-pro, claude,
docs/plan/backlog-completion, 1: entrypoint/backlog/src/write/update.ts:583-628,
2: entrypoint/backlog/src/write/update.ts:680,
3: entrypoint/backlog/src/write/update.ts:641-665,
4: entrypoint/backlog/src/write/superseded-uid-guard.spec.ts:1-34,
5: entrypoint/backlog/src/query/resolve.ts:55-62]

## 2. The production store rejects all writes while reads succeed

`bug` / `high` / project `backlog`

As described above: `upsert-project` against the live store returns a retryable
`internal` write-I/O error while the identical call against `--sandbox` succeeds, and
`query` against the live store reads fine (returns 0 issues, which is expected for the
fresh application-layer graph). The abandoned `-shm`/`-tshm` files suggest the recovery
path for a dead connection-holder does not reclaim the store. Needs a reproduction and
a decision on whether recovery should be automatic.

Citations: [worktree .worktrees/backlog-v2, sox:typescript-pro, claude,
docs/plan/backlog-completion, 1: ~/.adhd/backlog/production/data/ (directory listing,
stale shm files dated 2026-09-16/17)]

## 3. `cascade-plan` cannot validate a minor bump through a `workspace:^` edge

`bug` / `medium` / project `sox-ecosystem`

`scripts/cascade-plan.ts`'s own docstring predicts this case — the walker follows only
`workspace:*` edges and flags "(b) a MINOR/MAJOR bump cascading through a `workspace:^`
edge (`^0.x` does not satisfy `0.y`) — the dangerous direction, flagged as
changeset-only". Verified empirically: `hybrid-search`, `semantic`, `analysis` and
`memory-core` each declare `@adhd/sox-graph-store: workspace:^` in `dependencies`, so a
graph-store minor makes the gate FAIL by construction even when the changeset set is
correct. The gate therefore cannot pass for any graph-store minor, which means it is
not currently usable as a release gate for this class of change.

Citations: [sox-ecosystem, sox:typescript-pro, claude, graph-store isSuperseded work,
1: scripts/cascade-plan.ts (docstring), 2: libs/data/graph/hybrid-search/package.json,
3: libs/memory/memory-core/package.json]

## 4. `registry/index.json` checksums drift ahead of npm, holding the smoke gate red

`bug` / `medium` / project `sox-ecosystem`

`node scripts/smoke-test.mjs` is red (4 passed, 9 failed) with root cause
`CHECKSUM MISMATCH for source "npm-package:@adhd/sox-extension-memory-server@1.3.3"`:
the working tree records a locally-rebuilt `sha256:803ed04…` while published 1.3.3
carries `sha256:6a4168d7…`. `registry/index.json` has been uncommitted since
2026-09-14 17:02 — predating this session's commits — and is the only dirty file.

The structural problem: the smoke test installs the **published** tarball, so a
locally-rebuilt checksum can never match until memory-server is republished at a new
version — and memory-server sits inside the changesets cascade closure that the
publish itself would produce. AGENTS.md makes 0 smoke failures a hard pre-merge gate
for anything touching `libs/data/`, so that gate is only satisfiable *after* the
irreversible step it is meant to guard. Mirrors the gate-ordering problem PUBLISHING.md
already documents for `changeset version`.

Citations: [sox-ecosystem, sox:typescript-pro, claude, graph-store isSuperseded work,
1: registry/index.json, 2: dist/smoke/run-2026-09-17T03-20-42/log.json, 3: AGENTS.md
(smoke-test pre-merge gate)]

## 5. The open-curve view double-counts an issue after every body edit

`bug` / `medium` / project `backlog`

`openCurveView` counts `existed` per sampled instant with `liveOnly: false` and
`validAt: at`[1]. A body edit mints a new node and leaves the old one with
`t_invalid` NULL forever, so at any instant AFTER an edit BOTH rows satisfy
`validAt` and the same logical issue is counted twice — three times after two
edits, and so on. The burndown silently inflates.

This site is deliberately excluded from the `isSuperseded: false` fix applied to
the current-view read paths, because that predicate is wrong here in the other
direction: at an instant BEFORE the edit, the replacement did not yet exist and
the original would also be filtered out, so the issue would count as never having
existed. A point-in-time view needs "the row that was current AT that instant" —
i.e. dedup by logical issue identity along the `SUPERSEDES` chain — which is the
same identity decision as item 1 and should be resolved with it.

Citations: [worktree .worktrees/backlog-v2, sox:typescript-pro, claude,
docs/plan/backlog-completion, 1: entrypoint/backlog/src/query/views/stats.ts:573-590,
2: entrypoint/backlog/src/write/update.ts:583-628]

## 6. The fused-relevance ranking path cannot express the current-row predicate

`bug` / `medium` / project `backlog`

`rankByFusedRelevance` builds `filters` for `handle.search.backend.searchRanked`
(a `StoreSearchBackend` from `@adhd/sox-hybrid-search`), not for
`graph.queryNodes`[1]. When no `candidateIds` are supplied it filters on
`{kind:'issue'}` alone, so superseded rows remain eligible for ranking and a
semantic search can return both a stale row and its replacement. The
`isSuperseded` predicate added to `NodeFilter` does not reach this path, because
it is a different filter type owned by another package.

Not fixed here: it needs the equivalent predicate in hybrid-search's own filter
contract. The `candidateIds` path is already safe, since those ids come from a
prior filtered `queryNodes`.

Citations: [worktree .worktrees/backlog-v2, sox:typescript-pro, claude,
docs/plan/backlog-completion, 1: entrypoint/backlog/src/query/views/semantic.ts:341-355]

## 7. `release:prepared` does not run `changeset version`, but PUBLISHING.md says it does

`bug` / `high` / project `sox-ecosystem`

PUBLISHING.md states, in bold, "**Never run `changeset version` by hand as a separate
step.** `release:prepared` runs `version` and `publish` together."[1] The script does
not: `"release:prepared": "node tools/release-consumers.mjs && npm run
build-index:publish && nx build sox && changeset publish"`[2] — there is no `version`
step anywhere in it.

The consequence lands on a one-way door. With a pending changeset for
`@adhd/sox-graph-store` (minor) the on-disk version is still `0.9.2` and npm already
serves `0.9.2`[3], so following the documented procedure runs `changeset publish`
against unbumped versions. Best case it fails with "cannot publish over previously
published versions"; worse, it publishes the four cascade packages from whatever
state their `dist/` is in. And the doc forbids the only step that would bump them, so
there is no documented path forward — the operator is told to do something the
tooling cannot do.

Either the script should gain `changeset version` (matching the doc and the CI
workflow's "Version Packages" PR model), or the doc should be corrected to name the
real sequence. A release was NOT attempted against this ambiguity.

Citations: [sox-ecosystem main, sox:typescript-pro, claude, graph-store isSuperseded
work, 1: PUBLISHING.md:50-52, 2: package.json:27, 3: libs/data/graph/graph-store/package.json:3
vs `npm view @adhd/sox-graph-store version` = 0.9.2]
