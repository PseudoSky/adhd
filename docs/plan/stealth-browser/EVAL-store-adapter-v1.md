# capture-upgrade: SqliteRecordingSink -> optional store-adapter sink (evaluation)

Dispatch dispatch-2026-10-12-ca18, plan 8468f7b1-8adc-4237-9986-21ea1e27c537. Read-only evaluation; nothing in the stealth-browser worktree or adhd was edited.
adhd = /Users/nix/dev/node/adhd. Spec = scratchpad/capture-and-lifecycle-spec.md (section 5, lines 112-240).

## 0. Verdict

Accept the twist, in modified form (Option B'): keep the `RecordingSink` seam the spec already has (spec:158), drop `node:sqlite` from the recording path entirely, ship (1) the sink contract with batching/flush/close/backpressure/typed errors, (2) an in-memory sink, (3) a SQL sink that takes a locally defined structural `RecordingSqlStore` which `@adhd/sox-store-adapter`'s `StoreAdapter` satisfies by duck typing. No new package, no new dependency, no `package.json` edit.

Two findings change the request's premise:
1. adhd ADR-0001 (docs/decisions/0001-...md:11, :46) says every adhd store, present and future, starts on `@adhd/sox-store-adapter`; "a new adhd storage surface that begins on better-sqlite3 is a violation". A writable `node:sqlite` recording DB is a new single-writer storage surface, and ADR-0001 D7 (:93-100) bans single-writer postures. The ADR names better-sqlite3, not node:sqlite, so the strict text is not literally hit, but the intent is. Option A is therefore an ADR-0001 risk; the twist is the compliant direction.
2. The only real "store adapter" contract (`StoreAdapter`) lives in an ESM-only external package (`"type":"module"`, node_modules/@adhd/sox-store-adapter/package.json) and is a third-party dependency from sox-ecosystem. adhd ADR-0003 (CJS-only) plus the approved-deps rule means @adhd/stealth-browser must NOT import it at runtime or declare it. Structural typing is the only clean path.

## 1. What "store adapter" means here

Exists: exactly one, and it is external to the monorepo's `packages/`.
- Name: `StoreAdapter` from `@adhd/sox-store-adapter` (sox-ecosystem, published, v0.13.3 pinned at /Users/nix/dev/node/adhd/package.json:162 override; dependency of entrypoint/backlog/package.json:24).
- Interface (node_modules/@adhd/sox-store-adapter/dist/types.d.ts:408-468): `executeGet/executeAll/executeRun(sql, args?)`, `exec(sql): Promise<void>`, `pragmaSet/pragmaGet`, `transaction(fn, {mode,maxRetries,baseDelayMs})`, `executeMany(stmts[])`, FTS helpers, `init?()`, `close()`, `config`, `capabilities`. Factory `createStoreAdapter(config)` (dist/factory.d.ts:4). `MockAdapter` exists (dist/mock-adapter.d.ts:21).
- Tier: not an adhd tier. adhd `store` tier = persistence/data access over base+core (CLAUDE.md:133-139; package-naming.md:33); `@adhd/sox-store-adapter` is the substrate those store packages sit on (ADR-0001 D1, :37-46). Reference consumer: entrypoint/backlog/src/store/graph-backlog-store.ts:14,102 (`await createStoreAdapter({ dbPath })`).
- Runtime: Turso-backed, multiprocess WAL mandatory (ADR-0001 D7). ESM-only, `engines node >=20`, deps `@tursodatabase/database`, `@adhd/sox-telemetry`.

Candidates and fit:
| Candidate | Where | Fit as stealth-browser sink target |
|---|---|---|
| `StoreAdapter` (sox-store-adapter) | external pkg, published | Best fit: SQL executor, async, transactional, ADR-0001 mandated. Cannot be imported (ESM-only, unapproved dep) -> duck-type only |
| `packages/data/*` (data-base-transforms, data-core-structures, data-query-engine) | /Users/nix/dev/node/adhd/packages/data | None. `rg "export (interface|type) \w*(Store|Sink|Repository|Adapter)"` over packages/ and entrypoint/ finds no contract in packages/data. They are transforms/structures/query, not persistence. Contents beyond package names not read in depth |
| `ICalibrationStore` | packages/dispatch/dispatch-base-spec/src/lib/types.ts:735 | Pattern precedent only: a deliberately minimal structural contract "so any storage backend can implement it" (comment :726-733). Domain-specific, not reusable |
| `ITaskEventSink { appendEvent }` | packages/agent/agent-engine-orchestrator/src/engine/task-event-hooks.ts:4 | Pattern precedent for "a slice of a store, structurally satisfied by the real one"; observational, a failing sink is logged and never fails the task. Same semantics as spec 5.4 rule 6 |
| `TaskStore`, `AgentStore`, `DagTaskStore` etc. | agent-engine-orchestrator | Domain stores, no fit |
| `GraphBacklogStore`, `IWriteStoreHandle` | entrypoint/backlog | Domain stores, no fit |
| `HostAdapter`, `TransportAdapter` | packages/apigen/* | Unrelated "adapter" sense (HTTP/MCP transports) |
| reverse-apis `db.ts` | /Users/nix/dev/projects/reverse-apis/tools/cdp-capture/db.ts:12-44 | Schema precedent only. Uses better-sqlite3 (the thing ADR-0001 retires), has `domain/operation` + `entity_refs` the spec drops, lacks `redirects`/`failure`/`body_encoding` |

Conclusion: a real store-adapter contract exists (one), it is not in `packages/`, and no `packages/data/*` store contract exists.

## 2. Allowed ways to accept a store adapter (dependency flow)

CLAUDE.md:119 "Dependencies flow strictly downward"; entrypoints are untiered (package-naming.md:43-49). ADR-0003 CJS-only; deps approval: node-html-parser, xpath, @xmldom/xmldom only (entrypoint/stealth-browser/package.json:dependencies).
| Way | Verdict |
|---|---|
| (i) Locally defined structural interface in `src/lib/recording/types.ts`, satisfied by `StoreAdapter` by duck typing | ALLOWED. No import, no dep, no format issue. Consumer in another package passes its adapter. Direction preserved (entrypoint knows nothing of sox). Recommended |
| (ii) `import type { StoreAdapter } from '@adhd/sox-store-adapter'` | NOT allowed: still requires declaring the dependency (devDependency or dependency) = a new dep needing user approval; types leak ESM-only package into published .d.ts |
| (iii) Runtime import / `createStoreAdapter` inside stealth-browser | NOT allowed: unapproved dep + ESM-only vs ADR-0003 CJS + it would make an entrypoint own a store lifecycle (ADR-0001 D3 locking contract becomes stealth-browser's problem) |
| (iv) New `*-store-*` package | NOT allowed: ADR-0003 approves exactly one new package; package-naming.md:60-77 also requires a consumer |

Structural interface (exact members chosen as the intersection real adapters satisfy; sox `StoreAdapter.exec(sql): Promise<void>` and `executeRun(sql,args?): Promise<RunResult>` match):
```ts
export interface RecordingSqlStore {
  exec(sql: string): Promise<void>;
  executeRun(sql: string, args?: unknown[]): Promise<unknown>;
  transaction?<T>(fn: (tx: { executeRun(sql: string, args?: unknown[]): Promise<unknown> }) => Promise<T>, opts?: { mode?: 'immediate' }): Promise<T>;
}
```
`transaction?` is optional; when present the sink batches inside `BEGIN IMMEDIATE` (ADR-0001 D3 item 2); when absent it falls back to per-row `executeRun`.

## 3. Recommended design

### Contract (supersedes spec 5.3 `RecordingSink`, line 158)
```ts
export interface RecordingSink {
  /** Called once per settled exchange (state finished|failed), after redaction. May be sync or async. */
  write(rec: RecordingEnvelope): void | Promise<void>;
  /** Optional batch form; the recorder prefers it when present and >1 queued. */
  writeBatch?(recs: readonly RecordingEnvelope[]): void | Promise<void>;
  flush?(): void | Promise<void>;
  close?(): void | Promise<void>;     // idempotent
}
export interface RecordingEnvelope { recordingId: string; key: string /* `${recordingId}:${requestId}` */; seq: number; ts: string /* ISO, recorder clock */; exchange: RecordedExchange }
export interface RecorderOptions { /* existing fields, plus: */
  sink?: RecordingSink;
  recordingId?: string;                       // default: random id generated by the recorder (injectable clock/id for tests)
  redact?: (ex: RecordedExchange) => RecordedExchange;   // default: identity; applied before onExchange AND sink
  maxQueue?: number;                          // default 1000 unsent envelopes
  batchSize?: number;                         // default 50
}
export function redactHeaders(names?: readonly string[]): (ex: RecordedExchange) => RecordedExchange;  // default names: cookie, set-cookie, authorization, proxy-authorization
// NetworkRecorder gains:  flush(): Promise<void>;  close(): Promise<void>   // stop() + settled() + flush() + sink.close()
```
Semantics:
- One envelope per exchange, emitted once at settle (finished/failed). Redirect hops live inside the exchange (spec 5.4.1), so a redirect chain is one record, never N.
- Idempotency: `key = recordingId:requestId`; the SQL sink uses primary key `(recording_id, request_id)` with `INSERT OR REPLACE`, so a retry or replay never duplicates. `seq` is monotonic per recorder for ordering.
- Ordering and backpressure: the recorder serializes sink calls through one promise chain (never concurrent writes), bounded at `maxQueue`. On overflow it drops the NEWEST envelope, increments a counter, and records one failure; capture never blocks on a slow sink.
- Errors: a throwing/rejecting `write` never stops capture (spec 5.4.6 kept). Failures are collected; `close()` rejects with `CaptureError('CAPTURE_SINK_FAILED', { detail: { failed: n, dropped: m, firstCause } })`; `flush()` does the same for failures since the last flush. `logger` still receives each failure once.
- Redaction: first-class hook, identity by default so replay use (reverse-apis style, needs cookies) is unchanged; `redactHeaders()` helper ships. The redaction applies to `redirects[].request/response` headers too. See decision D1.
- No env var anywhere (ADR-0001 posture; CU13 rg check stays).

### Ships in-package (src/lib/recording/)
1. `memory-sink.ts`: `MemoryRecordingSink` (array, `records()`, idempotent by key, `close()` marks closed). Test double and default for quick scripts.
2. `sql-sink.ts`: `SqlRecordingSink(store: RecordingSqlStore, opts?: { table?: string })` + `RECORDING_DDL` (the spec's table, plus `recording_id TEXT NOT NULL`, `PRIMARY KEY(recording_id, request_id)`, no AUTOINCREMENT, `PRAGMA user_version` NOT used because user_version is per-connection-engine specific; use a `recording_schema(version)` row instead). `init()` runs DDL via `store.exec`. No `node:sqlite`.
3. `node:sqlite` sink is NOT shipped. Anyone wanting a local file wraps `DatabaseSync` in a 6-line `RecordingSqlStore` in their own code; documented as an example only (docs belong to the docs states, not this one).

### Composition
`NetworkRecorder` owns the queue; `start()` unchanged. `captureNetworkResponse(options.sink)` forwards to the recorder it creates and calls `await recorder.close()` in its `finally` (so wrapper callers get flush-on-close for free). A consumer plugging in an adhd data store: `const store = await createStoreAdapter({ dbPath }); const sink = new SqlRecordingSink(store); await sink.init(); const rec = new NetworkRecorder(session, { sink, redact: redactHeaders() });` (their code, their dependency, their lifecycle; ADR-0001 D3 retry/busy-timeout is the adapter's).

### Options compared
| | A: SqliteRecordingSink only (spec as-is) | B: interface + memory + node:sqlite reference | B': interface + memory + SQL-store sink (RECOMMENDED) | C: interface only, adapters elsewhere |
|---|---|---|---|---|
| Dependency cost | node:sqlite (already used read-only at storage/helpers.ts:1) | same | none | none |
| ADR-0001 | Risk: new single-writer writable store, no multiprocess coordination | Same risk, now optional | Compliant by construction: persistence is the consumer's adapter | Compliant |
| Unit purity | `:memory:` DatabaseSync is in-process but the repo precedent mocks node:sqlite (foundation/helpers.spec.ts:29) | Same | Fake `RecordingSqlStore` records SQL strings; zero native modules | Trivial (memory only) |
| User value | One working path, locked to a file | Local file + memory | Works with Turso store the monorepo mandates, memory for tests, and any SQL backend | Highest flexibility, nothing usable out of the box |
| Risk | ADR-0001 violation; Node-version coupling (node:sqlite >=22.5) | Two sinks to maintain | SQL dialect portability (see claims) | Needs a second package to be useful: blocked by ADR-0003 (one package) -> effectively undeliverable |
| Effort (output tokens, rough) | ~900 | ~1300 | ~1500 | ~600 |
Recommendation: B'. C is not viable under ADR-0003 (adapters would need packages). A and B keep a writable node:sqlite surface the monorepo is steering away from.

## 4. Spec changes (acceptance criteria, owned paths, executor)

Owned paths: unchanged and sufficient: `src/lib/recording/` (types.ts, errors.ts, network-recorder.ts, memory-sink.ts, sql-sink.ts, redact.ts, index.ts; `sqlite-sink.ts` is removed from the file list), `src/lib/capture/network.ts`, `src/lib/capture/index.ts`, `src/test/unit/capture/`, `src/test/unit/capture-parsers/network.spec.ts`. `package.json` NOT touched. Executor unchanged: `typescript-pro` (sonnet/high). Depends/blocks unchanged.

Spec edits: 5.1 last sentence ("separate, optional sink") stays; 5.2 row `sqlite-sink.ts` -> `memory-sink.ts`, `sql-sink.ts`, `redact.ts`; 5.3 `RecordingSink` replaced by section 3 above; 5.4.6 extended with queue/close semantics; 5.5 `CAPTURE_SINK_FAILED` detail shape defined; DDL paragraph (spec :229-232) replaced (no `user_version`, adds `recording_id`, composite PK); amendment A3 export list (spec :394): replace `SqliteRecordingSink` with `MemoryRecordingSink`, `SqlRecordingSink`, `redactHeaders`.

Replacement criteria (each test header cites `8468f7b1 AC [capture-upgrade.CUn]`):
| AC | Statement | Spec |
|---|---|---|
| CU11 (replaced) | `SqlRecordingSink` over a fake `RecordingSqlStore`: `init()` issues the DDL once; `write` issues one parametrized INSERT OR REPLACE carrying status, request_headers JSON, request_body, response_headers JSON, response_body, body_encoding, duration_ms, redirects JSON, failure JSON; double `close()` safe; uses `transaction` with mode `immediate` when provided and per-row `executeRun` when not | `sql-sink.spec.ts` |
| CU13 (amended) | hygiene: only owned paths changed by `[psm:capture-upgrade]` commits; `rg "process\\.env" src/lib/recording` empty; `rg "node:sqlite|@adhd/sox-" src/lib/recording` empty; `git diff` shows `package.json` unchanged | guard.py |
| CU14 | sink contract: exactly one envelope per settled exchange; `key === recordingId:requestId`; `seq` strictly increasing; a redirect chain (`redirect-301-200`) yields ONE envelope with `redirects.length===1`; failed exchange (`cors-failure`) is delivered with `state==='failed'` | `sink-contract.spec.ts` |
| CU15 | `MemoryRecordingSink` stores envelopes, is idempotent by key (replaying the same envelope leaves one record), exposes them in `seq` order, double `close()` safe | `memory-sink.spec.ts` |
| CU16 | redaction: `redactHeaders()` masks cookie, set-cookie, authorization, proxy-authorization (case-insensitive) in request, response, and every redirect hop; the sink and `onExchange` receive redacted data; default (no `redact`) leaves headers intact; ExtraInfo-merged Cookie (`extrainfo-before-main`) is redacted too | `redaction.spec.ts` |
| CU17 | sink failure isolation: a sink that rejects on the 2nd write does not stop capture (all exchanges still in `exchanges()`); `close()` rejects `CAPTURE_SINK_FAILED` with `detail.failed===1`; logger called once per failure | `sink-failure.spec.ts` |
| CU18 | flush/close/backpressure: `flush()` resolves only after the sink's slow (fake-timer) `write` completes; `close()` calls `sink.flush` then `sink.close` in order and `stop()`s the recorder; with `maxQueue:2` and a blocked sink the 3rd envelope is dropped, capture continues, and `close()` reports `detail.dropped===1`; `captureNetworkResponse({sink})` closes the sink in `finally` even when the capture throws `CAPTURE_TIMEOUT` | `flush-close.spec.ts` |

Unit scenarios simulating real use (all through `FakeCdpServer` + fixtures, fake timers, in-memory fakes, no sockets/process/network):
1. Record a page load with redirects: `redirect-301-200` + a `post-json-api` + `search-404` fed into a `NetworkRecorder` with `MemoryRecordingSink`; assert envelope count, order, redirect chain, 404 status.
2. Same load into `SqlRecordingSink` over a fake store; assert the SQL parameter arrays and that a replay of the same `recordingId` does not add rows (fake store keyed by PK).
3. Adapter failure mid-capture: store rejects on the 2nd `executeRun`; capture finishes, `close()` -> `CAPTURE_SINK_FAILED`.
4. Flush on close: slow sink, `close()` awaits it; second `close()` is a no-op.
5. Redaction: authenticated request with ExtraInfo Cookie; verify the sink never sees the secret while `exchanges()` (unredacted? see D1) matches the decision.
6. Backpressure: blocked sink, `maxQueue` overflow counted.
Unit-purity check: none of these import `node:sqlite`, `node:net`, `node:http`, `child_process`, `ws` (the harness's CU rg guard `.2` at spec :109 still applies).

Execution strategy delta for the weaker executor (spec 5.7): step 2 also creates `memory-sink.ts`, `sql-sink.ts`, `redact.ts`; step 3 adds the serialized queue (`Promise` chain, counters, no timers except the existing grace timer and none for batching: batch = drain whatever is queued when the chain turns); NEVER import `node:sqlite` or `@adhd/sox-*` under `src/lib/recording/`.

## 5. Decisions for the user

D1. Redaction default: identity (replay-friendly, spec-compatible; recommended) vs `redactHeaders()` ON by default for sinks (safer for persisted data; breaks reverse-apis style replay and requires an opt-out option). Also: does `exchanges()` hold redacted or raw data? Recommended: raw in memory, redacted only at the sink/onExchange boundary.
D2. Confirm dropping `node:sqlite` writable sink (recommended, ADR-0001-aligned) vs keeping it as optional reference (Option B).
D3. Confirm no dependency on `@adhd/sox-store-adapter` in stealth-browser (structural only). If the user wants a typed import, that is a new-dependency approval AND collides with ADR-0003 (ESM-only package); recommended: do not.
D4. Whether to ask for an ADR amendment/clarification on adhd ADR-0001 whether `node:sqlite` writable stores in entrypoints are in scope (the ADR names better-sqlite3 only). Not needed if D2 is accepted.

## 6. Claims needing proof
- `INSERT OR REPLACE` and a composite PRIMARY KEY behave identically on the Turso and SQLite adapters (not verified; the integration is the consumer's, but the sink DDL must run on both). Verify in a consumer e2e, not in this package's unit lane.
- `StoreAdapter.exec`/`executeRun` are structurally assignable to `RecordingSqlStore` (verified by reading types.d.ts:412 and the executeRun signature in the interface list; a `tsc` assignability check test `satisfies` against a copied signature is advised but cannot import the package).
- `AUTOINCREMENT` portability to Turso was not checked; the design avoids it.
- No `packages/data/*` package exports a persistence contract: established by an `rg` over export names, not by reading each package.
- ADR-0001's literal scope (names better-sqlite3) vs intent (D7 single-writer ban) is my reading; the owner may rule otherwise (D4).

## 7. Superset guarantee (user direction: no existing failsafe may be removed or narrowed)

Rule: with no `sink`, `redact`, `select`, or new option set, `captureNetworkResponse` must behave exactly as capture/network.ts at the pre-change commit, except the explicitly listed FIXES in 7.2. The store adapter never participates in selection, bans, debounce, or error outcomes (it is a pure observer after redaction). Evidence below is capture/network.ts line numbers (worktree) and bans.ts:113-126.

### 7.1 Existing behaviors to preserve (each pinned by a replacement AC)
| # | Existing behavior | Evidence | Risk in the spec as written | Preserved how |
|---|---|---|---|---|
| P1 | Timeout WITH captured bodies is a SUCCESS (graceful): `timeoutTimer` calls `finalize()`, which picks the best body; `matchError='timeout'` is only thrown if nothing was captured | :97-101, :87-91, :183-185 | CU10 "timeout -> CAPTURE_TIMEOUT" could be read as always throwing | Throw `CAPTURE_TIMEOUT` ONLY when zero candidates; with candidates return best. Message contains `timeout` |
| P2 | WebSocket `error` before/after bodies: `finalize()`; success if any body was captured, else throws `WebSocket error` | :167-170 | CU10 maps socket close -> SESSION_CLOSED (old code has no `close` listener, so mid-capture close waited for the timeout) | Socket error/close with candidates -> return best; without -> `CAPTURE_CONNECT_FAILED` (pre-open) / `CAPTURE_SESSION_CLOSED` (post-open); message keeps `WebSocket error` text for the error case. Earlier failure than the old wait-for-timeout is a listed fix (7.2 X4) |
| P3 | Message compatibility: errors are `Error` with messages `timeout`, `WebSocket error`, `No matching request captured`, `Ban detected: <signal>`; existing specs assert them via `toThrow(substring)` (capture-parsers/network.spec.ts:71,115,146) | :184,:198 | New typed messages ("one line naming the fix") could drop these substrings | `CaptureError extends Error`; each message CONTAINS the legacy substring (`timeout`, `WebSocket error`, `No matching request captured`, `Ban detected: ${signal}`) |
| P4 | Setup failures are logged and swallowed, not thrown: `Page.enable`, `Network.enable`, `Page.navigate` rejections go to `console.error('[capture] ...')` | :105-107 | Spec 5.5 throws NAVIGATE_FAILED | Keep the log lines. Throw NAVIGATE_FAILED only when navigate failed AND there are no candidates AND no tracked exchange is inflight; otherwise keep waiting as before (a body that still lands is still returned) |
| P5 | Body fetch only for URLs matching `urlPattern`; non-matching traffic is never body-fetched | :134-136,:139 | Recorder default `fetchBodies: true` for all filtered exchanges (default filter: all) would fetch every body (cost, latency, size) | `captureNetworkResponse` constructs the recorder with `filter` = tracked-set predicate below; recorder default for direct users stays as spec but the wrapper always narrows |
| P6 | Sticky tracking: a requestId is tracked once ANY `requestWillBeSent` url (including a later redirect hop) matches; never un-tracked | :131-136 | Per-hop filter in the recorder could un-track on a non-matching later hop | Wrapper predicate is sticky per requestId |
| P7 | Result `url` is the url of the LAST `requestWillBeSent` for that id (the final hop), falling back to `navigateUrl` when empty | :133,:152,:188 | `RecordedExchange.url` could be defined as first hop | Define `exchange.url` = latest hop url; wrapper keeps `url || navigateUrl` |
| P8 | Empty bodies count as captured: a successful `getResponseBody` with `body:''` pushes a candidate; error/missing result does not | :145-154 | Spec 5.4.7 says "finished exchanges with a body", ambiguous for `''` | Candidate predicate = body fetch succeeded (including `''`); `bodyError` excludes. `no-body-204` -> `body===''` (CU12 already) |
| P9 | Base64 bodies are utf-8 decoded into `CapturedResponse.body` | :148-150 | covered by spec 5.4.4 | keep; pinned in CU12 |
| P10 | Selection = largest `body.length`; on ties the LATER capture wins (`a.length > b.length ? a : b` returns `b` on equal) | :88 | Spec says "largest body" only | Pin tie-break: later wins. Custom `select` is additive |
| P11 | Bans run only when `banRules` is non-empty, only on the selected response, with `{url, status, body}`, rules in order, url then status then body per rule; throw `Ban detected: ${signal}`, also after a timeout-with-bodies success | :190-199; bans.ts:113-126 | Moving ban check into recorder or onto all candidates would change outcomes | Ban check stays post-selection in the wrapper, same order. Status is now real (fix X2) |
| P12 | Debounce re-arms on every landed body and only starts after the first body; `finalize` is idempotent; resolveTimer cleared | :155-157,:82-96 | covered by CU8, but settle-after-first-body semantics must stay | CU8 plus: timer starts only after first candidate; each later candidate re-arms |
| P13 | After the timeout fires, later socket messages are ignored | :119 | Recorder keeps folding events after wrapper returns | Wrapper `close()`s the recorder (unsubscribes) before returning, so late events cannot mutate the result or hit the sink after close |
| P14 | Ws is always closed on finalize | :93 | session lifecycle moves to CdpSession | Wrapper owns the `CdpSession` it created and always closes it in `finally` (success, error, ban, timeout); sessions passed in by callers are never closed (spec stop() rule) |
| P15 | Signature `captureNetworkResponse(pageWsUrl, options)`, `CaptureOptions` fields and defaults `timeoutMs` 10_000, `navigateUrl` required, old export list of capture/index.ts | :60-66; capture/index.ts:1 | covered by CU12 | keep |
| P16 | Invalid ws url: `new WebSocket` throws synchronously inside the promise executor -> rejection with the raw error | :75 | CONNECT_FAILED wrapping would change the error class | `CaptureError('CAPTURE_CONNECT_FAILED')` with `cause` = original error; message includes the original message |

### 7.2 Listed fixes (the only intentional deviations)
| # | Old behavior | New | Why it is a defect |
|---|---|---|---|
| X1 (B-017) | `extraWaitMs > 0 ? extraWaitMs : 500` so the default and explicit 0 both wait 500 ms (:157) | default 0, explicit 0 = no added wait (spec 5.1/CU8) | Divergence between the declared default (`?? 0`, :66) and the effective one. User-listed fix. Decision D5 below: mitigation for losing the 500 ms collection window |
| X2 | status hardcoded 200 (:89) so `checkStatus` bans were dead | real status | Dead ban rules |
| X3 | `requestId: ''`, `method: 'GET'` hardcoded, `responseHeaders` never set (:89) | real values | Fabricated data |
| X4 | Socket close mid-capture waited out the whole timeout (no `close` listener) | fails fast with SESSION_CLOSED if no candidates; returns best if candidates (P2) | Hang until timeout |
| X5 | `timeoutTimer` never cleared on success (:97) | cleared in `finally` | Timer leak, keeps event loop alive |
| X6 | `JSON.parse` of a malformed message threw inside the listener (:120) | malformed frames logged and skipped | Uncaught exception |
| X7 | Navigation failure only visible as a later `timeout` (P4) | typed NAVIGATE_FAILED under the P4 conditions only | Misleading error |

### 7.3 Spec text corrections implied
- CU10 is reworded (below); spec 5.4.7 candidate definition = P8; 5.4.4 `extraInfoGraceMs` (default 100 ms, only when `hasExtraInfo` and ExtraInfo missing) is additive latency per body; the wrapper must keep `timeoutMs` as the hard upper bound including grace.
- Sink behavior with no adapter: `sink` undefined means zero sink code runs (no queue, no envelope allocation beyond the recorder's own exchange).

### 7.4 Replacement and added criteria (cite `8468f7b1 AC [capture-upgrade.CUn]`)
| AC | Statement | Spec / fixture |
|---|---|---|
| CU10 (reworded) | each `CaptureErrorCode` produced ONLY on its failure path: connect fail (incl. sync invalid-url throw, with `cause`), `Page.navigate` errorText under the P4 conditions, TIMEOUT with zero candidates, NO_MATCH with `detail.urls` (<=10), `closeFromServer` with zero candidates, BAN; every message contains its legacy substring (P3) | `errors.spec.ts` |
| CU19 | graceful outcomes: timeout with one captured body returns it (no throw); ws `error` after a captured body returns it; `closeFromServer` after a captured body returns it; Page.enable/Network.enable/Page.navigate rejections are logged with the legacy `[capture] <method>:` prefix and do not throw while a body still lands | `graceful.spec.ts` |
| CU20 | selection parity: only `urlPattern`-matching requests get `Network.getResponseBody` (assert zero body calls for a non-matching id); sticky tracking across a redirect whose second hop does not match; largest-body wins and ties go to the later capture; empty-string body is a candidate, a body error is not; result `url` is the final hop url with `navigateUrl` fallback | `selection-parity.spec.ts` |
| CU21 | ban parity: rules evaluated in order url/status/body on the selected response only; no `banRules` or `[]` -> no ban evaluation; ban fires after a timeout-with-bodies success; message `Ban detected: <signal>`; status rule fires only on real status (X2) | `ban-parity.spec.ts` |
| CU22 | lifecycle parity: wrapper always closes the session it created (success, error, ban, timeout) and never a caller-supplied session; timers cleared (assert no pending fake timers after resolve, X5); events arriving after return do not reach `onExchange` or the sink | `lifecycle.spec.ts` |
| CU23 | robustness: malformed JSON frame is skipped and logged, capture still completes (X6) | `malformed-frame.spec.ts` |
| CU24 | zero-adapter equivalence: run the SAME fixture set (`doc-200`, `no-body-204`, `search-404`, `redirect-301-200`, `two-tabs-parallel`) with and without a `MemoryRecordingSink` and with `sink` unset; `CapturedResponse` fields `url/body` identical in all, `status/requestId/method/responseHeaders` equal to the real wire values; no extra CDP commands sent when `sink` is unset beyond the P5 set (assert the sent-command log) | `superset-equivalence.spec.ts` |
| CU25 | fix register: one named test per fix X1-X7 asserting the NEW behavior and referencing the old line numbers in its title, so a regression is traceable | `fixes.spec.ts` |

Owned paths unchanged (all new specs under `src/test/unit/capture/`). The rewritten `capture-parsers/network.spec.ts` must keep every existing case except the 500 ms one (replaced by CU8/X1).

### 7.5 Added decision
D5. With X1 the default debounce drops from effective 500 ms to 0, which can shorten the window in which a larger sibling body (e.g. a later XHR beating the document) is collected. Options: (a) accept as listed fix (matches spec and the user's B-017 note; recommended) with the wrapper resolving at first body only when no tracked body fetch is pending (the old `bodyFetchPending` counter at :116 was computed but never used; using it is a free quality gain), or (b) keep an effective 500 ms default and fix only the divergence in documentation. Recommended (a).

### 7.6 Claims needing proof (additions)
- Old tie-break (later wins) is derived from reading :88, not from a run; the CU20 test proves it against the OLD implementation before refactor (write the parity specs against the pre-change code first, then keep them green).
- Message-substring compatibility is verified for the existing specs only; external callers were not found (rg over src showed only the in-package wrapper and capture/index.ts:1; other consumers outside this package were not searched).
