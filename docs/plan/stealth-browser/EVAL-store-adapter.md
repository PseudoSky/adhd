# capture-upgrade store-adapter sink: re-evaluation v2 (sox-store-adapter allowed as a direct dependency)

Dispatch dispatch-2026-10-12-ca18, plan 8468f7b1-8adc-4237-9986-21ea1e27c537. Read-only on repos; probes ran in scratchpad/probe-esm (symlink to the installed package). Supersedes store-adapter-evaluation.md sections 0, 2, 3 (design), 4 (CU11/CU13) and the legacy-parity parts of section 7. Everything else in v1 (contract semantics, P/X tables) stays as FEATURE input.

## 0. Verdict

Recommend B'' (hybrid): ship the sink contract + MemoryRecordingSink + a `StoreRecordingSink` whose store parameter is `Pick<StoreAdapter,'exec'|'executeRun'|'transaction'>` (type-only import from @adhd/sox-store-adapter, so signature drift is a compile error, not a duplicated interface) + `openStoreRecordingSink(opts)` as the default concrete adapter, using a LAZY `await import('@adhd/sox-store-adapter')` inside the async factory. Add @adhd/sox-store-adapter ^0.13.3 to dependencies (same range as entrypoint/backlog/package.json:24 and the root override at package.json:162). No env var, no toggle. The v1 premises (approval needed, ADR-0003 conflict) are dropped; both were wrong on the ADR text (section 1.4).

## 1. Module format, proven

Environment: node v24.11.1 (only node installed: ~/.nvm/versions/node/v24.11.1; older Node could not be run, see claims). Probe dir type=commonjs, `node_modules/@adhd/sox-store-adapter` symlinked to /Users/nix/dev/node/adhd/node_modules/@adhd/sox-store-adapter.

### 1.1 Package facts (read from package.json)
version 0.13.3, `"type":"module"`, `exports["."] = {types, default:"./dist/index.js"}` (no `require` condition), `engines.node ">=20"`, deps `@tursodatabase/database ^0.8.1`, `@adhd/sox-telemetry ^0.4.1`, optional better-sqlite3.

### 1.2 Probes (all exit 0 unless stated)
| Probe | Result |
|---|---|
| `node -e "require('@adhd/sox-store-adapter')"` | OK, `createStoreAdapter` is a function, 256 exports, no warning printed (exit 0) |
| `node -e "import('@adhd/sox-store-adapter')"` | OK, same 256 exports |
| `node --no-experimental-require-module -e "require(...)"` | throws at cjs/loader (the ERR_REQUIRE_ESM path; first 4 lines only captured) |
| rg for top-level await in dist/*.js (`^await`, `= await` at col 0) | no match (exit 0 from rg wrapper, empty output); corroborated because require(esm) succeeded, and Node throws ERR_REQUIRE_ASYNC_MODULE for any TLA in the graph (Node docs). That covers the transitively loaded graph incl. @tursodatabase/database and @adhd/sox-telemetry at 0.13.3 |
| Functional: `await import(...)`, `createStoreAdapter({dbPath})`, `exec('create table')`, `executeRun('insert...',[1])` | works: `{rowsAffected:1,lastInsertRowid:1}`; capabilities `multiprocess-wal`, `multiprocessWrite:true`. Prints a sox-telemetry warning (no initTelemetry call, records dropped): harmless for a library, noted |
| tsc 6.0.3, `--module commonjs --moduleResolution bundler`, `import type` + dynamic import | exit 0; tsc rewrites `import()` to `Promise.resolve().then(() => require(...))` |
| tsc `--module nodenext --moduleResolution nodenext` | exit 0; `import()` preserved verbatim |
| rollup 4.63.3 `format:'cjs'`, package marked external, source has `await import('@adhd/sox-store-adapter')` | output keeps a real `import()` (no require rewrite). stealth-browser builds with vite/rollup (vite.config.ts), not tsc, so dist/index.js keeps `import()` |

### 1.3 Node versions (Node docs, modules.html "Loading ECMAScript modules using require()", fetched)
- require(esm) added v22.0.0 / v20.17.0 behind `--experimental-require-module`.
- Unflagged: v22.12.0, v20.19.0, v23.0.0.
- Experimental warning removed: v22.13.0, v23.5.0, v20.19.0. No longer experimental: v24.15.0.
- TLA in graph => ERR_REQUIRE_ASYNC_MODULE.
Consequence at stealth-browser's declared floor (`engines node >=22.5`, package.json:11-12): Node 22.5.0 - 22.11.x has NO unflagged require(esm). A static `import`/`require` of the adapter in the CJS dist would throw ERR_REQUIRE_ESM at LOAD time on those versions, breaking every consumer of stealth-browser, not only sink users. 22.12+ and 24.x work.

### 1.4 Bridges and ADR fit
| Bridge | Works on 22.5-22.11 | Notes |
|---|---|---|
| (1) lazy `await import()` inside `openStoreRecordingSink` | yes (import() of ESM from CJS is supported on all supported Node) | dist loads without touching the adapter; failure is local to the factory. RECOMMENDED |
| (2) `import type { StoreAdapter }` only | n/a, erased at emit | needed for the Pick<> typing. In d.ts consumers resolve types via package.json top-level `types` (works with node10/bundler; under nodenext CJS, TS may need the ESM d.ts allowance, unverified, see claims) |
| (3) static import, bundler-inlined | yes but bad | vite.config.ts externals are only `/^node:/` (line ~40), so rollup would INLINE the adapter into dist, dragging in native @tursodatabase binding resolution. Must externalize: use `externalizeRealDeps(__dirname)` exactly as backlog/vite.config.ts:10,108 does (file-owner note in section 3) |
| (4) static `require`/`import` in CJS dist | no | the pattern entrypoint/backlog uses (graph-backlog-store.ts:14); its exposure is the Node <22.12 floor, which backlog accepts; stealth-browser need not |

ADR-0003 (docs/decisions/0003-...md): D1 governs what @adhd/* PUBLISHES (CJS, no exports map, type unset); it is not violated by depending on an ESM package. The only dependency obligation is D5 (:50-54): externalize a dep only if its root specifier resolves under ESM `import` and exposes the used named exports. Probe shows `import()` resolves root and exposes `createStoreAdapter`: satisfied. ADR-0003 context (:67) itself records that require(esm) works from 22.12 and calls the older exposure "compatibility debt"; the lazy import() design takes zero of that debt. ADR-0003 D3 (:36-43, verify-dist-load executes the entry): with lazy import() the entry executes on every Node; with a static import it would fail on 22.5-22.11. This is the argument for bridge (1) over (4).
ADR-0001: D1 (:37-47) "New stores MUST start on the adapter; better-sqlite3-as-store is retired"; D6 (:89-91) accepts a pinned dependency on the published adapter ("same shape backlog already carries"); D7 bans single-writer postures. Implied for a new store: the sink's persistence goes THROUGH the adapter and nothing else, a locally written node:sqlite writer (v1 Option A/B) is out, and the adapter handles busy-timeout/retry/immediate (D3 contract) - the sink must use `transaction(..., {mode:'immediate'})` for batches rather than hand-rolling BEGIN, and must not disable multiprocess. Pin ^0.13.3 (D6). D5's two-process acceptance gate belongs to stores that own a schema migrated from legacy; a pure append sink inherits the adapter's gate, but see decision D2.

## 2. Compare on merit

| Criterion | A' adapter-backed sink, lazy factory only | B'' contract + MemoryRecordingSink + StoreRecordingSink(Pick<StoreAdapter>) + lazy factory | C'' interface only |
|---|---|---|---|
| ADR-0001 | fit | fit (store path is adapter-only) | fit but delivers no store; "new store must start on the adapter" is unmet by anything shipped |
| ADR-0003 | fit with bridge (1) | fit with bridge (1) | fit |
| User value | Turso-backed store the backlog/graph tooling already queries (same WAL multiprocess engine; rows reachable by anyone opening the db file with createStoreAdapter) | same + in-memory sink for dev/tests/quick scripts; sink usable with a caller-owned adapter (shared connection, custom dbPath) | none out of the box; blocked as v1 noted (ADR-0003 one-package budget means adapters have no home) |
| Unit purity | one seam: loader must be injectable | store seam is a plain object; `Pick<>` fake is 3 methods; loader seam only for the factory | trivial |
| Effort (output tokens, rough) | ~1100 | ~1500 | ~600 |
| Risk | factory is the only path, hard to test sink without the loader | slightly more surface (2 sinks), memory sink doubles as the reference contract implementation | none, no value |
Why a separate `Pick<>` store param and not only the factory: the sink must be unit-testable against a fake store without importing the 256-export native-backed package, and callers who already hold a StoreAdapter (backlog-style apps) can inject it. This is not a toggle: it is the same code path the factory uses.
Recommendation: B''.

### 2.1 Design deltas from v1 section 3
- `RecordingSqlStore` (hand-written structural) is deleted; replaced by `export type RecordingStore = Pick<StoreAdapter, 'exec' | 'executeRun' | 'transaction'>` with `import type { StoreAdapter } from '@adhd/sox-store-adapter'`. `transaction` becomes required (adapter always has it); the per-row fallback branch is removed (no longer needed: greenfield).
- `openStoreRecordingSink(opts: { dbPath: string; table?: string; loadAdapter?: () => Promise<Pick<typeof import('@adhd/sox-store-adapter'),'createStoreAdapter'>> }): Promise<StoreRecordingSink>`. Default `loadAdapter = () => import('@adhd/sox-store-adapter')`. It opens, runs DDL, returns a sink whose `close()` closes the adapter it opened (owns it) vs an injected store it does not close (`ownsStore` internal flag, no option). Failure to load => `CaptureError('CAPTURE_SINK_UNAVAILABLE', { cause })` with a one-line message naming the fix; failure to open => same code, cause kept.
- Schema/DDL, envelope, key, queue, redaction, close/flush semantics: v1 section 3, unchanged. Schema versioning via a `recording_schema(version)` row (not PRAGMA user_version), AUTOINCREMENT avoided; `INSERT OR REPLACE` on composite PK is retained but its Turso behaviour is an unverified claim (section 5).
- Sink telemetry noise (sox-telemetry "no initTelemetry" warning) is out of scope; note to user in decisions.

## 3. Ownership and execution

Owned paths for the capture-upgrade state: src/lib/recording/{types,errors,network-recorder,memory-sink,store-sink,open-store-sink,redact,index}.ts, src/lib/capture/{network,index}.ts, src/test/unit/capture/**, src/test/unit/capture-parsers/network.spec.ts (unchanged from v1 except sql-sink.ts renamed store-sink.ts and open-store-sink.ts added).
Files this state needs but does not own (owned by another state; the plan owner must name which, I cannot see the plan): `package.json` (add `"@adhd/sox-store-adapter": "^0.13.3"` to dependencies; keep range identical to backlog/root override) and `vite.config.ts` (rollupOptions.external: add `externalizeRealDeps(__dirname)` alongside `/^node:/`, importing `../../tools/vite-plugins/externalize.mjs`). Also pnpm-lock via the workspace install. Executor: typescript-pro (sonnet/high) for src; the owning state's executor for package.json/vite.config.ts. Ordering: dependency+vite state must merge BEFORE capture-upgrade's gate runs the build assertion (CU27). Executor traps for the weak model: NEVER `import { createStoreAdapter }` statically; NEVER `require`; only `import type` at top level; the dynamic import goes through `loadAdapter`.

## 4. Replacement acceptance criteria (cite as `8468f7b1 AC [capture-upgrade.CUn]` in test headers)

REMOVED (existed only for rejected premises): the `rg "@adhd/sox-" src/lib/recording` empty check; "package.json unchanged"; `node:sqlite` absence is KEPT only as hygiene (below); legacy message-substring parity (P3) and the whole old-error-message pinning; "zero-adapter equivalence as legacy parity" (old CU24 framing); CU19's legacy `[capture] <method>:` log-prefix assertion (the graceful OUTCOME is kept, the prefix is not). Legacy-test preservation clause in v1 section 7.4 last paragraph removed: the rewritten network.spec.ts may drop or change any case.

| AC | Statement | Test file |
|---|---|---|
| CU11 (replaced) | `StoreRecordingSink` over a `Pick<StoreAdapter,'exec'|'executeRun'|'transaction'>` fake: `init()` issues the DDL once and writes the schema row; a batch runs inside ONE `transaction(fn,{mode:'immediate'})`; each envelope is one parametrized INSERT OR REPLACE carrying status, request_headers, request_body, response_headers, response_body, body_encoding, duration_ms, redirects, failure; replaying a key leaves one row (fake keyed by PK); double `close()` safe; an injected store is NOT closed by the sink | store-sink.spec.ts |
| CU13 (amended) | hygiene: `rg "node:sqlite|process\\.env" src/lib/recording` empty; the only top-level reference to @adhd/sox-store-adapter in src/lib/recording is `import type` (rg for `^import (?!type)` / `require(` of the package empty); commits touch owned paths + the declared package.json/vite.config.ts edits only | guard.py |
| CU14 | sink contract: one envelope per settled exchange; `key === recordingId:requestId`; `seq` strictly increasing; redirect-301-200 -> ONE envelope with `redirects.length===1`; cors-failure -> `state==='failed'` | sink-contract.spec.ts |
| CU15 | MemoryRecordingSink: stores envelopes, idempotent by key, `seq` order, double `close()` safe | memory-sink.spec.ts |
| CU16 | redaction: `redactHeaders()` masks cookie/set-cookie/authorization/proxy-authorization case-insensitively in request, response and every redirect hop; sink and `onExchange` get redacted data; no `redact` leaves headers intact; ExtraInfo-merged Cookie redacted (extrainfo-before-main) | redaction.spec.ts |
| CU17 | sink failure isolation: sink rejecting on 2nd write does not stop capture; `close()` rejects `CAPTURE_SINK_FAILED` with `detail.failed===1`; logger called once per failure | sink-failure.spec.ts |
| CU18 | flush/close/backpressure as v1 (flush awaits slow write; close order flush->sink.close->stop; maxQueue 2 drops 3rd with `detail.dropped===1`; `captureNetworkResponse({sink})` closes sink in finally even on CAPTURE_TIMEOUT) | flush-close.spec.ts |
| CU26 (new) | `openStoreRecordingSink` with a fake `loadAdapter` returning a fake `createStoreAdapter`: calls it with `{dbPath}` once, runs DDL, returns a working sink; the sink's `close()` closes the fake adapter exactly once; a `loadAdapter` that rejects (ERR_MODULE_NOT_FOUND) => `CaptureError('CAPTURE_SINK_UNAVAILABLE')` with `cause`; a fake `createStoreAdapter` that rejects => same code, cause kept; the factory never calls the real package (assert via injected loader only; no vi.mock of the package needed) | open-store-sink.spec.ts |
| CU27 (new) | module-format guard (unit lane, reads the build output only if present, else builds nothing): after `vite build`, dist/index.js (cjs) contains no `require('@adhd/sox-store-adapter')` and no inlined adapter code, and contains `import('@adhd/sox-store-adapter')` exactly in the factory; `node -e "require('./dist/index.js')"` succeeds without loading the adapter (ADR-0003 D3, valid on every Node >=22.5) | src/test/unit/build-format.spec.ts (build step is in the e2e/verify lane per ADR-0009; the unit spec asserts on `src` text: only `import type` at top-level and exactly one `import(` call site) |
| CU10 (reworded, feature-level) | each `CaptureErrorCode` is produced only on its failure path: CONNECT_FAILED (incl. sync invalid-url throw, `cause` kept), NAVIGATE_FAILED when navigate failed and no candidate and nothing inflight, TIMEOUT with zero candidates, NO_MATCH with `detail.urls` (<=10), SESSION_CLOSED with zero candidates, BAN, SINK_FAILED, SINK_UNAVAILABLE; no message-substring requirement | errors.spec.ts |
| CU19 (feature-level) | graceful outcomes: timeout with one captured body returns it; socket error after a captured body returns it; session close after a captured body returns it; Page.enable/Network.enable/Page.navigate rejections are logged and do not throw while a body still lands | graceful.spec.ts |
| CU20-CU23, CU25 | feature-level behaviors kept (P5-P16, X1-X7 as FEATURES: urlPattern-only body fetch, sticky tracking, largest-body/later-wins, empty-string candidate, final-hop url, ordered ban eval on selected response, session ownership/close, timers cleared, malformed-frame skip). Drop any wording that says "parity with old"; assert the behavior directly | as v1 |
| CU24 (reworded) | sink-independence: the SAME fixture set (doc-200, no-body-204, search-404, redirect-301-200, two-tabs-parallel) with `sink` unset, with MemoryRecordingSink, and with StoreRecordingSink(fake) yields identical `CapturedResponse`; with `sink` unset no sink queue/envelope allocation happens and no extra CDP commands are sent beyond the urlPattern body fetches | superset-equivalence.spec.ts (rename sink-independence.spec.ts) |

Unit scenarios (all FakeCdpServer + fixtures + fakes, no sockets/process/network): (1) page load with redirects into MemoryRecordingSink; (2) same into StoreRecordingSink over the PK-keyed fake, assert SQL arg arrays and replay idempotence; (3) store rejects on 2nd executeRun inside the transaction, capture finishes, close() => CAPTURE_SINK_FAILED; (4) factory with injected loader: happy path, unavailable, open-failure; (5) redaction before sink; (6) backpressure; (7) double close. Faking StoreAdapter: hand-written 3-method fake typed `satisfies RecordingStore`; do NOT use the package's MockAdapter (regex SQL parser; unproven for INSERT OR REPLACE / composite PK, and importing it loads the 256-export native-backed package into the unit lane).

## 5. Claims needing proof
- Node 22.5-22.11 behaviour is from the Node docs, not run: only v24.11.1 is installed. A CI matrix leg on 22.11 would prove CU27's premise.
- TLA absence is proven for the graph that loaded on 24.11.1 (require succeeded). Not re-proven for future adapter versions (hence pin ^0.13.3 and the CU27 guard).
- `import type` from the ESM-only package under `module:nodenext` CJS emit of the published d.ts for consumers: tsc probe covered a standalone file (exit 0 under commonjs/bundler and nodenext), not stealth-browser's vite-plugin-dts output or a downstream consumer.
- Rollup external dynamic import preserved: proven with rollup 4.63.3 directly, not through the project's vite config (externalizeRealDeps wiring is unverified there).
- INSERT OR REPLACE with composite PK and the DDL on Turso: only a trivial table/insert ran; the sink's DDL needs a consumer e2e (e2e lane).
- Backlog/graph tooling "can query the rows" is true at the file level (same adapter, same WAL engine); no cross-tool query was run, and recording rows are not in the backlog graph schema.
- sox-telemetry no-init warning appears on first adapter use in a process that never called initTelemetry; effect on stealth-browser consumers not assessed.

## 6. Decisions needed from the user (real ones only)
D1. Dependency weight: `dependencies` (recommended: simplest, types always resolvable, ADR-0001 D6 shape; costs the @tursodatabase native install for every stealth-browser consumer, previously 3 light deps) vs optional peerDependency (lighter install, sink factory throws CAPTURE_SINK_UNAVAILABLE when absent; adds a state where types are missing for non-installers). Recommend `dependencies`.
D2. ADR-0001 D5 acceptance gate: does a pure append sink need its own two-process proof (real two-connection negative control) or inherit the adapter's? Recommend inherit, plus the consumer e2e from section 5; user ruling needed only if they read D5 as per-store.
D3. Redaction default (v1 D1) and raw-vs-redacted `exchanges()`: unchanged, recommend identity default, raw in memory, redacted at the sink/onExchange boundary.
D4. Debounce default 0 (v1 D5): unchanged, recommend accept.
(v1 D2, D3, D4 are closed by this evaluation: node:sqlite sink dropped, adapter dependency allowed, no ADR clarification needed.)
