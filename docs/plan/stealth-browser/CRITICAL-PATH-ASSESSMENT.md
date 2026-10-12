# Critical-path assessment: plan `stealth-browser` (backlog 8468f7b1-8adc-4237-9986-21ea1e27c537)

Assessor: product. Dispatch dispatch-2026-10-12-ca18. Read-only review; nothing inside the worktree or the scratch repo was written.
Plan dir (P): `/Users/nix/dev/node/adhd/.worktrees/stealth-browser/docs/plan/stealth-browser/`. Citations use `P/<file>:<line>`. Source package (SRC): `/Users/nix/dev/ai/scratch/agent-browser/`.
Snapshot of execution at review time (P/state.json:6-243, 289): `productization-hold`, `scaffold`, `entrypoint-parity` complete; `deps-install` in_progress (claimed, state.json:27-33); the other 30 states pending.
Tooling disclosure: GitNexus MCP failed to connect (session notice), so code navigation used rg/Read only. One `grep -v` pipe was denied by the permission system and re-run with `rg`. Memory recall returned nothing relevant to this plan (no prior roadmap/decision entries).

---------------------------------------------------------------------------------------------------

## 1. VERDICT (10 lines)

1. The objective ("migrate the already intentionally structured package into adhd as an entrypoint") needs: generator-built package + sibling parity (done), the 47 manifest files ported behavior-preserving, a minimal apigen host so the user-directed tracing plugin has something to mount on, gates under nx, ONE blind review + ONE implementer, doc-steward then content-marketer, and the ff-only merge.
2. Minimal critical path (class A+B): 29 of 34 states; its longest dependency chain is 22 states (whole DAG: 26). With three zero-cost edge fixes it is 19 (section 2).
3. Off the critical path but still necessary: 7 states (mig-chrome-manager in the A+B graph, mig-capture-parsers, mig-docs, four tests-unit-*). Excluded (class C/D): `prod-public-api`, `prod-errors`, `prod-examples`, `prod-publish-readiness` (all four product-folded) and `agent-search-cutover`: 5 states; `audit-final` stays but as a script gate, not a second reviewer.
4. About 36 of 199 acceptance criteria in the contexts carry a productization (PA) tag; 19 of them sit in the four prod-* states, 17 are amendments inside A+B states. About 50 criteria (hand count) are TRIM/DROP/SPLIT-OUT in section 3, 19 of them in the removed prod-* states.
5. BLOCKING defect in my own earlier fold: the `./legacy` subpath needs a `package.json` `exports` map, and accepted ADR-0003 forbids one (docs/decisions/0003-adhd-packages-publish-commonjs-only.md:11,41,43). D1 in PRODUCT-REVIEW.md:8 is therefore rejected as written; `surface-hosts.9` (guard.py:1797) and `prod-public-api` must change.
6. The plan replaces the source's declared public surface (5 subpaths `/cdp /storage /capture /parsers /chrome-manager`, SRC/adhd/README.md:14-22) with a new six-verb root. The "six verbs extracted from search-mcp-source.ts:454-495" premise is false: only `chromeStatus`, `launchChrome`, `shutdownSearchChrome` exist there (search-mcp-source.ts:454,472,491); the other verbs are new design.
7. BLOCKING for merge: the repo's CI runs `nx affected -t e2e --parallel=1` on ubuntu (.github/workflows/ci.yml:15,97) and the new e2e is macOS-Chrome-only (P/human-blockers.json hb-chrome-binary). Merging turns main red unless a platform decision is made.
8. HIGH parity gap: the 181-line hermetic regression test for the livelock fix (SRC/chrome-lifecycle-test.ts, commit 8da0dbb) is never ported and `_rearmIdle` is not a must-contain token (P/scripts/port-manifest.json:62-63 area), so the 80% similarity guard can lose the very fix the package exists to protect.
9. `agent-search-cutover` cannot pass as specified (10 consumer files import `./adhd/...` outside its owned paths; its probe launches `node server.mjs` with no stdio transport while the default is SSE): move it to a separate plan item; it is a USER DECISION.
10. Biggest risks: (a) ADR-0003 conflict; (b) CI-red-on-merge; (c) surface-api is design not extraction (4 of 6 verbs new); (d) e2e can write the live `/tmp/stealth-browser-heartbeat`; (e) guard-driven on-disk mutation of `src/tracing.ts` in a shared worktree. Cheapest moment to change anything is now: every `mig-*` state is independent of the API decision, so amendments cost no rework until `surface-api` starts.

---------------------------------------------------------------------------------------------------

## 2. METHOD

### 2.1 Rubric

Critical path = the set of states that must be true for the migration to be done AND defensible, judged against the objective sentence, not against the plan's own DoD.

| Class | Meaning | Test |
|---|---|---|
| A | User-directed mandatory | Appears in the user's directives: name `@adhd/stealth-browser` in `entrypoint/`; built with the workspace generator matching entrypoint structure; one branch/dir with non-overlapping buckets; ONE blind review after migration; ONE implementer resolving all findings; apigen tracing plugin with confirmed namespacing; doc-steward marketing run then content-marketer README; productization review by product (P1-P10 folded) |
| B | Migration-correctness necessary | Behavior-preserving; builds/tests/lints under nx (CLAUDE.md:33-34, 181-183); matches entrypoint conventions (CLAUDE.md:80, 88); publishable/consumable (PUBLISHING.md:9-33); real-component proof (CLAUDE.md:213-222); security of what the new hosts newly expose |
| C | Valuable but deferrable | Improves the product around the migration but no part of the objective or an A item fails without it |
| D | Unnecessary / scope creep | Duplicates another gate, contradicts an ADR, or solves a problem the migration did not create |

An apigen tracing plugin has nothing to mount on unless the package has an apigen engine and at least one host, so a minimal `src/api.ts` + host is class B by implication of A (and `src/api.ts`, `bin/cli.ts` are in the entrypoint structure, P/contexts/_shared.md ref:entrypoint-structure).

Items the user directed are never classed D here. Where I recommend dropping something the user (or the user's product review) added, it is flagged USER DECISION in section 7.

### 2.2 Longest dependency chains (computed from dag.json `depends_on`, P/dag.json:17-511, with a script; edges to removed states dropped)

| Graph | States | Longest chain (states) | Chain |
|---|---|---|---|
| Whole DAG | 34 | 26 | productization-hold > scaffold > entrypoint-parity > deps-install > mig-foundation > mig-cdp > mig-domains-storage > mig-queries > surface-api > **prod-public-api** > surface-hosts > tracing-plugin > **prod-examples** > **prod-publish-readiness** > tests-e2e > tracing-namespace-proof > gates-first > review-prep > audit-migration-blind > resolve-findings > gates-rerun > docs-marketing-run > readme-rewrite > **audit-final** > merge-readiness > **agent-search-cutover** |
| V1: class A+B (prod-* x4 and cutover removed; audit-final kept as script gate) | 29 | 22 | same chain minus the four bold prod-* and the cutover: ... surface-api > surface-hosts > tracing-plugin > tests-e2e > tracing-namespace-proof > gates-first > ... > readme-rewrite > audit-final > merge-readiness |
| V2: V1 + `tracing-namespace-proof` no longer waits for `tests-e2e` | 29 | 21 | removes tests-e2e from the chain (requires the in-process mutation change in section 5, item U9) |
| V3: V2 + `mig-cdp`, `mig-chrome-manager`, `mig-domains-storage`, `mig-queries`, `mig-capture-parsers`, `mig-docs` all depend only on `mig-foundation` | 29 | 19 | productization-hold > scaffold > entrypoint-parity > deps-install > mig-foundation > mig-chrome-manager > surface-api > surface-hosts > tracing-plugin > tracing-namespace-proof > gates-first > review-prep > audit-migration-blind > resolve-findings > gates-rerun > docs-marketing-run > readme-rewrite > audit-final > merge-readiness |

Remaining from the current point (three states complete): whole DAG 23 serial states (script), V1 19 (22-3), V3 16 (19-3).
Waves in the plan README are 26 (P/README.md:76-101).
Wall-clock/tokens: no per-state token telemetry exists in `events.ndjson` (423 events, keys ts/plan/slug/phase/kind/by/lifecycle/event_type/outcome/iteration/start_ref/end_ref/detail/complete; no token fields). Observed durations: scaffold ~13 min, entrypoint-parity ~1.4 min (state.json:15-16, 22-23). Plan authoring alone spanned 09:58 to 10:52 (events.ndjson first event 2026-10-12T09:58:22Z; productization-hold start 10:52Z). Per-state token cost is not estimable from the DAG (hypothesis: ~7 min mean per work state on n=2, no basis to extrapolate).

### 2.3 Facts the assessment rests on (all opened)

- The source README already names itself `@adhd/stealth-browser` and declares the five import paths `/cdp /storage /capture /parsers /chrome-manager` with a quickstart that imports from them (SRC/adhd/README.md:1,14-22,41-103). The nested `adhd/cdp-connection` is a private package `@adhd/cdp-connection` (SRC/adhd/cdp-connection/package.json). The pre-existing barrel is `SRC/cdp-query-client.ts` (outside `adhd/`).
- `adhd/` contains no tests. The only tests touching it are `SRC/chrome-lifecycle-test.ts` (181 lines, hermetic ChromeManager idle-deferral regression), `search-guard-test.ts`, `e2e-test.ts` (all at the agent-browser root). `package.json:test:lifecycle` runs the first (SRC/package.json scripts).
- Ground truth for the verbs: `search-mcp-source.ts` exports `chromeStatus()` (line 454, hard-codes `127.0.0.1:9222`), `launchChrome()` (472, no inputs, calls `chrome.ready()`), `shutdownSearchChrome()` (491, soft shutdown). `listPageTargets` is a CDP helper (adhd/cdp-connection/src/targets.ts:103), `checkChromeActivity` is a query (search/queries/activity.ts:5), `getPageContext(targetId, cdpHost)` is a query (search/queries/context.ts:14) and takes a `targetId`. There is no `shutdownChrome` anywhere (rg over agent-browser).
- Consumers of the old paths: 10 files outside the cutover's owned paths import `./adhd/...` directly: `search-network.ts:10,12`, `search-dom.ts:13-15`, `search-tripwire.ts:22`, `search-challenge.ts:15-16`, `search-fetch.ts:20-21`, `search-mcp-source.ts:35-36`, `cdp-search.ts:25-34`, `network-capture.ts:20-21`, `search-guard-test.ts:45`, `chrome-lifecycle-test.ts:39-40`, plus `cdp-query-client.ts` and `search/queries/*.ts`.

---------------------------------------------------------------------------------------------------

## 3. STATE-BY-STATE TABLE (all 34)

Legend: CP = on the A+B critical path (V1 chain, section 2.2); status per state.json. Criteria dispositions: KEEP / TRIM (keep, reword or shrink) / DROP / SPLIT-OUT (move to a new state or backlog). Criterion ids are exact (`<state>.N`, P/contexts/<state>.md and P/scripts/criteria.json). Bookkeeping criteria "Only owned paths changed by [psm:<state>] commits" appear 24 times; they enforce the user-directed non-overlapping-buckets directive and are KEEP everywhere (cheap, class A) unless noted.

| # | State | Class | CP | Status | Reason |
|---|---|---|---|---|---|
| 1 | productization-hold | A | yes | complete | User-directed product review. Done. |
| 2 | scaffold | A | yes | complete | Generator + name + dir directives. Done. |
| 3 | entrypoint-parity | A | yes | complete | "Match the entrypoint structure". Done. |
| 4 | deps-install | B | yes | in_progress | Three parser deps need install + approval (P/APPROVALS.md granted). |
| 5 | mig-foundation | B | yes | pending | types/session/helpers; root of the port. |
| 6 | mig-cdp | B | yes (V1) | pending | cdp-connection to `src/lib/cdp/`. |
| 7 | mig-chrome-manager | B | no (V1) / yes (V3) | pending | ChromeManager; the package's reason to exist. |
| 8 | mig-domains-storage | B | yes (V1) | pending | domains + read-only SQLite. |
| 9 | mig-capture-parsers | B | no | pending | capture + parsers; part of "the package", not needed by the six verbs. |
| 10 | mig-queries | B | yes (V1) | pending | activity/context queries feed two verbs. |
| 11 | mig-docs | B (low) | no | pending | Ports the package's own docs (cheap, sonnet/low). |
| 12 | surface-api | B | yes | pending | Required for any entrypoint + for tracing; it is DESIGN, not extraction. |
| 13 | surface-hosts | A/B | yes | pending | Hosts are what the tracing directive mounts on; carries the new security exposure. |
| 14 | tracing-plugin | A | yes | pending | User directive. |
| 15 | tests-unit-core | B | no | pending | Unit coverage for foundation/cdp/chrome-manager. |
| 16 | tests-unit-data | B | no | pending | Unit coverage for domains/storage/queries. |
| 17 | tests-unit-extract | B | no | pending | Unit coverage for capture/parsers. |
| 18 | tests-unit-surface | B | no | pending | Host-level security tests (P1/P2) live here. |
| 19 | tests-e2e | B | yes | pending | Real-component proof (CLAUDE.md:213-215); needs CI decision. |
| 20 | tracing-namespace-proof | A | yes | pending | "Confirm correct namespacing." |
| 21 | gates-first | B | yes | pending | Review input must be gate-green. Also dod.6. |
| 22 | review-prep | A | yes | pending | Mechanics of the ONE blind review. |
| 23 | audit-migration-blind | A | yes | pending | The ONE blind review. |
| 24 | resolve-findings | A | yes | pending | ONE implementer. |
| 25 | gates-rerun | B | yes | pending | dod.6 requires gates re-run green. |
| 26 | docs-marketing-run | A | yes | pending | doc-steward. |
| 27 | readme-rewrite | A | yes | pending | content-marketer. |
| 28 | audit-final | B (trim to script) | yes | pending | `audit_dod.py` routes dod.1,4-8 through `audit-final.*` (audit_dod.py:37-52); keep as a script gate, drop the architect-reviewer agent. |
| 29 | merge-readiness | B | yes | pending | The ff-only merge IS "into adhd". Re-parent to readme-rewrite if audit-final is removed; keep as is otherwise. |
| 30 | agent-search-cutover | C | no | pending | Different repo, different live system, cannot pass as specified (section 4 M-1); USER DECISION. |
| 31 | prod-public-api | C (blocked by ADR) | no | pending | Exists only to support the `./legacy` exports map (ADR-0003 violation). |
| 32 | prod-errors | C | no | pending | Typed error codes; keep only a Node preflight. |
| 33 | prod-examples | C | no | pending | Examples; README receipts already cover first-run. |
| 34 | prod-publish-readiness | C (folded) | no | pending | Fields already written by entrypoint-parity.4 (P/entrypoint/stealth-browser/package.json:5-35); dry-run folds into gates-first. |

### 3.1 Criteria-level dispositions

**productization-hold** (complete)
- .1 KEEP (STATUS: folded). .2 TRIM: it requires every INSERTED state to exist in dag.json (contexts/productization-hold.md .2); if the four prod-* states are removed, either change `INSERTED:` in PRODUCT-REVIEW.md:2 to the retained states or record an amendment_log entry. .3 TRIM: the "every prod-* is an ancestor of gates-first" rule is the sole reason `tests-e2e` waits on `prod-examples` and `prod-publish-readiness` (dag.json:281-284); reduce to "dag.json acyclic". State is already complete, so this is an amendment, not a rerun.

**scaffold** .1-.8 KEEP (complete; `.6` main node_modules mtime stamp and `.7` source baseline remain useful). Note `.7` bakes a tree-sha freeze of SRC/adhd (see M-9).

**entrypoint-parity** .1-.7 KEEP (complete). `.7` (engines.node >=22.5) rests on `node:sqlite`; whether 22.5 needs a flag is `(hypothesis)` unverified (TOOLS.md:48,63 asserts only `@types/node` includes it).

**deps-install** (in progress). .1 KEEP. .2 KEEP. .3 KEEP. .4 TRIM: "zero '-' lines in the lockfile diff" is brittle in pnpm (importer insertion can re-sort neighbours) `(hypothesis)`; restate as "no resolved version of an existing package changes". .5 KEEP. .6 KEEP.

**mig-foundation** .1 KEEP, .2 KEEP, .3 KEEP, .4 KEEP (alias `getSearchSessionId` is cheap and consumers use it: search-tripwire.ts:22, cdp-search.ts:34).

**mig-cdp** .1-.3 KEEP; .4 KEEP (drops nested package and .js twins; mandated by the one-package approval, APPROVAL.md).

**mig-chrome-manager** .1-.3 KEEP. .4 SPLIT: keep heartbeat path + three-tier shutdown, and ADD `.5` "the idle-deferral livelock invariant is preserved: `_rearmIdle` exists and deferral does not write the heartbeat" with `_rearmIdle` added to `must_contain` for `adhd/chrome-manager.ts` (currently only `/tmp/stealth-browser-heartbeat`, `shutdownIfIdle`, port-manifest.json chrome-manager entry; `_rearmIdle` at SRC/adhd/chrome-manager.ts:144,250,267,278).

**mig-domains-storage** .1-.4 KEEP (.4 read-only/immutable SQLite is a hard behavior invariant).

**mig-capture-parsers** .1-.3 KEEP. .4 KEEP (low cost). .5 KEEP.

**mig-queries** .1-.3 KEEP; .4 KEEP (`last-search.ts` is search-specific).

**mig-docs** .1-.3 KEEP. Add (low) the lifecycle doc `SRC/docs/agent-search/lifecycle.md` (heartbeat semantics) to the manifest; it is not in port-manifest.json.

**surface-api**
- .1 KEEP. .2 KEEP (oneOf boolean quirk, search-mcp-source.ts:440-453). .3 TRIM: rewrite per D1' (section 7): old-barrel names plus the deep-imported names resolve from the root as namespaces (`cdp`, `storage`, `capture`, `parsers`, `chromeManager`); no `./legacy` (ADR-0003). .4 KEEP. .5 KEEP (no env reads; needed for parity). .6 KEEP.
- .7 KEEP (security) but TRIM the content: host-exposed `launchChrome` input = `port` only; `userDataDir`, `chromePath`, `extraArgs` library-only (an exposed `userDataDir` lets an MCP caller aim Chrome at the developer's real profile, SRC/adhd/helpers.ts:40,44; medium).
- .8 TRIM: replace the `evidence/product-claims.json` artifact by two assertions in `tests-unit-surface.4` (cookie values returned? redaction applied?); the claims are checkable facts, not process artifacts.
- .9 KEEP (TSDoc >=40 chars is what the MCP tool description is built from).

**surface-hosts** (13 criteria)
- .1 KEEP, .2 KEEP, .3 KEEP, .4 KEEP, .5 KEEP, .6 KEEP.
- .7 KEEP (security: no spawn on `extraArgs`).
- .8 KEEP (cookie value redaction at host projection; library unchanged for parity).
- .9 TRIM: "package.json exports a ./legacy subpath" violates ADR-0003:11,41,43 (no `exports` map). Keep only "built root index.d.ts resolves and `nx run stealth-browser:verify-dist-load` exits 0".
- .10 TRIM: keep tool-description length; keep `--help` default-port text only.
- .11 TRIM: keep the naming decision itself (U1/U2 in demo/UNRESOLVED.md must be resolved), drop the separate `evidence/naming-decision.md` artifact; record it in the state commit message and AGENTS.md.
- .12 SPLIT: keep the one-line Node >=22.5 preflight in `bin/cli.ts`/`bin/mcp.ts` and the `CHROME_NOT_RUNNING` mapping (CLI non-zero without stack; MCP `isError`). SPLIT-OUT the other typed codes (`PORT_IN_USE`, `NODE_TOO_OLD`, `CHROME_NOT_FOUND`) to backlog.
- .13 TRIM: `--port` only. SPLIT-OUT `--user-data-dir`.

**tracing-plugin**
- .1 KEEP, .2 KEEP, .3 KEEP, .4 KEEP, .5 KEEP, .6 KEEP (user directive; mirrors backlog/src/tracing.ts, `_shared.md` ref:backlog-tracing).
- .7 TRIM: keep "MCP host path writes nothing to stdout except JSON-RPC" (protocol correctness); SPLIT-OUT the `--verbose` flag.
- .8 KEEP (pins to what plugin.ts emits; backlog 5152786d).

**tests-unit-core / -data / -extract** (identical shape .1-.5)
- .1 KEEP (a spec per ported module; the port ships with no `adhd/` tests so these are new tests, not ported ones). .2 KEEP. .3 KEEP (unit purity, ADR-0009 D1). .4 TRIM: "at least as many expect() calls as test cases" is a count proxy; replace in `tests-unit-core` with named behaviors: (i) the livelock invariant ported from `chrome-lifecycle-test.ts`, (ii) heartbeat path override, (iii) three-tier shutdown; in `-data`, immutable-open and a malformed-row case; in `-extract`, `decideRetry` stop-on-ban and empty-xpath no-throw (UC-15, UC-17). .5 KEEP.
- tests-unit-core ADD `.6`: ports `SRC/chrome-lifecycle-test.ts` (181 lines) as a spec.

**tests-unit-surface** .1 KEEP. .2 KEEP. .3 KEEP. .4 KEEP (PA1.2/PA1.3/PA2.2 are the security regression proof). Add: absorb the two claims formerly in `surface-api.8`.

**tests-e2e**
- .1 KEEP, .2 KEEP, .4 KEEP, .5 KEEP.
- .3 SPLIT: keep "no mocks, dedicated port, temp profile, fake HOME, kill own PID" and ADD `.8` "the harness isolates the heartbeat file (the live `/tmp/stealth-browser-heartbeat` is never read or written)". Today the default is the absolute path (SRC/adhd/chrome-manager.ts:35,45,69) and a fake HOME does not isolate it; `[inv:live-chrome]` only covers port 9222 (_shared.md).
- .6 KEEP (live proof that cookie values never leave over MCP/CLI).
- .7 TRIM: keep "every stdout line of the MCP bin is JSON-RPC"; drop `--verbose`.
- ADD `.9` CI platform decision: the harness resolves Chrome per platform (browser.ts has darwin/linux/win32 cases, SRC/adhd/cdp-connection/src/browser.ts:39-43) instead of the hard-coded macOS path, OR the target documents and enforces the approved gate per CLAUDE.md:228-234.

**tracing-namespace-proof**
- .1 KEEP, .2 KEEP, .3 KEEP, .5 KEEP, .6 KEEP.
- .4 TRIM: the guard rewrites `src/tracing.ts` on disk twice, running nx test between, in the shared worktree (guard.py:856-872). If the guard is killed (timeouts 1500s each) the file stays flipped to `'apigen'`; CLAUDE.md:19 cites exactly this failure class. Keep the teeth (mutated variant must fail) but exercise it on a temp copy or in-process via a second `makeTracingPlugin({serviceName:'apigen'})` positive control. That also removes the dependency on `tests-e2e` (dag.json:296-298), which exists because the mutation would race the e2e build.

**gates-first** .1-.7 KEEP. ADD `.8` (from prod-publish-readiness .3/.4/.5): `npm pack --dry-run` against dist lists README, CHANGELOG, `bin/cli.js`, `bin/mcp.js`, exports targets; bin shebangs; no unpublished `@adhd/*` dependency. Rationale: PUBLISHING.md:9-33 (publish-from-dist) is the real consumption path.

**review-prep** .1-.4 KEEP (class A: the blind-review input is the diff + the word `Review`, CLAUDE.md-global "Blind Review").
**audit-migration-blind** .1-.4 KEEP.
**resolve-findings** .1-.4 KEEP.
**gates-rerun** .1-.7 KEEP.

**docs-marketing-run**
- .1 KEEP, .2 KEEP, .3 KEEP, .4 KEEP (class A).
- .5 TRIM: README and CHANGELOG are build inputs (CLAUDE.md:192 production inputs hash README), so "gate evidence still matches the tree" cannot hold after a README change; reword to "no change under `src/`".
- .6 TRIM: fold the defaults table (port 9222, Chrome-CDP profile, heartbeat path) into README/AGENTS.md; SPLIT-OUT a standalone `CONFIGURATION.md`.
- .7 TRIM: keep the two-flag definition of "stealth" and a responsible-use section INSIDE the README (the "more exciting readme" directive carries over-claim risk); SPLIT-OUT a standalone `RESPONSIBLE-USE.md`.
- .8 KEEP (overclaim word scan; cheap mitigation for the user-directed marketing step).
- .9 TRIM: one README/AGENTS paragraph documenting `adhd.<op>.start|finish|error`; SPLIT-OUT standalone `OBSERVABILITY.md` and the `--verbose` text.

**readme-rewrite** .1-.5 KEEP. .6 KEEP (defines stealth; link target becomes the README section). .7 KEEP. .8 TRIM to one sentence (0.x, six verbs stable).

**audit-final**
- .1-.4 KEEP. .5 TRIM: dod.5 "source untouched until cutover" becomes "source untouched" if the cutover is split out; also replace the byte-for-byte tree freeze with a recorded baseline plus drift report (M-9). .6, .7, .8 KEEP.
- .9 KEEP but move to gates-first.8; NOTE a plan defect: contexts/audit-final.md lists `.9` and `.10` with identical citation text, while guard.py:2075 makes `.9` the tarball check and guard.py:1324-1330 makes `.10` the citation re-run; README.md:117 says `.10` is the tarball. .10 DROP (duplicate of gates-first.7 / audit-final.9 citation rule).
- audit-final.ref-backlog-tracing / ref-entrypoint-structure / ref-apigen-host / ref-runner-port KEEP (guard.py:1488-1494; conformance proofs against siblings).
- Executor: replace `architect-reviewer` (README.md:72) by running `audit_dod.py --phase final`; a second reviewer agent after the user's ONE blind review is in tension with "ONE blind review" `(user decision, section 7)`.

**merge-readiness** .1 KEEP, .2 KEEP, .3 KEEP. .4 KEEP only if `CONSUME: link:` is chosen.

**agent-search-cutover** (7 criteria; whole state SPLIT-OUT to its own plan item, section 7 D2): .1 KEEP in the new plan; .2 KEEP; .3 TRIM (needs every consumer file listed in section 2.3 in scope, see M-1); .4 TRIM (transport, see M-1); .5 KEEP; .6 KEEP; .7 TRIM per D1' (no `./legacy`).

**prod-public-api** (5 criteria) .1 TRIM (export snapshot spec KEEP as a `tests-unit-surface` case: root export names must not drift); .2 DROP (it is the legacy split); .3 DROP (`PageSource` alias is C); .4 DROP (tier tagging is C); .5 DROP. State removed.
**prod-errors** .1 SPLIT-OUT (only `CHROME_NOT_RUNNING` retained inline in surface-hosts.12); .2 SPLIT-OUT; .3 DROP. State removed.
**prod-examples** .1 TRIM (one `examples/library.ts` typechecked under `typecheck-spec` is enough; README receipts cover CLI/MCP); .2 KEEP (as a gates-first sub-check) ; .3-.5 SPLIT-OUT. State removed.
**prod-publish-readiness** .1 DROP (already satisfied by entrypoint-parity.4/.7 and the scaffolded manifest); .2 KEEP as one line in gates-first; .3-.5 move to gates-first.8; .6 DROP. State removed.

---------------------------------------------------------------------------------------------------

## 4. MISSING (what a migration of this kind needs and the plan lacks)

Severity: blocking / high / medium / low. "Home" = existing state to amend, or a new state with owned paths that do not overlap anything in P/scripts/ownership.json.

| ID | Gap | Severity | Evidence | Proposed home |
|---|---|---|---|---|
| M-1 | The plan breaks accepted ADR-0003: adds an `exports` map for `./legacy`. | blocking | ADR-0003:11 ("no `exports` map"), :41, :43 ("deliberately not added"), :88 (rejected); plan: PRODUCT-REVIEW.md:8,45, guard.py:1797 (`surface-hosts.9`), contexts/surface-api.md:35 | amend `surface-api.3`, `surface-hosts.9`; remove `prod-public-api`; see D1' |
| M-2 | Merge turns main CI red: CI runs `nx affected -t e2e --parallel=1` on ubuntu-latest, Node 22; the new e2e requires a macOS Chrome path and macOS profile helpers. Product's own review deferred "CI without Chrome" (PRODUCT-REVIEW.md:138). | blocking | .github/workflows/ci.yml:15,37,97; P/human-blockers.json (hb-chrome-binary verifies `/Applications/Google Chrome.app/...`); SRC/adhd/helpers.ts:40,44 (macOS-only profile paths); CLAUDE.md:34,228-234 (no silent gating; CI runs e2e) | amend `tests-e2e` (.3, add .9); decide runner support or an ADR-0009-style documented gate |
| M-3 | Behavior-parity evidence is static only (export names, 80% line similarity, token presence) and misses the newest fix: `_rearmIdle` livelock guard (commit 8da0dbb) and its test are not carried. | high | guard.py:267-269 (80% ratio); port-manifest.json chrome-manager entry (`must_contain` = heartbeat path, `shutdownIfIdle` only); SRC/adhd/chrome-manager.ts:9-14,144; SRC/chrome-lifecycle-test.ts:1-30; `rg "_rearmIdle|livelock"` over P returns nothing | amend `mig-chrome-manager` (.5), `tests-unit-core` (.6) |
| M-4 | e2e can contaminate the developer's live agent-search: `heartbeatPath` defaults to absolute `/tmp/stealth-browser-heartbeat`, a fake HOME does not isolate it, and a stray heartbeat from the e2e would make live servers defer shutdown (the livelock class). | high | chrome-manager.ts:35,45,69; contexts/tests-e2e.md has no heartbeat clause (`rg heartbeat` over tests-e2e.md and surface-api.md: no match) | amend `tests-e2e` (.8); in `surface-api` derive `heartbeatPath` from the port when port != 9222 (default behavior unchanged) |
| M-5 | The "six verbs extracted from search-mcp-source.ts:454-495 (40 lines delegating)" premise is false; four verbs are new design (`shutdownChrome`, `listPageTargets`, `checkChromeActivity`, `getPageContext` as verbs; `launchChrome` gains inputs; `getPageContext` needs `targetId`, the demo calls it with none). Behavior-preservation guards do not cover this layer. | high | SCOPE.md:22; README.md:17; TOOLS.md G2/§4; search-mcp-source.ts:454,472,491; context.ts:14; UC-10 (USE_CASES.md) | `surface-api`: add a criterion that each verb's contract (inputs, defaults, error shape) is written in TSDoc and covered by `tests-unit-surface`; correct SCOPE/README text |
| M-6 | The plan discards the source's intentionally designed public surface (5 import paths) in favour of a new six-verb root; no criterion keeps the source's module grouping. | high | SRC/adhd/README.md:14-22; the plan's only subpath is `./legacy` (`rg subpath` over P) | `surface-api`/`index.ts`: namespace exports (D1') |
| M-7 | Consumer migration cannot succeed as written: the cutover covers `cdp-query-client` barrel names only, but 10 deep-imported names (CdpSession, humanPause, createIsolatedPageTarget, awaitPageSettled, ensureChromeRunning, getChromeInfo, hideAllWindows, killChrome, isChromeReachable, IdleShutdown) and `extractResultsFromEmbeddedJson` are consumed outside the barrel, from files the cutover does not own. | high (if cutover kept) | files and lines in section 2.3; contexts/agent-search-cutover.md .5 allows only `adhd/`, `cdp-query-client.ts`, `search/queries/`, `package.json`, docs; surface-api.3 lists barrel names only | new plan item for the cutover with owned paths = all 10 consumer files + INDEX.md (scratch rule: INDEX.md updated on folder change, scratch/CLAUDE.md "After every update to script folders update the INDEX.md entry") |
| M-8 | Cutover probe is wrong: guard runs `node server.mjs` with no `--transport stdio`/`SEARCH_MCP_TRANSPORT`; server default is SSE, so a stdio JSON-RPC client gets nothing. | high (if cutover kept) | guard.py:1454; SRC/server.mjs:93 (`?? 'sse'`), :13,78 | fix in the new cutover plan |
| M-9 | Source drift: the plan freezes `agent-browser/adhd` by git tree sha for the whole run, but this directory is actively maintained (commits 8da0dbb, 1ac0abf, 63019c8 on chrome-manager/lifecycle). A legitimate fix landing there turns `source_untouched` red, or worse, lands on the old copy and never reaches the new one. | medium | guard.py:160-170; source-baseline.txt (`tree d7d06e10...`); `git log` on adhd/chrome-manager.ts | `audit-final.5`/`merge-readiness`: record baseline and report diffs (`git diff <baseline> -- agent-browser/adhd`) instead of failing; port deltas or ack |
| M-10 | Source package disposition is undecided for the migration objective itself. After the merge the scratch copy (~4,200 lines in 37 files) and the new package both exist; SCOPE.md:30 puts publishing out of scope and the cutover is conditional on `hb-release-decision`. A "migration" with two live copies has no recorded end state. | medium | README.md:21; dag.json:436-452; USE_CASES UC-30/31 | D2: either the follow-on plan, or a one-line "MOVED" note decision recorded in `merge-readiness` |
| M-11 | Tests: all unit tests are rewritten from scratch; none of the three existing test files is ported; the only teeth requirement is a count heuristic (see tests-unit-*.4). Per user memory ("a case that changes no source and asserts no data cannot fail") this is the known failure mode. | medium | contexts/tests-unit-core.md .4; SRC `chrome-lifecycle-test.ts`, `search-guard-test.ts` | `tests-unit-core.6`; replace `.4` proxy with named behaviors |
| M-12 | Licence and supply-chain check for the three new dependencies is absent (approval exists, licence/CVE/maintenance evidence does not). | low | P/APPROVALS.md; `rg -i licen` over P finds only the package.json field checks | `deps-install` add one line to APPROVALS.md or the commit: licence per dep `(hypothesis: all MIT, unverified)` |
| M-13 | Release plumbing: the post-publish clean-room smoke names its bin-shipping entrypoints explicitly; a new bin package is not on it. | low | PUBLISHING.md:205 | `merge-readiness` note or follow-on |
| M-14 | `package.json` carries a `module` field while ADR-0003 says no `module` field; siblings also do (dispatch-cli/package.json: `"module": "./dist/index.mjs"`), so parity and ADR disagree. | low | entrypoint/stealth-browser/package.json:9; ADR-0003:41 | follow-up with the repo-wide ADR-0003 migration; do not fix in this plan |
| M-15 | Plan self-consistency: SCOPE.md says 30 states and 154 criteria (SCOPE.md:63,67), final-review.md says 155/30 (final-review.md:26), README says 34 (README.md:35), criteria.json holds 201 (`jq`-equivalent count) and contexts list 199. `audit-final.9/.10` text swapped (section 3). | low | cited lines | doc touch-ups when amending |
| M-16 | CDP surface hardening: loopback binding is by default only (`--remote-debugging-port`, no `--remote-debugging-address`, SRC/adhd/cdp-connection/src/browser.ts:99), `listPageTargets` returns every tab URL of the user's browser into an agent transcript (URLs can carry tokens), and `getPageContext` returns cookies. Only cookie values are redacted. | medium | PRODUCT-REVIEW.md P1/P2 only; contexts/surface-hosts.md | `surface-hosts.8`: also redact URL query strings in host projection `(hypothesis: needs product decision)` |
| M-17 | Rollback: only the cutover has a restore path (contexts/agent-search-cutover.md:77). Adhd-side rollback is trivial (branch unmerged). | low | same | none needed |
| M-18 | Not a gap, confirmed covered: nx tag/module-boundary constraints and codegen conformance are enforced by `entrypoint-parity.1-4` and `gates-first.1` (lint), `scaffold.5` (single project.json). | n/a | P/contexts/entrypoint-parity.md; gates-first.md | no change |

---------------------------------------------------------------------------------------------------

## 5. UNNECESSARY (scope creep and over-engineering)

| ID | Item | Evidence | Cost | Action |
|---|---|---|---|---|
| U1 | `prod-public-api`: `./legacy` subpath, `@deprecated`/`@experimental` tier tags, `PageSource` alias | PRODUCT-REVIEW.md:45; contexts/prod-public-api.md .2-.4 | 1 state, 5 criteria, 1 wave on the critical path, plus `surface-hosts.9` coupling | drop (blocked by ADR-0003 anyway); keep only the export-name snapshot as one `tests-unit-surface` case |
| U2 | `prod-errors`: typed error classes with remediation text | contexts/prod-errors.md .1-.3 | 1 state, 3 criteria, plus `surface-hosts.12` | defer-to-backlog; keep Node preflight + `CHROME_NOT_RUNNING` inline |
| U3 | `prod-examples` | contexts/prod-examples.md .1-.5 | 1 state, 5 criteria, 1 wave on the critical path, and an artificial predecessor of `tests-e2e` (dag.json:281-284) | defer; README Quickstart is receipts-backed (readme-rewrite.3) |
| U4 | `prod-publish-readiness`: fields already present | entrypoint/stealth-browser/package.json:1-35 (description, keywords, license, publishConfig, files, engines, bin all present); entrypoint-parity.4/.7 | 1 state, 6 criteria, 1 wave | fold dry-run into `gates-first.8`; drop state |
| U5 | The "every prod-* must be an ancestor of gates-first" rule | productization-hold.3 (guard) | forces 2 extra waves into the chain | amend rule text |
| U6 | `audit-final` as a second reviewer agent (architect-reviewer, sonnet/high) | README.md:72; dag.json:420 | 1 agent dispatch after the ONE blind review | keep the criteria, execute via `audit_dod.py`; flag to user |
| U7 | Standalone docs: `CONFIGURATION.md`, `RESPONSIBLE-USE.md`, `OBSERVABILITY.md` | docs-marketing-run.6,.7,.9 | 3 docs + guards, executed by doc-steward who already produces AGENTS/llms/CHANGELOG/README | fold into README sections (keep the overclaim scan .8) |
| U8 | `--verbose` flag, `--user-data-dir` flag, 40-char description guard, `evidence/naming-decision.md`, `evidence/product-claims.json` | tracing-plugin.7, tests-e2e.7, surface-hosts.10/.11/.13, surface-api.8 | ~7 criteria and 2 evidence artifacts | trim as listed in section 3 |
| U9 | On-disk source mutation by the guard (`tracing-namespace-proof.4`) | guard.py:856-872 | blocks parallelism (adds a wave) and risks a left-behind flipped file | in-process/temp-copy mutation |
| U10 | `agent-search-cutover` inside this DAG | dag.json:436-452 | 1 state, 7 criteria, last wave, unsatisfiable as written | split to own plan item (D2) |
| U11 | Three `.js`-extension, nested-package, twin-file checks and similar mechanics | mig-cdp.4 | trivial | keep (ADR/one-package mandated) |
| U12 | Duplicated criterion `audit-final.10` | guard.py:1324-1330 vs gates-first.7 | trivial | drop |
| U13 | `gates-first` and `gates-rerun` are the same 7 checks run twice | contexts/gates-first.md, gates-rerun.md | 2 states | KEEP: dod.6 requires "gates re-run green" after the ONE implementer |
| U14 | Plan-authoring overhead in the repo: `scripts/guard.py` 2,225 lines, `check-disjoint.py` 91, `check-guards-red.py` 76, `run-audit.js` 431, 34 context files; 24 "owned paths" and 17 "cites ticket" criteria | wc -l output | one-off; sunk | keep: the disjoint-bucket machinery is the user's A directive; do not add more guards (recommended guard count after trim: ~150) |

Savings summary: removing U1-U5 and U10 drops 5 states, ~28 criteria, and 4 waves from the whole-DAG critical path (26 to 22); the edge fixes in 6.2 take it to 19.

---------------------------------------------------------------------------------------------------

## 6. SEQUENCING AND PARALLELISM

### 6.1 Unnecessary serialization
1. `tests-e2e` depends on `prod-examples` and `prod-publish-readiness` (dag.json:278-284). No technical reason; caused by productization-hold.3. Cost: 2 waves.
2. `surface-hosts` depends on `prod-public-api` and `prod-errors` (dag.json:186-190). Cost: 1 wave; both only touch types and an error module.
3. `tracing-namespace-proof` depends on `tests-e2e` (dag.json:293-298) only because its guard mutates `src/tracing.ts` on disk in the shared worktree. Cost: 1 wave.
4. Mechanical ports are chained `foundation > cdp > {chrome-manager, domains-storage} > queries` (dag.json:88-153) although each is copy + specifier rewrite by the same executor class. Real dependency is only on `types/session/helpers` (foundation). The `.2` "relative imports resolve" checks create the chain; they could run once in a combined check at `gates-first`. Cost: 3 waves.
5. `tracing-plugin` and `surface-hosts` both own `src/server.ts`, `src/cli.ts`, `package.json` (ownership.json) and share an executor class, so they serialize anyway; merging them removes one wave and one handoff (optional; each remains separately guarded).
6. `audit-final` is serial after `readme-rewrite` and `merge-readiness` after it. Keep (cheap when scripted).

### 6.2 Unsafe parallelism
1. Wave 11 (`tracing-plugin` + `tests-unit-surface`): tests-unit-surface.4 drives `src/server.ts`/`src/cli.ts` in process, while tracing-plugin edits both files concurrently (dag.json:205-220, 263-275). Test churn and possible stale-mock failure. Medium. Fix: make `tests-unit-surface` depend on `tracing-plugin`, or move tracing into `surface-hosts`.
2. Guard `tracing-namespace-proof.4` writing `tracing.ts` while any other state builds (see 6.1.3); safe only because of the serialization the plan currently has. If edge 6.1.3 is removed, the mutation must move off-disk.
3. Shared files: `index.ts` is owned by `surface-api` and `prod-public-api`, `package.json` by five states; serialized by `depends_on`, so safe today. check-disjoint.py output claims 34 states, 72 concurrent pairs, 0 overlaps (README.md:37); not re-run by me.

### 6.3 Critical-path length vs total
Whole DAG: 34 states, longest chain 26. Class A+B: 29 states, chain 22. With 6.1 items 1-4 applied: chain 19 (16 states remaining from the current position). The execution is already past wave 3, so every change below is free until `surface-api` starts, and free for all `mig-*` states regardless.

---------------------------------------------------------------------------------------------------

## 7. DECISIONS FOR THE USER (only genuine decisions)

**D1' Public API shape (ADR-0003 forces a choice).** The `./legacy` exports map is not allowed. Options: (a) RECOMMENDED: keep the source's own structure as root namespace exports (`import { cdp, storage, capture, parsers, chromeManager } from '@adhd/stealth-browser'`) plus the six verbs flat; no exports map, no legacy file, no tier tags, nothing for agent-search to import from a special path; (b) six verbs only at the root, everything else reachable by deep dist path (fragile); (c) ask for an ADR-0003 amendment allowing an `exports` map (heaviest, re-opens a decision the owner closed). I reject my earlier D1 and recommend (a); this changes `surface-api.3`, `surface-hosts.9`, `agent-search-cutover.7` and removes `prod-public-api`. User decision because it re-states a product call I made in PRODUCT-REVIEW.md.

**D2 Agent-search cutover.** Keep inside this plan, or split to its own plan item. Recommendation: SPLIT. It operates in a different repo (scratch, local-only, dirty tree), on a live daily-use MCP, behind a human publish-or-link decision, and as specified cannot pass (M-7, M-8). Keep the migration state `merge-readiness` as the terminal state here and record the follow-on with its real owned path list. If the user wants a hard end-state for the source package inside this plan, the minimum is: a recorded decision (retain / mark MOVED / delete) at `merge-readiness`.

**D3 Host surface width.** Decide how much product surface ships in this migration. Recommendation: security-mandatory only (P1 allowlist = port only, P2 cookie-value redaction, stdout-clean MCP, Node preflight, `CHROME_NOT_RUNNING` mapping); defer typed error codes, `--verbose`, `--user-data-dir`, standalone docs, examples dir, tier tags (they are in section 3 as SPLIT-OUT and go to backlog under component 24cfccf0).

**D4 Second reviewer.** `audit-final` run by an architect-reviewer agent after the ONE blind review. Recommendation: run it as `audit_dod.py` only, to preserve the "ONE blind review" intent. Needs the user's call because it touches a stated directive.

**D5 CI posture for the e2e lane (M-2).** (a) RECOMMENDED: make the harness platform-aware (use the browser.ts platform detection) so the existing ubuntu `e2e` lane runs it; (b) mark the target env-gated with the documented owner approval required by CLAUDE.md:228-234 (README + AGENTS + test header); (c) accept red CI. Choose before `tests-e2e` starts.

**D6 Keep the tracing mutation check (A, user-directed namespacing proof).** Keep, but run it on a temp copy/in-process (recommended). No user decision unless they prefer the current on-disk form.

**D7 Number of guards.** Recommendation: keep all structural guards that enforce an A directive (ownership, single package, parity, blind review, one implementer); drop or fold the productization guards listed in section 3. Net: ~201 to ~150 criteria. No user decision needed unless D3 is rejected.

---------------------------------------------------------------------------------------------------

## 8. RECOMMENDED AMENDED DAG (apply mechanically)

Status key: C = complete, R = running, P = pending. "free" = change costs no rework; "gated" = needs the named decision first.

### 8.1 Retained states (29)
| Order | State | Status | Action | depends_on (final) | Criteria changes |
|---|---|---|---|---|---|
| 1 | productization-hold | C | amend_log only | [] | .2/.3 reword (INSERTED line) |
| 2 | scaffold | C | none | [productization-hold] | none |
| 3 | entrypoint-parity | C | none | [scaffold] | none |
| 4 | deps-install | R | none (finish) | [entrypoint-parity] | .4 TRIM |
| 5 | mig-foundation | P | none | [deps-install] | none |
| 6 | mig-cdp | P | edge fix (free) | [mig-foundation] | none |
| 6 | mig-chrome-manager | P | edge fix + add .5 | [mig-foundation] | .4 SPLIT, ADD .5 |
| 6 | mig-domains-storage | P | edge fix | [mig-foundation] | none |
| 6 | mig-capture-parsers | P | none | [mig-foundation] | none |
| 6 | mig-queries | P | edge fix | [mig-foundation] | none |
| 6 | mig-docs | P | add lifecycle.md to manifest | [mig-foundation] | none |
| 7 | surface-api | P (gated D1') | amend | [mig-chrome-manager, mig-queries, mig-capture-parsers, mig-cdp, mig-domains-storage] | .3 TRIM, .7 TRIM, .8 TRIM, ADD verb-contract criterion (M-5) |
| 8 | surface-hosts | P (gated D1', D3) | amend; drop edges to prod-public-api, prod-errors | [surface-api] | .9 TRIM, .10 TRIM, .11 TRIM, .12 SPLIT, .13 TRIM |
| 9 | tracing-plugin | P | amend | [surface-hosts] | .7 TRIM |
| 10 | tracing-namespace-proof | P (gated D6) | drop edge to tests-e2e | [tracing-plugin] | .4 TRIM |
| 10 | tests-e2e | P (gated D5) | drop edges to prod-examples, prod-publish-readiness | [tracing-plugin] | .3 SPLIT, ADD .8, .9; .7 TRIM |
| 7+ | tests-unit-core | P | none | [mig-chrome-manager] | .4 TRIM, ADD .6 |
| 7+ | tests-unit-data | P | none | [mig-queries] | .4 TRIM |
| 7+ | tests-unit-extract | P | none | [mig-capture-parsers] | .4 TRIM |
| 10 | tests-unit-surface | P | add dep on tracing-plugin | [surface-api, surface-hosts, tracing-plugin] | .4 absorbs claims; add export-snapshot case |
| 11 | gates-first | P | amend | [tests-unit-core, tests-unit-data, tests-unit-extract, tests-unit-surface, tracing-namespace-proof, tests-e2e, mig-docs] | ADD .8 (pack dry-run, shebang, no unpublished dep) |
| 12 | review-prep | P | none | [gates-first] | none |
| 13 | audit-migration-blind | P | none | [review-prep] | none |
| 14 | resolve-findings | P | none | [audit-migration-blind] | none |
| 15 | gates-rerun | P | none | [resolve-findings] | none |
| 16 | docs-marketing-run | P | amend | [gates-rerun] | .5 TRIM, .6 TRIM, .7 TRIM, .9 TRIM |
| 17 | readme-rewrite | P | amend | [docs-marketing-run] | .8 TRIM |
| 18 | audit-final | P (gated D4) | executor -> script | [readme-rewrite] | .5 TRIM, .9 moved, .10 DROP |
| 19 | merge-readiness | P | none | [audit-final] | .4 conditional |

### 8.2 Removed or deferred (5)
| State | Action | Where the content goes |
|---|---|---|
| prod-public-api | remove (gated D1') | export-name snapshot becomes a tests-unit-surface case |
| prod-errors | defer to backlog | `CHROME_NOT_RUNNING` + Node preflight stay in surface-hosts.12 |
| prod-examples | defer to backlog | one `examples/library.ts` optional |
| prod-publish-readiness | remove | .3-.5 become gates-first.8; fields already present |
| agent-search-cutover | split to own plan item (gated D2) | new plan with owned paths = 10 consumer files + INDEX.md, transport fix, deep-import coverage |

State.json bookkeeping: removed states must also be deleted from `state.json`, `ownership.json`, `criteria.json` and contexts (use `plan-scaffold.js` verbs per README.md:118: add-state / set-reservation / add-criterion; there is no remove verb in the README recipe `(hypothesis: confirm against the skill)`); re-run `check-disjoint.py` and `check-guards-red.py` after every change (README.md:118).

### 8.3 User-directed items preserved
Package name and location (scaffold, entrypoint-parity); generator build (scaffold); one branch/dir with disjoint buckets (ownership machinery retained, all `Only owned paths` criteria KEEP); ONE blind review (review-prep, audit-migration-blind); ONE implementer (resolve-findings); apigen tracing with confirmed namespacing (tracing-plugin, tracing-namespace-proof incl. mutation teeth); doc-steward run then content-marketer README (docs-marketing-run, readme-rewrite); productization review by product (productization-hold, P1/P2 security items retained, P3-P9 reduced per D3; P10 folded into gates-first.8; P11 stays backlog). Items I recommend changing that touch a directive and are therefore user decisions: D1' (reverses my own D1), D2, D4.

### 8.4 What can change now without rework
- Free now (nothing downstream has started): every edge fix, every mig-* criterion change, removal of prod-* states, tests-* criterion changes, docs/readme criterion changes, audit-final executor change.
- Free until `surface-api` starts: D1' (API shape), D3 (host width). Pre-decision state `deps-install` (running) is unaffected by all of the above.
- Rework risk if delayed: any change after `surface-api` or `surface-hosts` completes requires editing shipped code (api.ts exports, package.json, bins).

---------------------------------------------------------------------------------------------------

## Items for the dispatcher to file (not filed by me; read-only brief)

1. Plan defect: contexts/audit-final.md lists `.9` and `.10` with the same citation text; guard.py:2075 makes `.9` the tarball check; README.md:117 says `.10` is the tarball.
2. Plan defect: state/criteria counts disagree across SCOPE.md:63,67, final-review.md:26, README.md:35, criteria.json (201), contexts (199).
3. Plan defect: guard `agent-search-cutover.4` starts `node server.mjs` without stdio transport (guard.py:1454 vs server.mjs:93).
4. Plan defect: guard `tracing-namespace-proof.4` mutates tracked `src/tracing.ts` on disk in a shared worktree (guard.py:856-872); CLAUDE.md:19 precedent.
5. Plan/ADR conflict: `./legacy` exports map vs ADR-0003 (PRODUCT-REVIEW.md:8,45; surface-hosts.9).
6. Plan gap: CI e2e lane vs macOS-only e2e (ci.yml:15,97; hb-chrome-binary).
7. Plan gap: `chrome-lifecycle-test.ts` not ported; `_rearmIdle` not a must-contain token.
8. Plan gap: e2e heartbeat isolation (`/tmp/stealth-browser-heartbeat`, chrome-manager.ts:45).
9. Factual error in SCOPE.md:22 / README.md:17 / TOOLS.md G2: "six verbs extracted from search-mcp-source.ts:454-495".
10. Package metadata `module` field vs ADR-0003 (low, repo-wide).
