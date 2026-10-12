# Deferred work - @adhd/stealth-browser (plan 8468f7b1-8adc-4237-9986-21ea1e27c537)

Items the plan deliberately does not build. Each has an owner decision recorded in `PRODUCTIZATION-CATALOG.md` or the architect spec for capture and lifecycle.

## Product review (medium and low priority, out-of-scope candidates)

| Id | Item | Why deferred |
|---|---|---|
| O1 | Doctor/preflight verb (7th verb) | Changes the six-verb scope. |
| O2 | Change default port/profile away from 9222 and Chrome-CDP | Needs its own migration epic with agent-search. |
| O3 | Linux/Windows support for profile paths, history, cookies | Cross-platform epic and CI needed; the package states macOS-first support. |
| O4 | Headless mode and profile-isolation option on `launchChrome` | A feature, not a migration. |
| O5 | Extract search-specific parsers/capture (Google SERP) into agent-search | Needs a second package or cutover work. |
| P11 | Post-cutover learnings review | Backlog follow-up (answers whether the cutover regressed the live MCP). |
| O7 | Publishing to npm | The dispatcher's decision at `merge-readiness`. |

## Capture and lifecycle spec follow-ups (not built)

| Id | Item | Why deferred |
|---|---|---|
| FU-1 | reverse-apis `cdp-capture.ts` consumes the `@adhd/stealth-browser` recorder instead of its inline CdpSession | Cross-repo, owned by reverse-apis. |
| FU-2 | WebSocket frame recording | No consumer asked; extend `RecordedExchange` later. |
| FU-3 | Path normalisation and operation-key derivation | Reverse-API specific. |
| FU-4 | Entity graph, exemplars, sequence discovery, tripwire/pacing four-gate, auth packages | Reverse-API scope, not a browser-automation concern. |
| FU-5 | Dev-only recorder writing real Chrome sessions into `*.cdp.json` (fixtures become `recorded`) | Needs a real Chrome; there is no live-Chrome lane. |
| FU-6 | Loopback RFC 6455 fake CDP server | Violates unit purity. |
| FU-7 | agent-browser BACKLOG hygiene: B-034/B-035 rows stale, B-036..B-039 absent | Folded into `agent-search-cutover.9` via the backlog graph; B-036..B-039 are defined in `evidence/lifecycle-definitions.md` (chrome-lifecycle.25). |
| FU-8 | `7f881aa7` (attach to any Chrome on the port without a profile check; port-occupant kill fallback) | Only partly mitigated here. |
| FU-9 | `ServiceProxyPresenceStore` implementing the `PresenceStore` seam on sox-service-proxy (phase 2: held dials, kernel-closed presence) | Needs upstream tickets U1 and U3; the seam and its contract suite (chrome-lifecycle.22) are built now. |
| FU-10 | Remove the read-only reader of the old agent-browser heartbeat file (`legacyHeartbeatPath`, chrome-lifecycle.24) | Needed only until the cutover is relinked; remove after `agent-search-relink`. |
| FU-11 | Consumer proof of the `StoreRecordingSink` DDL and INSERT OR REPLACE on the real Turso-backed adapter, plus a CI leg on Node 22.5-22.11 | No lane in this plan runs the real adapter or older Node versions. |
| FU-12 | Real two-process proof that the detached reaper loads `dist/` through `lifecycle.runChromeReaper` and that `ensureBackend` keeps it single-instance | Needs a lane with processes and sockets; the unit lane mocks `ensureBackend`. |
| FU-13 | Upstream tickets in the owned `@adhd/sox-service-proxy` repo: U1 connection id plus `onClientConnect` / `onClientDisconnect` on `serveBackend`; U2 housekeeping (close stale 72d980e5, README says node builtins only though it depends on listen-guard, the 0.5.0 tarball `dist/package.json` says 0.4.4, `ensureBackend` lock staleness uses bare `kill(pid, 0)` so a recycled pid keeps a lock alive until the 30 s TTL); U3 dial recovery after a backend restart (3d5da8f2, already filed) | Not filed by this plan; U1 and U3 gate FU-9. |
| FU-14 | Backlog 19dfb641 acceptance criterion 4 amendment (OD-9 in `EVALUATIONS.md`) | A backlog edit for the dispatcher; this plan does not edit the backlog. |

## Housekeeping

- The scratch repo `INDEX.md` entry for agent-browser is not updated by the cutover: the file carries other agents' uncommitted edits, so staging it would sweep their work into a commit. Update it when the tree is clean.
- The generated `e2e` nx target and `vitest.e2e.config.ts` (sibling parity, `entrypoint-parity.1,3`) stay in place and are unused: there is no live-Chrome lane.
- Fixtures under `src/test/fixtures/cdp/` are labelled `synthetic-protocol-conformant` until FU-5 replaces them.
- Design decisions: the capture sink (store adapter, option B'') and the lifecycle backbone (hybrid C with the service-proxy launcher) are recorded in `EVALUATIONS.md` with their provisional defaults as OPEN-DECISIONS OD-1..OD-11, including the pending service-proxy extension design (OD-10).
- Kill -9 of the last out-of-process reaper with no returning client orphans Chrome (no parent-death signal on darwin); bound: the next `ready()` of any process adopts or reaps.
- The capture/dom.ts Google-SERP walker is kept as a feature; whether it is only a search-provider leftover is a user decision flagged by the failsafe inventory.
- The default `extraWaitMs` change (500 ms effective to 0, CU8; OD-4) needs the user's approval.
