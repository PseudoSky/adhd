# Performance discovery sweep (dispatch-1014)

Scope: `entrypoint/*` (agent-mcp, apigen-cli, backlog, decompile-cli, dispatch-cli, environment-cli, policy) and the `packages/*` they depend on. Method: static reading only (gx/rg + Read); no builds, tests, profilers or benchmarks were run. Every "Evidence" line below was read in the worktree `discovery-sweep-1014`. "Expected gain" is an estimate from code shape, not a measurement, and is labelled as such. Anything unconfirmed is under "Hypotheses / checked-and-cleared".

Severity scale: High = on a per-request/per-turn path with cost that grows with data; Medium = per-call or per-startup cost that is wasteful but bounded; Low = minor or rare path.

---

## PERF-1 — `messages`, `tasks` (and FK-cascade) have no index on `session_id` / `status`

- Severity: High
- Evidence:
  - `packages/agent/agent-store-runtime/src/db/schema.ts:45-47` (`messagesTable`, `session_id` NOT NULL FK, no index argument) and `:96-98` (`tasksTable`, `session_id`, no index; `status` / `parent_task_id` also unindexed). Compare `:152` where `task_events` does get `idx_task_events_task_id_type`.
  - `rg -i 'index'` over `entrypoint/agent-mcp/drizzle/*.sql` finds no index on `messages`, `tasks` or `sessions` (0017 comment at line 5 confirms `messages` is untouched).
  - Queries that hit them: `packages/agent/agent-store-runtime/src/store/session-store.ts:646-650` (`getMessages`, `WHERE session_id = ?`, no ORDER BY), `:398-401` (delete by session), `:573` (correlated `SELECT max(created_at) FROM messages WHERE session_id = e.session_id` evaluated per echo row in `sweepEchoes`), `store/task-store.ts:161-183` (`list` filters on `session_id`/`status`), `entrypoint/agent-mcp/src/index.ts:486-490` (startup scan `tasks WHERE status='pending'`).
  - `PRAGMA foreign_keys = ON` (`packages/agent/agent-core-env/src/sqlite-locking.ts:60`), so every `ON DELETE CASCADE` from `sessions` scans `messages` and `tasks` without an index.
  - Hot callers: `packages/agent/agent-engine-orchestrator/src/tools/task.ts:640` and `:1022` (`getMessages` on every task dispatch into a session), `entrypoint/agent-mcp/src/streaming/chat-gateway.ts:182` (`readHitlQuestion`).
- Expected gain (estimate): each `getMessages` / cascade / sweep subquery goes from a full-table scan of `messages` to an index seek; cost no longer grows with total stored messages across all sessions. Magnitude unmeasured.
- Proposed fix: add additive migration `0018` with `CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at)`, `idx_tasks_session_id ON tasks(session_id)`, `idx_tasks_status ON tasks(status)`, `idx_tasks_parent ON tasks(parent_task_id)`; mirror in `schema.ts` `index(...)`; keep it additive so a previous-version binary still reads (same rule as 0016/0017).
- Write-scope: `entrypoint/agent-mcp/drizzle/0018_*.sql`, `entrypoint/agent-mcp/drizzle/meta/*`, `packages/agent/agent-store-runtime/src/db/schema.ts`, test fixtures that hand-write DDL (`packages/agent/agent-store-runtime/src/__tests__/*.test.ts`).
- ACs:
  - AC1: a fresh migrated DB reports `idx_messages_session_created`, `idx_tasks_session_id`, `idx_tasks_status` in `sqlite_master`.
  - AC2: `EXPLAIN QUERY PLAN` for `getMessages`'s SQL, for `DELETE FROM messages WHERE session_id=?`, and for `tasks WHERE status='pending'` each shows `SEARCH ... USING INDEX` and no `SCAN messages`/`SCAN tasks`.
  - AC3: migrating an existing 0017-level DB applies 0018 without data loss and is idempotent on re-run.
  - AC4: `schema.ts` and the SQL migration declare the same index names (drift test).
- Size: S
- Root-cause / design question remaining: no (the one open point, composite column order, is settled by the query shapes above).

## PERF-2 — Session history is re-read and fully JSON-parsed on the request path where only the tail is needed

- Severity: Medium
- Evidence:
  - `packages/agent/agent-store-runtime/src/store/session-store.ts:646-668`: `getMessages` loads every row and `JSON.parse`s `tool_calls` / `tool_results` for each.
  - `entrypoint/agent-mcp/src/streaming/chat-gateway.ts:180-196` (`readHitlQuestion`): calls `getMessages` for the whole session, then walks backwards to find the last `request_human_input` call. It runs on every `awaiting_input` status change (`:225-229`).
- Expected gain (estimate): O(history) read+parse per HITL pause becomes O(1)-O(k) with a bounded tail query. Grows with session length; unmeasured.
- Proposed fix: add `SessionStore.getLastMessages(sessionId, n)` (or `findLastAssistantToolCall(sessionId, tool)`) with `ORDER BY created_at DESC LIMIT n` backed by PERF-1's index; use it in `readHitlQuestion`.
- Write-scope: `packages/agent/agent-store-runtime/src/store/session-store.ts`, `entrypoint/agent-mcp/src/streaming/chat-gateway.ts`, their tests.
- ACs:
  - AC1: `readHitlQuestion` no longer calls `getMessages` (assert via spy in a real-store test).
  - AC2: with a 5,000-message session, the new query parses at most `n` rows (assert row-count via the test's parse spy).
  - AC3: the returned prompt equals the old implementation's for a session whose HITL call is the last assistant message and for one where it is not.
- Size: S
- Root-cause / design question remaining: no

## PERF-3 — Backlog `order` / dependency-graph views issue N+1 (sequential) graph reads and ignore the adjacency they already built

- Severity: High
- Evidence:
  - `entrypoint/backlog/src/query/query.ts:1047-1050`: sequential `await graph.getEdges({ src: issue.id, rel: 'blocks' })` per issue builds `blockedBy`.
  - `:1060-1063`: `resolveDependents(graph, i.id, idSet)` is called per issue without the optional `blocksOutAdj` argument, so each BFS re-issues `graph.getEdges({src,rel:'blocks'})` per visited node (`entrypoint/backlog/src/query/card.ts:449-470`; the `blocksOutAdj` parameter exists at `:453` for exactly this and is unused here even though the adjacency was just computed at `:1047-1055`).
  - `:955-961` (dependency-graph view): per issue `getOutgoingEdges`, then for every edge a single-id `graph.getNodesByIds([e.dst])` even though `issues` (the full node list, `:945`) already holds the dst uid.
  - `:421-423` and `:971-973`: `Promise.all(issues.map(i => graph.getEdges(...)))` is N queries in parallel, not one batched query (lesser issue; same shape).
- Expected gain (estimate): order/graph view cost goes from O(N + sum of BFS visited sets) round-trips to O(1) edge query + in-memory BFS. At N issues with D average dependents the old path is up to N*D adapter calls. Unmeasured.
- Proposed fix: in the order view, fetch `blocks` edges once (`graph.getEdges({ rel: 'blocks' })`, filter to `idSet`) into `blocksOutAdj`, pass it to `resolveDependents`; in the dependency-graph view build `uidById` from `issues` instead of `getNodesByIds([e.dst])`; optionally add a batched `getEdges({ srcs: [...] })` to the backend for the `has_status` / `has_priority` resolvers.
- Write-scope: `entrypoint/backlog/src/query/query.ts`, `entrypoint/backlog/src/query/card.ts` (only if signature widened), `entrypoint/backlog/src/query/*.spec.ts`.
- ACs:
  - AC1: a spy-wrapped `GraphBackend` records at most 2 `getEdges` calls for the `order` view independent of issue count (test with 10 and 200 issues; call counts equal).
  - AC2: the dependency-graph view makes zero `getNodesByIds` calls with a single-element array.
  - AC3: output of `order` and dependency-graph views is byte-identical to the pre-change output on an existing fixture, including cycle detection and the tiebreak order (dependents DESC, priority rank ASC, uid ASC).
- Size: M
- Root-cause / design question remaining: no

## PERF-4 — Backlog `byCitationPath` and `similar` cluster views scan whole edge sets then resolve rows one at a time

- Severity: Medium
- Evidence:
  - `entrypoint/backlog/src/query/views/by-citation-path.ts:114`: `graph.getEdges({ rel: 'has_citation' })` loads every citation edge in the store, then keeps only matched ids (`:115`).
  - `:131`: `await projectRootOfIssue(graph, issue)` per candidate row (each a placement walk; fn at `:159`), and `:150` `await statusNameOf(graph, issue)` per page item (fn at `:168`).
  - `:104-112`: one `queryNodes` per path spelling, awaited serially.
  - `entrypoint/backlog/src/query/similar-clusters.ts:258-261`: for every live `similar_to` edge in the store: two separate `getNodesByIds([id])` calls (one id each), no limit and no batching.
- Expected gain (estimate): fewer round-trips; `similar` cost no longer scales with 2 queries per stored `similar_to` edge. Unmeasured.
- Proposed fix: resolve citation owners by querying edges with `dst IN citationNodes` (or invert from the citation node set); batch `getNodesByIds` for all edge endpoints once; memoise placement per project; run spelling queries with `Promise.all` or a single `metadata.target IN [...]` filter if the backend supports `in`.
- Write-scope: `entrypoint/backlog/src/query/views/by-citation-path.ts`, `entrypoint/backlog/src/query/similar-clusters.ts`, specs.
- ACs:
  - AC1: `similar` view makes one `getNodesByIds` call total for linked-edge endpoints (spy assertion), regardless of edge count.
  - AC2: `byCitationPath` makes no unfiltered `getEdges({rel:'has_citation'})` call (spy assertion on the filter argument).
  - AC3: result ordering and content are identical to current fixtures.
- Size: M
- Root-cause / design question remaining: yes (whether `GraphBackend` can accept an edge filter on `dst IN [...]`/`src IN [...]`; if not, a backend API addition belongs in the graph-store package, which is outside this repo path set).

## PERF-5 — Budget plugin serialises the entire message history and every tool schema on every model request, before checking whether any cap needs it

- Severity: High
- Evidence:
  - `packages/agent/agent-plugin-budget/src/index.ts:1772` calls `estimateRequestContext(p.messages, p.tools)` inside `enforcePreModel`, unconditionally.
  - `:528-550` `estimateRequestContext`: `JSON.stringify` of every tool call's arguments, every tool result, and `{name, description, inputSchema}` for every tool, per request.
  - The value is consumed only for the `'context'` cap field (`:78`, `:142`); `modelCaps` (`:1757-1760`) can contain no `'context'` cap, in which case the result is unused.
- Expected gain (estimate): removes an O(history + tool-schema bytes) stringify from every model call for agents without a context cap; grows with turns. Unmeasured.
- Proposed fix: compute lazily only when `modelCaps.some(c => c.field === 'context')`; cache the tools-size term per `p.tools` array identity (tools are constant across turns of a task); keep a running message-size total per task if a context cap is present.
- Write-scope: `packages/agent/agent-plugin-budget/src/index.ts`, `packages/agent/agent-plugin-budget/src/**/*.test.ts`.
- ACs:
  - AC1: with no `'context'` cap configured, `JSON.stringify` is not invoked by `enforcePreModel` (spy on `JSON.stringify` in a unit test driving the real plugin).
  - AC2: with a `'context'` cap, the enforced value equals the previous implementation for the same inputs (golden numbers), and the tools term is computed once across two consecutive calls with the same tools array.
  - AC3: all existing budget-plugin tests stay green.
- Size: S
- Root-cause / design question remaining: no

## PERF-6 — Anthropic echo replay deep-clones (JSON round trip) every echoed block of the whole history on every request

- Severity: Medium
- Evidence:
  - `packages/agent/agent-engine-orchestrator/src/providers/anthropic-echo.ts:143` `const copy = cloneJson(block)` for every block of every echoed assistant message; `cloneJson` is `JSON.parse(JSON.stringify(value))` (`:79-81`). Called per assistant message in the request build at `packages/agent/agent-engine-orchestrator/src/providers/anthropic.ts:246`.
  - The only mutation the clone supports is renaming `tool_use.name` (`:144-146`); thinking blocks (signed, large) and server-tool result blocks (fetched pages) are cloned and not otherwise modified.
- Expected gain (estimate): per-request clone cost drops from O(total echoed bytes) to O(number of tool_use blocks). Unmeasured.
- Proposed fix: return the block by reference unless it is a `tool_use` whose name differs from `nameFor(tc)`; for that case shallow-copy `{...block, name}` (input stays shared, the SDK serialises it and never mutates it).
- Write-scope: `packages/agent/agent-engine-orchestrator/src/providers/anthropic-echo.ts`, its tests.
- ACs:
  - AC1: for thinking / server-tool blocks `assistantBlocks` returns the identical object reference (`toBe`).
  - AC2: the serialised request bytes for a fixture history are byte-identical before and after.
  - AC3: mutating the returned array's `tool_use` copy does not mutate the stored echo (shared `input` is not mutated by any caller; assert via freeze on echo blocks).
- Size: S
- Root-cause / design question remaining: no (confirm no downstream code mutates `input`; AC3 enforces this)

## PERF-7 — `decompile` CLI loads dependency-cruiser and depcheck at module import via top-level await

- Severity: Medium
- Evidence:
  - `entrypoint/decompile-cli/src/lib/store/package.ts:1` (`import depcheck from 'depcheck'`) and `:6` (`const { cruise: depcruise } = await import('dependency-cruiser')`, top-level await).
  - Static chain: `entrypoint/decompile-cli/bin/decompile.ts:4` imports `../src/index.js` -> `src/index.ts:2` imports `./store/index.js` -> `src/lib/store/index.ts:6` imports `./package.js`.
  - Therefore every invocation (including `--help` / `--version`) pays the import cost of both heavy tools, though they are used only in `buildPackage` / `getDeps` / `cruiseDeps` (`package.ts:98`, `:186`, `:196`).
- Expected gain (estimate): cold-start of non-packaging commands drops by the load time of two large dependency graphs. Unmeasured.
- Proposed fix: move both imports inside `getDeps` / `buildPackage` as `await import(...)` (memoised); no top-level await remains.
- Write-scope: `entrypoint/decompile-cli/src/lib/store/package.ts`, `entrypoint/decompile-cli/src/tests/*`.
- ACs:
  - AC1: `package.ts` contains no top-level `await` and no static `depcheck` import.
  - AC2: importing `src/index.js` in a fresh Node process does not load `dependency-cruiser` or `depcheck` (assert via `require.cache` / module-load hook in a test).
  - AC3: existing store/package tests pass unchanged.
- Size: S
- Root-cause / design question remaining: no

## PERF-8 — `data-query-engine` compiles a new `RegExp` on every comparison for `_regex`/`_iregex` (and negations)

- Severity: Low
- Evidence: `packages/data/data-query-engine/src/lib/filters.ts:91-96`: `matchesRegex` / `matchesIRegex` call `new RegExp(b[, 'i'])` per invocation; the filter is applied once per row, so a scan compiles the same pattern per row. This engine backs `@adhd/policy-core-client` (`packages/policy/policy-core-client/package.json` depends on it), whose own `matcherCache` (`core/engine/matches.ts:33`) caches the predicate per expression but not the regex inside this operator.
- Expected gain (estimate): removes N regex compilations per N-row filter. Policy decisions evaluate few rows, so impact there is small; larger on data-query-engine consumers with big row sets. Unmeasured.
- Proposed fix: small bounded LRU (e.g. 256 entries) keyed `flags + '/' + pattern` in `filters.ts`; reuse RegExp (non-global flags only, so no `lastIndex` state).
- Write-scope: `packages/data/data-query-engine/src/lib/filters.ts`, its spec.
- ACs:
  - AC1: a 10,000-row filter with one pattern constructs `RegExp` exactly once (spy on `globalThis.RegExp`).
  - AC2: case-insensitive and case-sensitive results for the same pattern remain distinct (cache key includes flags).
  - AC3: cache size never exceeds its bound under 10,000 distinct patterns.
- Size: S
- Root-cause / design question remaining: no

## PERF-9 — Apigen IR cache computes dependency hashes/stats sequentially

- Severity: Low
- Evidence: `packages/apigen/apigen-plugin-ir-cache/src/lib/ir-cache-layer.ts:352-355` (`for ... of dependencyPaths ... await sha256FileOrMissing(depPath)`, slow-gate key), `:372-376` (`buildStalenessSnapshot`, `await statMtimeMs` per dep), `:402-406` (`fastGateHits`, `await statMtimeMs` per dep). Each await waits for the previous file op although the operations are independent.
- Expected gain (estimate): fast gate (runs on every cached extract) goes from sum-of-stat-latencies to max; matters for call sources with many local imports. Unmeasured.
- Proposed fix: `Promise.all` over the dep list (stat is cheap; for hashing bound concurrency to ~16); preserve order for the hash input by mapping then joining in sorted order (the key must stay byte-identical).
- Write-scope: `packages/apigen/apigen-plugin-ir-cache/src/lib/ir-cache-layer.ts`, its spec.
- ACs:
  - AC1: `computeCacheKey` output is byte-identical to the current implementation on the existing determinism fixtures.
  - AC2: `fastGateHits` issues all dep `stat` calls before awaiting any result (assert via a stat spy that records start order vs. completion order with delayed fakes).
  - AC3: a missing dep still yields a miss (fast gate) and the `missing` sentinel (slow gate).
- Size: S
- Root-cause / design question remaining: no

## PERF-10 — Backlog verdict/attest paths spawn several synchronous `git` processes per anchor and re-run invariant checks

- Severity: Medium
- Evidence:
  - `entrypoint/backlog/src/write/anchor-check.ts:172-189` `runGit` uses `execFileSync`; `checkAnchor` (`:361-`) runs `isGitWorkTree` (`rev-parse`, `:195-198`) then `existsAtHead` (`cat-file -e`, `:204`), `changedSinceFiling` (`:213`), possibly `digestAtHead` (`cat-file -p`, `:230`) for one anchor. `isGitWorkTree` is repeated on every call for the same root.
  - `entrypoint/backlog/src/query/verdict.ts:342` `await resolveProjectRoot(...)` and `:361` `checkAnchor(...)` run inside `for (const kind of kinds)` in `refineEvidence`, i.e. repeated per obligation kind, on the read path of an MCP server; each `execFileSync` blocks the event loop for the duration of the process spawn.
  - `entrypoint/backlog/src/write/citation.ts:215` additionally spawns `git show` per revision-pinned citation and buffers up to 64 MiB (`maxBuffer`).
- Expected gain (estimate): fewer spawns per verdict (memoise `isGitWorkTree` per root for the call; resolve project root once per issue); no event-loop stall if converted to async `execFile`. Unmeasured.
- Proposed fix: hoist `resolveProjectRoot` out of the `kinds` loop; per-call memo of `isGitWorkTree(root)`; replace `execFileSync` with promisified `execFile` (and `git cat-file --batch-check` for multi-path checks) in the async callers.
- Write-scope: `entrypoint/backlog/src/query/verdict.ts`, `entrypoint/backlog/src/write/anchor-check.ts`, `entrypoint/backlog/src/write/citation.ts`, `entrypoint/backlog/src/write/attestation.ts` (callers at `:298`, `:437`, `:570`), specs.
- ACs:
  - AC1: `refineEvidence` for N kinds on one issue calls `resolveProjectRoot` once and `git rev-parse --is-inside-work-tree` at most once (spawn spy).
  - AC2: no `execFileSync` remains in `verdict.ts`'s call chain on the async read path.
  - AC3: verdict/attest results (state, method, reason) identical on the existing anchor-check fixtures.
- Size: M
- Root-cause / design question remaining: yes (`checkAnchor` is a public sync export used by sync callers; making it async changes its contract; decide between adding an async twin and migrating callers).

## PERF-11 — `@adhd/policy` re-reads and hashes every `.d.ts` of the client surface on each start-up

- Severity: Low
- Evidence: `entrypoint/policy/src/wrapper/ir.ts:89-105` `surfaceDigest` walks the declaration root with `readdirSync` and `readFileSync` + sha256 for every `.d.ts`; it is invoked from the baked-artifact validation at `:135` on each start, before the artifact is trusted. The baked artifact exists to avoid live extraction, but its validity check costs a full read of the surface each launch.
- Expected gain (estimate): start-up time proportional to the number/size of `.d.ts` files drops to one stat pass. Unmeasured; the number of files was not counted.
- Proposed fix: stamp a cheap fingerprint (`path + size + mtimeMs` list) in the artifact and fall back to the content digest only when the fingerprint differs.
- Write-scope: `entrypoint/policy/src/wrapper/ir.ts`, `entrypoint/policy/src/wrapper/ir-artifact.ts`, `entrypoint/policy/src/test/*`.
- ACs:
  - AC1: start-up with an unchanged surface performs zero `readFileSync` on `.d.ts` files (spy).
  - AC2: touching one `.d.ts` content (same size) with a changed mtime invalidates and re-extracts; restoring identical bytes with the baked fingerprint stale falls back to the content digest and still accepts.
  - AC3: artifact format version bumped; an old-format artifact is rejected with the existing `reason` path.
- Size: S
- Root-cause / design question remaining: yes (mtime fingerprints are unreliable across package-manager installs/copies; confirm the fallback-to-digest policy is acceptable).

## PERF-12 — `result` wait polls SQLite every 100 ms with no backoff, per waiting caller

- Severity: Low
- Evidence: `packages/agent/agent-engine-orchestrator/src/tools/task.ts:1252` (`RESULT_WAIT_POLL_MS = 100`) and `:1282-1288` (loop: `deps.taskStore.read(...)` then `sleep(min(100, remaining))`, up to `RESULT_MAX_WAIT_MS = 55_000` per `validation/task.ts:161`). That is up to 550 DB reads per wait; N parents waiting on children multiply it. A task event bus already exists (`subscribeToTask`, used by `entrypoint/agent-mcp/src/streaming/chat-gateway.ts:225`) so an event-driven wake-up is available.
- Expected gain (estimate): from up to 550 reads per wait to 1 read plus event wake-ups (with a slow safety poll). Unmeasured.
- Proposed fix: subscribe to the task's terminal/`awaiting_input` events with the existing bus and keep a backed-off (100 ms -> 1 s) fallback poll for cross-process completions (ADR-0012: another process may finish the task, so the poll must stay as the correctness fallback).
- Write-scope: `packages/agent/agent-engine-orchestrator/src/tools/task.ts` and tests.
- ACs:
  - AC1: for a task that completes in the same process, `taskStore.read` is called at most 3 times during a 55 s-budget wait (deterministic fake clock/latch).
  - AC2: for a task completed by another process (no in-process event), the wait still returns within the fallback poll interval (store updated out-of-band in test).
  - AC3: timeout semantics and `dispatch:completed` emission unchanged.
- Size: M
- Root-cause / design question remaining: yes (whether the in-process bus is authoritative enough to skip polling, given parallel-process writers per ADR-0012).

## PERF-13 — Chat gateway fingerprint map grows without bound in a long-lived server

- Severity: Low
- Evidence: `entrypoint/agent-mcp/src/streaming/chat-gateway.ts:30` `const fingerprintMap = new Map<string, string>()`; the only inserts are `:176` (`fingerprintMap.set(fp, newSessionId)`), and the only removals are `:164` (when the same fingerprint is looked up again and its session is gone) and `:33` (test reset). A fingerprint never seen again is never removed.
- Expected gain (estimate): bounds memory (two short strings per distinct conversation) in a process that serves the HTTP chat endpoint indefinitely.
- Proposed fix: bounded LRU (e.g. 10,000 entries) or TTL sweep; map is only an optimisation (a miss creates a new session) so eviction is safe.
- Write-scope: `entrypoint/agent-mcp/src/streaming/chat-gateway.ts` and its test.
- ACs:
  - AC1: inserting `limit + 1` distinct fingerprints leaves `size <= limit`.
  - AC2: a recently used fingerprint survives eviction of older ones (LRU order).
  - AC3: `resetFingerprintMap` still empties the map.
- Size: S
- Root-cause / design question remaining: no

## PERF-14 — Policy-owned and tool-name regex creation inside validation of every schema node

- Severity: Low
- Evidence: `packages/policy/policy-core-client/src/core/schema/validate.ts:83` `new RegExp(node['pattern']).test(v)` constructs a regex per validated string value (called per node per validation run). The sibling `packages/agent/agent-core-native-tooling/src/lib/permissions.ts:11-27` shows the repo's own precedent (a `TOOL_NAME_GLOB_CACHE`).
- Expected gain (estimate): negligible on small configs; relevant only if validation runs per request. Whether it does was not traced (hypothesis on frequency).
- Proposed fix: share a small pattern->RegExp cache (could be the same helper as PERF-8 if hoisted to a shared package in the `data` family).
- Write-scope: `packages/policy/policy-core-client/src/core/schema/validate.ts`, its spec.
- ACs:
  - AC1: validating the same document twice compiles each distinct `pattern` once.
  - AC2: invalid patterns still produce the same error message.
- Size: S
- Root-cause / design question remaining: no

---

## Hypotheses / checked-and-cleared (not findings)

- (hypothesis) `entrypoint/agent-mcp/src/index.ts:493-501` re-enqueues orphaned pending tasks with a sequential `await enqueueExistingTask` at start-up; whether `enqueueExistingTask` blocks until the task finishes was not read. If it only enqueues this is fine; its scan already benefits from PERF-1's status index.
- (hypothesis) `packages/dispatch/dispatch-orchestrator/src/lib/process-guard.ts:124-129` `psRssBytes` runs `spawnSync('ps')` per tracked pid per `sweep()`; `ChildReaper` has no non-test caller found in `packages` or `entrypoint` (rg), so the cost is currently unreachable. Re-check if it gets wired.
- Cleared: `ajv.compile(schema.input)` per call (`packages/apigen/apigen-engine-runtime/src/lib/validate-layer.ts:353,434`) hits Ajv's identity cache because `schemas[fnName]` is a stable object from the closure; per-call cost is a Map lookup, not a recompile.
- Cleared: orchestrator compaction (`packages/agent/agent-engine-orchestrator/src/engine/context-window.ts:109-128`) uses the provider-reported prompt size, so the per-message estimator only runs on the first call.
- Cleared: usage queries chunk their IN lists (`packages/agent/agent-engine-orchestrator/src/tools/usage.ts:567`, `:839`); `policy-core-client` caches compiled matchers per expression (`core/engine/matches.ts:33`); `apigen-cli` orchestrator fans out with `Promise.all` (`entrypoint/apigen-cli/src/lib/orchestrator.ts:464,725`); `environment-builder` reads layer files at construction only (`environment-builder/src/layer-files.ts:75-101`).
- Cleared (small, startup-only or rare): `claudecli-session.ts:154-166` `removeTranscripts` does `readdirSync` plus `rmSync` per project dir x id on session release/exit (sync I/O on a rare path); `dispatch-cli/src/lib/import-agents.ts:219-285` imports personas strictly sequentially (one-shot CLI; ordering may matter for duplicate names).
- Not examined (budget/time): `packages/ui-react`, `packages/workspace/*` (build-time tooling, not on entrypoint runtime paths), `apigen-engine-gateway`, `apigen-plugin-api-*` request handlers beyond a skim, the external graph-store package indexes behind `GraphBackend` (outside the repo path set; PERF-3/PERF-4 assume per-call cost, which was not measured).
