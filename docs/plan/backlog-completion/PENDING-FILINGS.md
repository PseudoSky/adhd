# Pending filings — findings awaiting a writable store

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

## 2. The production store rejects all writes while reads succeed

`bug` / `high` / project `backlog`

As described above: `upsert-project` against the live store returns a retryable
`internal` write-I/O error while the identical call against `--sandbox` succeeds, and
`query` against the live store reads fine (returns 0 issues, which is expected for the
fresh application-layer graph). The abandoned `-shm`/`-tshm` files suggest the recovery
path for a dead connection-holder does not reclaim the store. Needs a reproduction and
a decision on whether recovery should be automatic.

**Cause identified 2026-09-17.** The stale files are not the residue of dead
connection-holders; they are produced by the store's OWN repair path, once per open.
Every single CLI invocation against the production store emits
`store.integrity.repaired` — "[BUG-026] foreign -shm sidecar reconciled BEFORE the
open: moved aside to …/backlog.db-shm.stale-<timestamp>" — so each open renames the
current `-shm` to a new dated file and none is ever reclaimed. That is a leak, not a
recovery: ~30 files had accumulated. Something recreates `backlog.db-shm` between
opens, and the repair treats it as foreign every time. The repair lives in the sox
store adapter, not in `entrypoint/backlog`.

Reads are healthy as of this probe (`query` returns `ok:true`, 0 issues — expected
for the fresh application-layer graph). A write probe against the production store
was not run: it is the user's real data and the action was declined.

Citations: [worktree .worktrees/backlog-v2, sox:typescript-pro, claude,
docs/plan/backlog-completion, 1: ~/.adhd/backlog/production/data/ (directory listing,
~30 stale shm/tshm files dated 2026-09-16/17), 2: `node dist/index.js query` stderr,
`store.integrity.repaired` event naming BUG-026]

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

## 4. `build-index` checksums the LOCAL artifact for `npm-package:` sources, so smoke can never pass

`bug` / `high` / project `sox-ecosystem`

`resolveChecksum` always hashes the local built artifact — `manifest.entrypoint`,
else `dist/index.js`, else `prompt.md`, else `extension.json`[1] — with no branch on
what kind of `source` the entry emits. But for a published extension the emitted
source is `npm-package:@adhd/sox-extension-memory-server@1.3.3`, and the installer
downloads that published tarball and compares it against the locally-derived hash.
Those agree only if the local build is byte-identical to what was published.

It is not, and cannot be relied upon to be. The expected checksum changed from
`sha256:803ed04…` to `sha256:953cb7b8…` across two `build-index` runs on the same
day with NO change to memory-server's source — a rebuild alone moved it. So
republishing memory-server would re-align the two for exactly as long as it takes
the next rebuild to run; it is not a durable fix. This is why `node
scripts/smoke-test.mjs` has been red at 4 passed / 9 failed since 2026-09-14, every
failure descending from the one CHECKSUM MISMATCH at bundle install.

The file's own header already anticipates the right behaviour — "may fetch published
artifacts to checksum them"[2] — but no code path does. The fix is for an
`npm-package:` source to take its checksum from the published tarball (npm's own
`dist.integrity` is authoritative and needs no download), leaving `file://` sources
on the local-hash path they legitimately use.

Not fixed here: it is release-tooling surgery in a second repo, outside the backlog
scope this session was asked to finish, and it does not block the backlog work — the
graph-store publish completed. Worth noting that AGENTS.md makes 0 smoke failures a
hard pre-merge gate for anything touching `libs/data/`, so this defect currently
blocks that gate for every such change.

Citations: [sox-ecosystem main, sox:typescript-pro, claude, graph-store isSuperseded
work, 1: scripts/build-index.ts:332-357, 2: scripts/build-index.ts:12,
3: dist/smoke/run-2026-09-17T14-26-27/log.json (tests[0].verdict_detail)]

## 6. The fused-relevance ranking path cannot express the current-row predicate — FIXED

`bug` / `medium` / project `backlog` — **resolved in this branch.**

`rankByFusedRelevance` builds `filters` for `handle.search.backend.searchRanked`
(a `StoreSearchBackend` from `@adhd/sox-hybrid-search`), not for
`graph.queryNodes`[1]. When no `candidateIds` are supplied it filters on
`{kind:'issue'}` alone, so superseded rows remain eligible for ranking and a
semantic search can return both a stale row and its replacement. The
`isSuperseded` predicate added to `NodeFilter` does not reach this path, because
it is a different filter type owned by another package.

Fixed by post-filtering inside `rankByFusedRelevance`: it over-fetches, drops the
superseded rows via one bounded `queryNodes`, and repeats (doubling, four rounds)
until `limit` live rows are in hand or the ranking backend is exhausted. A predicate
on `query.filters` remains impossible — that filter belongs to hybrid-search's own
contract — so the drop happens on the results. Proven by
`src/query/superseded-ranking.spec.ts` against real fastembed and a real Turso vector
space: an edited issue appears exactly once, as its successor. Run as a negative
control, a pass-through `dropSupersededResults` turns it red with `expected [ …(2) ]
to have a length of 1 but got 2`. The test drives `view:'similar'` with a bare
`filter.semantic` deliberately — that is the only caller shape for which
`resolveSimilarFilterIds` returns `undefined` and `rankByFusedRelevance` takes its
un-narrowed `{kind:'issue'}` branch. Driving `{text}` instead proves nothing: it
routes to the keyword path, which already filters on `isSuperseded`, and the first
version of this test did exactly that and stayed green with the fix removed.

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
