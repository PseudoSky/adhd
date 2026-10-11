# Instrument spec: CLI-parity round-5 blockers FC1, FC2, FC3, FC4, FC6 (+ FC5 instrument defects, grid score)

Status: SPEC ONLY. Nothing implemented, no backlog items filed, no model arms run.
Repo: /Users/nix/dev/node/adhd, main@ebd24f9c+. Evidence root SP = /private/tmp/claude-502/-Users-nix-dev-node-adhd/f118b5b4-5fc4-458b-9f31-9ac647bb0cab/scratchpad

## 0. Summary

Move the throwaway round-4 instrument (SP/round4: drive.mjs 98 KB, oracle.mjs 65 KB, lib.mjs 31 KB, fixtures.mjs 17 KB, info-server, dryrun fakes, selfcheck observations, ledger) into ONE new private entrypoint package `entrypoint/agent-parity`, faithfully, with its self-check as tests. Then, on that base, in disjoint file scopes: (B1) fix the oracle (FC1 plus the three FC5 instrument defects), (B2) add a zero-model egress preflight that the driver runs and obeys (FC3, FC2), (B3) make web tooling symmetric (FC4, owner-gated), (B4) render each variant cell as icon + score. Raw output goes to gitignored `tmp/agent-parity/`; distilled results stay in docs/agent/parity/EXPERIMENT-LOG.md (dispatcher-written).

This spec does NOT promise that no model run ever fails. A1 (R4) failed on model variance (parent mis-briefed the worker without reading summary.js); that stays a red result after the fixes (see B1 AC7). FC8 and FC7 remain owner matters.

## 1. Verified facts (read, not assumed)

* The repo's existing "parity-harness" (packages/apigen/apigen-engine-runtime/src/test-support/parity-harness.ts, tsconfig.base.json:99; backlog 1f903927 resolved, b18099f7 resolved) is the apigen golden-fixture transport harness (captureGolden / assertParity / proveNegativeControl). It is a different domain and is NOT reusable here. b18099f7 shows its negative-control escaped scratch and ran git against the real repo (CRITICAL, resolved), so we do not borrow it. We reuse its precedent only: a cross-package test-only import goes through a tsconfig.base.json path, which we avoid by not sharing test code across packages.
* Reusable, already in repo: `resolveNativeTooling` (packages/agent/agent-core-native-tooling/src/lib/resolver.ts:398; the catalog is the single producer of the shell launch literal, ADR-0008 D2); `@modelcontextprotocol/sdk` Client + StdioClientTransport (already used by drive.mjs loadSdk); `AgentDefinition.nativeWebTools?: boolean` (packages/agent/agent-base-types/src/domain.ts:585, `false` removes server-side web_search/web_fetch; negative control in entrypoint/agent-mcp/src/__tests__/integration/native-web-tools.e2e.test.ts). NOT reusable: `RpcClient` and the parentProxy stub inside shell-egress.e2e.test.ts (file-local, not exported); use the SDK client, and write a ~25-line local parentProxy stub in the new package (duplication accepted over cross-package test imports; extraction is an optional later item).
* R4 ledger SP/round4/ledger/model-runs.json is at 6/6 (cap spent). R5 needs a fresh per-round ledger.
* Backlog ACs (verbatim sources): 25ce70b8 AC1 driver/fixtures/oracle+README in repo, AC2 oracle defects fixed with tests, AC3 BK5 gate text (OUT OF SCOPE here: depends on owner decision FC7; 625b611e), AC4 tests cite uid+AC. 90758419 AC1 q_rate separates recall from re-use, AC2 preflight fails loudly, AC3 s1/x3 fixes with red-then-green cases, AC4 self-check cites uid+AC. 50e21ed9 AC2 web-symmetry definition + egress preflight implemented and tested. 0ba70e47 AC1 curl via shell_execute returns the page under srt (live), AC2 exit status visible (PENDING upstream, F32, not in this spec). 1207765d and 9063acac have NO ACs; tests cite them with the bucket AC id as `1207765d (bucket B0.AC4)`.

## 2. Package decision (ADR-0002/0008 compliant)

New package is warranted. Home options: (a) inside entrypoint/agent-mcp: rejected, its build copies docs/ and src into the PUBLISHED dist and it would ship a paid-model driver plus 200 KB of fixtures; its test lane is already the heaviest. (b) packages/agent/agent-core-native-tooling: rejected, wrong tier (library below agent-mcp; the driver must run agent-mcp's built dist). (c) throwaway: rejected, that is the defect (25ce70b8). (d) new entrypoint (runner, AGENTS.md section 1: "A CLI / server / runner -> entrypoint/"). Chosen: (d), private (publish defaults false).

Exact invocation (bare name; dry-run first, read the CREATE list, then re-run without it):
```
npx nx g @adhd/workspace-codegen-nx:entrypoint --name agent-parity --nxLayer entrypoints --platform node --dry-run
npx nx g @adhd/workspace-codegen-nx:entrypoint --name agent-parity --nxLayer entrypoints --platform node
```
No new repo-root folder (entrypoint/ exists). Raw output only under `tmp/agent-parity/<round>/` (gitignored, AGENTS.md section 10). Tracked state: `entrypoint/agent-parity/ledger/<round>.json` (cap must survive a fresh checkout; atomic write + lock as in reserveModelRun; R4's ledger committed as ledger/R4.json for history). Owner approval D6 below covers the new package + tracked ledger.

Language: oracle, fixtures, lib, ledger, preflight, report = TypeScript (types in src/types.ts: Observation, Expectation, FieldResult, PreflightVerdict; shared interfaces prefixed `I` per AGENTS section 9). Driver split into modules (below). Behavior-preserving port first; refactors only where a bucket says so.

Layout (B0 creates everything; later buckets own the files listed in section 4):
```
entrypoint/agent-parity/
  README.md  AGENTS.md  project.json ...(generator)
  src/types.ts
  src/fixtures/{scenario,expectations,hidden-suite}.ts   src/lib/*.ts   src/oracle/{index,fields,brief}.ts
  src/driver/{cli,plan,arms-a,arms-bc,agent-def,analyze,invariants,pacing,ledger,live}.ts
  src/gate/index.ts            (round gate: pacing + ledger + preflight, fail closed)
  src/preflight/index.ts       (B0: stub that returns RED "not implemented"; B2 replaces)
  src/detectors/index.ts       (B0: exports []; B2 owns)
  src/report/{summary,grid}.ts
  src/dryrun/ (fake claude shim, fake anthropic, egress guard)   src/info-server.ts
  test/**  e2e/parity.e2e.test.ts
  test/golden/{round3,r4,legacy}/**
```

## 3. Buckets (each: done-state, ACs, tests)

### B0 FC6: instrument in repo (25ce70b8 AC1/AC2/AC4, 1207765d)
Done-state: clean checkout builds `agent-parity`; `--self-check` exits 0; the round-3-red/round-4-green oracle cases are unit tests; nothing references SP.
* B0.AC1 (25ce70b8 AC1): package scaffolded via the generator; driver, fixtures, oracle, lib, info-server, dryrun fakes ported; README covers scenario, arm definitions (A native `claude -p`, B claudecli, C anthropic), criteria-in-force history, how to run each command, cost-basis definitions, and the tmp/ output convention. No path under /private/tmp or the scratchpad remains (`rg -n "private/tmp|scratchpad" entrypoint/agent-parity` returns nothing).
* B0.AC2 (25ce70b8 AC2): the four R4 oracle fixes (w2 null, s2 double count, h2_empty over-spec, x3 HEDGE) carried over as-is and proven: frozen R3 oracle+fixtures (SP/round4/legacy/*) kept under test/golden/legacy/ (lint-ignored, header comment says frozen on purpose), scored against SP/round4/selfcheck/round3 observations (A1,B1,B2,C1,C2 + C2-repo, 264 KB): legacy oracle RED on the named fields, current oracle GREEN. Unit test.
* B0.AC3 (1207765d, no AC id): every R4 record needed later is captured BEFORE the scratchpad is touched: from SP/round4/live/out/runs/{A1,A2,B1,B2,C1,C2}/record.json copy only `observation`, `expected`, `score` (about 40 KB each) to test/golden/r4/<run>.json with the sha256 of the source record.json in a header; for A1 additionally a reduced stream (event type, message id, parent_tool_use_id, tool names, tool_use ids only) to test/golden/r4/A1.events.json. Secret scan (`rg -n "sk-ant|Bearer |/Users/nix"` over test/golden) returns nothing; home paths rewritten to `<HOME>`.
* B0.AC4 (25ce70b8 AC4): ledger: per-round file, cap 6, lock, fail closed on corrupt file; a unit test cites it. `--live` can never be reached without gate/index.ts passing.
* B0.AC5 (25ce70b8 AC2/AC4): `--self-check` = selfCheckPure() (no spawn; also the unit test) + selfCheckSpawning() (claude binary read, hidden-suite `node --test` runs, process-tree sweep; e2e only). Output lines cite ticket+AC ids.
* B0.AC6 seams for later buckets, each fail-closed: gate/index.ts runs [pacing, ledger, preflight]; preflight stub returns RED; detectors/index.ts exports [] and analyze calls every detector.
Lane split (ADR-0009): unit tests mock `node:child_process`, the MCP SDK client/transport, `fs` of the real HOME, and any network; they never spawn. Anything that spawns is e2e.
Tests: unit `test/**/*.test.ts` citing `25ce70b8 AC2` etc. E2E: ONE file `e2e/parity.e2e.test.ts`, ONE shared scaffold in beforeAll (tmp dir under tmp/agent-parity/e2e-<pid>, fake HOME, isolated cwd, per ADR-0009 D3) and every surface driven in that one run: `--print-plan`, `--self-check`, hidden-suite on the fixture repo, `--live` refusal (B2 adds the preflight legs to the same file). Minimum duration: build the CLI once, one scaffold, no per-test servers. Wire an `e2e` target with `vitest.e2e.config.ts` and E2E_FILE_EXCLUDES in vite.config.ts as the agent family does (tools/vite-plugins/e2e-globs.mjs, check-lane-reachability rule 8).
Proof (raw exit codes):
```
npx nx run agent-parity:lint ; echo $?
npx nx run agent-parity:typecheck ; echo $?          # and typecheck-spec if the target exists
npx nx run agent-parity:test ; echo $?
npx nx run agent-parity:build ; echo $?
node entrypoint/agent-parity/dist/src/cli.js --self-check ; echo $?     # 0
npx nx run agent-parity:e2e ; echo $?
```
Verify the dist entry path with `npx nx show project agent-parity` first (agent-mcp's pattern is dist/src/index.js).

### B1 FC1 (+FC5 instrument defects): oracle (90758419 AC1/AC3/AC4, 25ce70b8 AC2)
Done-state: on the frozen R4 records the oracle is red where it should be and green where the old oracle was wrong; real failures stay red.
* B1.AC1 (90758419 AC1) q_rate definition. FAIL iff the phase-2 value is missing/wrong, or the probed rate is contaminated (unchanged: invalid). A correct value PASSES whether or not the model re-read the ticket. New informational process field `q_rate_reread` (count of phase-2 get_ticket calls; never counted in the content denominator) records re-use. Reason: re-verifying is legitimate real-world behavior (R4 B1 4.50, B2 3.00 correct, context byte-continuous).
* B1.AC2 (90758419 AC1) continuity is then tested structurally so recall is not left unmeasured: new process field `q_context_carry`: phase-2 first-turn cache_read >= 0.9 x (phase-1 last-turn cache_read + cache_create) for A/B (R4 evidence: B1 20830 -> 20830; A2 24855 -> 24855), and for C the first phase-2 request contains the phase-1 get_ticket result. Red on a synthetic broken-carry observation.
* B1.AC3 (90758419 AC3) x3 HEDGE: a hedge counts only when it conditions the delegation clause (same clause, at or before the delegation verb). "so you can ..." purpose clauses do not hedge; "if you can delegate ..." does. Before editing, produce a table of every R4 brief (B1,B2,C1,C2 `na`/fail, from test/golden/r4) with old and new verdict; only flips caused by the purpose-clause pattern are allowed; the table is committed as test/golden/r4/x3-briefs.md and reviewed in the PR.
* B1.AC4 (90758419 AC3 + FC5 finding 1) s1_tests_honest scored against the VISIBLE suite at the end of phase 1 (`node --test`, what `make test` runs), the same way s2_honest already is (oracle.mjs:278). Driver captures `hidden.p1.visible` (lives in B1's scope only through fixtures/hidden-suite.ts; driver call site is B0's runHidden, so B1 owns `src/fixtures/hidden-suite.ts` and B0 leaves p1 visible capture inside that module). Legacy records without it score `invalid`, never pass. A1's R4 golden gets `hidden.p1.visible=true`, annotated "derived from stream: make test 25/25 (SP/a1p1.txt:296-315)".
* B1.AC5 (FC5 finding 2) h2_regress counts a root cause once: it fails only when a hidden suite that PASSED at end of phase 1 FAILS at end of phase 2. A1: feature red in both phases -> not a regression -> pass; h1_feature stays the single red for that cause.
* B1.AC6 (FC5 finding 3) x2_parallel for arm A scored by outcome like B/C: two child runs overlap if their events interleave in stream order (events of child 2 appear between first and last event of child 1, keyed by parent_tool_use_id) or, when timestamps exist, if intervals intersect; "same assistant message" remains sufficient but not required. Native Agent returns "Async agent launched" instantly, which defeats the outstanding-counter (lib.mjs:401-413). A1 (two messages, interleaved children) -> pass; a synthetic strictly sequential A run -> fail (negative control).
* B1.AC7 must-stay-red: A1 h1_feature, h2_empty, s2_honest stay RED (real model variance); B1/B2 w1_web stays red on the R4 records (they ran before the egress fix). Test asserts these exact fields so the fixes cannot launder real failures.
* B1.AC8 (90758419 AC4) every new case's description cites `90758419 AC<n>` (or `25ce70b8 AC2`); each case has a red-then-green pair: frozen R4 oracle (test/golden/r4/oracle.r4.frozen.mjs, copied verbatim from SP/round4/oracle.mjs before edits) RED on the record, new oracle GREEN.
Proof: `npx nx run agent-parity:test ; echo $?` (0) plus `node entrypoint/agent-parity/dist/src/cli.js --check-oracle ; echo $?` (0). Teeth: temporarily revert the q_rate rule in a throwaway copy and show the B1/B2 case turns red (recorded in the PR, not committed).

### B2 FC3 + FC2: zero-model egress preflight (50e21ed9 AC2, 0ba70e47 AC1, 90758419 AC2)
Design:
* B2.AC1 (50e21ed9 AC2, 0ba70e47 AC1) Done-state: `agent-parity preflight` drives the built stack through the real srt path with no model call, exits 0 only if the page came back, and `--live` runs it first and refuses on red. Running it on the dev box verifies the 0.0.4 egress fix live (FC2) without a round.
* B2.AC2 Real MCP client, not an import of server code: resolve `resolveNativeTooling` from the module agent-mcp's dist actually loads (`createRequire(<wt>/entrypoint/agent-mcp/dist/src/index.js).resolve('@adhd/agent-core-native-tooling')`; record resolved version, expect >= 0.0.4), call it with the exact B/C shell config (`nativeTooling.shell = { allowCommands: SHELL_ALLOW }`, sandbox on, `ADHD_AGENT_SRT_SETTINGS` = the per-run srt policy that already allows example.com), spawn the returned command/args/env with the official SDK `StdioClientTransport` + `Client`, `listTools`, then `callTool shell_execute` argv `["curl","-sS","--max-time","15","-L","<targetUrl>"]`.
* B2.AC3 Legs: B and C share one launch literal (provider-independent resolver); the preflight resolves once per provider type and asserts deep-equal (if they ever diverge each gets its own server). Leg A: the same curl argv spawned directly with arm A's cleaned env (Bash on arm A is unsandboxed). With FC4 option O1 there is no server-side fetch left to test; under any option that keeps C's web_fetch it cannot be preflighted at zero model cost and the report says so.

Asserts per leg (all must hold; each is one criterion):
* B2.AC4 (1) launch ok and tool `shell_execute` listed.
* B2.AC5 (2) result `isError` false.
* B2.AC6 (3) text content non-empty, >= 200 bytes.
* B2.AC7 (4) contains `<title>Example Domain</title>` (marker constant lives in fixtures WEB_HEADING).
* B2.AC8 (5) wall time > 150 ms (R4's silent failures returned in 13-23 ms; a real TLS fetch cannot).
* B2.AC9 (6) FALSE-EMPTY rule: `content == [] or all-blank` with `isError:false` is RED (code EMPTY_FALSE_SUCCESS), the exact R4 signature.
* B2.AC10 (7) a `curl: (6)` / "Could not resolve" / "blocked" in text is RED (code EGRESS_DENIED).
* B2.AC11 Verdict codes: GREEN, LAUNCH_FAIL, EMPTY_FALSE_SUCCESS, TOOL_ERROR, MARKER_MISSING, EGRESS_DENIED, LITERAL_DIVERGED, TIMEOUT.
* B2.AC12 CLI exit 0 only if every leg GREEN, else 3 (usage errors 2). JSON verdict on stdout, human line per leg on stderr.
* B2.AC13 Receipt written to tmp/agent-parity/<round>/preflight-receipt.json with identity {agent-mcp dist sha, native-tooling version, srt version, policy sha, SHELL_ALLOW sha, targetUrl, marker}.
* B2.AC14 Driver refusal: `--live --yes` runs the preflight BEFORE pacing and BEFORE any ledger reservation; red -> print leg verdicts, exit 3, ledger untouched, claude never spawned.
* B2.AC15 (50e21ed9 AC2) Second line of defense: `src/detectors/egress-silent-empty.ts` scans each run's tool-call log; any shell curl result that is `content:[]`/blank with isError false marks that run's `w1_web` INVALID(egress) with the call ids, instead of letting the model's fabrication score as a model fail (R4 B1/B2 signature). Tested red on a synthetic log shaped like the R4 B1 api log lines 110-118. Detector unit test cites `50e21ed9 AC2`.
* B2.AC16 Config: `PreflightSpec { targetUrl, marker, minBytes, minWallMs, policyPath, allowCommands, worktree, timeoutMs }` is a function argument; no env flag toggles anything and the CLI has no test-only flags.

Tests:
* B2.AC17 (90758419 AC2, 50e21ed9 AC2, 0ba70e47 AC1) Unit (`test/preflight.test.ts`, mocks `@modelcontextprotocol/sdk` client/transport and `node:child_process`, no network): table of tool results -> verdict code, covering every code incl. `{content:[],isError:false}` -> EMPTY_FALSE_SUCCESS, 20 ms wall -> RED, launch literal B != C -> LITERAL_DIVERGED, exit-code mapping 0/3.
* B2.AC18 E2E, same `e2e/parity.e2e.test.ts` and scaffold (no third-party network, no skip): local HTTP stub as srt `network.parentProxy` answering allowed.test with a known body (technique documented in shell-egress.e2e.test.ts: srt refuses loopback targets). Case: GREEN preflight against the stub (B/C share one real uvx mcp-shell-server start).
* B2.AC19 E2E NEGATIVE CONTROL: same call with `MCP_SHELL_CHILD_ENV_ALLOWLIST` stripped from the resolved env must be RED (proves the gate has teeth and would have caught R4).
* B2.AC20 E2E zero-spawn proof: `--live --yes` with the control config exits 3, ledger file byte-identical, and a `claude` shim on PATH that appends to a file proves zero spawns (file absent).
* B2.AC21 Missing srt/uvx fails loudly in beforeAll.
* B2.AC22 Operator proof of FC2 (not a CI test; needs internet): `node entrypoint/agent-parity/dist/src/cli.js preflight ; echo $?` must print 0 with real example.com. Paste that exit status into the experiment log.
Proof: `npx nx run agent-parity:test ; echo $?`, `npx nx run agent-parity:e2e ; echo $?`, the operator command above.

### B3 FC4: web-tool symmetry (50e21ed9 AC2, 9063acac) , OWNER-GATED (D1)
Current surface: A `--tools Bash,Read,Write,Edit,Glob,Grep,Agent` (no WebFetch; fetches by Bash curl, unrestricted). B claudecli `--tools ''` + shell builtin curl (allowlist, srt). C server-side web_search/web_fetch (default-on) plus shell curl; those add about 2.2k tokens per turn (9063acac; final-report-2: C-shell 0.56x vs 0.36x with `nativeWebTools:false`).
Options:
* O1 (RECOMMENDED): every arm fetches via curl; arm C gets `nativeWebTools:false`. Pros: identical tool surface and web path, so w1_web is like-for-like; only path the zero-model preflight can fully prove (all arms covered); removes the ~2.2k/turn overhead from the context/cost bands; a small, existing, tested knob. Cons: C is measured in a non-default config, so the result says nothing about the shipped default (whether the default should change is 9063acac, a separate owner decision); the cost/ctx verdict for C shifts favorably and must be labeled "C, web tools off".
* O2: give A and B an equivalent hosted fetch. A: add WebFetch to `--tools` (its fetch involves an extra small-model call that A then bills); B: no mechanism today (`--tools ''`, bridge-only), needs a product change. Pros: keeps C default. Cons: new asymmetries, hidden model calls in A, product work, cannot be preflighted at zero model cost.
* O3: keep each arm as shipped; add a `webSurface` column and score w1_web conditionally; run a second C config in a later round. Pros: no code change, honest about defaults. Cons: w1_web not like-for-like; cost/ctx comparison conflates web overhead with provider overhead; extra C runs exceed the 6-run per-round cap.
ACs (for O1; O2/O3 get their own list if chosen): B3.AC1 (50e21ed9 AC2) agent-def sets `nativeWebTools:false` for arm C only, covered by a unit test on the produced agent definition; B3.AC2 run-validity invariant (like the thinking invariant): any observed web_search/web_fetch/WebFetch/WebSearch tool name in any arm marks the run INVALID, unit-tested red on a synthetic C log (C1 R4 api log shows a web_fetch result "Example Domain" as the red fixture); B3.AC3 README matrix of tool surface per arm; B3.AC4 e2e (same file): resolved agent definition sent to a fake provider shows no web tool entry for C. Proof: `npx nx run agent-parity:test ; echo $?`, `npx nx run agent-parity:e2e ; echo $?`.

### B4 grid: variant result includes its score (owner direction)
* B4.AC1: `renderGridCell(record)` returns `🟢 17/17` (all content items pass), `🔴 15/17`, `🟡 9/17` while running when a partial score exists else `🟡`, `⚪` not started; invalid runs `⛔ n/a`. Score = content items passed / content items applicable (denominator printed, since it differs across rounds). Unit table test, cites `25ce70b8 AC1`.
* B4.AC2: `cli grid --round R5` prints the section-2 row of EXPERIMENT-LOG (six cells) from tmp/agent-parity/<round>/ records, so the dispatcher pastes it instead of hand-typing. Unit test with the R4 goldens must output `🔴 12/17 | 🟢 17/17 | 🔴 15/17 | 🔴 15/17 | 🟢 17/17 | 🟢 17/17` for A1 A2 B1 B2 C1 C2 (note: B1/B2 become 16/17 after B1.AC1; the test pins the recomputed values after the fix, and the old-oracle values via the frozen oracle).
Proof: unit test exit 0.

## 4. Write scopes (declared up front; disjoint among parallel buckets), executor, tier, order

| Bucket | Executor | Model tier | Write scope (exclusive) | After |
|---|---|---|---|---|
| B0 | typescript (port) , fan-out per module via pipeline(): fixtures, lib, oracle, driver modules (each an independent bounded dispatch, shared src/types.ts written first) | sonnet | entrypoint/agent-parity/** (generator output), tsconfig.base.json only if the generator edits it | none |
| B1 | typescript | sonnet | src/oracle/**, src/fixtures/hidden-suite.ts, src/fixtures/expectations.ts, test/oracle/**, test/golden/r4/** (adds only), CHANGELOG-free | B0 |
| B2 | backend | sonnet | src/preflight/**, src/detectors/** (index.ts ownership transfers from B0), src/gate/preflight-gate.ts, test/preflight*.test.ts, e2e/parity.e2e.test.ts (preflight describe blocks appended; B0 owns the file's first blocks, B2 appends only after B0 merged, so single-writer at a time) | B0 |
| B3 | backend | haiku (tiny, exact steps) after D1 | src/driver/agent-def.ts, src/driver/invariants.ts, README "web surface" section, test/web-surface.test.ts | B0, D1 |
| B4 | typescript | haiku | src/report/grid.ts, src/driver/cli.ts (one added command case), test/report/grid.test.ts | B0 |
Order: B0 -> {B1, B2, B4, B3} in parallel (file-disjoint: oracle / preflight+detectors+gate / report+cli / agent-def+invariants; e2e file appended by B2 and B3 sequentially: B3 after B2 for that file, or B3 adds its case in its own `e2e/web-surface.e2e.test.ts` to keep scopes disjoint; choose the latter) -> integration by the dispatcher.
Integration gate (dispatcher, after merges): `npx nx affected -t lint,typecheck,typecheck-spec ; echo $?`; `npx nx run agent-parity:e2e ; echo $?`; pre-push test gate `npx nx affected --base=origin/main --head=HEAD $(node .githooks/lib/pre-push-flags.mjs) ; echo $?`; operator `agent-parity preflight ; echo $?` on the real network; `git status --porcelain` accounted for. Every executor's final message carries a `Gates:` list with command + exit code (AGENTS.md).
Dispatch hygiene: B0 spans many files, so fan out one bounded dispatch per module; no executor loops over the whole port in one context.

## 5. Round-readiness forecast after these land
Resolved by code: FC1, FC3, FC6, the three FC5 instrument defects, FC2 (verified live by the operator preflight, which must be pasted green into the log before R5 is declared). Still open and NOT code: FC4 (D1), FC7 (D2), FC8 (success definition), FC5 model variance (A1 can fail again). A non-empty forecast keeps R5 held per log section 0.4. Additional preemptive forecasts: (a) uvx/PyPI first-start latency inside preflight (timeout 120 s, same as the existing e2e STARTUP_MS); (b) srt policy drift between preflight and run (identity hash in the receipt, re-checked by gate); (c) A leg passes while B leg fails is a valid outcome and still blocks the round; (d) the egress detector protects mid-round hiccups only for w1_web, not other fields.

## 6. FC7 options for the owner (not chosen)
Content band "equal or better", context and cost "at or below native":
* N1 Point estimate, no tolerance: arm median content >= A median; ctx <= A median; cost <= A median. Literal reading. R4 would fail B cost by +0.5% (noise).
* N2 Tolerance band: content >= A median minus 1 item (about 6%); ctx and cost <= 1.05 x A median; latency reported, not gated. Pros: tolerates measurement noise at the scale seen (A cost per-run spread 0.171-0.205, 18%; A content 12 and 17). Cons: 5% is still below A's own n=2 spread, so a verdict can flip on resampling.
* N3 Noise-aware: n >= 5 per arm per scenario shape (exceeds the 6-run per-round cap, so 2-3 rounds), pass iff the bootstrap upper bound of (arm median - A median)/A is <= +5% for ctx and cost and the lower bound >= -1 item for content. Pros: only option that supports a statistical claim; cons: paid runs and the cap.
Cost basis (R4 numbers): common-card estimate (all cache writes at 5m rate; A 0.1877, B +0.5%, C +3.1%) vs billed (A from CLI total_cost_usd, B/C tier-aware; A 0.2088, B +5.9%, C -7.3%). The verdict for C flips. Choices: (i) gate on common-card (reproducible, provider-neutral, undercharges the 1h cache tier), (ii) gate on billed (what is actually paid), (iii) gate on billed, report common-card informationally. 
Latency stance: L1 not a criterion, report medians (R4 B +41%, C +77%); L2 gate wall <= 1.25 x A median; L3 gate only agent-mcp overhead (wall minus summed model-call time) <= a fixed seconds budget. These interact with D1: O1 lowers C's context and cost, so fix D1 before reading any band verdict.

## 7. Open owner decisions
* D1 FC4 web symmetry: O1 (recommended) / O2 / O3.
* D2 FC7 bands: N1/N2/N3, cost basis (i/ii/iii), latency L1/L2/L3.
* D3 prompt: add one sentence for the web item, e.g. "If you cannot fetch the page, write `Source: (not fetched)` and report web_heading null" (90758419 finding 6; B invented a heading in R4). Changes the scenario text, so R5 is not byte-comparable with R2-R4 on that item.
* D4 ticket wording (FC5): the A1 variance came from the parent not reading summary.js; the ticket text stays untouched. Option only: add an explicit "keep existing return properties" line to the ticket. Not recommended: it makes the task easier for every arm and hides the brief-fidelity signal the scenario exists to measure.
* D5 tracked per-round ledger under entrypoint/agent-parity/ledger/ (recommended) vs gitignored (cap resets on a fresh checkout).
* D6 approve the new private package `entrypoint/agent-parity` (section 2).
* Out of scope here: BK5 625b611e gate text (25ce70b8 AC3) pending D2; F32 exit status (0ba70e47 AC2, upstream PR tumf/mcp-shell-server#61); FC5/FC8 model variance.

## 8. Unfiled items this spec surfaces (dispatcher to file via backlog-operator)
* Ticket 1207765d and 9063acac carry no ACs (tests cite bucket ids).
* llms.txt Gemini/version staleness (from SP/parity-critical-path.md) remains unfiled.
