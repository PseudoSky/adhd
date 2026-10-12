# capture-upgrade + chrome-lifecycle — architecture spec

Run dispatch-2026-10-12-ca18 · backlog plan 8468f7b1-8adc-4237-9986-21ea1e27c537 · package `@adhd/stealth-browser` at
`/Users/nix/dev/node/adhd/.worktrees/stealth-browser/entrypoint/stealth-browser/` (PKG below; paths are relative to PKG unless absolute).
Plan dir PLAN = `/Users/nix/dev/node/adhd/.worktrees/stealth-browser/docs/plan/stealth-browser/`. Nothing in the worktree was edited.
Labels: [FACT file:line] verified by reading; [HYP] hypothesis; [INFER] inference.

## 0. Answer to "was the prior reverse-apis comparison used in planning?"

NO. `rg -i 'reverse-apis|cdp-capture|cross-repo'` over PLAN returns nothing; the plan's only mention of agent-browser's capture is the port
manifest (`adhd/capture/network.ts` -> `src/lib/capture/network.ts`, default 0.80 similarity, PLAN/scripts/port-manifest.json). The port copied
every defect the comparison names (section 2).

## 1. Discovery: artifacts found

| # | Artifact | Path | Date / commit | Notes |
|---|----------|------|---------------|-------|
| A1 | THE cross-repo comparison | `/Users/nix/dev/projects/reverse-apis/docs/marketing/.catalog/cross-repo-comparison.md` (333 lines; hidden `.catalog` dotdir, which is why the dispatcher's search missed it) | 5 commits 2026-07-25: f9e11ac (initial), 5913850, cb4a996 (rewrite), 9749f49, 5939464 (HEAD of the file); sweeps d959c6a | Authored by the doc-cartographer/doc-steward pass (reverse BACKLOG.md:306 cites "doc-steward (deepseek-v4-flash)"), NOT by an architect. Has no section 4 (jumps 3 -> 5) because 9749f49 rewrote 284 lines; cb4a996 had a different section 4 ("Shared anti-detection patterns") that was dropped in the rewrite. Contains no migration spec. |
| A2 | Findings filed from it | `/Users/nix/dev/ai/scratch/agent-browser/BACKLOG.md:27-32` (B-028..B-033), commit 0f5f325 (2026-07-25); B-034..B-039 in cffee3c (2026-07-28) | | The citation "reverse-apis cross-repo-comparison.md §1/§2.1/§2.2/§2.3" resolves to A1. |
| A3 | Reverse-side counter-finding | `/Users/nix/dev/projects/reverse-apis/BACKLOG.md:272` BACKLOG-017 (CdpSession single-handler, cross-ref B-003) | b703088 | |
| A4 | Reverse design doc A1 leans on | `/Users/nix/dev/projects/reverse-apis/docs/concepts/capture-system-architecture.md` (384 lines) | 2026-07-25 | "five general-purpose techniques"; 4 of 5 are reverse-API scope |
| A5 | The earlier "architect" migration specs | `/Users/nix/dev/ai/scratch/agent-browser/docs/restructure-proposal.md`, `docs/dispatch-plan.md` (6 worktrees incl. `capture`, specifying a genericised `captureNetworkResponse`/`CapturedResponse{status, responseHeaders?}`), `docs/cdp-query-client-spec.md`; commit 59e8f06 2026-07-05; `FOLLOWUP.md` (fa179dc 2026-07-01, proposes extracting `@adhd/cdp-connection` and replacing `cdp-capture.ts`'s inline CdpSession) | | These PREDATE the comparison by 20 days, so they never saw B-028..B-033; the dispatch-plan even declares `responseHeaders?`/`status` fields that no code ever populates. The stealth-browser plan calls them "wrong on strategy" (PLAN/README.md:17) and superseded them. This is the only architect-authored spec I found; there is no spec derived from comparing the two copies. |
| A6 | Memory graph (researcher query, read-only) | node 01M4E6K2KCWXHEYY2MBVT64F7R (2026-10-08, reverse-apis backlog triage; FS-07 "CDP session event multiplexing" cites B-003, OQ-10 "port-the-pattern vs consume a shared CDP primitive"); 01M4S0DM096FFRAYPH18M7F284 (critical-path assessment); 01M4RSH5WWH4DSYWFKYJECJS7N (profile-reset investigation; latent bug backlog 7f881aa7 in `ensureChromeRunning`/`killChrome`) | | No node for "cdp-capture", "B-028", "chrome-manager v3", "stealth browser migration spec". |
| A7 | Other stores searched, nothing relevant | adhd worktree docs/ (9 hits, matching lines read: agent-final, GAP-MATRIX, D-A spec, agent-tracing, website-design: cross-repo noise about sox/backlog, none about capture), reverse `docs/plan*.md`, `FOLLOWUPS.md`, `REARCHITECTURE.md` (only ExtraInfo rationale :347/:484), `docs/plans/client-generation`, `/Users/nix/dev/ai/agent-source`, `~/.claude/jobs/396ecf1a/tmp/*.json` (backlog dumps) | | |

Conclusion: the comparison (A1) is found and, below, re-validated; the "architect specs for this migration" do not exist beyond A5, so this
document reconstructs them: capture-upgrade (section 3) and chrome-lifecycle (section 4) are RECONSTRUCTED from A1/A2 + current source.

## 2. Re-validation of each finding

Columns: agent-browser HEAD (AB) / migrated port (PORT, PKG/src/lib).

| ID | Finding | AB HEAD | PORT | Evidence |
|----|---------|---------|------|----------|
| F1 | Duplicate capture implementations | STILL VALID | PARTLY: only one copy ported (`capture/network.ts`), but agent-search's root `network-capture.ts` survives the cutover (PLAN/README.md:17 "Stays in agent-search"), so the duplicate just changes repos | AB `network-capture.ts` 278 lines vs `adhd/capture/network.ts` 209; no commit touched `adhd/capture/network.ts` after 0f5f325 (git log) |
| F2 | Request headers / postData not captured | STILL VALID | PRESENT (defect copied) | AB `network-capture.ts:135` and PORT `capture/network.ts:132` destructure `{requestId, request:{url, method}}` only; `rg postData` 0 hits in both |
| F3 | No `Network.responseReceived`; status hardcoded 200; responseHeaders never set | STILL VALID | PRESENT | AB `network-capture.ts:92`, `adhd/capture/network.ts:89`; PORT `capture/network.ts:89` (`status: 200`). Compounding defect [FACT PORT capture/network.ts:192-194]: `checkBans(rules,{url,status: matchedRequest.status,body})` always receives 200, so every status-based ban rule (403/429) is dead in capture |
| F4 | No ExtraInfo events / merge | STILL VALID | PRESENT | `rg ExtraInfo` 0 hits in AB capture files and PORT src/lib/capture |
| F5 | Capture inlines raw WebSocket instead of CdpSession | STILL VALID | PRESENT | PORT `capture/network.ts:75` `new WebSocket(pageWsUrl)`; meanwhile `capture/dom.ts:12` already takes a `CdpSession` and `cdp/session.ts:21` is multi-handler (B-003 fixed) |
| F6 | B-017 debounce default divergence | FIXED ONLY in root copy (`network-capture.ts:66,158-172`) | BUG PRESENT: `capture/network.ts:157` `extraWaitMs > 0 ? extraWaitMs : 500` | existing PORT spec `src/test/unit/capture-parsers/network.spec.ts` asserts "resolves ... after the settle delay" and so enshrines the bug |
| F7 | `adhd/capture/network.ts` is dead code (B-033) | STILL VALID (`rg 'adhd/capture/network'` no importer; root `network-capture.ts` imports only `bans.ts`) | exported from `capture/index.ts`, no internal consumer; no external consumer exists (greenfield) | |
| F8 | B-034 foreground tab leak, B-035 isolated-context leak (consumer side) | OVERTAKEN: `search-mcp-source.ts:305` uses `createIsolatedPageTarget`, `:372-381` disposes on both paths; fd627f5 "B-035 resource leak". BACKLOG.md:33-34 rows are stale (still listed). B-036..B-039 have no rows in BACKLOG.md HEAD | The lib-level hole remains [HYP, executor must confirm by reading PORT `cdp/targets.ts:200-323`]: `createIsolatedPageTarget` creates the browser context (:181-186) and can throw "not found in /json/list after 3s" (:323) without disposing it or closing its browser CdpSession | |
| F9 (new) | ExtraInfo ordering hazard in reverse's own merge | n/a | n/a | Protocol JSON (browser_protocol.json, Network.requestWillBeSentExtraInfo): "there is no guarantee whether requestWillBeSent or requestWillBeSentExtraInfo will be fired first"; responseReceivedExtraInfo "may be fired before or after responseReceived". Reverse drops early ExtraInfo (`cdp-capture.ts:773 if (!r) return`), so its "wire truth" is lossy; port must BUFFER early ExtraInfo |
| F10 (new) | Reverse comparison §2.6 says each redirect hop has its own requestId | n/a | n/a | Protocol: `requestWillBeSent.redirectResponse` + `redirectHasExtraInfo` exist ("the request which was just redirected") i.e. hops share the requestId and arrive as repeated `requestWillBeSent` [INFER from protocol; the CU7 fixture encodes it]. Reverse's `inflight.set(requestId, ...)` (`cdp-capture.ts:756`) would overwrite hop N-1, so its redirect capture is lossy [HYP] |
| F11 (new) | `responseReceivedExtraInfo.statusCode` is the correct status for cached (304) and for CORS-failed requests with no `responseReceived` | | | protocol JSON text; neither implementation uses it |

## 3. Capability comparison: reverse vs migrated package

| Capability (reverse source) | PORT today | Relevant to a browser-automation entrypoint? | Decision |
|---|---|---|---|
| request headers + postData (`cdp-capture.ts:749-762`) | no | YES (forensics, auth debugging, ban analysis) | BUILD (CU) |
| status + response headers (`:789-797`) | no (hardcoded 200) | YES (correctness; unbreaks ban rules) | BUILD |
| ExtraInfo merge, extra wins (`:764-788`) | no | YES (wire-truth cookies, sec-ch-ua) | BUILD, fixing the F9 ordering hazard |
| timing `startedAt/finishedAt` | no | YES (cheap) | BUILD |
| all responses captured, not one winner (`:818-835`) | one winner | YES, as option; default selection preserved | BUILD (`captureAll` + selector) |
| SQLite persistence `requests` table (`db.ts:26-44`) | none (storage/* is READ-ONLY on Chrome profile DBs; `storage/helpers.ts:1` already uses `node:sqlite`, node >=22.5) | JUSTIFIED as an opt-in sink: "record this session" is a standard automation need and needs zero new dependencies | BUILD minimal (`requests` only), behind a `RecordingSink` interface |
| redirect chain | lossy in reverse | YES | BUILD correctly (CU7) |
| WebSocket frames (`websocket_frames`) | no | plausible, not requested | FOLLOW-UP |
| `entity_refs` + `extract.ts` entity classification | no | NO: Tinder/Bumble-biased semantics (reverse BACKLOG-008) | NOT BUILT |
| exemplars + `exemplar-config.json` + parity | no | NO: client-id/parity pipeline for generated API adapters | NOT BUILT |
| `discover-sequences.ts` (968 lines: boot sequence, data-flow prereqs, pacing) | no | NO: probabilistic API-workflow mining | NOT BUILT |
| path NORMALIZERS / `deriveOpKey` | no | NO unless a consumer needs operation keys | FOLLOW-UP |
| tripwire / pacing / 4-gate send pipeline, `packages/auth/*` | tripwire is agent-search scope; cookies reader exists in `storage/cookies.ts` | NO | NOT BUILT |

Reverse should ultimately CONSUME this recorder instead of its inline `CdpSession` (FOLLOWUP.md item 4 "cdp-capture.ts: replace inline CdpSession"; reverse FS-07/OQ-10). That is cross-repo and file as follow-up, not built here.

## 4. Shared test-harness item: `cdp-test-harness` (prerequisite of both specs)

Constraint [FACT PLAN/contexts/_shared.md:32 `[inv:unit-purity]`]: the unit lane has no subprocess, no network, no real Chrome. A loopback
WebSocket server IS network (and `ws` is not a dependency of the package), so the "in-process fake CDP WebSocket server" is implemented as an
IN-MEMORY server behind `vi.stubGlobal('WebSocket', FakeWebSocket)` — the pattern already used by
`src/test/unit/capture-parsers/network.spec.ts:19-48` — but driven by a real protocol state machine and fixture files instead of hand-fed events.
A loopback-socket variant belongs in the e2e lane (owned by `tests-e2e`) and is follow-up FU-6.

Executor: `test-automator` (sonnet/medium). Owned paths: `src/test/support/`, `src/test/fixtures/cdp/`, `src/test/unit/support/`.

Files:
- `src/test/support/fake-cdp.ts` (create). Exports:
```ts
export interface CdpFixtureStep {
  when: { method: string; params?: Record<string, unknown> };                      // subset match on the client command
  reply?: { result?: Record<string, unknown>; error?: { code: number; message: string } };   // default result {}
  emit?: Array<{ method: string; params: Record<string, unknown>; delayMs?: number }>;       // events after the reply, in order
}
export interface CdpFixture { meta: { name: string; origin: 'recorded' | 'synthetic-protocol-conformant'; chromeVersion?: string }; steps: CdpFixtureStep[] }
export class FakeCdpServer {
  constructor(fixture: CdpFixture, opts?: { strict?: boolean });   // strict (default): unknown command => CDP error -32601 and pushed to .unexpected
  install(): () => void;                                           // vi.stubGlobal('WebSocket', ...); returns restore fn
  readonly received: Array<{ id: number; method: string; params: Record<string, unknown> }>;
  readonly unexpected: string[];
  emitNow(method: string, params: Record<string, unknown>): void;
  closeFromServer(code?: number): void;                            // simulate Chrome dying
  openCount(): number;                                             // sockets opened (leak assertions)
}
export function loadFixture(name: string): CdpFixture;             // src/test/fixtures/cdp/<name>.cdp.json
```
  FakeWebSocket implements `addEventListener('open'|'message'|'error'|'close')`, `send`, `close`; fires `open` on the next microtask; answers by `id`
  exactly as CDP does; honours `vi.useFakeTimers()` for `delayMs`.
- `src/test/fixtures/cdp/*.cdp.json` (create). HONEST LABEL: Chrome cannot run in this lane and no recorded captures of these scenarios exist on disk,
  so fixtures are `synthetic-protocol-conformant`: each event/param name is checked by a harness spec against an allow-list of Network-domain field names
  copied from `browser_protocol.json` (no network fetch in the test). A dev-only recorder that converts a real Chrome session to this JSON is follow-up FU-5;
  fixtures then upgrade to `recorded`. Required: `doc-200`, `search-404`, `rate-limit-429` (json + `retry-after`), `redirect-301-200` (two `requestWillBeSent`
  with the same requestId, second carries `redirectResponse`), `extrainfo-before-main`, `extrainfo-after-main`, `cached-304` (responseReceived 200 +
  ExtraInfo statusCode 304), `cors-failure` (loadingFailed + ExtraInfo only), `post-json-api`, `binary-base64`, `no-body-204` (getResponseBody errors),
  `two-tabs-parallel` (interleaved requestIds), `isolated-context-ok`, `isolated-context-target-missing` (Target.* for lifecycle).
- `src/test/unit/support/fake-cdp.spec.ts` (create): HC1 id correlation; HC2 strict unknown command; HC3 fake-timer ordering; HC4 fixture field-name
  allow-list; HC5 `closeFromServer` fires `close`. Each cites ticket 8468f7b1 and `[cdp-test-harness.N]`.

ACs: `[cdp-test-harness.1]` harness + fixtures exist with the exports above; `.2` `rg "node:net|node:http|child_process|from 'ws'" src/test/support` is empty;
`.3` `nx run stealth-browser:test` green including HC1-HC5; `.4` only owned paths changed.

## 5. SPEC `capture-upgrade`

Executor: `typescript-pro` (sonnet/high). Depends on: `cdp-test-harness`, `port-fixes`, `tests-unit-extract`. Blocks: `gates-first`, `prod-public-api`.
Owned paths: `src/lib/recording/` (new), `src/lib/capture/network.ts`, `src/lib/capture/index.ts`, `src/test/unit/capture/` (new),
`src/test/unit/capture-parsers/network.spec.ts` (rewritten: it currently enshrines the 500 ms default and the single-winner result).

### 5.1 Strategy
ONE capture pipeline: a `NetworkRecorder` attaches to an existing `CdpSession` (`cdp/session.ts:21`, multi-handler `on()` returns an unsubscribe) and
folds `Network.*` events into `RecordedExchange` records. `captureNetworkResponse` keeps its public name and becomes a ~40-line wrapper (connect a
`CdpSession`, attach recorder, navigate, wait, select); `new WebSocket` at `capture/network.ts:75` disappears. Persistence is a separate, optional
sink. ADR-0002 ("correct the source, never work around"): the defect is fixed in the one implementation, not wrapped. ADR-0001: no env var; every
behavior is an explicit option with a default.

### 5.2 Files
| Path | Change | Notes |
|---|---|---|
| `src/lib/recording/types.ts` | create | types in 5.3 |
| `src/lib/recording/errors.ts` | create | `CaptureError` |
| `src/lib/recording/network-recorder.ts` | create | merge engine |
| `src/lib/recording/sqlite-sink.ts` | create | `SqliteRecordingSink` on `node:sqlite` `DatabaseSync` (already used at `storage/helpers.ts:1`; engines node >=22.5 in package.json) |
| `src/lib/recording/index.ts` | create | barrel of named exports (ADR-0003: CJS-only, no exports map) |
| `src/lib/capture/network.ts` | modify | delegate to recorder; keep `CaptureOptions`, `CapturedResponse`, `captureNetworkResponse(pageWsUrl, options)`; delete inline WebSocket, `InflightRequest`, `CdpResponse` |
| `src/lib/capture/index.ts` | modify | additive re-exports |
| `src/test/unit/capture/*.spec.ts`, `src/test/unit/capture-parsers/network.spec.ts` | create/rewrite | 5.6 |
`src/lib/types.ts` (owned by mig-foundation) is NOT edited; new types live in `recording/types.ts`. No docs written (docs states own `docs/`).

### 5.3 Public types
```ts
// src/lib/recording/types.ts (new)
export type Headers = Record<string, string>;                       // CDP shape: duplicate headers joined by "\n"
export interface RecordedRequest { method: string; url: string; headers: Headers; postData?: string; hasPostData?: boolean;
  resourceType?: string; startedAt: number /* CDP MonotonicTime, s */; wallTime?: number }
export interface RecordedResponse { status: number; statusText?: string; headers: Headers; mimeType?: string; protocol?: string;
  remoteIPAddress?: string; fromCache?: boolean; encodedDataLength?: number; body?: string; bodyEncoding?: 'utf8' | 'base64'; bodyError?: string; finishedAt?: number }
export interface RedirectHop { request: RecordedRequest; response: RecordedResponse }
export interface RecordedExchange {
  requestId: string; url: string; request: RecordedRequest; response?: RecordedResponse; redirects: RedirectHop[];
  failure?: { errorText: string; canceled?: boolean; blockedReason?: string; corsErrorStatus?: unknown };
  wire: { requestExtraInfo: boolean; responseExtraInfo: boolean };
  state: 'inflight' | 'finished' | 'failed'; durationMs?: number }
export interface RecorderOptions {
  filter?: (url: string, method: string) => boolean;                // default: all
  fetchBodies?: boolean | ((ex: RecordedExchange) => boolean);      // default true for filtered exchanges
  maxBodyBytes?: number;                                             // default 5_000_000; larger => bodyError 'BODY_TOO_LARGE', body omitted
  extraInfoGraceMs?: number;                                         // wait for ExtraInfo after loadingFinished when hasExtraInfo; default 100
  sink?: RecordingSink; onExchange?: (ex: RecordedExchange) => void; logger?: (msg: string) => void }   // default logger console.error
export interface RecordingSink { write(ex: RecordedExchange): void | Promise<void>; close?(): void | Promise<void> }
export class NetworkRecorder {
  constructor(session: CdpSession, opts?: RecorderOptions);
  start(): Promise<void>;       // subscribe (session.on) THEN send Network.enable; idempotent
  stop(): void;                 // unsubscribes only its own handlers; never closes the session
  exchanges(): readonly RecordedExchange[];
  settled(): Promise<void>;     // no exchange inflight / awaiting body or ExtraInfo grace
}
// src/lib/capture/network.ts
// BEFORE
export interface CapturedResponse { requestId: string; url: string; status: number; body: string; responseHeaders?: Record<string,string> }
export interface CaptureOptions { urlPattern: RegExp; timeoutMs?: number; extraWaitMs?: number; banRules?: BanRule[]; navigateUrl: string }
// AFTER (superset: old fields keep name and meaning; `status` is now REAL)
export interface CapturedResponse { requestId: string; url: string; status: number; body: string; responseHeaders?: Headers;
  method: string; requestHeaders: Headers; postData?: string; mimeType?: string; redirects: RedirectHop[]; durationMs?: number; exchange: RecordedExchange }
export interface CaptureOptions { /* unchanged fields plus: */
  select?: (candidates: readonly RecordedExchange[]) => RecordedExchange | undefined;   // default: largest body (old behavior)
  sink?: RecordingSink }
export function captureNetworkResponse(pageWsUrl: string, options: CaptureOptions): Promise<CapturedResponse>        // signature unchanged
export function captureAllNetworkResponses(pageWsUrl: string, options: CaptureOptions): Promise<CapturedResponse[]>  // new
```
`extraWaitMs` default `0`; explicit `0` means no debounce; the `> 0 ? x : 500` expression is deleted (single place, F6).

### 5.4 Behavior (merge engine)
1. `requestWillBeSent`: new exchange, or, when it carries `redirectResponse` for a known requestId, push `{request: previous, response: fromRedirectResponse}`
   onto `redirects` and start a fresh `request`. Capture `headers`, `postData`, `hasPostData`; if `hasPostData && !postData` call `Network.getRequestPostData`
   (failure leaves it undefined, never throws).
2. `requestWillBeSentExtraInfo`: `request.headers = {...request.headers, ...extra.headers}` (EXTRA WINS, as reverse `cdp-capture.ts:777`);
   `wire.requestExtraInfo = true`. If the exchange does not exist yet, BUFFER by requestId in a bounded map (max 1000, 30 s TTL) and apply on arrival of
   the main event (fixes F9). Same for `responseReceivedExtraInfo`.
3. `responseReceived`: record `status`, `headers`, `mimeType`, `protocol`, `remoteIPAddress`, `fromCache`; remember `hasExtraInfo`.
   `responseReceivedExtraInfo`: merge headers (extra wins); its `statusCode` OVERRIDES `status` (F11: 304 for cached); if no `responseReceived` ever
   arrives, synthesize `response` from ExtraInfo (CORS case).
4. `loadingFinished`: `finishedAt`, `durationMs = (timestamp - startedAt) * 1000`; if `hasExtraInfo` and ExtraInfo is missing wait up to `extraInfoGraceMs`;
   then fetch the body with `Network.getResponseBody` if permitted. Base64 bodies are kept raw (`bodyEncoding:'base64'`); `CapturedResponse.body` is the
   utf8-decoded string (old behavior). A body error sets `bodyError`; the exchange is still `finished`.
5. `loadingFailed`: `state='failed'`, `failure` populated; the exchange is KEPT (reverse deletes it at `cdp-capture.ts:815-816`).
6. A throwing `sink.write`/`onExchange` never stops capture; it is logged and the recorder continues; `SqliteRecordingSink.close()` reports it (CU11).
7. `captureNetworkResponse` selection: candidates = finished exchanges with a body whose url matches `urlPattern`; default selector = largest body (old
   default); each landed body re-arms the `extraWaitMs` timer. `checkBans` receives the REAL status (CU4).
8. `captureAllNetworkResponses` returns every matching finished exchange ordered by `startedAt`.

### 5.5 Typed errors — `src/lib/recording/errors.ts`
```ts
export type CaptureErrorCode = 'CAPTURE_CONNECT_FAILED' | 'CAPTURE_NAVIGATE_FAILED' | 'CAPTURE_TIMEOUT' | 'CAPTURE_NO_MATCH'
  | 'CAPTURE_BAN_DETECTED' | 'CAPTURE_SESSION_CLOSED' | 'CAPTURE_SINK_FAILED';
export class CaptureError extends Error { readonly code: CaptureErrorCode; readonly cause?: unknown; readonly detail?: Record<string, unknown> }
```
Mapping: WebSocket open failure -> CONNECT_FAILED; `Page.navigate` rejection or result `errorText` -> NAVIGATE_FAILED (today these are logged and swallowed, so
the caller just waits for the timeout); nothing finished before `timeoutMs` -> TIMEOUT; traffic seen but none matched -> NO_MATCH (`detail.urls` = up to 10 seen
urls); `checkBans` signal -> BAN_DETECTED (`detail.signal`); socket closes mid-capture -> SESSION_CLOSED. One-line messages naming the fix. Relation to
`prod-errors` (future `src/errors.ts`): kept a separate class here; plan amendment A4 asks `prod-errors` to re-export it or use it as a base.

### 5.6 Acceptance criteria and tests
All in the unit lane through `FakeCdpServer` + fixtures; each spec header cites `8468f7b1` and its AC id (e.g. `8468f7b1 AC [capture-upgrade.CU4]`).
Plan ids are `[capture-upgrade.N]` (N = CU number).
| AC | Statement | Spec (under `src/test/unit/capture/`) / fixture |
|---|---|---|
| CU1 | single pipeline: `rg "new WebSocket\\(" src/lib` has hits ONLY in `cdp/session.ts`; `captureNetworkResponse` obtains transport from `CdpSession` | `single-pipeline.spec.ts` (behavioral through `doc-200`) + guard.py rg check |
| CU2 | recorder composes: a pre-existing second `session.on('Network.loadingFinished')` subscriber still fires; `stop()` removes only the recorder's handlers | `compose-session.spec.ts` |
| CU3 | request headers + postData captured; `hasPostData` path calls `Network.getRequestPostData` | `request-capture.spec.ts` / `post-json-api` |
| CU4 | real status + response headers: 404 and 429 (with `retry-after`); a status ban rule `{status:[403,429]}` now produces `CAPTURE_BAN_DETECTED` (impossible before) | `status-headers.spec.ts` / `search-404`, `rate-limit-429` |
| CU5 | ExtraInfo merge, extra wins, BOTH orders give identical merged Cookie/sec-ch-ua; `wire.requestExtraInfo` true; orphan buffer bounded (1001st entry evicts oldest) and TTL-expired | `extra-info.spec.ts` / `extrainfo-before-main`, `extrainfo-after-main` |
| CU6 | `cached-304` -> 304; `cors-failure` -> status from ExtraInfo, `state==='failed'`, `failure.errorText` | `status-override.spec.ts` |
| CU7 | redirect chain: `redirects.length===1`, `redirects[0].response.status===301`, `location` header present, final 200, same requestId | `redirects.spec.ts` / `redirect-301-200` |
| CU8 | debounce: fake timers; `extraWaitMs` unset and explicit 0 resolve with no added wait; explicit 300 pending at 299, resolved at 300 | `debounce.spec.ts` |
| CU9 | selection: default largest body; custom `select`; `captureAllNetworkResponses` on `two-tabs-parallel` returns all ordered by start | `selection.spec.ts` |
| CU10 | each `CaptureErrorCode` produced: connect fail (socket `error` before open), `Page.navigate` errorText, timeout, no-match with `detail.urls`, `closeFromServer` -> SESSION_CLOSED, ban | `errors.spec.ts` |
| CU11 | `SqliteRecordingSink` on `:memory:` round-trips an exchange (status, request_headers JSON, request_body, response_headers, response_body, duration_ms, redirects); `PRAGMA user_version=1`; double `close()` safe; failing write -> `CAPTURE_SINK_FAILED` from `close()`, capture itself continues | `sqlite-sink.spec.ts` |
| CU12 | compat: every old export of `capture/network.ts` still exported; old `CapturedResponse` fields unchanged; `no-body-204` -> `body === ''` | `compat.spec.ts` / `no-body-204` |
| CU13 | hygiene: only owned paths changed by `[psm:capture-upgrade]` commits; `rg "process\\.env" src/lib/recording` empty | guard.py |
SQLite DDL (subset of reverse `db.ts:26-44`; no `entity_refs`, no domain/operation derivation): `requests(id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL,
request_id TEXT NOT NULL, method TEXT NOT NULL, url TEXT NOT NULL, url_path TEXT NOT NULL, status INTEGER, request_headers TEXT NOT NULL, request_body TEXT,
response_headers TEXT NOT NULL, response_body TEXT, body_encoding TEXT, redirects TEXT NOT NULL, failure TEXT, duration_ms INTEGER)` + indexes on `ts`, `url_path`,
`status`. The sink takes an explicit `DatabaseSync` or file path; no default path, no env.

### 5.7 Execution strategy (for a weaker executor)
1. Read only `capture/network.ts` (209 lines), `cdp/session.ts`, the current `capture-parsers/network.spec.ts`, `capture/bans.ts:113-126`.
2. Create `recording/types.ts` verbatim from 5.3, then `errors.ts`.
3. Implement `network-recorder.ts` as a fold over events: `Map<string, Draft>`, a bounded early-ExtraInfo `Map`, a pending counter for `settled()`; only timer = `extraInfoGraceMs` (unref'd).
4. Rewrite `capture/network.ts` to delegate; delete the inline socket. NEVER leave both implementations.
5. Write specs per 5.6; the old "settle delay" case becomes CU8. Run `nx run stealth-browser:test` and `:typecheck-spec`.
6. Commit explicit paths, tag `[psm:capture-upgrade]`. NEVER edit `types.ts`, `session.ts`, `bans.ts`.

## 6. `chrome-lifecycle` ("Mig manager")

### 6.1 What it is, in plain language (inference marked)
1. [INFER] "Mig manager" is most plausibly the plan state `mig-chrome-manager` (state 7 of 34; PLAN/contexts/mig-chrome-manager.md), i.e. "migrate the Chrome manager".
2. The Chrome manager (`ChromeManager`; agent-browser `adhd/chrome-manager.ts`, docs `adhd/docs/chrome-manager.md`; port `PKG/src/lib/chrome-manager.ts`, 304 lines)
   starts ONE shared Chrome on port 9222, keeps it alive while any agent is using it, and closes it when everyone is idle, so Chrome processes do not pile up.
3. Every process that uses Chrome writes `pid:timestamp` into `/tmp/stealth-browser-heartbeat`; the idle shutdown has three safety tiers (fresh heartbeat of
   another process, open http(s) page, recent history) [FACT chrome-manager.ts header and `_doShutdown`].
4. History (git, agent-browser): af85011 (2026-07-05) auto-start + idle timer + safe shutdown; 7f3c201 (2026-07-06) shared heartbeat file for several processes;
   2026-09 hardening: fd03d56, 63019c8 (chrome://newtab no longer counts as "in use", closed bug 90ed0315), 1ac0abf (race-free launch lock, process-group kill),
   8da0dbb (deferral no longer re-stamps the heartbeat, which had made idle servers keep each other alive forever). Backlog 90ed0315 is CLOSED: those fixes exist and are in the port.
5. No document calls these "v1/v2/v3"; [INFER] the natural reading is: v1 = the 07-05/06 design, v2 = the hardened version in agent-browser today, which the plan ports
   verbatim ("behavior parity", mig-chrome-manager.4), and v3 = the REDESIGN in open backlog item 19dfb641 (single machine-wide Chrome behind sox-service-proxy,
   authoritative client counting instead of heartbeat files, self-reaping). PLAN/README.md:27 and SCOPE.md:31 push 19dfb641 out as "follow-up work on the NEW package paths".
6. [INFER, weaker alternative] the only literal "V3" in the plan is a DAG-shortening variant in PLAN/CRITICAL-PATH-ASSESSMENT.md:49 (mig-* states all depend only on
   `mig-foundation`); it changes scheduling, not Chrome behavior. Given "it should be built now", reading (5) is the one the user means.
7. What this item does: build the v3 goals now, in the new package, without the external service (decision D1), and remove the old heartbeat mechanism so there is exactly one lifecycle implementation.

### 6.2 Requirements taken from 19dfb641 (body read via `adhd-backlog backlog get`) and what already exists
| 19dfb641 AC / gap | Status in PORT | Action |
|---|---|---|
| N callers -> 1 Chrome tree | race-free already: per-port O_EXCL launch lock, `cdp/browser.ts:138-215` [FACT] | keep; add test CL1 |
| Chrome exits within grace after last caller leaves | only a per-process timer + heartbeat heuristics | lease registry + reaper (CL3-CL6) |
| `kill -9` of a caller leaves no Chrome | NOT covered: the only reaper is an in-process timer | detached watchdog + TTL/pid-reuse-safe eviction (CL8-CL9) |
| no parallel lifecycle implementation | heartbeat + `IdleShutdown` + 3 tiers | remove heartbeat and history tier; keep `IdleShutdown` timer as the in-process trigger (CL12) |
| stale-client eviction (ADR-0020 D2 gap) | none | lease TTL + pid liveness + process start time (CL3) |
| spawn circuit breaker | none | file-backed breaker (CL7) |
| bounded orphan backstop (not a 30-min watchdog) | none | watchdog polls every 5 s, grace default 30 s |
| B-035 context leak | consumer fixed (fd627f5); lib-level hole [HYP] in `createIsolatedPageTarget` | fix at the source + `openIsolatedPage` (CL10) |
| related, filed: 7f881aa7 (`ensureChromeRunning` attaches to any Chrome on :9222, `killChrome` kills the port's process group; memory node 01M4RSH5...) | open | idle reaper kills ONLY a Chrome it recorded as launched (CL9); do not close 7f881aa7 |

### 6.3 Files (executor `typescript-pro` sonnet/high; depends on `cdp-test-harness`, `port-fixes`, `tests-unit-core`; blocks `gates-first`, `prod-errors`)
Owned paths: `src/lib/lifecycle/` (new), `src/lib/chrome-manager.ts`, `src/lib/cdp/targets.ts`, `src/test/unit/lifecycle/` (new),
`src/test/unit/chrome-manager/` (rewritten; includes port-fixes' `chrome-lifecycle.spec.ts`, whose heartbeat guarantee is replaced by CL5), `src/test/unit/cdp/targets.spec.ts`.
| Path | Change |
|---|---|
| `src/lib/lifecycle/errors.ts` | create: `LifecycleError` |
| `src/lib/lifecycle/lease-store.ts` | create: `LeaseStore`, `Lease`, `LeaseInfo`, injected `FsLike`/`ProcLike` |
| `src/lib/lifecycle/reaper-core.ts` | create: pure `decideReap()` |
| `src/lib/lifecycle/watchdog.ts` | create: `spawnWatchdog()`, `WATCHDOG_SOURCE` (self-contained JS string, node builtins + global fetch only) |
| `src/lib/lifecycle/launch-breaker.ts` | create |
| `src/lib/lifecycle/isolated-page.ts` | create: `openIsolatedPage`, `withIsolatedPage` |
| `src/lib/lifecycle/index.ts` | create barrel |
| `src/lib/chrome-manager.ts` | modify (see below) |
| `src/lib/cdp/targets.ts` | modify ONLY `createIsolatedPageTarget`: after `Target.createBrowserContext` succeeds, any later failure runs `Target.disposeBrowserContext` and closes the browser `CdpSession`, then rethrows |
| tests | `src/test/unit/lifecycle/*.spec.ts`, `src/test/unit/chrome-manager/chrome-manager.spec.ts` (+ `chrome-lifecycle.spec.ts` replaced), `src/test/unit/cdp/targets.spec.ts` |
Harness additions owned by `cdp-test-harness`: `src/test/support/mem-fs.ts` (in-memory `FsLike` with O_EXCL create, rename, readdir, mode, uid), `src/test/support/fake-proc.ts`
(`pidAlive`, `procStart`, `kill(pid|-pgid, sig)` log, `spawn` recorder). ACs `[cdp-test-harness.5]` mem-fs semantics (exclusive create fails on existing, rename atomic), `.6` fake-proc.

### 6.4 Interfaces
```ts
// src/lib/lifecycle/errors.ts
export type LifecycleErrorCode = 'LEASE_DIR_INSECURE' | 'LEASE_RELEASED' | 'LAUNCH_FAILED' | 'LAUNCH_LOCK_TIMEOUT' | 'LAUNCH_CIRCUIT_OPEN'
  | 'CHROME_UNREACHABLE_AFTER_LAUNCH' | 'WATCHDOG_SPAWN_FAILED' | 'ISOLATED_CONTEXT_FAILED';
export class LifecycleError extends Error { readonly code: LifecycleErrorCode; readonly cause?: unknown; readonly detail?: { retryAfterMs?: number; port?: number; path?: string } }
// src/lib/lifecycle/lease-store.ts
export interface LeaseInfo { id: string; pid: number; procStart: string; acquiredAt: number; lastBeatAt: number; lastActivityAt: number }
export interface Lease { readonly id: string; beat(): void; activity(): void; release(): void }
export class LeaseStore {
  constructor(opts: { dir: string; leaseTtlMs?: number /* 30_000 */; fs?: FsLike; proc?: ProcLike; now?: () => number });
  acquire(): Lease;                    // creates <dir>/<pid>.<nonce>.lease with 'wx', dir mode 0700, owned by current uid; throws LEASE_DIR_INSECURE otherwise
  list(): LeaseInfo[];                 // live leases only; evicts (unlinks) dead, pid-reused (procStart mismatch) and TTL-expired leases as a side effect
  sweep(): LeaseInfo[];                // returns the evicted ones
}
// src/lib/lifecycle/reaper-core.ts
export interface ReapState { now: number; leases: LeaseInfo[]; httpPages: number; chromeOwned: boolean; idleTimeoutMs: number; lastLiveLeaseAt: number | null; graceMs: number }
export function decideReap(s: ReapState): 'keep' | 'wait' | 'reap'
//   keep: an owned-or-not Chrome with any lease whose lastActivityAt within idleTimeoutMs, or httpPages>0  (httpPages from isActiveWebTarget)
//   wait: no active lease but now - max(lastLiveLeaseAt, lastActivity) < graceMs
//   reap: chromeOwned && no active lease && httpPages===0 && grace elapsed ;  chromeOwned===false => never 'reap'
// src/chrome-manager.ts
// BEFORE
export interface ChromeManagerOptions { cdpHost?: string; idleTimeoutMs?: number; heartbeatPath?: string; checkHistory?: boolean; logger?: (msg: string) => void }
// AFTER
export interface ChromeManagerOptions { cdpHost?: string; idleTimeoutMs?: number /* 120_000, no activity => lease no longer pins */;
  shutdownGraceMs?: number /* 30_000 after the last pinning lease went away */; leaseDir?: string /* default <os.tmpdir()>/stealth-browser-leases-<port> */;
  leaseTtlMs?: number /* 30_000 */; watchdog?: boolean /* default true; explicit option, NOT an env var (ADR-0001) */; logger?: (msg: string) => void }
export interface ChromeStatus { ready: boolean; owned: boolean; leases: number; activeLeases: number; httpPages: number; watchdog: boolean; breaker: 'closed' | 'open' }
export class ChromeManager { ready(): Promise<void>; bump(): void; shutdown(): Promise<void>; shutdownIfIdle(): Promise<void>; withBrowser<T>(fn: () => Promise<T>): Promise<T>;
  readonly isReady: boolean;             // unchanged
  release(): void;                       // NEW: drop this manager's lease (idempotent) and arm the reap check; the next ready() re-acquires
  status(): Promise<ChromeStatus> }      // NEW
export function installProcessExitHooks(manager: ChromeManager): () => void   // NEW (in lifecycle/index.ts): release() on exit/SIGINT/SIGTERM/uncaughtException; returns uninstall
// src/lib/lifecycle/isolated-page.ts
export interface IsolatedPage { page: CdpSession; targetId: string; browserContextId: string; reveal(): Promise<void>; dispose(): Promise<void> }
export function openIsolatedPage(cdpHost: string, opts?: { foreground?: boolean }): Promise<IsolatedPage>      // disposes the context if the page connect fails
export function withIsolatedPage<T>(cdpHost: string, opts: { foreground?: boolean } | undefined, fn: (p: IsolatedPage) => Promise<T>): Promise<T>   // always disposes
```
`isActiveWebTarget` (`chrome-manager.ts:54`) and all unchanged method signatures remain.

### 6.5 Behavior
- `ready()`: if previously ready, re-verify reachability (existing self-healing); `LaunchBreaker.check()` -> `ensureChromeRunning({port})` (the existing O_EXCL lock stays); on a fresh launch persist
  ownership `<leaseDir>/chrome.json` = `{pid, procStart, port, profileDir, launchedAt}` (atomic rename); `hideAllWindows`; acquire (or re-acquire if evicted) the lease and start `lease.beat()` every
  `leaseTtlMs/3` on an unref'd timer; spawn the watchdog once per port (single-instance lock `<leaseDir>/watchdog.lock`, exclusive create, stale if pid dead).
- `bump()`: `lease.activity()` and re-arm the in-process `IdleShutdown`. It is the ONLY writer of `lastActivityAt`. Deferral paths in `_doShutdown` write nothing, so the mutual-deferral livelock fixed by 8da0dbb
  cannot recur by construction (CL5 replaces its regression test).
- `shutdownIfIdle()` (soft): `decideReap` over `LeaseStore.list()` + http(s) page count; reap = `closeAllPageTargets` -> `killChrome(port)` -> remove `chrome.json`. `shutdown()` (force) keeps today's behavior.
- Watchdog (detached, `stdio:'ignore'`, unref'd; `process.execPath -e WATCHDOG_SOURCE <json args>`): every 5 s sweep leases, read `/json/list` via global `fetch`, evaluate the same decision table as `decideReap`;
  on `reap` send SIGTERM to the recorded Chrome process group (negative pgid, same as `cdp/browser.ts:218-240`), SIGKILL after 3 s, delete `chrome.json` and its own lock, exit. Exits after 2 polls with Chrome unreachable.
  It only ever signals the pid in `chrome.json` whose `procStart` still matches (never an unrecorded port occupant: safety re 7f881aa7). [HYP W1] inline-source launch avoids touching `bin/` and `package.json` (owned
  by concurrent `surface-hosts`/`tracing-plugin`) and does not depend on how vite bundles `dist/`; equality with `decideReap` is enforced by a test (CL8). If the plan owner prefers a `bin/watchdog.ts` entry (W2) the item must
  also depend on `tracing-plugin` and own `bin/watchdog.ts`.
- `LaunchBreaker` (file `<tmpdir>/stealth-browser-launch-breaker-<port>.json`, atomic rename): opens after 3 failures in 60 s; stays open 30 s after the last failure; success resets; `ready()` throws `LAUNCH_CIRCUIT_OPEN`
  with `detail.retryAfterMs` without spawning. Failures = `ensureChromeRunning` rejections and "reachable never" after launch.
- Errors: raw spawn `ENOENT`/`EADDRINUSE` and launch-lock timeout are wrapped as `LAUNCH_FAILED` / `LAUNCH_LOCK_TIMEOUT` with `cause`, so `prod-errors`' `classifyError` can map them to `CHROME_NOT_FOUND`/`PORT_IN_USE`;
  messages are one line and name the fix. Watchdog spawn failure is non-fatal: logged, `status().watchdog===false`.
- Removed: `heartbeatPath`, `checkHistory`, `_writeHeartbeat`, `_readHeartbeat`, `_isOtherProcessActive`, the history tier, and the `/tmp/stealth-browser-heartbeat` constant. `HistoryClient` import leaves chrome-manager.

### 6.6 Acceptance criteria and tests (unit lane; `MemFs`, `FakeProc`, mocked `node:child_process`, `FakeCdpServer`, `vi.useFakeTimers`; no Chrome)
Plan ids `[chrome-lifecycle.CLn]`; each spec cites `8468f7b1` and the id.
| AC | Statement | Spec |
|---|---|---|
| CL1 | 8 concurrent `ready()` across 8 managers over one MemFs -> `spawn` called exactly once, all resolve (real `ensureChromeRunning` with mocked spawn/fetch/fs) | `concurrent-launch.spec.ts` |
| CL2 | lease acquire/release/list; ids distinct; dir created 0700; foreign-owned or group-writable dir -> `LEASE_DIR_INSECURE` | `lease-store.spec.ts` |
| CL3 | eviction: dead pid; pid reused (procStart mismatch); alive-but-no-beat past TTL are all evicted and counted by `sweep()`; a beating lease survives | `lease-eviction.spec.ts` |
| CL4 | reap: after the last lease is released and grace elapsed with 0 http pages -> exactly one `killChrome`, `chrome.json` removed; with an http page -> `wait`/`keep`, re-checked; `chrome://newtab/` never pins | `reap.spec.ts` |
| CL5 | livelock regression: two idle managers (no `bump`) do not change any `lastActivityAt` while deferring; Chrome is still reaped within idle+grace | `no-livelock.spec.ts` |
| CL6 | genuine activity pins: `bump()` inside `idleTimeoutMs` keeps Chrome; silence past it unpins even though the pid is alive and beating | `activity-pin.spec.ts` |
| CL7 | breaker: 3 failures -> 4th `ready()` throws `LAUNCH_CIRCUIT_OPEN` with `retryAfterMs`, `spawn` not called; closes after cool-off; success resets; state shared across managers | `launch-breaker.spec.ts` |
| CL8 | watchdog: `spawnWatchdog` spawns detached/ignored/unref'd once per port (second call no-ops via lock); spawn error -> `WATCHDOG_SPAWN_FAILED` logged, `ready()` resolves, `status().watchdog===false`; `WATCHDOG_SOURCE` evaluated under `node:vm` with fakes yields the same decisions as `decideReap` on the shared case table | `watchdog.spec.ts` |
| CL9 | `kill -9` simulation: lease never released, pid dead -> after TTL+grace the watchdog tick signals the recorded process GROUP SIGTERM then SIGKILL; with no `chrome.json` or mismatching `procStart` it signals nothing | `orphan-reap.spec.ts` |
| CL10 | isolated page: connect failure after target creation -> `Target.disposeBrowserContext` sent once and `openCount()` equals closed sockets; `createIsolatedPageTarget` target-missing fixture disposes before throwing `Error`; `withIsolatedPage` disposes when `fn` throws | `isolated-page.spec.ts`, `cdp/targets.spec.ts` |
| CL11 | each `LifecycleErrorCode` is reachable and carries `code`, `cause`/`detail`, one-line message | `errors.spec.ts` |
| CL12 | compat/no parallel impl: old public methods and `isActiveWebTarget` still exported; `rg "heartbeat|_isOtherProcessActive|checkHistory" src/lib` empty; `rg "process\\.env" src/lib/lifecycle` empty | `compat.spec.ts` + guard.py |
| CL13 | only owned paths changed by `[psm:chrome-lifecycle]` commits | guard.py |

### 6.7 Execution strategy
1. After the harness: read `chrome-manager.ts` (304), `cdp/browser.ts:130-275`, `cdp/shutdown.ts` (106), `cdp/targets.ts:150-330`, `src/test/unit/chrome-manager/chrome-manager.spec.ts`. Nothing else.
2. Order: `errors.ts` -> `lease-store.ts` (+spec) -> `reaper-core.ts` (+spec) -> `launch-breaker.ts` -> `watchdog.ts` -> `isolated-page.ts` + `targets.ts` fix -> `chrome-manager.ts` -> delete heartbeat code -> rewrite chrome-manager specs.
3. Keep `IdleShutdown` (`cdp/shutdown.ts`) untouched; ChromeManager still owns one per process as the in-process trigger.
4. NEVER add an env var toggle; NEVER kill by `lsof` port lookup in the idle/watchdog path; NEVER edit `cdp/browser.ts` (owned by mig-cdp; lock and group-kill already correct).

## 7. Plan structure (for backlog-operator / plan amender; I did not write the graph)

All items `part_of` plan 8468f7b1-8adc-4237-9986-21ea1e27c537 (component entrypoint/stealth-browser).
| Item (state id) | Executor (tier) | depends_on (blocked_by) | blocks | Owned paths (relative to PKG unless noted) |
|---|---|---|---|---|
| `cdp-test-harness` | test-automator (sonnet/medium) | `port-fixes` | `capture-upgrade`, `chrome-lifecycle` | `src/test/support/`, `src/test/fixtures/cdp/`, `src/test/unit/support/` |
| `capture-upgrade` | typescript-pro (sonnet/high) | `cdp-test-harness`, `port-fixes`, `tests-unit-extract` | `gates-first`, `prod-public-api` | `src/lib/recording/`, `src/lib/capture/network.ts`, `src/lib/capture/index.ts`, `src/test/unit/capture/`, `src/test/unit/capture-parsers/network.spec.ts` |
| `chrome-lifecycle` | typescript-pro (sonnet/high) | `cdp-test-harness`, `port-fixes`, `tests-unit-core` | `gates-first`, `prod-errors` | `src/lib/lifecycle/`, `src/lib/chrome-manager.ts`, `src/lib/cdp/targets.ts`, `src/test/unit/lifecycle/`, `src/test/unit/chrome-manager/`, `src/test/unit/cdp/targets.spec.ts` |
ACs: `[cdp-test-harness.1-6]`, `[capture-upgrade.CU1-CU13]` (written as `.1-.13` in guard.py), `[chrome-lifecycle.CL1-CL13]`; every test file cites ticket `8468f7b1` + the AC id ([inv:tests-cite]).
Cycle check [FACT dag.json]: none of `gates-first`, `prod-public-api`, `prod-errors` is an ancestor of `port-fixes`, `tests-unit-extract`, `tests-unit-core` -> acyclic.

Ownership collisions against `scripts/ownership.json` (check-disjoint.py only forbids overlap between states that are NOT ancestor/descendant of each other [FACT check-disjoint.py:1-8]):
- With ANCESTOR states (allowed, but the spec must say so): `src/lib/capture/{network,index}.ts` <- `mig-capture-parsers` (owns `src/lib/capture/`) and `port-fixes` (owns `src/lib/`);
  `src/test/unit/capture-parsers/network.spec.ts` <- `tests-unit-extract`; `src/lib/chrome-manager.ts` <- `mig-chrome-manager`; `src/lib/cdp/targets.ts` <- `mig-cdp`;
  `src/test/unit/{chrome-manager,cdp}/` <- `tests-unit-core`; `src/test/unit/chrome-manager/chrome-lifecycle.spec.ts` <- `port-fixes`.
- With CONCURRENT states: none. Checked against `surface-api` (`src/api.ts`, `src/index.ts`), `surface-hosts` (`src/server.ts`, `src/cli.ts`, `bin/`, `package.json`), `tracing-plugin`, `tests-unit-data` (`src/test/unit/domains-storage|queries`), `tests-unit-surface`, `tests-e2e`, `mig-docs` (`docs/reference/`), `prod-errors` (`src/errors.ts`), `prod-examples`, `prod-publish-readiness`. No docs are written by these items.

Plan amendments REQUIRED (for the plan amender; these are outside the items' owned paths):
- A1 `scripts/port-manifest.json`: entries `adhd/capture/network.ts` and `adhd/chrome-manager.ts` need `"min_similarity": 0` (as the docs entries have). Otherwise `guard.py mig-capture-parsers` / `mig-chrome-manager` (guard.py:249-270) go red if anyone re-runs them. The gates (`gates-first`/`gates-rerun`) run nx targets, not per-state guards (guard.py:1040-1087), so they stay green either way.
- A2 `guard.py:625-627` (`mig-chrome-manager.4` asserts `/tmp/stealth-browser-heartbeat`), `guard.py:1504` `DEFAULTS` and the docs AC at `guard.py:2014` (lists `/tmp/stealth-browser-heartbeat` verbatim) must be changed to the lease-dir default or marked superseded by `chrome-lifecycle`.
- A3 `prod-public-api`: add an AC that `src/index.ts` exports `NetworkRecorder`, `SqliteRecordingSink`, `CaptureError`, `LifecycleError`, `openIsolatedPage`, `withIsolatedPage`, `installProcessExitHooks`, `captureAllNetworkResponses`.
- A4 `prod-errors`: reconcile `CaptureError`/`LifecycleError` with `StealthBrowserError` (re-export or base class) and map `LAUNCH_FAILED.cause` ENOENT/EADDRINUSE to `CHROME_NOT_FOUND`/`PORT_IN_USE`.
- A5 `agent-search-cutover`: root `network-capture.ts` must delegate to `captureNetworkResponse` (`select` option for the `#rso` preference), `search-mcp-source.ts` must call `release()`/`installProcessExitHooks`, drop the `checkHistory:false` argument; on completion resolve B-028..B-033 and the stale B-034/B-035 rows in `agent-browser/BACKLOG.md`; re-cite 19dfb641 to the new package paths and resolve it when `chrome-lifecycle` is verified.
- A6 Standard plan scaffolding for three new states: `dag.json` nodes with `mutates` equal to ownership, `ownership.json`, `contexts/<slug>.md`, `criteria.json`, guard.py checks for the new ids (the item bodies above are the content).

## 8. Follow-ups to file, NOT built
| # | Item | Reason |
|---|---|---|
| FU-1 | reverse-apis `cdp-capture.ts` consumes `@adhd/stealth-browser` recorder instead of its inline CdpSession (reverse BACKLOG-017, FS-07/OQ-10; agent-browser FOLLOWUP.md item 4) | cross-repo, owned by reverse-apis |
| FU-2 | WebSocket frame recording (reverse `websocket_frames`) | no consumer asked; extend `RecordedExchange` family later |
| FU-3 | path normalization / operation-key derivation (`NORMALIZERS`, `deriveOpKey`) | reverse-API-specific; only if a consumer needs operation keys |
| FU-4 | `entity_refs`/`extract.ts` entity graph, exemplars + parity, `discover-sequences.ts`, tripwire/pacing 4-gate, `packages/auth/*` | reverse-API scope (client-id mapping, Tinder/Bumble bias per reverse BACKLOG-008), not a browser-automation concern |
| FU-5 | dev-only recorder that writes real Chrome sessions into `*.cdp.json`, upgrading fixtures from synthetic to recorded | needs real Chrome; belongs to the e2e lane |
| FU-6 | loopback RFC6455 fake CDP server in the e2e lane | violates unit purity; e2e already owns real-Chrome |
| FU-7 | agent-browser BACKLOG hygiene: B-034/B-035 rows stale (fixed in fd627f5, `search-mcp-source.ts:305,372-381`), B-036..B-039 absent | housekeeping via backlog-operator |
| FU-8 | 7f881aa7 (`ensureChromeRunning` attaches to any Chrome on the port without profile check; `killChrome` fallback kills the port occupant) | only partially mitigated here (idle path kills owned Chrome only) |
| FU-9 | `ServiceProxyLeaseStore` implementing the `LeaseStore` seam on sox-service-proxy if D1 flips | decision-gated |

## 9. Decisions needed from the user
- D1 Lifecycle backend. RECOMMENDED: in-package lease registry + watchdog (this spec). ALTERNATIVE: `@adhd/sox-service-proxy` (0.5.0 published on npm [FACT `npm view`]; has `require` condition; depends on `workspace:^` `@adhd/sox-listen-guard`; per its package.json it is a stdio<->UDS MCP front-shim lib, so Chrome would run behind a new long-lived host process and every client would dial a UDS: a new process role, a cross-repo dependency, and it inherits ADR-0020's open gaps (no stale-client eviction, no breaker, 30-minute orphan bound) that this spec closes). Not "one new package", but a new bin entry and dependency: needs your explicit go.
- D2 Approve waiving guards A1/A2 (retire heartbeat path and similarity guard for `capture/network.ts` and `chrome-manager.ts`).
- D3 Watchdog launch mode W1 (inline source, recommended) vs W2 (`bin/watchdog.ts`, serialises behind `tracing-plugin`).
- D4 Accept dropping the history-recency tier and `checkHistory` option (agent-search already ran with `checkHistory:false` per backlog 90ed0315 body).
- D5 Accept that the idle reaper only closes a Chrome this package recorded as launched (an externally started Chrome on 9222 is never auto-killed; explicit `shutdown()` keeps its current behavior).
