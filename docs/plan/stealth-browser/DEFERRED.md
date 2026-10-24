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
| FU-4 | Entity graph, exemplars, sequence discovery, the pacing and sequencing gates, auth packages | Reverse-API scope, not a browser-automation concern. The tripwire itself is no longer deferred: it is `@adhd/resilience-core-tripwire`. |
| FU-5 | Dev-only recorder writing real Chrome sessions into `*.cdp.json` (fixtures become `recorded`) | Needs a real Chrome; there is no live-Chrome lane. |
| FU-6 | Loopback RFC 6455 fake CDP server | Violates unit purity. |
| FU-7 | agent-browser BACKLOG hygiene: B-034/B-035 rows stale, B-036..B-039 absent | Folded into `agent-search-cutover.9` via the backlog graph; B-036..B-039 are defined in `evidence/lifecycle-definitions.md` (chrome-lifecycle.25). |
| FU-8 | `7f881aa7` (attach to any Chrome on the port without a profile check; port-occupant kill fallback) | Only partly mitigated here. |
| FU-11 | Consumer proof of the `StoreRecordingSink` DDL and INSERT OR REPLACE on the real Turso-backed adapter, plus a CI leg on Node 22.5-22.11 | No lane in this plan runs the real adapter or older Node versions. |
| FU-12 | A stealth-browser `*.e2e.test.ts` lane for the real two-process kill -9 case | The detached host loading `dist/` is proven by `sp-reaper-load-proof` and `sp-reaper-smoke`, and kill -9 at library level by SP-K9 in service-proxy; a full e2e lane stays deferred by user decision. |
| FU-13 | Upstream tickets in the owned `@adhd/sox-service-proxy` repo: U2 housekeeping (close stale 72d980e5, README says node builtins only though it depends on listen-guard, the 0.5.0 tarball `dist/package.json` says 0.4.4, `ensureBackend` lock staleness uses bare `kill(pid, 0)` so a recycled pid keeps a lock alive until the 30 s TTL) | Not filed by this plan. U1 and U3 ship in service-proxy 0.6.0 (consumed through `sp-link`); only the U2 housekeeping remains. |
| FU-14 | Backlog 19dfb641 acceptance criterion 4 amendment (OD-9 in `EVALUATIONS.md`) | A backlog edit for the dispatcher; this plan does not edit the backlog. |

## Housekeeping

- The scratch repo `INDEX.md` entry for agent-browser is not updated by the cutover: the file carries other agents' uncommitted edits, so staging it would sweep their work into a commit. Update it when the tree is clean.
- The generated `e2e` nx target and `vitest.e2e.config.ts` are not part of the packages (there is no live-Chrome lane): sibling parity (`entrypoint-parity.1,3`, `search-scaffold.2`) compares against the sibling set minus the e2e lane.
- Fixtures under `src/test/fixtures/cdp/` are labelled `synthetic-protocol-conformant` until FU-5 replaces them.
- Design decisions: the capture sink (store adapter, option B'') and the lifecycle backbone (hybrid C with the service-proxy launcher) are recorded in `EVALUATIONS.md` with their provisional defaults as OPEN-DECISIONS OD-1..OD-11, including the pending service-proxy extension design (OD-10).
- Kill -9 of the last out-of-process reaper with no returning client orphans Chrome (no parent-death signal on darwin); bound: the next `ready()` of any process adopts or reaps.
- The capture/dom.ts Google-SERP walker is kept as a feature; whether it is only a search-provider leftover is a user decision flagged by the failsafe inventory.
- The default `extraWaitMs` change (500 ms effective to 0, CU8; OD-4) needs the user's approval.

## getOpenTabs removal (audit-fixes P32)

2026-10-24. `ProfileClient.getOpenTabs()` was removed from the public client in audit-fixes P32. Findings:

- Legacy source (scratch repo commit `4dc2b7ea0`, recorded in `evidence/source-baseline.txt`): `agent-browser/adhd/storage/profile.ts:81-82` is `getOpenTabs(): SessionTab[] { notYet('getOpenTabs'); return [] }`, a stub that warns and returns an empty array. The legacy docs list it as not implemented (`agent-browser/adhd/docs/storage.md:303`, `agent-browser/docs/architecture.md:367`, `agent-browser/docs/cdp-query-client-spec.md:175`) and `agent-browser/BACKLOG.md:9` records it as needing a Chrome Session protobuf parser.
- No failsafe row relied on it: `evidence/failsafe-inventory.json` (the profile row fs-170 lists top sites, favicons, autofill, search engines, preferences, extension ids and saved-credential presence) and `evidence/search-failsafe-inventory.json` contain no `getOpenTabs` or open-tab row; the only `notYet` mention (inventory line 3363) is for the helper, which stays.
- No consumer relied on it: `git grep getOpenTabs` at the baseline commit finds only the definition and docs, and a search of `packages/`, `entrypoint/` and the scratch repo working tree finds only the absence test `test/unit/domains-storage/profile.spec.ts`.
- The open tabs of a running Chrome come from `listPageTargets()`; parsing the profile's session files is not planned.
