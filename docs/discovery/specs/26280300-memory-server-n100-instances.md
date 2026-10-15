# Spec 26280300 — memory-server: N concurrent instances without interference

user-request (verbatim): "For ones that dont [meet DoR]: bucket -> architect spec -> product revision -> impl ready. ... Do not merge or run tests until I say so."
item user-request (verbatim, from the item): "I should be able to run 100 memory servers without problem"
items: 26280300-8194-443b-b95c-2f12c84c2fb6 (feature, HIGH, project sox-ecosystem)
dor: needs-decision (definition-of-ready path = needs-triage, route debug) — check: the item itself states "the root cause is under investigation ... and is not decided here"; no code seam is known, so a fix cannot be specced. This spec fixes the test harness and the diagnostic gate only. Size: L (harness S-M, fix unknown).

## Observed facts (O = opened by architect; R = reported by item, unverified)
- O: `ls ~/.memory` shows `memory-dev.db`, `memory-dev.db-tshm` and 51 files `memory-dev.db-tshm.stale-2026-10-15-HHMM-<n>-p75391`, timestamps 30 s apart (02:12:48, 02:13:18, 02:13:48 ...), one writer pid (75391). So the symptom "reopen about every 30 s, one stale sidecar per cycle" is CONFIRMED on disk; the cause is not.
- O: liveness watchdog `extensions/bundles/sox-memory-bundle/members/memory-server/src/liveness-watchdog.ts:85-130` is strictly in-process: `isWedged() = pending>0 && now-lastCompletionAt > thresholdMs`; `forceExit(code,'liveness_watchdog')`. It reads no other instance's state, so a cross-instance kill must arrive through a different mechanism (launchd/service-proxy health probe, shared sidecar files, shared driver-stall watchdog `driver-stall-watchdog.bl-862129b5.spec.ts`) — HYPOTHESES only, none verified.
- O: stale-sidecar machinery is in the store adapter: `/Users/nix/dev/ai/sox-ecosystem/libs/data/store/store-adapter/src/integrity.ts` (`recoverStaleWalIndex` l.813, `proactivelyReconcileStaleSidecar` l.1056, `DEFAULT_WAL_SIDECAR_STALE_THRESHOLD_MS` l.351 = 60 s, `isTshmContentDead` l.657) and `sidecar-retention.ts`. A reconcile at 30 s cadence under a 60 s threshold is unexplained.
- R: prod `com.sox.user.memory-server` was in a watchdog SIGKILL/respawn loop while dev ran; 592 `hard_exit` lines in the live-service jsonl 2026-10-15, 41 in the proxy backend log (operator grep; `forced` subfield and ownership by instance NOT verified).
- O: 26584e74 (cited as the investigation) is about enrichment stall / vector breaker / FTS alarm on ONE instance — it does not cover cross-instance interference. No open item owns the root cause.
- O: sox ADRs: 0012 (Turso multi-process write is an invariant; many processes may hold write connections to one store), 0007 (partly superseded), 0013 (no env-var switches), 0024 (off-thread driver, PROPOSED), 0015 (single-writer backlog daemon, PROPOSED/never accepted). No instance may be assumed single-writer.
- O: the sox tree has uncommitted edits to `members/memory-server/extension.json`, `members/memory-server/CLAUDE.md`, `libs/host-runtime/src/ext-config-cascade.ts`, `libs/install-engine/src/install.ts` — work from a worktree, and expect collisions in memory-server config.

## Design decisions
D1 Do not design a fix. Route to `debug` first with this exact question: "Which mechanism makes starting dev instance P2 on `memory-dev.db` (a) reopen its own db every 30 s with a stale-sidecar rename and (b) cause prod to be killed?" Required evidence: per-instance jsonl correlated by pid and timestamp (`hard_exit.forced`, `mainthread.lag`), launchd job log, the code path that renames `.tshm` (integrity.ts l.813/1056), and a minimal 2-instance repro (distinct db) before any N=100 run. A hypothesis list is not evidence.
D2 Harness design (ready once the repro exists): a scaffold that launches N real memory-server processes each with `SOX_ECOSYSTEM_HOME` and a data root under a temp dir (ADR sox 0004 split of data root vs sandbox), a fake HOME, distinct ports, a mix of `shared-db:distinct-db = 1:3`, and never the prod launchd job. N is a typed parameter of the test, not an env toggle: default lane N=4 (tier P), scale lane N=100 (tier H/X-style long lane, minimum duration). Rejected: always N=100 in CI (a P-tier test has a 10 s budget, `docs/standards/testing.md` tier P; 100 ONNX-capable servers exceed any runner).
D3 AC4 (startup not serialized by open-time integrity) is a *measurement* AC first: record time-to-`memory_ping` per instance vs N; the bound (e.g. p95 <= 2x single-instance) is a product number to be set after D1, not guessed here.
D4 Isolation guarantees expressed as invariants the harness asserts, not mechanisms: no instance's jsonl contains `hard_exit.forced` unless that instance was told to stop; sidecar file count per db is bounded by retention policy constant after T seconds of steady state.

## Write-scope (exact) — provisional until D1 completes
- Harness (known): /Users/nix/dev/ai/sox-ecosystem/extensions/bundles/sox-memory-bundle/members/memory-server/src/ new `multi-instance.e2e.ts` + helper `test-support/instance-fleet.ts` (names indicative)
- Fix (UNKNOWN): candidates by hypothesis — memory-server `liveness-watchdog.ts`/`hard-exit.ts`; store-adapter `integrity.ts` (shared with spec 87799e1d), `sidecar-retention.ts`, `store-lease.ts`, `cold-open-lock.ts`; service-proxy probe. Do not edit until D1 names the cause.

## Acceptance criteria (item's AC1-AC5 retained; ids stable)
- AC1 N=100 mixed instances start on one host and every `memory_ping` returns `store_ok:true`.
- AC2 Starting or stopping any instance causes no watchdog kill or forced reopen in any other (no foreign `hard_exit.forced`).
- AC3 No unbounded stale-sidecar growth per instance-hour (bounded count after steady state).
- AC4 Startup of N instances is not serialized/starved by main-thread open-time integrity (bounded concurrency or deferred integrity), with the bound set by product after D1.
- AC5 Automated e2e cites this item id and each AC and runs red on current main first.
- AC0 (new, gate) A 2-instance repro (one shared db, one distinct db, alongside a stand-in "prod" instance) reproduces the 30 s reopen / kill on current main and is attached to the fix item.

## Test plan (tier per AC; cite `26280300 AC<n>`)
AC0: P (real processes, <=10 s budget not met -> classify tier H long lane; justification: observed only with several live servers). AC1-AC4: H/long lane at N=100, P at N=4 for the default CI lane; unit seams (S) with spawn/network mocked for any pure policy extracted by the fix. Negative control: the harness must go red when one instance is deliberately SIGSTOPped past the watchdog threshold and the others stay green (proves cross-talk detection has teeth). Tests authored by `test-author`.

## Risks / serialization
- Shares store-adapter `integrity.ts`/sidecar code with spec 87799e1d — serialize after it. Resource: 100 servers x embedding model is heavy; fleet uses the mock-by-default embed path (spec `bl567-mock-by-default.spec.ts` shows the pattern).
- Open for user/product: accept D1 (diagnose before spec), the AC4 bound, and which lane (not CI per-PR) hosts N=100.
