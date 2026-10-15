# Spec 4256bc8b — real-model semantic coverage: correct the lane claim, keep the paired stub honest

user-request (verbatim): "For ones that dont [meet DoR]: bucket -> architect spec -> product revision -> impl ready. ... Do not merge or run tests until I say so."
items: 4256bc8b-3162-4bab-85de-8fe454724b2c (debt, HIGH, project adhd)
dor: needs-decision — check: the item asks for a "default-running real-model spec"; under the accepted lane model (ADR-0009 + `docs/standards/testing.md`) a real ONNX model cannot be tier S, and the real-stack suite already runs in the CI `e2e` lane. The owner must confirm that CI-e2e satisfies "default-running" (then only a wording/stub fix remains, XS) or require a new local lane (new decision, L). Size: XS under the recommendation.

## Observed facts (O = opened; the item's "unreachable" claim is from main@734f756d and is superseded)
- O: real suite exists and is wired: `/Users/nix/dev/node/adhd/entrypoint/backlog/src/store/embed-drain-real-model.e2e.ts` (two cases, `it(` at l.69, l.136; real fastembed bge-base-en-v1.5, real Turso vector store, real built bin; imports `bootstrapSemanticStoreMembers` from `../write/bootstrap.js`). Header l.~20-27 says "Why this runs by DEFAULT, with no env flag".
- O: it IS reached by CI: `.github/workflows/pull-request.yml:~155-160` runs `npx nx affected -t e2e --parallel=1`; `tools/gate/lane-gate.mjs` `GATE_TARGETS=['test','e2e']`; `entrypoint/backlog/project.json` `e2e` target comment says "MUST REMAIN REACHABLE FROM THE PUSH/CI GATE ... REWIRED 2026-09-28" (item's quoted "deliberately unreachable" text describes the history, not the current state). Backlog 0b83f28d ("no CI runner") is RESOLVED. AGENTS.md: e2e is CI-only; the local pre-push runs `test` only.
- O: stub: `entrypoint/backlog/src/store/embed-drain-real-model.spec.ts:19-22` is `describe("mocked: ...")` with two `it.todo`. `docs/standards/testing.md` tier P: "Every `*.e2e.ts` has a paired `*.spec.ts` stub so the tier S lane lists the suite" — the stub is MANDATED, so deleting it is wrong; but a `todo` marker needs an owner/date (G4, FM8: new markers must carry a tracking item and an unexpired date).
- O: tier ceilings (testing.md l.10-13): tier S = 100 ms p95, no subprocess; tier P budget 10 s/test (this suite uses a 180 s cold-model timeout, `E2E_TIMEOUT`); tier H has no lane yet. A real in-process ONNX init cannot meet tier S; the spawned-bin case cannot be S at all (ADR-0009).
- O: the false statement is the header wording "runs by DEFAULT": it runs in the `e2e` lane (CI presubmit), not in `nx test`. Related claims in AGENTS.md §7 ("every behavioural test runs by default, unflagged, in CI") are satisfied by CI e2e.
- Not established: whether a case through `ensureSemanticReady` exists in the e2e file (grep found no reference; the file exercises `bootstrapSemanticStoreMembers` + `create`/`query`). The item names `ensureSemanticReady` as a seam to cover.

## Design decisions
D1 (recommended): the real-stack proof stays in tier P (`*.e2e.ts`, CI e2e lane). No new local lane, no env flag (banned toggle pattern), no model load in tier S. Rejected: a new in-process real-model spec in the unit lane (violates tier S ceiling and `check-lane-reachability` heuristics; forces every `nx test` and pre-push to pay a ~minute model load); a "mock" spec (the item and AGENTS §7 reject mocking the thing under test).
D2 Fix the header claim to say precisely which lane runs it and how to run it (`npx nx run backlog:e2e`), no "DEFAULT".
D3 Replace the two `it.todo` strings with real, cheap tier-S assertions that give the stub teeth without a model: (a) the e2e file's case names are listed 1:1 in the stub (a spec that reads the sibling `.e2e.ts` and asserts each `it(` title is mirrored — keeps the stub honest as the suite changes); (b) `bootstrapSemanticStoreMembers` against the existing fake provider (`src/test/helpers/fake-embedding-provider.ts`) proves wiring order. Rejected: leaving `it.todo` (G4 debt, proves nothing).
D4 (open question, DECISION) the `ensureSemanticReady` seam: add one e2e case (tier P, real model) that opens the store through the production factory, calls `ensureSemanticReady`, and asserts a query returns the item through the semantic route only. Needs owner OK for the extra ~minute of CI e2e time.

## Write-scope (exact)
- /Users/nix/dev/node/adhd/entrypoint/backlog/src/store/embed-drain-real-model.spec.ts
- /Users/nix/dev/node/adhd/entrypoint/backlog/src/store/embed-drain-real-model.e2e.ts (header comment; D4 case if approved)
- NOT in scope: `entrypoint/backlog/project.json`, `nx.json`, `tools/gate/lane-gate.mjs` (lane wiring already correct).

## Acceptance criteria
- AC1 The e2e header states the lane it runs in and the command; the phrase "runs by DEFAULT" is absent.
- AC2 The paired stub contains no `it.todo`; every `it(` title in the e2e file has a mirror entry in the stub, and adding a case to the e2e without mirroring it turns the stub red.
- AC3 The stub's wiring assertion runs under tier S (no subprocess, no model, <1 s).
- AC4 (D4) A real-model e2e case through `ensureSemanticReady` finds an item by a query sharing no token with it, and fails when the vector is absent.

## Test plan (cite `4256bc8b AC<n>`; every new test has the G9 header: failure mode, tier, item and AC, red run)
AC1: S (grep-style assertion in the stub or the lane-reachability header check; failure mode = false lane claim). AC2/AC3: S, negative control = temporarily add an unmirrored title in a fixture string. AC4: P (real fastembed + Turso; tier P because it needs the built production factory; model is local ONNX, not a paid service, so no env gate). Red evidence for AC4: run against a build with embedding disabled.

## Risks / serialization
- No shared files with other specs in this batch. Same directory as sibling backlog work (embed-drain.spec.ts) — keep edits to the two named files. CI e2e time +~1 min if D4.
- Open for owner: accept CI-e2e as "default-running" (D1) and approve D4; correct the item (premise superseded by 0b83f28d).
