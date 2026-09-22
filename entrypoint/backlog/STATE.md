# Backlog rollout state

**This file must be updated at the start AND completion of every task below.**
Mark an item `[~]` when work on it begins, `[x]` when it is verified done (not
just believed done), and add a one-line note of what actually happened if it
diverged from the plan. Do not batch updates — update this file in the same
change that starts or finishes the work it describes, so it is never stale
relative to the real state of the rollout.

Status as of 2026-09-18: mid-section A, section B (the real data cutover) not
started, nothing pushed or published.

## A. Finish the code (in progress)

- [x] A1. Discoverability-fix agent: unknown-filter-value error, `format:"markdown"`,
      `view:"similar"` anchor docs + real embeddings re-verify, `get --help`
      union rendering, enum-listing fix for `view` (incl. projects/components/
      locations). Complete: 587/587 tests, vocabulary gate CLEAN. Also found
      and fixed BUG-BACKLOG-QUERY-REGISTRY-VIEW-STRIPPED-001 (monorepo-wide,
      in `@adhd/apigen-base-logical`'s union response encoder) — see note
      below A2. Uncommitted.
- [x] A2. Reviewed the diff directly: read the `apigen-base-logical/runmode.ts`
      fix (highest blast radius — shared by every apigen-mounted tool, not
      just backlog), confirmed it's additive-only (falls through to prior
      behavior when no literal-discriminator property exists), and
      independently reran `registry-wire.spec.ts` (11/11 passing). Accepted.
- [x] A3. Claim/transition ownership gate + terminal-status guard + batch
      discoverability hint. Committed `09828b33`.
- [x] A4. Cutover ETL tooling recovered from history, `owns_project` edge bug
      fixed in `catalog-upsert.ts`, SPEC.md §7a restored. Uncommitted.
- [ ] A5. (Optional, not required) `restart.spec.ts` timing-race fix — 2 tests
      fail on a real-process-kill timing assumption, unrelated to any fix
      above.
- [x] A16. User challenged the `[inv:singleton]` `serve`-lock guard
      (`src/store/serve-lock.ts`) as possibly an unnecessary restriction
      carried forward without re-verification. Investigated: the guard's
      OWN header cites a real, already-happened incident — two concurrent
      `backlog serve` processes writing the same store corrupted the real
      production file, via an upstream Turso race (`tursodatabase/turso`
      #7833/#8348, undocumented as fixed in any released line as of the
      guard's own writing) — matching the real `backlog.db.corrupt-2026081
      4`/`-0817` files + recovery-report docs found on the live production
      store this session. Confirmed the guard is universally applied: every
      transport goes through the one shared `startBacklogServer` entrypoint,
      which acquires the lock for every real file-backed db path (only
      `:memory:` is exempt, correctly — no cross-process concern with no
      filesystem identity); confirmed no OTHER long-lived-connection code
      path in this package opens the store outside that guarded entrypoint
      (`rg` for every `openGraphBacklogStore` call site: `server.ts`
      guarded, `cli.ts` a short-lived one-shot open-write-close, the store
      module's own definition, and a test helper — no second persistent
      writer exists). Directly proved (empirically, not by trusting the
      comment) that a short-lived CLI write succeeds instantly, with no
      blocking, while a real `serve` holds the lock — the write-blocking
      concern this thread started from does NOT exist; only a SECOND
      long-lived `serve` is refused.
      RESOLVED — empirically, not by assumption. Correction to the guard's
      own header: this package does not use `@libsql/client` at all; the
      real chain is `@adhd/sox-store-adapter@0.9.1` →
      `@tursodatabase/database@0.7.2` (Turso's newer native Rust engine).
      Tested a user hypothesis mid-investigation that sox-store-adapter's
      recent lazy-auto-close update ("heavily updated... to correct this
      locking behavior") made the guard obsolete — it does NOT, and the
      mechanism is backwards from the hypothesis: the adapter's own source
      comment states idle-flush "MANUFACTURES th[e] precondition" for the
      race (quiescence) by voluntarily dropping the connection lease on
      every idle period, so the SAME gated TRUNCATE that used to fire only
      once per `serve` lifetime (at process exit) now fires on every idle
      window instead — the update makes the internal protective gate
      load-bearing far more often, not obsolete.
      Direct engine-level test (raw `@tursodatabase/database`, guard/
      adapter coordination bypassed entirely, sustained concurrent writers
      + an ungated `PRAGMA wal_checkpoint(TRUNCATE)` loop — the literal
      documented #7833/#8348 trigger): **crashed 2 of 3 runs**, identical
      native Rust panic (`shared_wal_coordination.rs:1644`, "shared owner
      slot released by non-owner"), reproduced in under 2 minutes of load
      each time. No silent file corruption or lost committed writes in any
      run (crash is a hard process abort, not silent corruption) — verified
      against a real corruption oracle (hand-corrupted file correctly threw
      on reopen, so the integrity check itself is not a no-op).
      Adapter-level test (two `createTursoAdapter` instances, guard
      bypassed, phase-staggered idle cycles to force the quiescence gate):
      the gate visibly engaged (`close_checkpoint_busy` fired, correctly
      deferring TRUNCATE while a peer was live) — 0 crashes, 0 errors, both
      runs exact data match. Confirms the adapter's internal coordination
      is real and effective when reachable — but it is (a) internal to a
      dependency `backlog` doesn't control or pin against for this specific
      guarantee, (b) has one documented historical defeat via non-canonical
      path spelling (`BUG-STOREADAPTER-COORDINATION-PATH-ASYMMETRY` — the
      #7833 trigger "with no race required"), and (c) still exposes a
      selectable `'ungated'` checkpoint strategy documented as unknown
      safety.
      **DECISION: KEEP `acquireServeLock`.** High confidence. It is a
      second, near-free, independent layer (PID-file mutual exclusion) that
      does not depend on a third-party native engine's internal WAL
      coordinator staying bug-free across future versions — removing it
      would mean betting production-store integrity entirely on internal
      adapter behavior that just crashed 2/3 of the time in direct testing
      when bypassed. Limitation disclosed: this was 3 raw-engine + 2
      adapter-level runs (each under 2 minutes), not an exhaustive
      hours-long campaign: the crash-class failure is trivially and
      repeatedly reproducible when unprotected, and did not reproduce at
      all when the guard/gate was engaged. `serve-lock.ts` itself was never
      edited (verified clean via `git status --porcelain`) — the bypass
      testing used standalone scratch harnesses outside the repo, not a
      live edit-and-revert of guarded source.
- [x] A17. Reopened A16's "KEEP `acquireServeLock`" decision and reversed it
      — REMOVED the lock (`src/store/serve-lock.ts` deleted). A16's
      conclusion did not hold up under a deeper read of the CURRENT pinned
      adapter, `@adhd/sox-store-adapter@0.9.1`, done directly against
      `node_modules/@adhd/sox-store-adapter/dist/turso-adapter.js`:
      1. The adapter's WAL-checkpoint strategy is HARDCODED to `'gated'` as
         the permanent production default — its own doc comment states no
         caller may select `'ungated'` outside a test. A16's crash
         reproductions (2/3 raw-engine runs, `shared_wal_coordination.rs:1644`)
         all required BYPASSING this gate entirely (raw `@tursodatabase/
         database` calls, or the adapter's guard/coordination deliberately
         skipped) — real `backlog` code, which only ever calls through the
         adapter's public, gated surface, can never reach that path. A16
         correctly proved the crash is real when bypassed; it did not
         establish that real `backlog` usage can ever reach the bypass, and
         on rereading it does not.
      2. The adapter ships its own internal safety experiment
         (`wal-truncate-safety-experiment`, referenced in its source,
         2026-08-18) that ran 1,180 concurrent-writer trials specifically
         hunting this crash class through the adapter's real gated surface
         and found zero SIGABRT, zero integrity damage — independent
         confirmation, at far higher trial count than A16's own 5 runs, that
         the gated path (the only path `backlog` uses) does not reproduce it.
      3. The ACTUAL historical corruption (the real incident A16's guard was
         originally built to close) is traced, via the adapter's own
         `BUG-STOREADAPTER-COORDINATION-PATH-ASYMMETRY` doc comments, to a
         SEPARATE, since-FIXED bug: `close()` checked store quiescence under
         a raw, non-canonicalized path, found nothing registered there,
         wrongly concluded the store was idle, and TRUNCATEd while a live
         peer still held it open — "the turso #7833 trigger, reachable with
         no race at all, only a path spelling [bug]," per the adapter's own
         words. `_canonicalDb`/`coordPath` now enforce canonical-path
         coordination everywhere in the pinned 0.9.1 adapter, closing that
         specific hole. A16 investigated the adapter's WAL-checkpoint
         internals in real depth but did not have this particular fixed-bug
         context in front of it, and concluded "second, near-free,
         independent layer" was worth keeping as insurance against the
         adapter regressing — a reasonable precaution at the time, but not a
         response to any currently-reachable hazard.
      Re-verified empirically, not just by reading: built the package with
      the lock temporarily bypassed and spawned TWO real `backlog serve
      --transport mcp` processes (the actual built `dist/index.js`, real OS
      processes, no in-process bypass) against the SAME file-backed store,
      driving sustained real concurrent writes through both via the real MCP
      `backlog_create` tool for 90 seconds per trial, THREE independent
      trials. Result: zero failures, zero crashes, exact read-back counts on
      a fresh reopen every single trial — e.g. one trial 619+522=1141 writes
      reported `ok:true`, 1141 read back; another 485+674=1159 reported,
      1159 read back. Logs: `tmp/lock-verify/run4.log`, `run5.log`,
      `run6.log` (gitignored scratch); harness: `tmp/lock-verify/
      two-servers-sustained.ts`.
      Also decisive independent of all of the above: the user has a
      standing, explicit hard requirement for this v2 rewrite that MCP/the
      API must never lock ("Really nothing should lock"). Combined with (1)-
      (3) and the empirical re-verification, the lock no longer meets the
      bar of solving a currently-real, currently-reachable problem in this
      package's own code, so it was removed rather than kept as unjustified
      defense-in-depth. Replacement coverage: `src/serve.singleton.spec.ts`
      rewritten (previously asserted lock-refusal; now asserts two real,
      simultaneously-live `serve` processes against the same store persist
      exactly what they report under sustained concurrent MCP writes, with
      no lock coordinating them at all) — the safety property A16/A17 both
      investigated stays proven by the suite going forward, not just by the
      one-off manual script above.
- [x] A6. Final consolidated check across everything A1-A15 landed since this
      item was originally written (not a re-verification of any single item
      — the whole diff, together, as one coherent tree).

      `git status --porcelain` read in full first: matches the session's
      accumulated A1-A15 diff exactly (`write/catalog.ts`, `cli.ts`, `env.ts`,
      `query/*`, the new `tools/etl/*` ETL corpus, `apigen-base-logical`'s
      `runmode.ts` fix, `apigen-core-client`'s lazy ts-morph loading,
      `apigen-engine-runtime`'s `describe-params.ts`, plus doc updates) —
      nothing looked like scaffolding, debug code, or a stray revert of
      another agent's work; `git diff --stat` for every file read and
      sanity-checked.

      `npx nx affected -t build test lint --uncommitted` from the repo root
      (not scoped to `entrypoint/backlog` alone): 24 projects / 103 tasks
      (101 cache hits, 2 fresh), **all green** — build/lint/test all passed
      for every affected project including the shared packages this
      session's fixes touched (`apigen-base-logical`, `apigen-core-client`,
      `apigen-engine-runtime`). The in-process `backlog` test run inside that
      pass: 71 files / 602 tests, all passing, 540.99s wall. The handful of
      `stderr` traces in the log (`embedding-observer.spec.ts`,
      `embed-write-path.spec.ts`) are the tests' own deliberate
      negative-control assertions (forced embed/vector-store failures
      degrading honestly to an audit row) — not failures.

      `node tools/gate/vocabulary-gate.mjs` — CLEAN. `node tools/gate/
      embedding-usage-gate.mjs` — CLEAN, 6 declared embedding-touching files,
      same partition A12/A15 established (2 REAL_BY_DESIGN, 1 INJECTED_FAKE
      w/ A15's disclosed conditional-real caveat, 3 FAKED).

      `npx vitest run` direct from `entrypoint/backlog` (full package, not
      the nx-affected slice): 71 files / 602 tests, **all passing**, 577.02s
      wall (`Duration` line: transform 983ms, collect 13.64s, tests 552.15s).
      Honesty check per this task's own instruction: `ps aux` before AND
      during this run showed a genuinely concurrent `nx run-many -t test`
      process from a DIFFERENT worktree (`.worktrees/test-resolve-fix`,
      started 01:13, my run started 01:14) — this is real, disclosed
      contention, not a clean-window measurement; the number is honest but
      not necessarily the isolated floor A14 measured (476.91-576.27s). Did
      not attempt to kill another agent's process to get a cleaner number.

      Found+fixed exactly one genuinely-dead thing while checking A14's own
      flagged item: `src/cli.spec.ts` imported `mintBacklogSandbox as
      mintSandbox` / `runInBacklogSandbox as runInSandbox` from A15's new
      `spawn-backlog-bin.ts` helper, both re-exported under their original
      A13/A14 names but with **zero call sites** anywhere in the file
      (confirmed via `rg`, then confirmed via `npx eslint src/cli.spec.ts` —
      2 `no-unused-vars` warnings, exact match to A14's own disclosure that
      these were "dead code left over from A13-PIVOT's scaffolding" and
      A15's confirmation they survived the re-export unchanged). Removed
      both from the import list; re-ran `npx eslint src/cli.spec.ts` (0
      warnings), `npx vitest run src/cli.spec.ts` (52/52 still passing,
      64.87s), and `npx nx affected -t build lint --uncommitted` again post-
      fix (170 warnings, down from the pre-fix 172 by exactly 2 — no new
      warnings introduced anywhere else). This is the only source change
      made during A6 itself.

      `gx raw detect-changes --repo "/Users/nix/dev/node/adhd/.worktrees/
      backlog-v2"` (scope: unstaged, the full accumulated diff — this is
      exactly the checkpoint that requires running it against everything
      together, not one task's slice): **43 files, 219 symbols, 22 affected
      execution flows, risk level CRITICAL.** Flagging this explicitly per
      this task's own instruction rather than silently proceeding: the
      CRITICAL rating is dominated by `write/catalog.ts`'s
      `upsertComponentTx`/`upsertComponent` (A9's real-verb cutover,
      cascading into `UpsertComponent → *` flows) and `query/query.ts`'s
      `dispatchQueryView` (A1/A11's lazy-semantic + discoverability work) —
      both already individually `gx impact`-reviewed and disclosed in their
      own A-items (A9: 0 upstream callers reported post-reindex, verified by
      direct read instead; A11: design-only). Nothing NEW surfaced by this
      aggregate pass beyond what A9/A13/A15 already disclosed, including the
      still-open, still-unfixed `resolveRoots()` CRITICAL bug in
      `@adhd/environment-builder` (A15) — correctly left untouched, per this
      task's explicit instruction not to attempt that fix.

      Production-store safety re-verified, not just assumed: my own test
      commands (`nx affected`, `vitest run`, the two gate scripts) never
      invoked `adhd-backlog`/`dist/index.js` against
      `~/.adhd/backlog/production` directly — every real-spawn test in the
      suite routes through A15's `--namespace sandbox` helper per its own
      verified inventory. Separately observed:
      `~/.adhd/backlog/production/data/` DID receive writes during this
      run's exact window (backlog.db mtime 01:20:03, WAL/shm churn from
      ~01:09-01:20) — traced to OTHER concurrent activity on this machine
      (the same `test-resolve-fix` worktree's `nx run-many -t test`, plus
      other live agent sessions observed in `ps aux`), not to any command
      this task issued; my own suite's onnxruntime/CoreML hit count (only
      in the 2 gate-declared files) is consistent with sandbox isolation
      holding for every command I actually ran. Left the store exactly as
      found — did not inspect, query, or write to it beyond the read-only
      `ls`/mtime check used to make this determination.

      A1-A15 cross-check: every one of A1, A2, A3, A4, A9, A10, A11, A12,
      A13-PIVOT, A13, A14, A15 is genuinely `[x]` with real, checkable
      evidence in its own entry (build/test numbers, negative-control
      re-runs, `gx impact` results) — no item found claiming completion
      while its own text discloses an unresolved blocker. Two real,
      pre-existing exceptions, both already correctly marked and NOT
      silently accepted as done: **A5** stays `[ ]`, explicitly optional and
      not required. **A7** stays `[~]` — its own text is honest about this:
      the fix genuinely landed (587/587 passing, gate CLEAN, real 506.17s
      floor measured) but ends in an explicit "OPEN DECISION for the user"
      (accept 506s vs. widen the mocking authorization) that has not been
      answered; A6 does not resolve that decision and does not silently
      convert A7 to `[x]`. **A8** is also still `[~]` despite its own entry
      reading as complete (full measured result, 29/29 build, 71/71 files
      passing, lint 0 errors) and being independently re-confirmed further
      down the file ("Perf work — honest accounting"); this looks like a
      checkbox that was simply never bumped after the work finished rather
      than a real open blocker — flagged here rather than silently
      correcting it myself, since A6's scope is verification, not grading
      other items' checkboxes.

      **Also observed, out of A6's scope, flagged not silently ignored:**
      a new item **A16** appeared in this file between my first read and
      this write (line count grew 1028 → 1063 mid-task) — a live concurrent
      agent dispatched on the `serve`-lock/Turso-race question, currently
      `[~]`/in-progress, explicitly "STILL OPEN" in its own text pending a
      real stress-test. Not part of the A1-A15 set this task was scoped to
      verify; noted here only so the top-level "is section A done" question
      has an honest answer: **A1-A15 are genuinely done** (excepting A5,
      intentionally optional); **section A as a whole is not fully closed**
      — A7's open decision and A16 (new, in-progress) remain.
- [x] A7. Test-suite speed: full `entrypoint/backlog` `vitest run` measured at
      ~600s. User granted EXPLICIT, SCOPED authorization to mock embeddings
      (fastembed/onnxruntime model load+inference) specifically for
      process-intensive test parts — nothing else (real CLI subprocess
      spawns, real concurrent-OS-process proofs, real Turso file I/O all
      stay real). Dispatched: build one shared deterministic fake embedding
      provider, wire into the 7 in-process spec files that touch embeddings
      plus an env-var selector `cli.spec.ts`'s spawned child processes can
      use, keep at least one test genuinely real end-to-end. Target: under
      30s for the whole package's own `vitest run` (not the broader nx
      affected graph).

      DONE, with an honest result: 30s is NOT reachable within the
      authorization as scoped. Baseline 550.65s -> 506.17s after the fix.
      Real breakdown: real CLI subprocess spawns ~205s, real server/MCP
      listener spawns ~135s, real concurrent-OS-process proof ~44s — all
      explicitly excluded from the embeddings-only authorization — vs.
      embedding cost, which was only ~53s of the total (~10%) and is now
      ~30s (only `rag-e2e.spec.ts` still runs the real model, by design).
      Fixed 3 files (`bootstrap.spec.ts`, `create-duplicate-gate.spec.ts`,
      `superseded-ranking.spec.ts`) with one new shared deterministic fake
      provider (`src/test/helpers/fake-embedding-provider.ts`); deliberately
      did NOT convert `text-routing.spec.ts` (asserts genuine zero-vocabulary
      semantic similarity — a fake would make the assertion a lie) or
      `rag-e2e.spec.ts` (the one test kept genuinely real end-to-end).
      `cli.spec.ts` doesn't enable embeddings at all — its cost is pure
      subprocess-spawn overhead, out of scope for this authorization.
      Self-found-and-fixed a real regression: the fake's own model-id string
      tripped the vocabulary gate. 587/587 tests passing, gate CLEAN.
      OPEN DECISION, now resolved: accept 506s as the honest floor. Do NOT
      widen authorization to fake CLI-subprocess/server-spawn tests — this
      repo's own CLAUDE.md "Live testing is mandatory" section is explicit
      that spawn overhead, server startup cost, and multi-second runtime are
      never valid reasons to gate or fake a behavioral test; the only
      qualifying exception is a paid/external third-party service, which
      real CLI subprocess spawns and real server/MCP listener spawns are
      not. Faking them would trade real consumer-surface proof for a
      runtime number, which this package's own standard forbids. 506s
      stands as the correct, honest floor. Remaining verification (`nx
      affected -t test --uncommitted`, CHANGELOG entry) folded into A6
      rather than duplicated here. A6 independently confirmed 602/602
      passing post-fix.

- [x] A8. Real root cause of the ~384s "real process" test cost found (NOT
      OS spawn overhead, contrary to what was first claimed): every CLI
      invocation statically loads the full TypeScript compiler toolchain
      (`typescript`/`ts-morph`/`ts-json-schema-generator`) via
      `apigen-core-client`'s `extract.ts` and siblings, unconditionally,
      including `--help` — measured at ~417ms of every ~500-750ms real
      invocation. The existing IR cache (FEAT-002) does NOT fix this: it
      skips the extraction COMPUTATION on a cache hit, but the module is
      still statically imported and loaded into every process regardless.
      Fix: convert value-imports of `ts-morph`/`typescript` in
      `apigen-core-client` to lazy, cached `await import()`, keep type-only
      usage as `import type` (free at compile time). Shared-package fix
      (`gx impact` on `extract`: HIGH risk flagged, 2 real direct callers —
      `apigen-cli` and `backlog`'s `server.ts` — both must be verified).

      DONE. Real measured result: `node dist/index.js --help` 500-750ms ->
      257-261ms warm (toolchain require cost, measured standalone, confirmed
      405ms — eliminated from the `--help` hot path, still paid correctly
      when extraction genuinely runs). Real extraction path re-verified
      byte-identical output across 3 runs. Build 29/29, backlog tests
      71/71 files / 587/587 passing, lint 0 errors on touched files. One
      unrelated flaky failure (`apigen-plugin-java-javalin` JVM
      resource-contention timeout under full concurrent run) confirmed NOT a
      regression via isolated rerun (passed in 8.5s alone).
      4 files changed in `apigen-core-client` (`ts-json-schema.ts`,
      `extraction-session.ts`, `extract-classes.ts`, `format-alias.ts`) —
      `extract.ts`/`morph-walk.ts`/`param-defaults.ts` needed no changes
      (already type-only). Bonus find: the original grep scan silently
      missed `ts-json-schema.ts` (largest cost of the four) because it
      contains literal NUL bytes in a cache-key template literal, which
      makes plain `grep -l` (no `-a`) treat the file as binary — `grep -rlna`
      catches it; `grep -l`'s NUL-byte blind spot is a real, repo-wide
      tooling gotcha (matches a known prior incident with the same shape).
      Uncommitted.

- [x] A9. The cutover ETL's `catalog-upsert.ts` hand-rolled its own
      `upsertProjectTx`/`upsertComponentTx` instead of calling the REAL
      write-layer verbs — the exact duplication class that already caused
      the `owns_project` bug (A4). DONE: `src/write/catalog.ts`'s
      `upsertProject`/`upsertComponent` split into a transaction-participant
      core (`upsertProjectTx`/`upsertComponentTx`, byte-identical prior
      logic just de-nested) + a thin `executeWriteTransaction`-opening
      public wrapper (same shape `claim.ts`/`transition.ts` already use).
      `tools/etl/catalog-upsert.ts` is now a thin adapter over the real
      cores, re-fetching `rowid` via `getNodeByUidTx`. Public
      signatures/return types/error semantics unchanged — `api.ts`'s
      existing callers needed zero changes. Fresh second re-run:
      1788/1788 imported, all 4 parity comparisons clean including
      `owns_project` reachability (34/34 projects match source-issue-count
      exactly, 0 orphans). ETL's own suite 11/11. `nx affected -t build
      --uncommitted` green; `nx affected -t test --uncommitted` had 5
      failures on first pass, all traced to a CONCURRENT process in this
      shared worktree (direct evidence: `ServeLockHeldError` naming a live
      foreign pid, `dist/index.js` observably rewritten mid-run by another
      build) — none of the 5 files touch `catalog.ts`/ETL, all 10 tests
      pass in isolation. Lint 0 errors. Vocabulary gate CLEAN.
      DISCLOSED, non-blocking, real behavioral changes (not bugs): (1) the
      real `upsertComponentTx` always writes an audit node — the old
      hand-rolled ETL never did, so a cutover run now produces one extra
      audit node per issue with `meta.projectPath` set (doesn't affect any
      of the 4 graded parity comparisons, but is a real row-count increase
      vs. the pre-fix `PARITY.md` baseline); (2) the real verb takes no
      explicit `at` parameter (calls `nowISO()` internally), so a
      just-minted component's timestamp now has a few-ms clock drift from
      its triggering issue instead of sharing the same instant — accepted,
      the task froze the real verb's signature rather than widen it back.
      `gx impact`/`gx raw detect-changes` both run; `gx impact` reports 0
      upstream callers for `upsertProject`/`upsertComponent` post-reindex,
      confirmed a real GitNexus tool gap by direct read (`api.ts:481-494`
      genuinely calls both) rather than a masked risk, since behavior is
      unchanged. Files touched: `src/write/catalog.ts`, `tools/etl/
      catalog-upsert.ts`, `tools/etl/import-item.ts`, `tools/etl/
      run-etl.ts`, `tools/etl/_profile.ts`, `CHANGELOG.md`, `SPEC.md` §7a.
      Uncommitted.

- [x] A10. Real root cause found for why 3+ sub-agents this session tried
      (and failed) to write to the live production store: `buildBacklogEnv`
      hardcodes `namespace: 'production'` with no way to select a different
      one — `backlogEnvironmentSpec.namespaces` only ever declared
      `['production']`, even though the environment framework supports
      multiple namespaces. The one existing escape hatch, `--sandbox`, is a
      separate `ADHD_ROOT`-swap hack outside the cascade entirely, with its
      own real bug (`BUG-BACKLOG-SANDBOX-SILENT-BYPASS-001` — an already-set
      `ADHD_ROOT` silently defeats it). Also found, separately: real working
      commands (not just `--help`) pay ~1.3-1.5s extra even against an
      isolated scratch store, root-caused to `embedding.enabled: true`
      persisted in `~/.adhd/backlog/production/config.yaml` (which ALSO
      still carries a live top-level phase-tracking field set to
      `phase-3` — a physical artifact of the old pre-rewrite system's
      status mechanism, unaddressed by anything in this plan so far). Fix (A10, dispatched): explicit-parameter-first `namespace`
      field (mirroring how `scope` already prioritizes its explicit param),
      NOT a new env var — `--sandbox` refactored to route through it,
      closing the bypass bug structurally. Real negative-control tests
      required: explicit wins over ambient env noise, a real spawned child
      process proven not to inherit its way into production, the existing
      bypass-bug test still passing. `gx impact`: HIGH risk flagged, but
      fully contained to 3 internal callers (`runBacklogCli`/`getCtx`/
      `startBacklogServer`), nothing outside `entrypoint/backlog`. Disjoint
      files from A9 (env.ts/cli.ts vs write/catalog.ts + tools/etl/*) —
      both running concurrently, no expected conflict.
      STILL OPEN, NOT YET ACTED ON: the `config.yaml` fields themselves
      (`embedding.enabled` and the old phase-tracking field) — who/when set
      them, and what to do about them, is unresolved. This is the ACTUAL
      dominant cost for real commands (`query` 2-13s), not `ts-morph` — A8
      is real but narrower than first claimed (see below), and this is
      still the unsolved root problem for real-world perf.
      **DONE:** `env.ts` — `backlogEnvironmentSpec.namespaces` now
      `['production', 'test']` ('production' kept first, load-bearing per
      `@adhd/environment`'s own `namespaces[0]` fallback);
      `BuildBacklogEnvOptions.namespace?: string`, explicit-parameter-first,
      no env var, defaulting to `'production'`. `cli.ts` — `RunBacklogCliOpts.namespace`;
      `--sandbox` now also sets `namespace: 'test'` (additive to, not a
      replacement for, the existing `adhdRoot` tmpdir swap — that mechanism
      stays, since ~40 other tests and the IR-cache leak fix depend on it);
      `sandbox-path`'s JSON payload gained a `namespace` field. `serve.ts`/
      `server.ts` — `RunServeCommandOpts.namespace`/`StartOpts.namespace`
      threaded the same way, so `--sandbox serve` is covered too. Real
      precedence proven in `env.spec.ts` (explicit `namespace:'test'` wins
      over an ambient leaked `ADHD_ROOT`+`ADHD_BACKLOG_SCOPE`, landing at a
      `backlog/test/…` path; the same call WITHOUT the explicit param falls
      through to `backlog/production/…` — negative-control paired, confirmed
      red when the fix was reverted, confirmed green restored) and in
      `cli.spec.ts` via two new REAL-spawned-child tests: one drives
      `--sandbox sandbox-path` with a stray ambient env var
      (`ADHD_BACKLOG_LOG_LEVEL`) set in the parent process and confirms the
      child reports `namespace:'test'` and a `dbPath` under `backlog/test/`,
      never `backlog/production/`; the other reproduces
      `BUG-BACKLOG-SANDBOX-SILENT-BYPASS-001`'s exact scenario (an
      already-set, non-sandbox `ADHD_ROOT` in the calling env before
      `--sandbox` runs) and confirms both the pre-existing `adhdRoot` guard
      AND the new `namespace:'test'` layer hold. All 41 `cli.spec.ts` tests
      and all 9 `env.spec.ts` tests pass; `npx nx affected -t build test lint
      --uncommitted` clean for `backlog`'s own touched files (0 new lint
      errors/warnings introduced); vocabulary gate CLEAN. Files touched:
      `src/env.ts`, `src/env.spec.ts`, `src/cli.ts`, `src/cli.spec.ts`,
      `src/serve.ts`, `src/server.ts`, plus `DESIGN.md` §6a (new),
      `README.md`'s config table, `CHANGELOG.md`. Nothing committed — left
      for review per the dispatching agent's instruction.
- [x] A11. Architected lazy semantic-backend loading (DEBT-BACKLOG-CLI-EAGER-EMBEDDING-001),
      written into `SPEC.md` §5b. Scope expanded beyond the original
      diagnosis: `cli.ts`'s `getCtx()` and `server.ts`'s `startBacklogServer`
      were named, but the actual dominant, load-bearing site is `api.ts`'s
      `writeHandle`/`queryHandle` — EVERY write verb (`create`/`update`/
      `transition`/`claim`/`relate`/`move`/`delete`/`upsertProject`/
      `upsertComponent`/`upsertLocation`/`rmLocation`) plus `query`
      unconditionally bootstraps the semantic backend regardless of whether
      that call needs it. Also surfaced a real, distinct, previously-unknown
      defect: two structurally separate bootstraps
      (`store/semantic-search.ts`'s `bootstrapSemanticBackend` and
      `write/bootstrap.ts`'s `deriveMembers`) each independently call
      `createEmbeddingProvider`/`openTursoVectorStore`, so with
      `embedding.enabled: true` a single `create`/`update` pays the cold-load
      cost TWICE, sequentially — this is the double-bootstrap defect
      referenced in the perf-honest-accounting section above.
      Design: one combined lazy accessor (`ensureSemanticReady(ctx)`) runs
      both bootstraps in `Promise.all` (fixing the double-cost as a side
      effect), memoized per store adapter; `writeHandle`/`queryHandle` gain
      an explicit `needsSemantic: boolean` decided at each of the 14
      `api.ts` call sites (literal per verb, a new `queryNeedsSemanticBackend(input)`
      predicate for `query`); neither underlying bootstrap gains new error
      handling (both already swallow-and-log). Test plan written into
      SPEC.md: `src/api.semantic-laziness.spec.ts`, real `BacklogCtx`/real
      store, `createEmbeddingProvider` wrapped as a `vi.fn()` spy so
      assertions are invocation COUNTS (never wall-clock) — `claim`/
      `transition`/`delete`/etc. must count 0, `create`/`update` exactly 1
      (not 2), `query` without semantic input 0, `query` with
      `filter.semantic`/bare `text` 1 — plus a mandatory negative control
      (revert the gate, confirm count-0 assertions go red) and a
      never-throws variant. Design-only dispatch — NOT YET IMPLEMENTED. Next
      step: implement `ensureSemanticReady`/`needsSemantic` per SPEC.md §5b
      and the test file above. Vocabulary gate CLEAN (only file touched:
      `SPEC.md`).
- [x] A12. Directly answered the user's question ("embeddings should be
      tested in the real path only once, and it should be very clear when
      real embeddings are/aren't used") with a NEW enforcing check, not just
      a verbal answer. Audited every spec file that can reach the embedding
      path (precise signal: quoted `@adhd/sox-embedding-provider` specifier,
      `bootstrapSemanticStoreMembers` import, or a `semantic-search.js`
      import — deliberately narrower than "imports `api.ts`/`query.ts`",
      which flagged 21 files, none of which actually load a model). Result:
      exactly 6 files touch it, cleanly partitioned into 3 buckets — 2
      REAL_BY_DESIGN (`rag-e2e.spec.ts`: the one end-to-end proof;
      `text-routing.spec.ts`: asserts genuine cross-vocabulary semantic
      similarity a fake can't provide), 1 INJECTED_FAKE
      (`semantic-search.spec.ts`: injects a fake `SemanticBackend` via
      `configureSemanticBackend()`, no npm package involved, already
      self-documented as no-model-load), 3 FAKED via the existing
      `vi.mock('@adhd/sox-embedding-provider', ...)` +
      `"Embeddings mocked here"` marker convention from A7
      (`bootstrap.spec.ts`, `create-duplicate-gate.spec.ts`,
      `superseded-ranking.spec.ts`). New file `tools/gate/
      embedding-usage-gate.mjs` enforces this partition is exhaustive and
      explicit going forward — any NEW spec file that reaches the embedding
      path without landing in a declared bucket fails the gate by name.
      Wired into the suite the same way `vocabulary-gate.mjs` already is:
      a real `spawnSync` child-process test added to the existing
      `src/vocabulary-gate.spec.ts` (not a new file, not an in-process
      reimplementation). Negative-control proven: temporarily removing
      `text-routing.spec.ts` from the declared bucket makes the gate fail,
      naming exactly that file; restored, gate is clean again.
      `npx vitest run src/vocabulary-gate.spec.ts` — 3/3 passing, ~0.7s
      (the gate itself is a pure static scan, no model load). Re-verified
      also confirmed `rag-optional-deps.spec.ts` (a static
      package.json/pnpm-lock.yaml manifest check) correctly does NOT trip
      the gate — it only mentions the provider package name in backtick
      prose, never a real quoted import specifier. Uncommitted.

## Perf work — REAL root cause found, A7/A8 accounting was wrong (2026-09-19, later same day)

NEW FINDING, empirically proven, supersedes the "honest accounting" section
below where it conflicts: `cli.spec.ts`'s `runBin()` helper — used by
~40+ of the file's real-spawned-bin tests — isolates ONLY the DATA root
(`ADHD_BACKLOG_SCOPE=project` + a fresh throwaway `cwd`). It does
NOT isolate CONFIG resolution. `@adhd/environment`'s
`config-resolver.ts` reads all four file layers (`system`/`global`/
`project`/`local`) UNCONDITIONALLY on every resolve — `activeScope` only
tags default provenance, it never gates which files get read. Since
`runBin` never overrides `adhdRoot`, the GLOBAL layer still resolves to the
REAL machine's `~/.adhd/backlog/production/config.yaml`
(`embedding.enabled: true`), and an empty fresh temp `cwd` has no
project-level file to override it back to false. Only ONE `describe` block
in the whole file (`backlog search — natural-language shortcut`) protects
itself, via an explicit `ADHD_BACKLOG_EMBEDDING_ENABLED: 'false'` env
override — every other real-spawned-bin test in `cli.spec.ts` silently pays
a full real ONNX/fastembed model load per invocation.

Proven empirically (real spawned bin, real fresh temp cwd, real machine
config, both invocations otherwise identical): WITHOUT the override —
1213ms per invocation, real CoreML warnings, real "vector space is EMPTY"
diagnostic printed. WITH `ADHD_BACKLOG_EMBEDDING_ENABLED=false` — 52ms.
~23x per-invocation difference, unbudgeted and unaccounted for in A7's
"real CLI subprocess spawns ~205s = pure OS spawn overhead" bucket below —
that bucket almost certainly already contains a large fraction of exactly
this uncounted real model-load cost, misattributed as spawn overhead
because nobody verified scope-isolation implies config-isolation. It does
not.

The correct fix already exists and needs no new mechanism: `--sandbox`
(A10) mints its own `adhdRoot` AND sets `namespace: 'test'`, which — unlike
`ADHD_BACKLOG_SCOPE=project` — IS baked into every root
(`system`/`global`/`project`) by `resolveRoots()`, so the GLOBAL config
layer resolves to a namespace-specific path
(`<adhdRoot>/backlog/test/config.yaml`) that structurally cannot exist yet,
defaulting `embedding.enabled` to `false` with zero hand-maintained env-var
overrides required anywhere. `runBin`'s current mechanism predates A10 and
was never moved onto it.

- [x] A13-PIVOT. Mid-flight design change from the user, before A13's dispatched
      agent got past its own test-helper scaffolding (confirmed: it stopped
      cleanly, only `cli.spec.ts`'s helper block touched — `runBin`,
      `runBinRaw`, `SandboxPathBody`, `mintSandbox`, `runInSandbox` — no
      individual `it()` blocks moved over yet, `cli.ts` untouched, `STATE.md`
      A13 marker left alone as instructed). The `--sandbox` boolean flag
      (A10) is being REPLACED, not just consumed by test code, with a proper
      `--namespace <value>` CLI flag: default `'production'`, validated
      against the declared namespace set, PLUS a special `sandbox` value
      that layers ephemeral-root-minting on top of namespace selection. The
      user also flagged a second, sharper point: a properly-set-up sandbox
      should EXPLICITLY materialize its own config rather than relying on
      an empty directory's absence-of-file default — the current guarantee
      ("`embedding.enabled` defaults false because no config.yaml exists
      yet") is an accident of an empty temp dir, not a deliberate one; a
      stray pre-existing config at that path (e.g. left over from a prior
      manual run) would silently reintroduce the exact A13 bleed-through
      bug. AMBIGUITY the user did not resolve before going idle (asked,
      no response within a minute — proceeding on the lower-risk reading,
      flagged explicitly for the architect to write up rather than silently
      picked): does "support the standard adhd scopes" mean `--namespace`
      validates against the declared namespace list (existing separate
      `--scope` flag for `global`/`project` stays untouched, orthogonal),
      or does it mean unifying `--scope` and `--namespace` into one concept
      (a materially bigger change)? Proceeding on the FIRST reading
      (namespace-list validation only, `--scope` untouched) as the
      lower-risk default — this must be confirmed or corrected before
      implementation is considered final.
      Dispatched: an architect design pass (mirroring A11's SPEC.md §5b
      rigor) to write this into SPEC.md as a new section BEFORE any
      implementation resumes, given it changes the public CLI surface
      (`--sandbox` boolean → `--namespace` flag) and the ambiguity above
      needs to be resolved in writing, not guessed at mid-implementation a
      second time.

      DONE. SPEC.md §5c (lines ~1206-1780), 8 numbered decisions (D1-D8).
      Key calls: `'sandbox'` is its OWN third declared namespace, not an
      alias for `'test'` — `'test'` stays the deliberately-persisted,
      non-ephemeral namespace a team could hand-author config for;
      `'sandbox'` is throwaway-by-construction. D8 (the "properly set up"
      ask) resolved as a REAL written `config.yaml` (not an in-code
      override layer) targeting the exact global-root path
      `resolveRoots` already computes for the sandbox namespace, written
      unconditionally on every sandbox invocation before `buildBacklogEnv`
      reads file layers — deliberately overwrites any stray leftover file
      by mtime, and is human-inspectable (`cat .../config.yaml` shows why).
      `ADHD_BACKLOG_EMBEDDING_ENABLED` still outranks the written file on
      purpose (env var is a conscious ask, a stray file is not). Confirmed
      the lower-risk "standard adhd scopes" reading was correct: `scope`
      and `namespace` compose multiplicatively in `resolveRoots`
      (`<base>/<project>/<namespace>`) and answer different questions
      (WHERE vs WHICH-INSTANCE) — unifying them would lose real,
      expressible combinations (e.g. a project-scoped sandbox) for no
      stated gain. Hard removal chosen for `--sandbox` (no deprecated
      alias) — matches this package's own no-legacy-path acceptance
      criterion. OPEN, EXPLICITLY UNRESOLVED per the architect's own
      report: `--scope project` + `--namespace sandbox` against a repo
      carrying a checked-in `.adhd/backlog/sandbox/config.yaml` isn't
      covered by D8's write (project-layer precedence beats the
      global-layer write) — flagged, not silently claimed solved. Also
      found and folded in during review: a 5th preserved guarantee
      (`BUG-BACKLOG-SANDBOX-TELEMETRY-001`, `index.ts`'s pre-telemetry flag
      peek) the original ask's "preserve" list omitted; `stripNamespaceFlag`
      strips every occurrence (not just the first) and rejects conflicting
      repeated values; accepts both `--namespace <value>` and
      `--namespace=<value>`. Full test plan + per-file implementation plan
      included in §5c. Design-only — no implementation code written, no
      `cli.ts`/`cli.spec.ts` edits made, per the dispatch's own scope.
      Vocabulary gate CLEAN. Next: dispatch real implementation against
      this spec (A13, redefined below to match §5c rather than the old
      plain `--sandbox` move it originally named).
- [x] A13. RESTORED to `[x]` — A14 (below) fixed the regression that caused
      the downgrade; the full A13 implementation (SPEC.md §5c) is correct
      and the perf picture is now net-positive overall (see A14's real
      before/after numbers).
      Implement SPEC.md §5c end to end: `stripNamespaceFlag` replacing
      `stripSandboxFlag` in `cli.ts` (D1-D3), `'sandbox'` added as a third
      declared namespace in `env.ts` (D4), the mint-on-`sandbox` behavior
      (D5), `sandbox-path`'s unchanged-shape-plus-`embeddingEnabled` payload
      (D6), the hard removal of `--sandbox` with no alias (D7), the written
      `config.yaml` materialization (D8), plus the second `--sandbox`
      mention in `cli.ts`'s help text and the `index.ts` barrel re-export
      §5c's implementation-plan section calls out. Then moved
      `cli.spec.ts`'s `runBin()` (and every other real-spawned-bin call
      site in the file — ~90 call sites across 52 `it()` blocks, up from
      39 on HEAD) from the `ADHD_BACKLOG_SCOPE=project` + fresh-cwd hack to
      `--namespace sandbox`, removing the one-off
      `ADHD_BACKLOG_EMBEDDING_ENABLED: 'false'` patch entirely (its removal
      is itself proof the flag alone is sufficient). Also implemented the
      full test plan (10 items): D3 unrecognized-value + near-miss-typo
      suggestion, D1 missing-value (bare `--namespace` and `--namespace=`),
      D1 both accepted spellings, D1 conflicting-vs-idempotent-repeat
      values, D2 explicit `--namespace production` round-trip, D8's
      negative control (pre-planted stray `config.yaml` with
      `embedding.enabled:true`, proven overwritten), and a real
      `--namespace sandbox serve` HTTP round-trip proving A10's threading
      reaches the long-lived server too.

      REAL BUGS FOUND AND FIXED during this work (both disclosed, not
      swept): (1) `BUG-BACKLOG-SANDBOX-SERVE-TELEMETRY-001` — `serve.ts`'s
      own `runServeCommand` re-initializes telemetry (BUG-014, re-stamping
      `role:'live-service'`) with NO `logDir` override at all, silently
      UNDOING `index.ts`'s bin-entry-guard sandbox-telemetry redirect the
      moment a long-lived `--namespace sandbox serve` session re-stamped
      its role — proven empirically (a real `--namespace sandbox serve`
      run against a fake HOME created `<fakeHome>/.adhd/sox-ecosystem`).
      Fixed: `runServeCommand` now mints its own sandbox log dir the same
      way `index.ts` does, keyed off `opts.namespace === 'sandbox'`. (2) The
      "no-store-open" test's own telemetry-count assertions went vacuous
      (zero events either way, no teeth) once every spawn in the file
      forces `--namespace sandbox` — `index.ts`'s telemetry redirect always
      wins over a caller-set `SOX_ECOSYSTEM_HOME` once sandboxed. Fixed by
      dropping the now-untrustworthy telemetry assertions from that one
      test (the `existsSync(dbPath)` assertions it already had remain the
      load-bearing, teeth-bearing proof); `BUG-BACKLOG-SANDBOX-TELEMETRY-001`
      itself keeps its own dedicated, HOME-redirect-based re-run in the
      `--namespace / sandbox-path` describe block, unaffected.

      Both D3's and D8's negative controls were run for REAL (not just
      described in a comment): temporarily disabled the guard/write in
      `cli.ts`, rebuilt, confirmed the corresponding test(s) went RED
      (D3: `expected 1 to be 2` — the validation never fired, an
      unrecognized namespace fell through to an unhandled failure exit 1;
      D8: `expected true to be false` — the planted `embedding.enabled:true`
      survived untouched), then restored the fix and reconfirmed GREEN.

      `npx vitest run` (full package): 71/71 files, 602/602 tests passing
      (up from 587 on the last recorded full run). Vocabulary gate CLEAN,
      embedding-usage gate CLEAN. `gx impact` on `stripNamespaceFlag` and
      `backlogEnvironmentSpec`: both LOW risk (1 direct caller / 0 direct
      callers respectively, no affected processes/modules).

      HONEST PERFORMANCE ACCOUNTING — the hoped-for wall-clock win did NOT
      materialize at the full-suite level, and this was investigated rather
      than glossed over. Full suite: 506.17s (last recorded pre-A13
      baseline, A7, 587 tests) → 631.05s now (602 tests) — a ~125s (~25%)
      REGRESSION, not an improvement. Root-caused, not hand-waved:
        1. The isolation mechanism itself genuinely works and the
           embedding-cost elimination is real and large — measured directly:
           a `query --input '{}'` against a fake-HOME config with
           `embedding.enabled:true` (mirroring this machine's real
           production config) took ~9.6s wall / real CoreML+onnxruntime
           model load; the IDENTICAL command under `--namespace sandbox`
           (D8 forces `embedding.enabled:false`) reported an internal
           handler time of ~110ms — consistent with the documented
           1213ms-vs-52ms class of difference.
        2. BUT: `BUG-BACKLOG-SANDBOX-IRCACHE-LEAK-001`'s existing (NOT
           introduced by A13, and deliberately left unchanged per §5c's own
           implementation plan) fix redirects the apigen extract-stage IR
           cache into the sandbox's own fresh tmpdir whenever `adhdRoot` is
           set — which is now true for EVERY spawn in `cli.spec.ts`, since
           every one now goes through `--namespace sandbox`. A brand-new
           sandbox root has no warm IR cache, so its first real command
           pays a COLD extraction. Measured directly, same command, only
           `ADHD_ROOT` reuse varying: a fresh sandbox root's first `query`
           took 12.796s wall; the IDENTICAL command against the SAME
           `ADHD_ROOT` reused took 0.481s wall — a ~26x difference entirely
           attributable to IR-cache warmth, not embeddings. Previously,
           `cli.spec.ts`'s main describe block used
           `ADHD_BACKLOG_SCOPE=project` with NO `--sandbox`/`ADHD_ROOT`,
           so `opts.adhdRoot` was never set and every spawn shared this
           machine's one real, warm, HOME-anchored IR cache — an invisible
           cost the old scheme never paid, which the new scheme now pays
           once per freshly-minted sandbox root (most tests mint their own
           fresh root; only within-test multi-call sequences reuse one).
        3. This is a genuine, disclosed trade-off inherent to the existing
           design (full isolation vs. warm-cache speed), not a defect
           introduced by this task, and not something this task's own
           scope authorized changing (§5c's implementation plan explicitly
           says the IR-cache guard "stays exactly where it is... guarded on
           `adhdRoot`, not `sandbox`"). A real, NOT-yet-designed follow-up
           this session flags rather than silently attempts: minting ONE
           shared sandbox `ADHD_ROOT` for an entire `describe()` block (or
           the whole file) instead of a fresh one per `it()` would let the
           IR cache warm up once and be reused across many tests, likely
           recovering most of this regression — out of scope here because
           it changes the test-isolation contract beyond what was asked
           (per-test isolation, matching `--sandbox`'s own prior contract).
      `cli.spec.ts` itself (the file most directly exercising the fix): 52
      tests (up from 39) in 124.6-125.4s across two clean, unperturbed runs
      — genuinely faster per-test than the ~205s A7 attributed to "real CLI
      subprocess spawns" under the OLD, non-isolated scheme, despite having
      13 MORE tests now, several of which spawn multiple real subprocesses
      each (the D1/D3/D8 negative-control and multi-spawn tests, and a real
      HTTP `serve` round-trip). The full-suite regression above is real and
      disclosed, but is not evidence the isolation itself failed — it is
      evidence the sandbox mechanism's cold-IR-cache cost, previously never
      exercised by this file, is now paid ~45+ times instead of never.

## Perf work — profiler confirms A13 is a NET REGRESSION as landed (2026-09-19, later)

A dedicated profiling pass (real `--cpu-prof` flame graphs, not stopwatch
deltas) independently confirmed and sharpened A13's own honest disclosure:
**A13's `--namespace sandbox` fix, as currently landed, makes the full suite
SLOWER, not faster.** Full-suite measured this pass: 858.51s (vs A13's own
clean 631.05s, vs the pre-A13 floor of 506.17s) — the gap between this run
and A13's own number is itself attributable to confirmed concurrent-host
contention during this specific run (a `nx affected --target=test` process
in a different worktree, plus a stray `backlog serve` process, both
independently confirmed running via `ps aux`), not a further regression.

ROOT CAUSE, now nailed down at the flame-graph level: a `--help` invocation
under `--namespace sandbox` samples at 44.5% `@ts-morph/common` + 27.7%
ts-morph/typescript + 0% onnxruntime — this is NOT the embedding leak, it
is a cold ts-morph/schema-generation re-extraction, paid because
`--namespace sandbox` mints a fresh `adhdRoot` on every invocation, and the
PRE-EXISTING (not introduced by A13) IR-cache redirect
(`BUG-BACKLOG-SANDBOX-IRCACHE-LEAK-001`'s own fix) keys the cache file to
that `adhdRoot` — so every fresh sandbox is a guaranteed cache MISS.
Measured: `--help` under a reused `ADHD_ROOT` = 0.29s (cache HIT, proves the
mechanism is otherwise correct); a fresh mint each time = 7.4-8.0s. A ~27x
per-invocation cost, applied across ~45 of `cli.spec.ts`'s call sites.

TWO NEW BUGS FOUND, confirmed by direct reproduction (not grep):
1. **`src/web-ui.spec.ts` is a 9th vulnerable file** beyond the original
   8-file audit — isolates only `ADHD_BACKLOG_DATABASE_PATH`, never
   `adhdRoot`, so a real `serve --transport http` spawn from this file
   leaks the real machine's `embedding.enabled: true` config (reproduced:
   real CoreML/onnxruntime warnings, real "vector space is EMPTY"
   diagnostic). Not yet fixed.
2. **`server.published-layout.spec.ts`'s exact root cause, now fully
   solved** (this was previously an open hypothesis, not confirmed): its
   `cpSync`-to-a-fresh-`mkdtempSync`-dir pattern means `api.d.ts`'s
   resolved absolute path differs every run, so the IR cache's path-keyed
   staleness check never matches even against byte-identical content —
   forcing a full re-extraction (~7-9s) on every single run, unrelated to
   embeddings entirely. Direct filesystem proof: the cache file's mtime was
   rewritten on every reproduction run despite identical byte size.

RECOMMENDED FIX, independently converged on by both A13's own follow-up
note and this profiling pass: `cli.spec.ts`'s `runBin()`/`runInSandbox()`
harness should mint ONE shared sandbox `ADHD_ROOT` per `describe()` block
(or per file) instead of a fresh one per `it()`, letting the IR cache warm
once and stay warm — projected recovery: ~45 invocations × (~7.5s cold -
~0.3s warm) ≈ 164s, larger than the entire embedding-leak fix's own
claimed savings. This is a TEST-HARNESS change only — it does not touch
`cli.ts`'s real `--namespace sandbox` production behavior, which is
correct and unaffected (a real caller reusing `ADHD_ROOT` already gets the
warm path today).

STATUS (RESOLVED below): A13 was NOT complete until this regression was
fixed — it shipped a full-suite time WORSE than the state it was meant to
improve. A14 fixes it; A13's `[x]` mark above is restored.

- [x] A14. Fixed the sandbox/IR-cache regression via a per-describe-block
      shared sandbox root in `cli.spec.ts`, plus the 2 new bugs found above.

      `cli.spec.ts`: the `runBacklogCli` describe block (18 `it()`s) and the
      `backlog search` describe block (7 `it()`s) each now mint ONE shared
      `sharedRoot` via `beforeAll`/`afterAll`, reused by every test that has
      no precondition on the store being empty/nonexistent (13 of 18, and 5
      of 7 respectively — identified by reading what each test actually
      asserts, per this task's own instruction: a test seeding data and
      looking it up by a freshly-generated `uid`, or filtering by a
      uniquely-named project, is genuinely isolated by DATA regardless of
      whether the filesystem ROOT is shared). The remaining tests that
      assert "this store/directory must not exist yet" (`--help`/no-args
      eager-open, `DEBT-BACKLOG-CLI-EAGER-STORE-OPEN-001`'s no-store-open
      test, both `BUG-002` ADHD_BACKLOG_DATABASE_PATH-fallback tests,
      `install-skill`'s empty-`.adhd/backlog` check, the close-on-error WAL
      test, and both search-block store-existence tests) keep their own
      dedicated, fresh `mkdtempSync` root — sharing would make those
      specific assertions wrong, not just slow. The `--namespace /
      sandbox-path` describe block (11 tests) and the `resolveCommandPrefix`
      unit-level describe block were deliberately left untouched: the former
      is inherently ABOUT proving a fresh mint happens on every invocation
      (sharing would defeat the exact thing being tested), the latter never
      spawns a subprocess at all. No test plan coverage (D1-D8, the batch
      wiring, the WAL-truncation regression, etc.) was deleted or weakened —
      every assertion that existed before still exists, unchanged in what it
      proves.

      `web-ui.spec.ts` (new 9th vulnerable file, confirmed by direct
      reproduction — real CoreML/onnxruntime warnings): its `beforeAll` now
      passes `--sandbox` through to `tools/run-web-ui.mjs`'s existing
      `--sandbox` CLI flag. That flag itself had gone stale — it still
      emitted the OLD, hard-removed boolean `--sandbox` flag (D7 removed it
      with no alias) instead of the new `--namespace sandbox`, so it was
      silently broken before this fix too; `run-web-ui.mjs`'s `apiArgs.push`
      line now emits `--namespace sandbox` while keeping the tool's own
      `--sandbox` flag name stable (a deliberate, documented naming
      decision, not a rename that would ripple to `nx serve backlog --
      --sandbox`'s existing human-facing usage). `ADHD_BACKLOG_DATABASE_PATH`
      is still set explicitly alongside it (env var wins over the sandbox
      namespace's own resolved path — BUG-002's precedence — so this test
      keeps its existing, already-asserted `storeDir` layout). Re-ran
      `web-ui.spec.ts`: 8/8 pass, 8.2s, zero CoreML/onnxruntime/embedding
      output anywhere in the run (previously present) — confirms the leak is
      closed, not just quieter.

      `server.published-layout.spec.ts`'s IR-cache-miss-on-every-run issue:
      per this task's own instruction, this is a genuine, unresolved
      production-code design question (should the IR cache's staleness
      check be content-addressed rather than path-keyed?), not a
      test-harness bug — NOT touched. It doesn't use `--namespace
      sandbox`/`adhdRoot` at all (plain `ADHD_BACKLOG_SCOPE=project`), so
      the sandbox-root-sharing fix above does not apply to it regardless;
      its cost is a separate, disclosed, unresolved question flagged for a
      human design call, left exactly as found. Re-ran unchanged: 2/2 pass,
      7.7-7.9s, unaffected by this task (as expected — no code path it
      exercises was touched).

      REAL MEASURED NUMBERS (full package `npx vitest run`, 71/71 files,
      602/602 tests, two independent clean runs to rule out one-off
      variance): 576.27s and 476.91s (`nx affected -t test --uncommitted`
      run) — down from A13's own clean 631.05s, and far below the
      contention-affected 858.51s this session's profiling pass measured.
      `ps aux` checked immediately before each run: no concurrent `nx`/
      `vitest` processes; two long-lived, otherwise-idle
      `fastembedProcessHost.js` processes were present throughout (one from
      this repo, one from an unrelated `sox-memory-bundle` project) — noted
      per this task's own honesty requirement, not hidden, though neither
      is a `vitest`/`nx` test runner and the BL-331 concurrent-fastembed
      warning that fired during the run is a pre-existing condition of this
      machine, not something this change caused or could suppress.
      `cli.spec.ts` alone: 71.1s, down from A13's own 124.6-125.4s — a real,
      isolated ~54s cut in the exact file this task targeted, which
      accounts for nearly the entire whole-suite delta (631.05s -> ~576s ==
      ~55s). This is MEANINGFULLY SHORT of the ~164s projected recovery,
      investigated rather than declared a win regardless: the ~164s
      projection assumed converting close to all ~45 forced-sandbox call
      sites; in reality only ~18 of those (`runBacklogCli` + `backlog
      search`'s shareable tests) could be converted without changing what a
      test proves. The `--namespace / sandbox-path` describe block's 11
      tests are inherently about proving a FRESH mint happens on every
      invocation (the exact thing sharing would defeat) and were correctly
      left alone, each still paying its own cold IR-cache cost — this
      residual cost is real, disclosed, and not a defect in this fix; it is
      the honest ceiling of the "test-harness only" fix this task's own
      instructions scoped it to (§5c's implementation plan explicitly kept
      the IR-cache guard's semantics off-limits). Full suite is still ~70s
      above the pre-A13 floor (506.17s) — the remaining gap is exactly the
      isolation-correctness cost A13 was built to pay in the first place
      (real config isolation via `--namespace sandbox`'s per-invocation
      mint, for the 11 tests that must exercise fresh minting) traded
      against the real embedding-leak elimination A13 achieved; it is not a
      regression this task introduced or left unaddressed.

      `npx nx affected -t build --uncommitted`, `-t lint --uncommitted`,
      `-t test --uncommitted`: all clean/passing (lint: 0 errors, 172
      pre-existing warnings across files this task did not touch, plus 2
      pre-existing `no-unused-vars` warnings on `cli.spec.ts`'s own
      `mintSandbox`/`runInSandbox` helpers — dead code left over from
      A13-PIVOT's scaffolding-only commit, predating this task, not
      introduced or removed here; flagged rather than silently left
      unmentioned). `vocabulary-gate.mjs` and `embedding-usage-gate.mjs`:
      both CLEAN. `gx impact`/`gx detect-changes`: the only non-test file
      touched (`tools/run-web-ui.mjs`) has exactly 2 real consumers (the
      `nx serve backlog` dev command and `web-ui.spec.ts`), both verified
      working; `detect-changes` reported no unexpected affected scope.

## The embedding leak is a RECURRING CLASS, not a fixed list of files — root cause (2026-09-20)

Direct, unambiguous per-file isolation testing (run each file alone, grep
its own stderr for real `onnxruntime`/`CoreML` output — NOT log-position
correlation against a combined-suite run, which produced false leads both
ways: falsely implicated `superseded-ranking.spec.ts`/`server.published-
layout.spec.ts` via async-flush timing coincidence, and would have missed
these two entirely if trusted alone) found TWO MORE genuinely leaking files
that no prior audit (the original 8-file sweep, A13, A14, or the dedicated
profiling pass) caught:

- `src/install.e2e.spec.ts` — 4 real onnxruntime/CoreML hits. Spawns a real
  `serve --transport mcp` to prove a written MCP config actually launches a
  working server; never isolates that spawn.
- `src/serve.singleton.spec.ts` — 10 real hits. Its singleton-lock/crash-
  recovery proofs spawn real `serve` instances the same unprotected way.

Root cause in both, identical shape to the original 8: a local variable
literally named `adhdRoot` (a fresh `mkdtempSync` dir) is used only as the
spawn's `cwd` — never passed as `ADHD_ROOT`/the `adhdRoot` option that
actually redirects config resolution. The name looks like isolation; it
isn't wired to anything that provides it.

Also found: `src/store/semantic-search.spec.ts` (embedding-usage-gate
classified `INJECTED_FAKE`, file header claims "no model download") has
ONE test (`reports not_installed... when the optional packages are
absent`) that calls the REAL `bootstrapSemanticBackend` with no mock,
deliberately branching on success/failure — on a machine where the
optional packages are actually installed (this one), it takes the success
branch and genuinely loads the real model. Not a bug exactly (the test is
honestly designed to work either way), but it contradicts both the gate's
classification and the file's own header claim. Needs its classification
corrected, not silently left contradictory.

**THE ACTUAL ROOT CAUSE, not a per-file list:** every real-spawn test file
in this package hand-rolls its OWN `spawnSync`/`spawn` wrapper with its OWN
independently-chosen env vars — there is no single shared, canonical,
correct-by-construction spawn helper. Isolation correctness currently
depends on every file's author independently remembering to wire it right,
every time, forever. That is mechanically why this recurs: 8 found in the
original sweep, a 9th (`web-ui.spec.ts`) found by profiling, a 10th and
11th found just now by direct testing. Patching files one at a time as
they're discovered will never converge — the fix has to be structural.

- [x] A15. Built the canonical spawn helper, moved every real-spawn-bin
      file, and re-verified the whole inventory directly (isolated run per
      file, grep own stderr for `onnxruntime`/`CoreML` — never log-position
      correlation). DONE, with one CRITICAL production bug found+disclosed
      along the way (not fixed, out of scope — see below).

      **New file:** `src/test/helpers/spawn-backlog-bin.ts`, extracted and
      generalized from `cli.spec.ts`'s own A13/A14-hardened `runBin`/
      `runBinRaw`/`mintSandbox`/`runInSandbox`. Exports `DIST_INDEX`,
      `runBacklogBin`/`runBacklogBinRaw` (spawnSync, always forces
      `--namespace sandbox` unless `Raw`), `mintBacklogSandbox`/
      `runInBacklogSandbox` (mint-once-reuse-many via `sandbox-path`), and a
      NEW `stdioSpawnOptionsForSandbox` (returns the `command`/`args`/`cwd`/
      `env` shape `StdioClientTransport`'s constructor accepts, for the
      files that drive a real MCP `Client` instead of a synchronous
      `spawnSync` round-trip). `cli.spec.ts` itself was moved onto it
      (re-exported under its original names so none of its ~90 call sites
      needed to change) — 52/52 passing, 0 leak, proving the extraction is
      behavior-preserving.

      **Full inventory** (every file spawning `dist/index.js` or an MCP
      server as a real child process, found via `rg -l "StdioClientTransport|
      spawnSync\(|spawn\("` — broader than the original `spawnSync\(|spawn\(`
      sweep, which is exactly how this task's own 12th file was missed by
      every prior audit): 21 files total.

      **Before/after leak table** (direct isolated-run, `rg -c "onnxruntime|
      CoreML"` on that run's own stderr — the only trustworthy method this
      session found; log-position correlation against a combined run
      produced real false positives AND false negatives):

      | File | Before | After | Disposition |
      |---|---|---|---|
      | `install.e2e.spec.ts` | 4 hits | 0 | moved onto helper |
      | `serve.singleton.spec.ts` | 10 hits | 0 | moved onto helper |
      | `serve.spec.ts` | **3 hits (NEW — not in the original 11)** | 0 | moved onto helper |
      | `cli.spec.ts` | 0 | 0 | moved onto helper (already correct, A13/A14) |
      | `server.mcp.spec.ts` | 0 (already safe, but by accident — see below) | 0 | fixture hardened defensively |
      | `web-ui.spec.ts` | 0 (A14 fix) | 0 | unchanged, re-verified |
      | `cli-envelope.spec.ts` | 0 | 0 | unchanged — BUG-002's own `ADHD_BACKLOG_DATABASE_PATH`-precedence harness, deliberately not `--namespace sandbox` |
      | `query/registry-wire.spec.ts` | 0 | 0 | unchanged — sets `ADHD_BACKLOG_DATABASE_PATH` directly, never reaches the embedding path |
      | `query/meta-wire.spec.ts` | 0 | 0 | unchanged, same reason |
      | `query/paging-wire.spec.ts` | 0 | 0 | unchanged, same reason |
      | `search-shortcut-wire.spec.ts` | 0 | 0 | unchanged, same reason |
      | `install-skill-usage.spec.ts` | 0 | 0 | unchanged — pure filesystem op, no embedding path |
      | `install.published-layout.spec.ts` | 0 (2 failing — unrelated `dist-manifest` gap, see below) | 0 (6/6 passing once `dist/package.json` exists) | unchanged |
      | `server.published-layout.spec.ts` | 0 (same unrelated gap) | 0 (2/2 passing) | unchanged |
      | `server.verbs.spec.ts` | 0 | 0 | unchanged — `--help` only |
      | `ir-cache.integration.spec.ts` | 0 | 0 | unchanged — `--help` only |
      | `ir-cache.perf.spec.ts` | 0 | 0 | unchanged — `--help` only |
      | `vocabulary-gate.spec.ts` | 0 | 0 | unchanged |
      | `write/claim.spec.ts` | n/a (no `dist/index.js` spawn) | n/a | confirmed tsx-worker+explicit-`dbPath`, exempt |
      | `write/catalog-verbs.spec.ts` | n/a | n/a | confirmed exempt, same reason |
      | `write/cross-process-write-safety.spec.ts` | n/a | n/a | confirmed exempt, same reason |
      | `store/semantic-search.spec.ts` | 2 hits (in-process, not a subprocess spawn) | 2 hits (unchanged — correct, disclosed, machine-dependent per RAG-SPEC §1.6) | classification fixed, not the behavior |

      21 files inventoried; 12 total ever confirmed to leak across every
      audit this rollout has run (the original 8, `web-ui.spec.ts`,
      `install.e2e.spec.ts`, `serve.singleton.spec.ts`, and `serve.spec.ts`
      found THIS pass) — all 12 now verified clean by direct reproduction,
      not by inference.

      **`server.mcp.spec.ts`** was already 0-hit going in, but only by
      accident: it calls `startBacklogServer({scope:'project', adhdRoot})`
      directly via `test/fixtures/mcp-stdio-entry.js`, bypassing `cli.ts`'s
      `--namespace sandbox`/D8 entirely, so its safety depended on
      `embedding.enabled` defaulting `false` when no config.yaml exists
      anywhere in the chain — the EXACT "accident of an empty directory, not
      a deliberate guarantee" fragility D8's own doc comment already called
      out and hardened against for the CLI path. Hardened the fixture with
      an explicit `process.env.ADHD_BACKLOG_EMBEDDING_ENABLED = 'false'` so
      this no longer depends on nobody else ever planting a config.yaml
      above it. Re-verified: 2/2 passing, still 0 hits.

      **`store/semantic-search.spec.ts` classification fix (chose option
      (a)):** its `bootstrapSemanticBackend` diagnostics test calls the REAL
      function with no mock and conditionally loads the real model when the
      optional `@adhd/sox-embedding-provider`/`@adhd/sox-vector-store`
      packages happen to be installed (true on this dev machine — confirmed
      2 real onnxruntime hits). This is not a bug (the test is honestly
      designed to work either way, matching the real optional-dependency
      contract) — the file header and `tools/gate/embedding-usage-gate.mjs`'s
      `DECLARED_INJECTED_FAKE` entry both now state this conditional
      behavior explicitly instead of unconditionally (and incorrectly)
      claiming "no model download." Chose (a) over (b) (forcing the
      `not_installed` branch via a mock) because the test's whole point is
      proving the REAL optional-dependency contract, which a mock would
      defeat.

      **REAL PRODUCTION BUG FOUND, DISCLOSED, NOT FIXED (out of scope,
      CRITICAL blast radius):** while moving `serve.spec.ts`/
      `serve.singleton.spec.ts`/`install.e2e.spec.ts`, discovered that
      `@adhd/environment-builder`'s `resolveRoots()`
      (`packages/environment/environment-builder/src/roots.ts`) computes the
      `project`-scope root ONLY from `findProjectRoot(cwd)` — it NEVER
      applies `ctx.adhdRoot`, unlike the `global`/`system` bases which both
      do. This means `--namespace sandbox`'s `adhdRoot` isolation is
      SILENTLY IGNORED whenever a caller ALSO sets `ADHD_BACKLOG_SCOPE=project`
      (or `scope:'project'`) — confirmed by direct reproduction: a reused
      sandbox `ADHD_ROOT` + `ADHD_BACKLOG_SCOPE=project` + a shared `cwd`
      resolved `dbPath` under `<cwd>/.adhd/backlog/sandbox/...`, NOT the
      minted sandbox dir, causing real cross-test collisions (stale
      `serve.lock` files from one test blocking the next) until diagnosed.
      `gx impact resolveRoots`: **CRITICAL**, 7 impacted symbols, 4 affected
      processes (`environment-cli`'s `runDoctorChecks`/`verifySnapshot`/
      `buildAndMaybeWrite`, `environment-core-node`'s `Environment`
      constructor), 6 affected modules — a shared foundational package used
      far beyond this repo. NOT fixed here (out of this task's scope given
      the blast radius; needs human sign-off). Could not file a formal
      backlog item either: the real production backlog store
      (`~/.adhd/backlog/production`) is CONFIRMED currently broken for
      writes (`upsert-project` → "Write I/O failure... unclassified
      driver/connection error", retryable, reproduced twice) and has zero
      projects — consistent with STATE.md's own still-open "B. The actual
      data cutover" section. Logged to memory (project_path
      `/Users/nix/dev/node/adhd`, tags `backlog, environment-builder,
      resolveRoots, adhdRoot, scope-project, sandbox-isolation, bug,
      unfiled`) per the disclosure protocol's "keep a running log" fallback.
      Remediation for THIS package: removed the unsafe `scope:'project'` +
      `--namespace sandbox` combination from all 3 moved files, relying
      purely on `--namespace sandbox`'s default `global` scope (which DOES
      honor `adhdRoot` correctly) — the exact convention `cli.spec.ts`
      already used safely. Suggested (not applied) upstream fix documented
      inline and in the memory entry: honor `ctx.adhdRoot` for the `project`
      base too, mirroring `global`/`system`.

      **Also found+disclosed (unrelated, logged to memory for the same
      reason — production backlog writes broken):** `project.json`'s `test`
      target `dependsOn` (`["^build","build","assets"]`) is missing
      `dist-manifest`, so `server.published-layout.spec.ts`/
      `install.published-layout.spec.ts` (both need `dist/package.json`)
      fail with `ENOENT` when run via a bare `npx vitest run <file>` instead
      of the full `nx test` pipeline. Confirmed: `npx nx run
      backlog:dist-manifest` once fixes both immediately (6/6 pass). Not a
      regression from this task (0 onnx hits either way) — flagged as its
      own orthogonal gap.

      **Verification:**
      - `npx vitest run` (full package, background run, `dist/package.json`
        present for the earlier isolated per-file checks but wiped again by
        an intermediate `nx build` before this run — see the dist-manifest
        gap above): 71 files, 602 tests — **598 passed, 4 failed**, all 4
        the two known `dist/package.json`-dependent files above (confirmed:
        regenerating `dist/package.json` then re-running just those two
        files gives 6/6 passing). Zero onnxruntime/CoreML output anywhere in
        the 503s run except `semantic-search.spec.ts`'s disclosed 2 hits.
        Duration 503.43s.
      - `npx nx affected -t build test lint --uncommitted`: build/test/lint
        all green for every touched project; lint 0 errors, 172 warnings —
        IDENTICAL count to the pre-A15 baseline (including the 2
        pre-existing `mintSandbox`/`runInSandbox` unused-var warnings in
        `cli.spec.ts`, now sourced from the re-export instead of the local
        definition — same warnings, same root cause, not a new regression).
      - `node tools/gate/vocabulary-gate.mjs` — CLEAN.
      - `node tools/gate/embedding-usage-gate.mjs` — CLEAN (6 embedding-
        touching files, all declared).
      - `gx impact` on the new helper's exports (`runBacklogBin`,
        `mintBacklogSandbox`, `stdioSpawnOptionsForSandbox`): LOW risk, 0
        impacted (spec-file-only consumers, as expected for a test helper).
        `gx impact resolveRoots` (the one non-test production code this task
        touched only by DISCOVERY, not edit): CRITICAL, as detailed above —
        correctly left unmodified.
      - `git status --porcelain`: only this task's intended files touched
        (`spawn-backlog-bin.ts` new; `cli.spec.ts`, `install.e2e.spec.ts`,
        `serve.spec.ts`, `serve.singleton.spec.ts`,
        `store/semantic-search.spec.ts`, `test/fixtures/mcp-stdio-entry.js`,
        `tools/gate/embedding-usage-gate.mjs` edited) — every other modified
        file in the tree predates this task (A1-A14/F5's own uncommitted
        work). Did not commit, per instruction. Never touched the real
        production store during verification — every check ran through
        `mintBacklogSandbox`/`runBacklogBin`/`stdioSpawnOptionsForSandbox`
        or a throwaway `dist-manifest` regeneration; the two `node
        dist/index.js backlog ...` production-store probes used to diagnose
        and disclose the `resolveRoots` bug were read-only diagnostics
        (`query`) plus one `upsert-project` attempt that itself failed
        (confirming the store's write path is broken, not writing anything).

## Perf work — honest accounting (2026-09-19)

A8 (apigen lazy-load) independently re-verified, NOT a regression: forced a
genuine cache miss via the real `APIGEN_IR_CACHE_FILE` env var (the agent's
own verification used `APIGEN_IR_CACHE_ENABLED`, which does not exist in
source — that check was very likely a silent no-op against a cache hit, not
real proof). Cold run: 13.3s, correct output. Warm run: 3.06s. Real work
genuinely happens on the lazy-loaded path and produces correct results — the
fix stands.

BUT: neither A7 (embedding mocks, 506s not 30s) nor A8 (real ~50% cut for
`--help`-class invocations only, NOT for real commands) solved the actual
dominant cost for real usage. `query`/`create` against even an isolated
scratch store take 2-13s, dominated by `embedding.enabled: true` persisted
in `~/.adhd/backlog/production/config.yaml` forcing a real fastembed/
onnxruntime model load on every invocation regardless of whether the
command needs it. That is the real, still-unsolved root problem. A8/A7 were
real, verified, narrower wins — not the fix for what actually matters.

## B. The actual data cutover — the load-bearing gap

- [x] B1. Re-ran the ETL against a read-only copy of the real production file
      (1788 items, current as of today, taken via online-backup API, never
      opened the live file for writing). Output: `tools/etl/tmp/out/
      cutover-target.db` (gitignored scratch, not committed).
- [x] B2. All 4 parity comparisons PASS, including comparison 4 (previously
      502-item gap, now 0/146 orphaned components — exact match). Full
      report: `tools/etl/tmp/PARITY.md`. Scoping note for the real cutover
      run: the `owns_project` fix is mint-branch-only — it does not self-heal
      an already-orphaned store from a pre-fix run, only prevents new
      orphans. Not an issue for B1 (this ran on a fresh target), but keep in
      mind since the real cutover (B4) is itself a fresh run too, so this
      doesn't block it.
- [x] B2a. Full set-difference verification, joined on the real ETL identity
      key (`sourceNodeId`, per `tools/etl/identity.ts`'s documented join-key
      contract) — not aggregate counts, not PARITY-v2.md's 100-item sample.
      Ran against `cutover-target-v2.db` (the current canonical ETL output,
      postdating A9's `owns_project` fix). **1788/1788 verified, 0 diffs**:
      0 missing (every source item resolves to a live target `issue`), 0
      spurious (every target issue traces to exactly one source item), 0
      content mismatches (title/kind/status/live-state exact match for all
      1788). Report: `tools/etl/tmp/SET-DIFF-VERIFICATION.md` (gitignored
      scratch). Flagged, unfiled (backlog MCP unavailable this session —
      logged to memory instead): PARITY-v2.md §4 disclosed a real read-path
      bug independent of this verification — `src/query/card.ts`'s
      `resolveCitations` checks `typeof metadata.line === 'string'` but ETL
      writes it as a `number`, so `card.citations[].lines` silently comes
      back `undefined` for every ETL-imported issue. Not a B2a blocker (B2a
      is about issue existence/content-identity, not citation rendering)
      but needs a real ticket once the backlog store is reachable again.
- [x] B2b. Designed and built a real backfill pass reusing the actual
      on-write embedding path — never a bespoke duplicate — per the note
      below the checkbox that flagged this as the required approach:
      `src/write/embedding-observer.ts`'s `composeEmbedText`/
      `scheduleIssueEmbedding` (the exact functions `create`/`update` call
      on every genuine write) and `src/write/bootstrap.ts`'s
      `bootstrapSemanticStoreMembers` (the exact function that resolves the
      real `fastembed`/`bge-base-en-v1.5` provider + `TursoVectorBackend`).
      New tooling under `tools/etl/`: `embed-backfill.ts` (orchestration),
      `embed-backfill-cli.ts` (real-process CLI), `embed-verify-sample.ts`
      (verification via the real `view:'similar'` read path), 7 passing
      tests in `embed-backfill.spec.ts` (real store/adapter/vector backend,
      only the embedding model itself faked, matching this repo's existing
      precedent in `write/embedding-observer.spec.ts`), plus one additive
      field on `store-bootstrap.ts`'s `IEtlStoreHandle` (exposes `graph`,
      needed for the query-side handle; verified non-breaking, `run-etl.
      spec.ts` 11/11 + etl typecheck still pass).
      Executed for real against `tools/etl/tmp/out/cutover-target-v2.db`
      (the actual file slated for B4): **1534/1534 live issues backfilled,
      0 failures, 0 empty-content skips** (1788 total nodes; 254
      invalidated/superseded correctly excluded, matching production
      semantics). ~18.1 minutes real local ONNX/fastembed CPU inference,
      concurrency 6. Verified via the real read path, not a non-null-vector
      proxy: `embed-verify-sample.ts` against 4 sampled anchors returned
      genuinely topically-coherent `view:'similar'` neighbours (e.g. an
      nx/tsc-parallelism bug surfaced other nx build/typecheck/publish
      bugs). `embedding-usage-gate.mjs` CLEAN.
      Found+fixed in the process (not by this task, flagged and fixed by
      me directly afterward): `vocabulary-gate.mjs`'s `packageDocs()`
      scanned every top-level `.md` file indiscriminately, which made
      `STATE.md`'s own necessary prose (literal ETL filenames like
      `cutover-target-v2.db`, which this in-progress rollout tracker must
      name to be useful) trip the gate. `STATE.md` is not shipped (absent
      from `package.json`'s `files`) and is deleted/archived once cutover
      lands — excluded it explicitly by name, with rationale, in
      `tools/gate/vocabulary-gate.mjs`. Re-verified CLEAN. The packed-
      tarball gate (`scripts/check-vocabulary.mjs`) was never affected —
      it only scans the actual `npm pack` output, which never included
      `STATE.md` to begin with.
- [ ] B3. Get explicit sign-off on cutover mechanics: new file path,
      backup-before-flip convention, who/what flips `db.path`.
- [ ] B4. Execute the cutover as one explicit, approved step — old file
      preserved untouched, new file becomes what the default scope root
      resolves to.
- [ ] B5. Smoke-test immediately post-cutover: `query`/`get`/`create`/`claim`
      all working against the new file, `view:"projects"` returning the real
      registry.

## C. Re-verify against the cutover file

- [x] C1. Reran the organic concurrency e2e against the real built package,
      NOT waiting for the actual cutover (B3/B4 stay deferred) — instead
      run against a working copy of the actual promotion candidate,
      `tools/etl/tmp/out/cutover-target-v2.db` (1788 nodes, 1534 live,
      100% embedded), reusing the exact primitives
      `cross-process-write-safety.spec.ts` (BUG-039) uses: two real spawned
      OS-process writers, file-barrier synchronized, fresh-reopen
      `storedCount` verification. Two phases: CONTROL-same (same-body
      target, 200 creates x 2 processes) and CONTROL-distinct (unique
      bodies, 200 x 2). **Both PASS**: `{"a":{"ok":200,"threw":0},
      "b":{"ok":200,"threw":0},"persisted":400,"expected":400,"pass":true}`
      then `{"a":{"ok":200,"threw":0},"b":{"ok":200,"threw":0},
      "persistedTotalNow":800,"expectedTotal":800,"pass":true}` — 800/800
      real concurrent writes against the actual populated+embedded cutover
      target, 0 errors, 0 lost writes, 0 collisions. Script:
      `tmp/cutover-verify/c1-concurrency.ts`, log:
      `tmp/cutover-verify/c1-run-fresh.log` (gitignored scratch).
- [ ] C2. File the outstanding fix IDs (claim/transition gate, terminal-status
      guard, `owns_project` edge) into the real tracker — only possible once
      writes actually work. STILL BLOCKED, correctly: this needs the real
      post-cutover tracker (B4), not a working copy — can't be substituted.
- [x] C3. Full real-world CLI e2e smoke pass against the same cutover
      working copy, real built `dist/index.js` invoked as separate OS
      processes (never in-process, never bypassed), `--namespace sandbox`-
      style test isolation via the real binary. 12 steps, **all exit 0**:
      query/list (2334 total items visible, real data), `view:"projects"`
      (39 real projects incl. C1's probe project — confirms C1's writes
      landed and are queryable), `view:"similar"` against a real anchor
      (genuinely topically-coherent results — an nx/tsc build-race item
      surfaced other nx build/typecheck/workspace-linking items), `get`,
      `upsert-project`, `create` (`awaitEmbed:true`, real embedding
      computed synchronously), `get` on the new issue, `claim`,
      `transition` (open→IN_PROGRESS→RESOLVED, both real transition uids
      recorded), final `get` confirming `RESOLVED`, and a second
      `view:"similar"` post-create (again genuinely coherent — a
      smoke-harness/e2e-test issue surfaced other smoke/e2e-harness
      issues). Real fastembed/onnxruntime CoreML inference ran throughout
      (the stderr `CoreML does not support input dim > 16384` lines are
      the model's own informational warning, not an error — confirms real
      embeddings, not a stub). Script: `tmp/cutover-verify/c3-smoke.sh`,
      results: `tmp/cutover-verify/c3-results.jsonl` (gitignored scratch).

## D. Ship the package

- [x] D1. Committed everything from A/B/C as one commit, `2118d384`
      ("feat(backlog): close out the hard-replacement rollout —
      discoverability, cutover ETL, embeddings, ownership gates, and
      serve-lock verification"). Staged explicitly by path (never `git add
      -A`/`.`/`commit -a`) — `entrypoint/backlog/{CHANGELOG,DESIGN,README,
      SPEC,STATE}.md`, `skill/`, `src/`, `tools/`, plus the specific
      `packages/apigen/*` shared-package fixes from A2/A8 that were
      individually reviewed and accepted earlier in the rollout.
      Deliberately excluded: `AGENTS.md` (unrelated GitNexus-section
      reformat, no relation to this rollout) and 8 pre-existing untracked
      files all dated 2026-09-17 (`.claude/workflows/backlog-e2e-*.{js,
      mjs}`, two unrelated package `CHANGELOG.md`s) — confirmed via `ls -la`
      timestamps to predate this session's work window entirely, so not
      mine to judge, commit, or discard. Pre-commit hook ran the real
      vitest suite against the staged spec files and passed. First attempt
      accidentally split into two commits (a scripting mistake — two
      sequential `git commit` invocations in one background command); fixed
      immediately via `git reset --soft` back to the pre-existing history
      and one clean recommit — safe because both split commits were
      local-only, unpushed, and mine alone (verified `origin/feat/backlog-
      hard-replacement` was still at the prior `2894d82a` before touching
      anything).
- [x] D2. Pushed to `origin/feat/backlog-hard-replacement` (PR #9, "feat
      (backlog): 1.0.0 — one surface, one identity, no predecessor left
      behind", https://github.com/PseudoSky/adhd/pull/9, OPEN). Pre-push
      hook ran `nx affected -t test` for 63 projects/171 tasks against the
      full unpushed range (base `2894d82a` → head `2118d384`, 5 commits
      total including 2 pre-existing from earlier in the rollout) — 0
      errors (a handful of pre-existing lint warnings only, not
      regressions). `origin/feat/backlog-hard-replacement` now matches
      local HEAD exactly.
- [ ] D3. Get the PR reviewed and merged. NOT done autonomously — merging a
      PR is a human decision, not something this session executes on its
      own initiative even under the standing overnight authorization
      (which covered commit + push explicitly, not merge).
- [ ] D4. Publish to npm. NOT done — still blocked from earlier in the
      session (cause not diagnosed), AND publishing a public package is a
      separate, more consequential action than commit+push; the standing
      authorization did not cover it. Diagnose the block and get explicit
      sign-off before attempting.

## E. Roll it out system-wide

- [ ] E1. Bump the published version wherever it's consumed as a global
      CLI/MCP install — the step that makes the cutover file the one real
      agents actually hit.
- [ ] E2. Re-run the skill installer for all three hosts (claude/codex/
      opencode) so they pick up the final shipped skill doc.
- [ ] E3. Reload/restart the MCP server against the new binary + cutover
      file (currently failing to connect — needs fixing regardless).
- [ ] E4. Confirm real agent usage lands correctly on the new schema
      post-cutover; watch for a burn-in period, not just one smoke test.
- [ ] E5. Retire/archive the old pre-cutover file once nothing still points
      at it (keep the timestamped backup regardless).
- [ ] E6. Once E1-E5 are all verified done and the rollout has held for a
      real burn-in period, delete this file — its job is done and a state
      file that outlives its rollout is exactly the kind of stale doc this
      project has already been burned by twice.

## F. Deferred, logged, not blocking

- [ ] F1. Embeddings-usefulness review (dedupe threshold, RAG layer
      complexity-vs-value) — after go-live, not before.
- [ ] F2. Any discoverability findings that held up but weren't in A1's
      scope, if they remain after A1 lands.
- [ ] F4. NEW, real, disclosed-not-fixed DEBT found during A8: `grep -l`
      (without `-a`) silently treats a file as binary and excludes it from
      results the moment it contains a literal NUL byte — this bit a scan
      during A8 (`ts-json-schema.ts`, which has a NUL byte in a cache-key
      template literal, was silently dropped from a `grep -rln` sweep and
      cost real rework to find). `grep -rlna` is the fix at the call site.
      Verified directly: `rg -l` does NOT have this blind spot (correctly
      finds a match in a NUL-containing file that plain `grep -l` silently
      misses) — so this is really just confirmation that CLAUDE.md's
      existing "never use grep, always use rg" rule already prevents this
      class of bug; the miss happened because a dispatched agent used raw
      `grep` instead. Low-priority, not yet filed — see F3's write-blocker
      note (same blocker applies).
- [ ] F3. NEW, real, disclosed-not-fixed bug found during B1: `src/query/
      card.ts`'s `resolveCitations` checks `typeof n.metadata?.line ===
      'string'`, but `import-item.ts` always writes `line` as a number — so
      `card.citations[].lines` is silently `undefined` for every
      cutover-imported citation through the public `get`/`query` read API,
      even though the real value is on the node. Not yet fixed. Should be
      filed to the real tracker once B4 unblocks writes (same as C2).
- [x] F5. Two small, independent review-pass spec bugs fixed (2026-09-20):
      (1) `cli-envelope.spec.ts` leaked its `beforeAll`-minted `tmpRoot`
      (mkdtempSync store dir) on every run — added an `afterAll` that
      `rmSync`s it, matching `cli.spec.ts`'s teardown pattern; confirmed via
      running the spec twice in a row with no new leaked dir accumulating.
      (2) `serve.singleton.spec.ts`'s crash-recovery test used a fixed
      `setTimeout(..., 300)` sleep after `SIGKILL` instead of a bounded poll
      (AGENTS.md §7 rule 3) — replaced with `waitForProcessExit`, polling
      `process.kill(pid, 0)` until it throws `ESRCH`, deadline 10s. Negative-
      controlled: temporarily forced `serve-lock.ts`'s `isAlive` to always
      return `true` (breaking reclaim), confirmed the test fails cleanly with
      a clear assertion error (not a hang), then reverted. Both files:
      10/10 tests green; `npx nx affected -t build test` for `backlog` + 19
      dependent tasks: 71 files / 602 tests green; vocabulary-gate CLEAN.
      Test-file-only change, no production code touched in the final diff.

## G. Post-merge-readiness hygiene audit (new, 2026-09-21)

Separate from A-F (which are the rollout itself, now functionally done
except the human-gated B3/B4/D3/D4 steps). This is a multi-pass, multi-
agent audit of the PR's accumulated diff for cruft, redundancy, and
external-dependency-boundary issues that a straight-line rollout wouldn't
surface on its own. Dispatched as a real multi-agent fan-out (not a single
dispatch) per the user's own explicit orchestration plan — Pass 1 runs 6
haiku agents in parallel over `entrypoint/backlog/src` plus a separate
4-way sonnet code-review fan-out (one per PR-touched package: `backlog`,
`apigen-base-logical`, `apigen-core-client`, `apigen-engine-runtime`,
confirmed via `git diff --name-only main...feat/backlog-hard-replacement`).
Pass 2 (4 more agents, some depending on Pass 1 output) triages PR
comments, checks for forgotten dead files, and assesses how much backlog
code exists only to work around external (sox/adhd) package issues. Pass 3
is a single Opus architect synthesis of everything into
`BACKLOG_BACKLOG.md` (buckets: needs triage / needs scoping / clear fix).

- [~] G1. Pass 1 — 6 haiku agents (external-library-claim comment
      extraction; GitNexus module graph + redundant/misplaced-function
      scan; magic-variable/hardcoded-enum search; `jscpd` duplication scan;
      PR-comment context-packet extraction; raw-SQL usage scan) + a
      parallel 4-way sonnet code-review fan-out (one per touched package).
      Dispatched.
- [~] G2. Pass 2 — depends on G1's outputs. 4 agents: forgotten-dead-file
      assessment; sonnet PR-comment triage (answers, not just packets);
      external-package-claim removal-scope assessment (T2); architect
      review of T2 for where code should be unified (kept in backlog vs.
      pushed to a shared package vs. fixed externally). Partial: the
      triage/answers landed, but the architect placement-analysis leg
      produced a dispatch-failure diagnosis instead of the analysis — that
      gap is audit item **T-02**, now tracked in section H.
- [x] G3. Pass 3 — Opus architect synthesis of G1+G2 into
      `BACKLOG_BACKLOG.md`, bucketed needs-triage / needs-scoping /
      clear-fix. Done — `BACKLOG_BACKLOG.md` (714 lines, 2026-09-21) is
      the audit record this section H tracks against. Not filed to the
      real backlog graph (store unreachable that session); the graph is
      reachable again (2026-09-21) and filing is tracked in H4.

## H. Hygiene-remediation status — tracked against BACKLOG_BACKLOG.md (2026-09-21)

The audit (`BACKLOG_BACKLOG.md`) produced 60 items: 13 triage (T-01..T-13),
21 scoping (S-01..S-21), 26 clear fixes (C-01..C-26). This section is the
live status tracker for the remediation program that works them.

Status key: `open` (no work started) · `triage` (decision in flight) ·
`spec` (implementation spec in flight) · `in-progress` (executor
dispatched) · `done` (verified against tests/git, reviewed) · `deferred`
(recorded, sequenced later) · `resolved` (settled by a decision or by
another item's work, e.g. its file gets deleted).

**Sequencing (user directive, 2026-09-21):**
1. *Triage* — settle every T-item verdict (architect-decision / product /
   architect placement analysis).
2. *Removal pass FIRST* — delete deprecated/redundant code (the S-01
   semantic-search/embed-queue cluster + a full dead-code inventory) before
   any fix work, so no effort lands on doomed files.
3. *Clear fixes* C-01..C-26.
4. *Scoped items* per their specs.
5. *Review + merge* — nothing merges unreviewed.

### H1 — Triage items (T-01..T-13)

| Item | Summary | Status | Resolution / owner |
|------|---------|--------|--------------------|
| T-01 | audit schemas lack `coverage` (CODE_REVIEW_SCHEMA) and tool-exclusion (JSCPD_SCHEMA) fields | triage | fold into the review spec — add both fields before the next audit round (`review` agent) |
| T-02 | external-package placement analysis was commissioned but never produced (dispatch-failure diagnosis instead) | triage | `architect` placement analysis dispatched 2026-09-21 |
| T-03 | 35 external-package assessments fragmented under near-duplicate names, conflicting line estimates | triage | reconciled inside the T-02 placement analysis |
| T-04 | `computeCitationSha` duplicated (create-issue.ts:307 / transition.ts:224); per-file convention vs extraction | triage | `architect-decision` dispatched 2026-09-21 |
| T-05 | `carryForwardResidualEdgesTx` bypasses the multiplicity gate (update.ts:638) — only such write path | triage | `architect-decision` dispatched 2026-09-21 |
| T-06 | `SemanticHealthState` literal-union duplicated in a file slated for deletion | resolved | moot — `semantic-search.ts` is deleted in the S-01 removal pass |
| T-07 | `isSuperseded` upstream-support claim disproven (installed 0.4.3 and published 0.4.5 both lack it) | resolved | keep `dropSupersededResults`; file an upstream request against the sox ecosystem (no code change) |
| T-08 | embed-queue write-lock framing dispute (author claim vs verified code) | resolved | moot — dead half of `embed-queue.ts` is deleted in the S-01 removal pass |
| T-09 | add a git-SHA provenance field to audit records? (code matches SPEC §4a/DATA_MODEL §4; feature call) | triage | `product` verdict |
| T-10 | anticipatory abstraction of `sortByPriorityRank` (exactly 1 caller today) | triage | `product` verdict (revisit-at-third-use candidate) |
| T-11 | cache `fetchCatalogNames`? (verification: "correct but not worth fixing") | triage | `product` verdict |
| T-12 | hardcoded 30s embed timeout in `bootstrap.spec.ts:55` | triage | `product` verdict; folds into the S-08/S-09 config pass if approved |
| T-13 | adopt a duplication gate? (jscpd 6.54% / 15 blocks, several individually justified) | triage | `architect-decision` dispatched 2026-09-21 |

### H2 — Scoping items (S-01..S-21)

| Item | Summary | Status | Owner / notes |
|------|---------|--------|---------------|
| S-01 | free-text search degrades to grep-only for process lifetime; delete `semantic-search.ts` + dead half of `embed-queue.ts` + duplicate host bootstrap; implement SPEC §5b `ensureSemanticReady` seam | spec | **removal-pass wave 1** — `architect` spec dispatched 2026-09-21 |
| S-02 | ad-hoc query filters ×5; `assignee`/`claimedBy`/`closedAt`/`createdAt`/`updatedAt` silently dropped on some paths (real correctness bug) | open | after removal pass; coordinate with C-01 |
| S-03 | open/closed resolution triplicated verbatim across 3 query modules | open | — |
| S-04 | `assertNonBlank` ×8 / `enforceRequiredFields` ×3 reimplemented; widened null-safe + `in`-guard to standardize | open | — |
| S-05 | `grep` misnames the FTS field (public breaking rename) | triage | `product` verdict on rename-now-vs-defer |
| S-06 | `'order'` misnames the execution-sequence view (public breaking rename) | triage | `product` verdict (same class as S-05) |
| S-07 | user-defined named views/relations (feature; needs its own spec) | deferred | separate plan, not this remediation |
| S-08 | query limits hardcoded (`MAX_QUERY_LIMIT`/`DEFAULT_QUERY_LIMIT`); no config plumbing at 3 call sites | open | config pass together with S-09 |
| S-09 | retry tuning constants have no override path (`BASE_DELAY_MS`/`MAX_DELAY_MS`) | open | config pass together with S-08 |
| S-10 | `catalog.ts` introduces 4 novel SQL shapes vs `tx.ts`'s stated mirror-only rule | open | promote to named `tx.ts` helpers |
| S-11 | `tryResolveComponentRef` duplicates `tryResolveRef`'s name-resolution path | open | note: audit cross-ref "S-23" resolves to S-21 (determinism) |
| S-12 | UUID v4 shape validation belongs in `@adhd/data-base-transforms` (cross-package export + publish + consume) | open | — |
| S-13 | vector store can't distinguish "no filter" from "filtered to zero" | triage | `architect-decision` dispatched 2026-09-21 (upstream fix vs local guard; ADR-worthy) |
| S-14 | external-package workaround-removal program (~1,400+ lines, upstream-contingent) | deferred | blocked on T-02 placement analysis; a program to plan, not a task to start |
| S-15 | `closeStoreOnce` independently defined in both hosts (cli.ts / server.ts) | open | needs a shared host-bootstrap module |
| S-16 | test-harness boilerplate copy-pasted across six spec files | open | home: `src/test/helpers/` |
| S-17 | `write/CONTRACT.md` embeds code samples mirroring the implementation | open | generate-from-source / trim-to-signatures / gate — pick one |
| S-18 | `findImplicitDiscriminatorBranch` can select the wrong union branch on a missing tag (apigen-base-logical, high) | open | negative-control test proving the bug today, then fix |
| S-19 | unbounded recursion in `describeParams` for union-of-unions (apigen-engine-runtime, medium) | open | depth budget threaded through `typeName`/`unionValues`/`objectShape` |
| S-20 | startup-cost fix in `extraction-session.ts` shipped with no test (apigen-core-client, medium) | open | child-process require-side-effect harness |
| S-21 | name lookups return "first match" with no ordering guarantee (resolve.ts:134-153) | open | ORDER BY defence-in-depth + product call on project scoping |

### H3 — Clear fixes (C-01..C-26)

All `open`; none started. The removal pass runs before any of these. C-09's
`semantic-search.ts:30` site resolves to "file deleted" via S-01 — only the
`RAG-SPEC.md:13` wording fix and the C-10 sweep survive.

| Item | Summary | Status | Owner / notes |
|------|---------|--------|---------------|
| C-01 | extract `buildDateRangeFilter` (query.ts + views/semantic.ts) | open | coordinate with S-02 (strict subset) |
| C-02 | use `MARKDOWN_CAPABLE_VIEWS` in its own guard | open | with C-03 |
| C-03 | one canonical markdown-capable-view type | open | with C-02 |
| C-04 | one canonical graph-relation vocabulary (`GRAPH_RELS`) | open | — |
| C-05 | name the catalog-kind union | open | — |
| C-06 | constrain `mutateMetadata`'s generic | open | — |
| C-07 | parallelize the independent ref-resolution loop | open | — |
| C-08 | export the env-var name (`ADHD_BACKLOG_EMBEDDING_ENABLED`) | open | — |
| C-09 | delete the false single-writer claim | open | `semantic-search.ts:30` site resolved by S-01 deletion; `RAG-SPEC.md:13` wording fix stands (repo hard rule) |
| C-10 | sweep the package for other single-writer language | open | repo hard rule |
| C-11 | remove the static import of an optional dependency (`bootstrap.ts:50-52`) | open | — |
| C-12 | export `parseJsonObject` from `tx.ts`; delete the `parseMetaObject` copy | open | — |
| C-13 | share the claim-staleness default (30) from `catalog.ts` | open | — |
| C-14 | share the busy-timeout default (5000) from `env.ts` | open | — |
| C-15 | name the default HTTP host/port; derive the help text | open | — |
| C-16 | name the retry jitter band | open | — |
| C-17 | name the default edge weight (incl. the raw-SQL literal at update.ts:871) | open | — |
| C-18 | extract `resolveIssueProjectTx` (transition.ts:175 / update.ts:236 byte-identical) | open | — |
| C-19 | export `looksLikeOwnSandboxDir` from one place | open | — |
| C-20 | hoist `getScopeEnum()` out of the per-method loop (apigen-core-client) | open | — |
| C-21 | fall back for an empty `enum: []` (apigen-engine-runtime describe-params) | open | — |
| C-22 | run the vocabulary gates in CI (Nx target on the backlog project) | open | — |
| C-23 | add a data-model diagram to `DATA_MODEL.md`; link it from README | open | doc-only |
| C-24 | retire the now-satisfied TEST-GAP marker (`graph-backlog-store.spec.ts:73-89`) | open | — |
| C-25 | correct the stale fixture header comment | open | — |
| C-26 | reword the retry header's PRAGMA framing | open | cosmetic |

### H4 — Backlog-graph filing status

- Store: reachable for READS (integrity-repaired event on open:
  `backlog.db-shm.stale-2026-09-21-2029` moved aside). Production graph is
  **empty — 0 projects, 0 items** (verified via `adhd-backlog query`,
  views `projects`/`list`). The pre-rollout corpus lives behind the
  human-gated cutover steps (B3/B4) — noted, not mine to trigger.
- **BLOCKER (2026-09-21): the write path is DOWN.** `upsert-project`
  fails with `Write I/O failure: an unclassified driver/connection error
  surfaced from the underlying transaction` (retryable flag set, but the
  CLI's own retry does not recover); retried once, failed again. Reads
  succeed, writes fail — same blocker class as the prior session's F3/D4
  write-blocker. Consequence: **zero of the 60 items is filed yet**, and
  the 11 prepared filing payloads (project + component + jscpd-gate +
  findings + deferrals) are blocked. Triage this FIRST on resume
  (`debug` → `architect` → fix), before filing or implementation can
  transition states. Candidate root causes on record: stale install vs
  lockfile (sox-graph-store declared 0.10.0 / installed 0.9.2),
  BUG-008-class WAL issues, `classifyDriverError` classifying an
  unrecognized driver error as retryable-I/O, harness-role telemetry
  drop — all (unverified) until `debug` traces it.

### H5 — Triage-wave outcomes, program directives, resume map (2026-09-21)

**Standing user directives (2026-09-21):** (1) remove deprecated/redundant
code FIRST; (2) a jscpd gate is wanted — filed high-value (uid pending the
H4 write-path fix); (3) autonomy to complete the whole scope; (4) changes
to sox-ecosystem packages allowed, publish allowed — repo located at
`/Users/nix/dev/ai/sox-ecosystem`; (5) **dispatch code reviews after
completion of task groups** (every wave/group gets a `review` pass before
merge/push); (6) **sox-semantic adoption** (user-directed): Wave 0's
replacement triage must utilize `@adhd/sox-semantic`'s
`createSemanticBackend` rather than preserve the hand-rolled
`deriveMembers` — sequenced per the packaging verdict below.

**H5a — Write-path root cause (debug, 2026-09-22) + sox-semantic amendment:**
- **Root cause of the filing blocker:** the production store is a LEGACY
  closed-schema graph DB (kind/rel CHECKs), holding ~1560 real items as
  `kind='generic'`; the global `adhd-backlog` symlink resolves INTO this
  worktree (v1.0.0, open vocabulary) → every write violates the legacy
  CHECK. Not corruption/WAL/version-drift/telemetry. Fix = the plan's
  CUTOVER (extract → ETL → new open-schema store → repoint; legacy
  untouched as rollback). Cutover execution plan dispatched (`architect`).
  7 adjacent bugs mapped (2 sox-ecosystem: nodeNeedsRebuild heuristic,
  migrateToOpenSchema-Turso refusal; 5 backlog/ops: premature symlink, no
  initTelemetry, sidecar churn, auto_vacuum panic, stale install).
- **sox-semantic packaging verdict (architect-decision): (c) upstream
  first.** sox-semantic's dist has STATIC value imports of the heavy two
  used on the default probe path — DI injection skips calling, not
  loading. Upstream change (sox-ecosystem, publish granted): lazy dynamic
  imports on the default path only + heavy two out of hard deps → publish
  (0.1.4 suggested). THEN backlog adopts: remove the dead
  `@adhd/sox-semantic` hard dep (declared ^0.1.2, imported nowhere —
  dead-dep finding), move it to optionalDependencies ^0.1.3, align ranges
  (sox-embedding-provider ^0.4.1→^0.5.0, sox-vector-store ^0.6.0→^0.6.1),
  and replace `deriveMembers` with a thin DI adapter over
  `createSemanticBackend` (probe + seam + routing + host deletions in
  A–D are unaffected). checkDim/errText/PermanentEmbeddingDimensionError
  drop iff a red/green test proves SpaceInvariantError covers dim
  mismatch. Batch-first `embedDocuments` is NOT a blocker (per-write
  keeps the injected provider's `embedSingle`).
- In-flight (2026-09-22 checkpoint): sox-integration triage (architect);
  S-13 empty-ids upstream fix (typescript, sox-ecosystem, publish);
  sox-semantic optional-loadability (typescript, sox-ecosystem, publish);
  cutover execution (backend, full authorization). See H6.

### H6 — Session checkpoint (2026-09-22) + superseding resume map

**Landed (verified):**
- `ef790a65` — S-18 fix (apigen-base-logical `runmode.ts` missing-tag branch
  selection) + 5 tests (RED→GREEN); 228 passed; dependents green.
- `c972d679` — C-22 review findings closed (blind review found 7; all
  corrected: fixture-based controls with neuter evidence, dist-missing →
  exit 2, widened scan incl. CONTRACT.md, metadata reworded, dist inputs
  dropped). Carried unfiled: Finding 7 — backlog's release closure loses the
  `lint`/@nx/dependency-checks edge (pre-existing BUG-060 class; CI gates
  lint explicitly, only `nx release publish` is affected).
- Wave 0 Seg A–D — IMPLEMENTED, UNCOMMITTED (inventory below). Suite
  589/591; the only red = the S-13 pin (`search-ranked-zero-filter.spec.ts`:
  `ids:[]` returns 1, not 0 — upstream conflation CONFIRMED; fix in flight).
  Positive/cross-process/upgrade controls GREEN. Negative control CONVERTED
  to the permanent EMPTY-SPACE→grep control (green) — the old reciprocal
  guard is retired; its pre-fix RED evidence stands in the wave record.
- apigen S-19+C-21, C-20, S-20 — implemented + verified RED→GREEN (committed
  at this checkpoint; see git log). C-20 deviation accepted (single `Scope`
  hoist — both loops share one block scope). S-20 harness: child-process
  guarded-loader probe; barrel-level coverage gap noted (deferred item).
- Write-path root cause (debug, evidence-backed) + cutover plan persisted:
  `report/cutover-execution-plan.md`. **User approved full autonomous
  cutover execution (2026-09-22).** Excluded: `@adhd/backlog` npm publish,
  PR #9 merge (human-gated).
- sox-semantic packaging verdict: (c) upstream-first (H5a).

**In flight (background dispatches — collect results; use `agent_task_list`
if a notification is missed):**
1. sox-integration triage (architect) — user directive: integrate the recent
   sox changes across graph/store/embedding/search/rrf/semantic; eliminate
   custom SQL + modeling code. Deliverable: feature→elimination map,
   upstream gaps, sequencing, verification.
2. S-13 empty-ids fix (typescript, sox-ecosystem) — present-but-empty `ids`
   ⇒ zero results at every layer; ADR + publish.
3. sox-semantic optional-loadability (typescript, sox-ecosystem) — lazy
   imports on the default path only + heavy two out of hard deps; publish.
4. Cutover execution (backend) — per `report/cutover-execution-plan.md`;
   full authorization; stop-and-report on gate failure.

**Uncommitted inventory (the wave's atomic unit — commit together when
green):** `entrypoint/backlog/src/write/bootstrap.ts`, `api.ts`,
`query/query.ts`, `cli.ts`, `server.ts`; specs `query/meta.spec.ts`,
`query/superseded-ranking.spec.ts`, `query/text-routing.spec.ts`,
`query/views/semantic.spec.ts`, `write/bootstrap.spec.ts`,
`query/search-ranked-zero-filter.spec.ts` (new S-13 pin),
`api.semantic-laziness.spec.ts` (new), `write/rag-optional-deps.spec.ts`
(renamed from `store/`). Plus this STATE.md. (AGENTS.md is a pre-existing
other-agent edit — not ours.)

**Sox-integration triage outcome (architect, 2026-09-22) — plan persisted at
`report/sox-integration-plan.md`:**
- **Headline correction: the tx-scoped-primitives hypothesis is FALSE** —
  graph-store 0.10.0/HEAD still has `writeNodeInTx`/`writeEdgeInternal`
  PRIVATE and `transaction(fn)` without an adapter swap. Upgrading removes
  ~0 lines of tx.ts; the S-14 cluster-1 elimination (~205 lines +
  claim/delete/catalog) requires NEW upstream work (**G1**).
- **Version matrix:** graph-store 0.9.2 installed vs 0.10.0 declared/latest;
  adapter 0.9.1 vs 0.9.2; hybrid-search 0.4.3 vs 0.4.5; semantic 0.1.3 vs
  0.1.4 latest / 0.1.5 HEAD-unpublished; vector-store 0.6.1 and embedding
  0.5.0 current. Declared `^0.10.0` is UNSATISFIED — re-install is a Wave 0
  prerequisite.
- **Usable immediately after re-install (published today):**
  `NodeFilter.isSuperseded` pushdown (kills the `as unknown as NodeFilter`
  casts + inflated counts); `countBy`/`getNodesByIds`/`NodeFilter.after`/
  edge-meta filtering (read-path simplification).
- **Gaps:** G1 tx-scoped primitives (BLOCKING, new sox work); G2 combined
  busy/contention predicate; G3 hybrid-search isSuperseded passthrough
  (=T-07); G4 migrateToOpenSchema-Turso + nodeNeedsRebuild (cutover
  hardening); G5 publish semantic 0.1.5 + close its hybrid-search residual;
  G6 empty-ids fix (in flight); G7 SortField joined-edge.
- **Wave 3 sub-waves:** 3a semantic adoption (G5); 3b tx elimination (G1 —
  dispatch AFTER the S-13 fix lands in graph-store to avoid version-bump
  collisions); 3c ranked-path cleanup (G3+G6); 3d telemetry.
- sox-semantic 0.1.5 optional-loadability is ALREADY AT HEAD (unpublished) —
  the in-flight executor's job is verify + close the hybrid-search residual
  + publish.

**Next steps (revised):**
1. Collect in-flight results (sox-semantic publish, S-13 publish, cutover).
   Verify via `npm view`.
2. **Wave 0 deps:** after the S-13 fix publishes → update the worktree to the
   published set (graph-store 0.10.x, adapter 0.9.2, hybrid-search 0.4.x,
   vector-store 0.6.x) → `pnpm install` → re-run the backlog suite → all
   green → commit Wave 0 A–E atomically
   (`refactor(backlog): SPEC §5b semantic-readiness seam + host bootstrap cleanup (S-01 A–E)`)
   → pre-push hook unblocks.
3. Wave 0 Seg F (deletions + `flushEmbeds` + embedding-usage-gate bucket
   fix) → Seg G (docs + resolutions) → review pass → push.
4. **On S-13 completion: dispatch G1** (sox-graph-store tx-scoped primitives —
   `transaction(fn,{mode})` adapter-swap overload preferred; reconcile
   ADR-0010 D3; publish), then 3b tx elimination.
5. sox-semantic adoption (post-G5): `bootstrap.ts` thin DI adapter over
   `createSemanticBackend` + package.json moves + range alignment + lockfile;
   drop `checkDim`/`errText`/`PermanentEmbeddingDimensionError` iff a
   red/green test proves `SpaceInvariantError` covers dim mismatch.
6. Wave 1: S-02+C-01 (query.ts); apigen S-20 barrel coverage gap.
7. Wave 2: remaining C-fixes + refactors + S-08/S-09 config pass + jscpd
   gate activation (5% ceiling + allowlist) + the published-feature
   adoptions (isSuperseded, countBy/getNodesByIds/after/edge-meta, range
   alignment, dead-dep removal).
8. Filing (once the cutover completes): the prepared block (project +
   component + 11 items) + accumulated findings — sox 7-bug list + G1–G7,
   review Finding 7, S-20 barrel gap, stale apigen-core-client AGENTS.md
   test counts, S-13 pin status, sox-semantic dead-dep/range conflicts.
9. Review each group before push (directive 5); PR #9 merge +
   `@adhd/backlog` publish remain human-gated.

**Update (2026-09-22 late) — publishes + cutover landed:**
- **Published (sox-ecosystem, npm-verified):** `sox-semantic@0.1.5`
  (optional-loadability; residual — hybrid-search still hard-declares the
  heavy two → `BUG-HYBRID-SEARCH-OPTIONAL-LOADABILITY-001` filed) +
  `sox-host-registry@0.5.0` (batched changeset). `sox-graph-store@0.10.1`,
  `sox-vector-store@0.6.2`, `sox-hybrid-search@0.4.6` (empty-ids conflation
  fixed at every layer; **ADR-0017** written; BUG-032 filed+resolved). The
  live worktree's declared ranges already satisfy these — only a lockfile
  refresh was needed.
- **Cutover executed** (A + B1–B5): new open-schema store
  `~/.adhd/backlog/production/data/backlog-v2.db` (1824 issues: 1569 live /
  257 invalidated; 1568 embeddings); parity green (full-population 1824/1824,
  residual 0 on every reproducible delta — the plan's "675" criterion was
  unreproducible as written and replaced by the decomposition); legacy
  untouched (hash-stable) + backed up to `backup-cutover-20260922-002647/`;
  config `db.path` flipped; global bin → frozen build
  (`.worktrees/backlog-cutover`, which needed an in-range hybrid-search
  0.4.5 bump to build — filed `0c800822`; ETL superlinear cost filed
  `50c69b14`). Frozen-build `update` verb rejects `note`/`addNote` (filing);
  two smoke items remain in the production store (`ef8295d5`, `848afee9`).
- **In flight now:** Wave 0 dep-align + suite-green + atomic A–E commit
  (typescript); G1 tx-scoped primitives (typescript, sox-ecosystem);
  Phase C serve/MCP repoint + real-JSON-RPC verify (backend); adhd-graph
  filing block (general).
- After Wave 0 commits: dispatch the wave review (directive 5) → push.

**Update (2026-09-22, later still):**
- **G1 PUBLISHED** — `@adhd/sox-graph-store@0.11.0` (+ cascade analysis 0.1.13,
  hybrid-search 0.4.7, semantic 0.1.6, memory-core 0.10.2): `transaction(fn, opts?)`'s
  callback now receives a `GraphTransaction` (AdapterTransaction superset) with
  typed tx-bound primitives (`writeNode`/`writeEdge`/`invalidateEdge`/`touch`/
  `getNodeByUid`/`getEdges`/`getNodesByIds`/`writeGraph`/`writeEdges`…);
  `{mode:'immediate'}` = BEGIN IMMEDIATE. 15 specs + negative control; commits
  `b7303404`/`856c8d50`/`7497c56f`/`d0e65326` on sox main. **CORRECTION
  recorded:** the old "writes autocommit against the bare adapter" premise was
  FALSE (AdapterTransaction wraps the same connection) — 3b is an API-adoption
  refactor (kill the SQL mirrors), not a correctness fix. 3b spec dispatched.
- **Phase C COMPLETE** — MCP registrations repointed (`.mcp.json` committed
  `fcb2f2dd` in the main repo; `~/.claude.json` + `~/Library/pnpm/backlog`
  shim backed up + repointed at the frozen build); stale serve PID 46472
  stopped (TERM hung → SIGKILL; bug filed `52a099ac` — serve ignores
  SIGTERM/SIGINT with a stdio peer); verified as a real MCP client: 40
  projects / 1571 items from `backlog-v2.db`. No orphan serve (host-owned stdio).
- **Filing COMPLETE** — 22 creates + 1 dedupe-update in the adhd graph (project
  `7ee5721e`; component `entrypoint/backlog` `9a7bf578`): jscpd gate
  `b63a66fe`, S-01 `76f0cef4`, C-22 `6bb37a98`, S-18 `7a197624`, S-19+C-21
  `d25f6b17`, C-20 `8c9b1b9f`, S-20 `751c4630`, C-06 `53a7eb55`, S-14 umbrella
  `6ff60c82`, isSuperseded adoption `095db4f3`, +12 more.
- **Wave 0 status:** deps committed (`a8906d3d` — ranges bumped to
  `^0.10.1`/`^0.6.2`/`^0.4.6`/`^0.9.2`; note: `pnpm update` silently no-ops on
  these, the range bump + install was the working path; lockfile churn is
  cosmetic re-serialization). **Suite 600/600 GREEN including the S-13 pin.**
  Wave commit BLOCKED by the vocabulary-guard entanglement (below).
- **NEW stream (not from any dispatcher dispatch): `store/vocabulary-guard`**
  — `src/store/vocabulary-guard.{ts,spec.ts}` + `graph-backlog-store.ts` +
  integration calls inside `api.ts`/`query.ts`/`cli.ts`; appeared 23:14-23:15.
  A fail-loud guard for the silent-empty-store class (a store written under a
  foreign node vocabulary reads as `{ok:true,total:0}`) — exactly the failure
  class the cutover exposed; references BUG-BACKLOG-005; spec documents teeth.
  Suite green with it. Commit handling awaiting the user's answer.

**Update (2026-09-22 — wave committed, review returned, push blocked):**
- **Commits landed:** `18e1596d` (vocabulary guard — committed first, per the
  user's decision), `4d54a54f` (the wave: 13 files, +1208/−270; 10 staged
  specs / 107 tests green), `951224ce` (session docs). Suite at commit:
  **600/600 green.**
- **Blind review of the wave** (a8906d3d + 4d54a54f) returned 11 findings —
  all filed to the graph: **HIGH `e19bc9d0`** (`spacePopulated()` reads the
  ENTIRE vector table per bare `text:` query — `iter`→`executeAll`→`db.all`;
  fix = bounded primitive; sox `hasVectors` dispatched), `f3f71daa`
  (SPEC §5b stale vs the shipped design), `e769bdc4` (real-model coverage
  moved off the production seam), `a1c2cbde` (`store-check` untested),
  `b7805de9` (S-01 dead code left — resolves via Seg F), `8ca66712`
  (vocabulary guard runs an O(store) histogram per verb), `efbb5c4b`
  (membersCache latches failures), `496e2c58` (RECOGNIZED_NODE_KINDS
  unpinned), + a stale-comment low. Fix batches dispatched (code/docs +
  tests).
- **Push BLOCKED:** the pre-push hook fails on `apigen-plugin-java-javalin:test`
  — `mvn package` exits 1 under the parallel affected run while passing
  standalone; TWO tasks invoke mvn on the same `packages/apigen/java` module
  (`plugin.ts findFatJar` + `conformance gate.ts`) and overlap → race
  (strongly evidenced; no metrics-guard messages). `debug` dispatched to
  confirm + propose the fix (preferred: a cached `apigen-java:package` nx
  target both consumers depend on). Remote still at `af8eaf63`; push waits
  on the fix.
- **In flight:** debug (java race) · sox-vector-store `hasVectors` + publish ·
  review fixes (code/docs) · review fixes (tests).
- **Next:** java fix → re-run affected → push; then switch the readiness
  probe to `hasVectors`; Seg F → Seg G → review → push; Wave 1 → Wave 2 →
  Wave 3 (3a/3b/3c/3d per `report/sox-integration-plan.md` +
  `report/wave-3b-tx-elimination-spec.md`).

**Update (2026-09-22 — java race fixed, test-review fixes landed):**
- `653d8996` — test-review fixes: `src/cli.store-check.spec.ts` (spawned-CLI;
  exit 0 + ok / exit 1 + `store_vocabulary_mismatch`), `src/store/
  vocabulary-drift.spec.ts` (pins RECOGNIZED_NODE_KINDS vs write/tx.ts; teeth
  proven), `src/api.semantic-production-seam.spec.ts` (DEFAULT-RUNNING
  real-model seam spec; loud-fail precondition, no gating), stale comments
  fixed. 12/12 touched specs green. Its deferral (canonical WRITE_NODE_KINDS
  export) folded into existing item `41b8326e` (body updated).
- `59bf05a9` — **java race fixed**: the previously-dead `apigen-java:package`
  target wired into BOTH test targets' `dependsOn`. **Key finding: a
  project-level `dependsOn` REPLACES `targetDefaults` (not merge)** — both now
  list `["lint","^build","apigen-java:package"]`. `findFatJar` locates the
  prebuilt jar under nx (`NX_TASK_TARGET_TARGET` detection — `@nx/vite:test`
  has no env option) and never spawns mvn (proven: 7 mvn invocations under the
  test, all `compile exec:java`, zero `package`); mvn stdout now included in
  thrown errors (BUG 73741a3c); java-javalin green ×2, conformance green.
- Debug confirmed the race (2/8 reproduction; shade plugin racing on
  `dependency-reduced-pom.xml`/`target/*.jar` between the suite's two parallel
  spec files — BUG 14614478). Residual cold-cache ordering hazard filed
  `f80bf841` (LOW; cheapest fix = narrow `apigen-java:package` outputs to
  `target/*.jar`).
- Note (hypothesis, triage pending): the frozen build's
  `scheduleIssueEmbedding` degraded once to `embedding_failed` ("database
  connection is not open") during item creation — item persisted, vector
  indexing skipped. Watch for recurrence.
- Still in flight: sox `hasVectors` (publish); review fixes code/docs. Then:
  full affected gate → push.

**Checkpoint for context compaction (2026-09-22):**
- HEAD `e23d7562` on `feat/backlog-hard-replacement`; remote `origin` still at
  `af8eaf63` — **push pending** the affected gate (the java mvn race blocker
  is fixed).
- In flight (background task ids): sox `hasVectors`
  (`ses_f36a6efc5ffeNgBQ6UICeIVjH1`); review fixes code/docs
  (`ses_f36a6e0b5ffeOU8LAWvpbb2wdT` — its edits are the uncommitted `SPEC.md` /
  `vocabulary-guard.ts`+spec / `bootstrap.ts` in the tree). Collect both, then:
  `npx nx affected -t test --base=af8eaf63 --head=HEAD` → push.
- Immediate queue after push: switch the readiness probe to `hasVectors`
  (dep bump) → Seg F → Seg G → review → push → Wave 1 → Wave 2 → Wave 3.
- Memory handoff (canonical): episode `01M34PTH0G1ZWJ7NM40HBAZTWN`, topic
  `backlog-v2-remediation` — updated at this checkpoint.

**Update (2026-09-22 — PUSHED; clean stopping point):**
- **PUSHED:** `af8eaf63..d4a72009` — remote
  `origin/feat/backlog-hard-replacement` now at `d4a72009`. Pre-push affected
  gate passed: 63 projects / 174 tasks, 213/237 cache hits, 0 failures.
- The branch now carries everything: apigen S-18/S-19/C-21/C-20/S-20; C-22 +
  review-fix; the vocabulary guard; Wave 0 A–E; the java mvn race fix
  (`59bf05a9`); the review fixes (`d7343221` code/docs, `653d8996` tests,
  `5294244b` gate buckets); the run.spec load-flake fix (`d21f7a03`); the
  bounded `hasVectors` probe switch (`d4a72009`).
- **`e19bc9d0` (HIGH) fixed in code** — bounded `hasVectors` capability probe
  (`sox-vector-store@0.7.0` installed; teeth proven by revert). Graph
  resolution deferred to Seg G.
- Residual notes: `run.spec.ts:304`'s doc comment still says the sibling
  declares `{ timeout: 20000 }` (now 90000) — one-token fix; the other
  load-sensitive bounds in that file (30s/20s) could get the same treatment.
- **Next:** Seg F → Seg G (incl. resolving `e19bc9d0`/`f80bf841`/`b7805de9`
  and the doc updates) → review → push → Wave 1 → Wave 2 → Wave 3.

**Triage decisions landed:**

| Item | Verdict → consequence |
|------|-----------------------|
| T-01 | fold into the review spec — add `coverage` (CODE_REVIEW_SCHEMA) + tool-exclusion (JSCPD_SCHEMA) fields before the next audit round |
| T-02/T-03 | placement analysis COMPLETE (architect): 13 cluster verdicts, T-03 estimates reconciled; **Finding 0 — worktree install is stale vs its own lockfile** (sox-graph-store declared 0.10.0 / installed 0.9.2) |
| T-04 | EXTRACT `computeCitationSha` → new `src/write/citation-sha.ts`; both write sites import; the divergent `tools/etl/citation.ts` copy stays distinct (flagged for follow-up). Queued Wave 2 |
| T-05 | doublet unreachable (acceptable) BUT the skip's doc comment is factually false and the gate is free: export `checkMultiplicityTx` (tx.ts:541), gate before the carry-forward INSERT, rewrite the justification. Queued Wave 2 |
| T-06/T-08 | resolved by S-01 deletion (moot) |
| T-07 | keep `dropSupersededResults`; upstream request filed (blocked on H4 write fix) |
| T-09 | deferred — data-model feature, own epic (filing queued) |
| T-10 | defer — revisit at the third caller |
| T-11 | won't-fix — reply-only |
| T-12 | defer — folds into the S-08/S-09 config pass if bootstrap.spec survives S-01 |
| T-13 | architect: no gate at today's 6.54%; adopt a 5% CI ceiling AFTER S-01/S-03/S-04/S-16 land, CONTRACT.md mirrors + per-file write conventions allowlisted. **USER OVERRIDE: gate wanted → filed HIGH-VALUE** |
| S-05/S-06 | defer both to the next major, batched as one breaking release with deprecation aliases |
| S-13 | decision agent INSUFFICIENT twice (could not read installed dist in budget). Disposition: the ambiguity dies with semantic-search.ts; surviving path passes NodeFilter straight to `searchRanked` (upstream filtered-KNN); local guard rejected; the "filter-resolved-to-zero must return zero, never unfiltered" invariant is upstream-owned and warrants a sox-ecosystem ADR (ADR-0016 amendment candidate). Wave-0 A–D acceptance must include a behavioral pin of zero-not-unfiltered against the real installed vector store |
| S-18 | exact fallback contract delivered (undefined tag never matches; distinct-literal gate; no-match → undefined → structural scoring → `oneOf[0] ?? {}`). Impl queued (apigen track) |
| S-19 | exact depth contract delivered (integer `depth=2` budget; union gated ≥2 consuming 1; object terminal ≥1; truncation markers `'union'`/`'object'`; existing pins stay byte-identical). Impl queued (apigen track) |

**Product worklist adopted:** Wave 0 removal (S-01 + dead-code + C-22 +
C-09-RAG-SPEC-site) → Wave 1 correctness (S-02+C-01; apigen S-18/S-19/
S-20/C-20/C-21; S-13 acceptance folded in) → Wave 2 clear fixes +
refactors (remaining C-items, S-03/S-04/S-11/S-12/S-15/S-16/S-17/S-21a,
config pass S-08/S-09) → Wave 3 (S-14 sox-ecosystem program; S-07 own
plan).

**Work landed this session:**
- **C-22 DONE** — commit `67b385d3`: `vocabulary-gate` Nx target on the
  backlog project (dependsOn build/assets; `test.dependsOn` extended),
  negative-controlled. Review queued per directive 5.
- **Wave 0 Seg E DONE (uncommitted, in tree — the A–D executor commits it
  together with the code):** new `src/api.semantic-laziness.spec.ts`;
  re-scoped `text-routing.spec.ts`, `superseded-ranking.spec.ts`,
  `meta.spec.ts`, `views/semantic.spec.ts`, `bootstrap.spec.ts` (header);
  staged rename `src/store/rag-optional-deps.spec.ts` →
  `src/write/`. RED evidence: positive control + cross-process + upgrade
  tests fail with `searchRanked` called 0 times (expected); the negative
  control is the reciprocal guard (green pre-fix, must flip red post-fix)
  — framing accepted: that is the correct teeth for a bug-presence test.

**Resume map (ordered):**
0. `debug` triage of the H4 graph write-path failure → `architect` plan →
   implement fix. Until then no filing and no status transitions.
1. Re-run the prepared filing block (project + component + 11 items), then
   fan out filing the remaining program items (dedupe per backlog-usage).
2. `review` pass on C-22 (directive 5).
3. Wave 0 Seg A–D (`typescript`): bootstrap probe + `ensureSemanticReady`
   seam + query routing + host deletions — one atomic commit together with
   the uncommitted Seg-E files; full suite green; S-13 zero-not-unfiltered
   behavioral pin included.
4. Wave 0 Seg F (`typescript`): delete `semantic-search.ts`,
   `embed-queue.ts`, `mutate-metadata.ts`, `rag-e2e.spec.ts`,
   `semantic-search.spec.ts`; drop `flushEmbeds` from graph-backlog-store;
   fix the stale REAL_BY_DESIGN bucket for text-routing.spec.ts in
   `tools/gate/embedding-usage-gate.mjs`.
5. Wave 0 Seg G (`backend`): docs (RAG-SPEC/DESIGN/PLUGIN_ARCHITECTURE/
   immediate-retry header) + resolve S-01/C-09-part/T-06/T-08/C-06 +
   transition filed items.
6. `review` pass on Wave 0 (directive 5) → push.
7. Wave 1: S-02+C-01 (query.ts, after Wave 0); apigen track
   S-18/S-19/C-21/C-20/S-20 (file-disjoint, parallel) per the landed
   verdicts.
8. Wave 2: remaining C-fixes + refactors + S-08/S-09 config pass; then
   activate the jscpd gate (5% + allowlist) per the filed item.
9. Wave 3: S-14 against `/Users/nix/dev/ai/sox-ecosystem` (clusters
   1/5/9/11, publish granted; start with lockfile re-install + cluster-1
   verification vs sox-graph-store 0.10.0); S-07 as its own plan.
10. Every transition: update this section + the backlog graph (once the
    write path is fixed).

**Notes:** audit cross-ref "S-23" in S-11 resolves to S-21 (determinism).
Two spec-tsconfig type errors pre-existed the Seg-E edits and were left
untouched (meta.spec.ts:51/272, views/semantic.spec.ts:488,
bootstrap.spec.ts:152 — repo-wide `IIssueListResult | IIssueMarkdownResult`
`.items` weakness on lines not authored this wave) — (unverified
pre-existing).

**Push status at pause:** commits `67b385d3` (C-22) and `e6b90897`
(state/audit docs) are LOCAL-ONLY. The pre-push hook correctly blocks on
`nx affected -t test` because the working tree holds the deliberately-RED
Seg-E specs (positive-control/upgrade assertions awaiting the A–D code) —
do NOT `--no-verify`; push after Wave 0 Seg A–D lands and the suite is
green. Remote `origin/feat/backlog-hard-replacement` is at `af8eaf63`.

**Update (2026-09-22 — waves + citations + telemetry + PR-split; persisted-plan sync):**

**Stream A (hygiene waves):**
- Seg F DONE `111c19bd` (not pushed): deleted `semantic-search.{ts,spec.ts}`,
  `embed-queue.ts`, `mutate-metadata.ts`, `rag-e2e.spec.ts` (−1695/+32, 8 files);
  dropped the `flushEmbeds` import/member/drain from `graph-backlog-store.ts`
  (vocabulary-guard untouched); `embedding-usage-gate.mjs` buckets updated. Suite
  75 files / 597 tests green (reconciled: −16 tests from the deleted specs); both
  gates CLEAN; lint clean. Filed `2b607b26` (residual stale comments) — resolved by Seg G.
- Seg G DONE `315f120f` + `145fda7b` (not pushed): RAG-SPEC/DESIGN/PLUGIN_ARCHITECTURE
  retired to the live seam; C-26 immediate-retry header; run.spec:304 comment + bounds
  30s/20s→90s; `2b607b26` sweep (+2 extra `rag-e2e` refs in the production-seam spec);
  CONTRIBUTING single-writer phrase fixed (C-10 partial — SPEC.md is citation-fix-owned).
  Graph: S-01→`45da2e00` (closed), e19bc9d0→`eacf4aa8` (closed), b7805de9→`fee0d523`
  (closed), 2b607b26→`836d4209` (closed); C-06 already closed; f80bf841 left OPEN.
  C-09/T-06/T-08 not filed in the graph (STATE-only) — no write possible.
- **Citations fix DONE `7875d848`** (typescript, not pushed) per verdict (A):
  `projectHasKnownPath(project)` predicate + both throw sites gated on it; path-less
  projects persist `sha:'unverified'`; path-present-unresolvable still hard-fails.
  4 new tests + negative control (red→green proven). No `policy` deep-merge (dropped).
  Optional `unverified-citation` audit event NOT added (conflicts with SPEC §4a one-
  audit-node contract — open question).
- **F3 verdict (ref field):** architect-decision APPROVE — add now, but ITEM-LEVEL
  provenance (`ICreateIssueInput`), not per-citation `ref`; `context` is prose and
  unrendered (markdown.ts:32-35) so it can't carry it; render once at the head of the
  `Citations:` block. LOW risk. Implementation queued (next wave).
- **Cross-agent gate break + fix:** Seg G's comment edit (`315f120f`) tripped the
  embedding-usage gate (`bootstrapSemanticStoreMembers` bare identifier in a comment)
  → filed `cd34ba0d` (blocks full-suite green). Needs the one-line fix (reword the
  comment). Next wave.

**Stream C (citations):** verdict (A) + fix landed (above). `29b4578d` enriched → live
`6defe186`; EISDIR gap `aede6810`; BUG-026 sidecar `edc4f456`; scheduleIssueEmbedding
audit-persist `cb47fb79` (2nd occurrence — now filed).

**Stream D (telemetry + fastembed) — user HARD requirements:**
- R1: BL-404 = duplicate `@adhd/sox-telemetry` singleton (`sox-embedding-provider@0.4.1`
  nests 0.2.1 as a regular dep; parent-side fastembed client emits through it; stack-
  probe proven). Backlog-side already correct in v2 (lazy seam; frozen build's eager
  init is L1, fixed in v2). **Verdict: mechanism (b) — globalThis-backed singleton in
  sox-telemetry** (ADR-0006-aligned; peerDependency rejected by ADR-0006). LOW-MODERATE;
  implementation must pin the global-key contract with a regression test + optional ADR
  addendum. sox-ecosystem work, publish authorized.
- R2: BL-331 lock stores `{pid,startedAt,poolGroup?}` — no service identity. Fix: `service`
  label (+cmdline) threaded via env (mirror `SOX_FASTEMBED_POOL_GROUP`), printed in the
  warning. Durable option: machine-wide host broker (later). Live contention confirmed
  (memory-server + backlog serve).
- Filed: dual-package hazard → `2d5f40b5` (reopened HIGH + requirement verbatim);
  store-adapter variant `db88fb0d`; lock identity `8331b4d8` (DEBT HIGH); onnx stderr
  `065b672f` (enriched `a4304cc7`, LOW→MEDIUM); library-embedded startBacklogServer
  `ed06a22b`. Check-only: `cfa3c313`/`80455bf5` (near-dup merge candidates, OPEN).
- Next: sox implementation (singleton + lock identity) + publish → backlog re-install →
  verify all namespaces clean.

**Stream B (deployment separation):** unchanged — Phase 0.1–0.3 still await user
approval (machine-global). All pointer-map findings filed (9 items, prior turn).

**PR split (user question):** architect-decision APPROVE — **stacked pair** (apigen PR
first, backlog rebases), MODERATE risk. Verified NOT merged (origin/main `0d110a50`).
`origin/main..HEAD` apigen footprint: 6 clean commits (`ef790a65` S-18, `2209e2a7`
S-19+C-21, `08ac7aac` C-20, `5caf3791` S-20, `59bf05a9` java race, `d21f7a03` run.spec)
+ apigen content bundled inside the mixed mega-commit `2118d384` (union encoder + lazy
ts-morph — needs surgical extraction) + run.spec portion of `315f120f`. `f80bf841`
excluded (LOW, stays). **User chose FULL stacked split.** Execution dispatched:
`.worktrees/apigen-fixes` on `fix/apigen-audit-fixes` from origin/main. Enumeration
CLEAN (all backlog-subject apigen-path touches are comment/formatting/net-absent);
`2118d384` extraction applied + staged; the six cherry-picks verified parent-blob-clean.
**PAUSED at step 5 (gate):** `backlog:test` = 16 failures on the apigen worktree —
PROVEN identical test-for-test on a pristine origin/main baseline (environmental/
pre-existing, NOT extraction-induced). Signature: spawned children never create the
temp store / read-write the wrong store (`item_not_found` for in-process seeds,
`duplicate_candidate`, serve-singleton failures) — matches the A-era config-isolation
finding, plausibly amplified by the cutover repointing the GLOBAL
`~/.adhd/backlog/production/config.yaml` at the production v2 store. `debug` triage
dispatched (isolation-leak hypothesis + PRODUCTION-POLLUTION check + CI-vs-local
verdict). Staged extraction preserved in `.worktrees/apigen-fixes` for resumption.

**Update (2026-09-22 — live degradation confirmed; isolation leak; parallel queue):**

**Live deployment (user report: vector search unusable, citations broken):**
- Live triage dispatched (`debug`). Established candidate causes (prior evidence, to
  verify live): the LIVE frozen build predates the branch fixes — `e19bc9d0`/`d4a72009`
  (bounded `hasVectors` probe; frozen build still scans the whole vector table per bare
  `text:` query), the citation-sha fix `7875d848`, and the lazy semantic init (frozen
  `cli.ts:658` eager-loads embeddings every verb); BL-331 fastembed host contention
  (live serve + memory-server); `cb47fb79` embed-write degradation; and the production
  contamination (below). Deployment response (re-cutover to a fresh frozen build) queued
  behind the triage + user approval.
- **Production store CONTAMINATED (proven):** the origin/main config-isolation leak
  (the cutover wrote `db.path` into the global config; spawned test children now open
  the PRODUCTION store) wrote ~20+ rows/gate-run (`author:"cli.spec"` etc., some
  orphaned and invisible to `view:list`). Root-cause chain proven end-to-end
  (`config-resolver.ts:128,163-167` global layer unconditional → `cli.spec.ts:47-58`
  no HOME redirect → cutover `config.yaml` `db.path`). Fix = HOME-redirect in spawned-
  bin helpers ON MAIN (do NOT scope-gate the resolver — gx impact HIGH). CI green is
  NOT evidence (the affected set excluded backlog:test). Filing pass dispatched
  (7 findings).

**Parallel queue (background dispatches):**
- LIVE: cd34ba0d gate fix + F3 git-context (typescript, backlog worktree);
  live-degradation triage (debug); isolation-leak filing (general).
- NEW: sox singleton/lock RE-DISPATCH — the first sox executor returned an EMPTY
  report; state-side check shows `sox-telemetry/src/runtime.ts` modified (+210/−123)
  UNCOMMITTED, NO regression test, Change 2 (lock identity) absent → fresh session to
  review/complete Change 1 + the mandatory regression test + Change 2 + commit
  (no publish).
- NEW: origin/main HOME-redirect test-isolation fix (new worktree
  `.worktrees/test-isolation-fix`, test-only, local commit + gate; PUSH/PR held for
  user approval) — stops the contamination bleed and unblocks the apigen-split gate.

**Held for user approval:** Phase 0.1–0.3 (deployment separation, machine-global);
re-cutover/fresh frozen build; production contamination cleanup (destructive); push of
the test-isolation branch; apigen PR push (paused at step 5, staged extraction preserved
in `.worktrees/apigen-fixes`).

**Update (2026-09-22 — LIVE triage complete: measured breakage + deployment recipe):**
- **The live deployment is 31 commits behind and broken for consumers (measured):**
  (1) LATENCY — frozen `cli.ts:658` eager semantic init + `semantic-search.ts:605`
  `iter` first-row probe = full-corpus scan per store-open: **12.18/13.94/78.94s** per
  trivial query vs **0.99/1.16s** on the branch (frozen with embeddings off: 3.4–4.8s).
  (2) CITATIONS — frozen unconditional sha gate; **38/40 projects path-less**; sandbox
  repro: frozen fails / branch passes (`7875d848`). (3) BL-331 contention live
  (memory-server 54752 + backlog serve child 33774); **the lock is last-writer-wins —
  its pid cannot identify the partner** (new; strengthens the R2 requirement).
- **NEW live correctness findings:** (4) production v2 store `integrity.damaged` on
  `ix_edge_dst_live` (−2 rows) / `ix_node_kind_live` (−1) at 13:33:46, self-healed
  13:33:47 — rows invisible to index-routed queries; recurrence-prone (mixed
  better-sqlite3 + turso writers; WHO the b-sqlite3 writer is = open question).
  (5) WAL unlinked/replaced warnings — "graceful close in this state discards every
  write since the last checkpoint, silently". (6) 2849 `recursive_cte_probe_failed`/day
  (~2849 store-opens). (7) BUG-026 foreign `-shm` peer-hold reconnect refusals (live).
  (8) Contamination nuance: 23/40 projects are test-authored and DO surface in
  `view:projects`; cli.spec item rows are orphaned.
- **Deployment recipe (triage):** rebuild/re-cut from the branch (or cherry-pick
  `7875d848` + `d4a72009` + `a8906d3d`); MUST carry dep bumps (vector-store ^0.7.0,
  hybrid-search ^0.4.6, store-adapter ^0.9.2, graph-store ^0.10.1); repoint `.mcp.json`
  + symlink chain; restart serve; verify with a real semantic query + citation write.
  Vehicle choice → architect-decision dispatched. Findings → filing pass dispatched.
- **Correction:** `cb47fb79`'s embed-degradation hypothesis NOT confirmed live
  (`embedding_failed`=0; the 28 "connection not open" hits are `rollback_failed` debug
  events). Note: `e19bc9d0`/`cb47fb79` are backlog ITEM uids, not commits — the triage
  correctly identified the fix commits as `d4a72009`/`7875d848`.
- **Deployment verdict (architect-decision): (b) minimal cherry-pick** — branch off
  `ab262d8f` (cutover HEAD) + `a8906d3d`→`d4a72009`→`7875d848`, fast-track bounded review
  of exactly those three diffs, build via normal cache, verify the two consumer outcomes
  through the real CLI, then deploy (deploy step = user-gated). Restore prep + blind
  review dispatched. (The verdict's "separation spec missing" discrepancy is a
  wrong-checkout artifact — the spec is untracked in the backlog-v2 worktree.)
- **Isolation-leak filing COMPLETE:** 7 items filed — `82468ca7` (config-isolation leak,
  HIGH), `6d332464` (contamination, HIGH), `c85c820e` (orphaned-row gap), `d2f11ab6`
  (HOME opt-out), `06922862` (side-effectful opens), `81de39f7` (CI blind spot),
  `87ef8bf9` (scratch projects) — all cross-linked.
- **Semantic package swap (Wave 3a) NOT started:** upstream published (`sox-semantic`
  0.1.5→0.1.7 optional-loadability); residual `BUG-HYBRID-SEARCH-OPTIONAL-LOADABILITY-001`
  open; the adoption (thin DI adapter over `createSemanticBackend` replacing
  `deriveMembers`, optionalDependencies move, range alignment, drop `checkDim`/`errText`/
  `PermanentEmbeddingDimensionError` iff `SpaceInvariantError` covers dim mismatch) is
  queued behind the restore + the wave review (worktree occupied). Pull-forward only on
  user request.

**Remaining-work inventory (2026-09-22 — verbatim per user request):**

Here's the complete remaining-work inventory, straight from the persisted plan, by stream and priority:

## In flight (4 of my sessions still running; I'm holding all new launches per your instruction)
`cd34ba0d` gate fix + F3 git-context · sox telemetry singleton + lock identity (re-do) · origin/main HOME-redirect test-isolation fix · blind review of the 3 restore commits.

## A. Hygiene waves (the main program)
1. **Wave 0 close-out** — collect the F3 executor → **group review** (Seg F `111c19bd` + Seg G `315f120f`/`145fda7b` + citations `7875d848` + F3) → fix findings → **push** (all of these are local-only, unpushed).
2. **Wave 1** — S-02 (ad-hoc query filters silently dropping `assignee`/`claimedBy`/date fields — the real correctness bug) + C-01 (`buildDateRangeFilter` extraction) + the S-20 barrel coverage gap. Not started.
3. **Wave 2** — ~20 remaining C-fixes, the S-03/S-04/S-11/S-12/S-15/S-16/S-17/S-21a refactors, the S-08/S-09 config pass, **jscpd gate activation** (5% + allowlist, per your directive), `isSuperseded`/`countBy` adoptions, T-04/T-05. Not started.
4. **Wave 3** — **3a the semantic package swap** (not started; pull-forward on your word), 3b tx elimination (spec written, upstream G1 published), 3c ranked-path cleanup, 3d telemetry. Not started.
5. The **EISDIR gap** (`aede6810`) — citation of a directory path throws instead of degrading. Filed, unfixed.

## B. Live deployment (your production)
6. **Restore** — the minimal cherry-pick **failed its pre-flight**: `d4a72009` (bounded probe) depends on the hygiene wave, so the verdict's fallback is a **hand-port** of just the citation-gate fix + a bespoke bounded probe, build, verify, then **deploy** (repoint + restart — needs your approval). The durable fix is a full **re-cutover** from the reviewed branch tip.
7. **Contamination cleanup** — surgical removal of the test-authored rows (destructive; needs your approval).
8. **Index desync / WAL silent-write-loss / BUG-026** — all filed (HIGH), unfixed, likely needing sox upstream work (concurrent-engine writers on the production store).
9. **Phase 0.1–0.6** separation spec — 0.1–0.3 need your approval (machine-global).

## C. Apigen split
10. Test-isolation fix lands on main → resume the paused apigen split (extraction is staged, ready) → gate green → **push + PR** (needs your approval).

## D. Telemetry (your hard requirements)
11. sox singleton + lock-identity fixes → review → **publish** → backlog re-install → verify all namespaces emit no BL-404/BL-331 warnings.

**Needs you:** deploy/restart, contamination cleanup, Phase 0.1–0.3, the four pushes (backlog branch, test-isolation, apigen PR), PR #9 + `@adhd/backlog` publish.

**Open bugs/deferrals:** live latency `46d04e3f` · citation gate `4290b63a` · lock identity `348cc700` · index desync `b200542b` · WAL silent-loss `d4b2cc68` · CTE probes `1c9e40d5` · BUG-026 `bfe3f770` · contamination `53eb67a7`/`e679f8f0`/`e9a094be` · staleness `42fc1822` · isolation leak `82468ca7`/`6d332464`/`c85c820e`/`d2f11ab6`/`06922862`/`81de39f7`/`87ef8bf9` · EISDIR `aede6810` · `f80bf841` · hybrid-search residual (BUG-HYBRID-SEARCH-OPTIONAL-LOADABILITY-001) · `2b607b26` resolved · `cd34ba0d` in flight.

**Update (2026-09-22 — restore-commit review returned; review-fix batch queued):**
- Blind review of `7875d848` + `d4a72009` + `a8906d3d` COMPLETE: **sound; 0 critical /
  0 high**; 1 medium (design), 5 low, 3 info. Teeth verified independently (reviewer
  reverted the `iter`-probe → both new bootstrap tests went RED; restored, file clean).
  - MEDIUM: `citationRequiresSha:true` is now a silent no-op for path-less projects
    (`create-issue.ts:641` / `transition.ts:356`) — documented (SPEC.md:134) and
    consistent with the architect-decision verdict (A); the fix is OBSERVABILITY
    (a warning/debug log — not an audit node; option (a) "keep flag authoritative" is
    ruled out by the standing verdict). Fix batch item.
  - LOW: predicate duplicated 3× (`catalog.ts:613`, `create-issue.ts:316`,
    `transition.ts:229`) — unify via `projectHasKnownPath`; test title "nothing is
    written" unasserted (`create-issue.spec.ts:256`); `projectHasKnownPath` untested
    directly; `CONTRACT.md` line-reference table stale (up to +75 drift); the
    align-commit left `sox-embedding-provider` at `^0.4.1` vs the graph's `^0.5.0`
    → TWO copies installed (latent dual-package/ONNX-singleton hazard — same class as
    the telemetry singleton).
  - INFO: `isVectorSpacePopulated` capability-miss silent (optional log);
    `a8906d3d`'s 17,966-line lockfile diff verified content-equivalent (format
    normalization only; 4 entries removed / 3 added, hashes preserved).
- **Review-fix batch queued** (typescript): all findings above. **Held under the
  resource-serialization rule** — 2 heavy sessions currently active (sox redo +
  test-isolation); nothing new heavy launches until they drain + user all-clear.
- Review findings → light filing pass dispatched (3 substantive + 1 combined-low).
- F3 open questions dispositioned: update-parity (`IUpdateIssueInput.gitContext`) —
  keep create/transition only (the verdict's scope); markdown head format accepted as
  shipped (`Citations: [<gitContext>]`); gitnexus partial-impact noted (index stale).

**Update (2026-09-22 — HOLD directive; 3 sessions in flight; review returned):**
- **USER DIRECTIVE: do not run more agents** — no new dispatches (heavy or light) until
  further notice. The one-heavy-session-at-a-time serialization rule stands.
- **Running (3):** (1) sox telemetry singleton + fastembed lock identity re-do
  (sox-ecosystem; vitest live); (2) origin/main HOME-redirect test-isolation fix
  (`.worktrees/test-isolation-fix`; `nx affected -t test lint build` live); (3)
  review-findings filing pass (light, graph writes only).
- **Since the last inventory:** `cd34ba0d` + F3 DONE — commits `4bf902fc` (gate comment
  fix; gates CLEAN) + `05ebbd6f` (F3 item-level `gitContext`, +10 tests, negative
  control proven; 611 tests / 608 passed + 3 load-flakes verified isolated). Wave 0
  close-out is now: group review of Seg F+G+citations+F3 → fix review findings → push.
  Blind review of the 3 restore commits DONE: **0 critical / 0 high**; 1 medium
  (`citationRequiresSha` silent no-op for path-less projects → verdict (A) stands,
  add observability via log — not an audit node), 5 low (predicate 3× duplication;
  unasserted "nothing is written" title; `projectHasKnownPath` untested; `CONTRACT.md`
  line drift up to +75; `sox-embedding-provider` `^0.4.1` vs `^0.5.0` skew = two copies
  installed, dual-package hazard), 3 info. **Review-fix batch queued, NOT dispatched.**
  Restore pre-flight result: the minimal cherry-pick is NOT constructible (`d4a72009`
  depends on hygiene-wave `4d54a54f`/`d7343221`; `a8906d3d` conflicts with the cutover's
  own `^0.4.5` bump; `7875d848` applies clean) → fallback = hand-port citation fix +
  bespoke bounded probe. **Queued, NOT dispatched.** Deployment step remains user-gated.

**Update (2026-09-22 — sox redo COMPLETE (all green); 2 sessions left):**
- **Sox telemetry singleton + fastembed lock identity DONE** — commits `d4160578`
  (BL-404 duplicate-module regression test via `vi.resetModules()` + fresh dynamic
  import, negative control proven red→green; ADR-0018 authored) + `668ded42` (BL-331
  lock service identity: `FastembedLockInfo.service`, `SOX_FASTEMBED_SERVICE` env,
  warning names the service, same-service suppression, `competing_service`/
  `competing_host_service` telemetry fields; 5 tests red→green). The inherited
  `runtime.ts` migration was already committed (`a1b50621`) and sound — all mutable
  runtime state + the `_warnedUnlabeled` latch live in
  `globalThis[Symbol.for('@adhd/sox-telemetry.runtime.v1')]`; no module-level `let`/`var`
  remains. Suites: telemetry 42, embedding-provider 112, store-adapter 639,
  mcp-runtime 32, graph-store 223, memory-core 752 (+8 skipped) — all green (two
  first-run failures were load-induced at LA 149; green re-run alone).
- **Versions to bump (NOT bumped/published — held):** `sox-telemetry` 0.3.1,
  `sox-embedding-provider` 0.5.1.
- **New disclosures (filing held):** (1) `trace.ts` duplicate-module hazard —
  module-level `AsyncLocalStorage`/`ulid` consts; trace propagation breaks across
  duplicate copies; ADR-0018 records it as not-covered; fix = same globalThis slot.
  (2) graph-store BL-504 spec load-fragile (`timeout: 200000` hard-coded at
  `graph-store.spec.ts:761`). (3) memory-core debug spec writes to a hard-coded
  foreign scratchpad path (`debug-heal-churn-perpass-vs-cumulative.spec.ts`). (4) The
  installed `backlog` bin exposes the uid surface (not the skill's six-verb v2) and
  rejects `--sandbox` — matches the already-filed skill-drift; executor correctly did
  NOT probe production. (5) memory MCP `E_FOREIGN_SQLITE_SIDECAR` on 2/3 recalls.
  (6) `registry/index.json` modified by a concurrent agent — left untouched.
- **Running (2):** test-isolation fix; review-findings filing pass. All new dispatches
  remain held per the user directive.

**Update (2026-09-22 — filing complete; 1 session left):**
- **Review-findings filing COMPLETE (5 items):** `8a09824c` (provider skew `^0.4.1`
  vs `^0.5.0`, two copies), `1e12507f` (CONTRACT.md line-reference drift),
  `a934e089` (citation `citationRequiresSha` observability), `2b1d8a22` (combined
  fix-batch lows), + **new discovery `e68be52c`** — one-shot CLI create loses the
  fire-and-forget embed AND its `embedding_failed` audit row (`TypeError: The database
  connection is not open`; reproduced 3/3 visible creates on the frozen bin). **Dedupe
  check vs `cb47fb79` pending** (same defect family — merge if confirmed; `cb47fb79`
  was filed for the same symptom class). Filing corrected the review's stale line
  numbers (actual gate sites: `create-issue.ts:664-668` / `transition.ts:363-367`;
  inline predicates `create-issue.ts:333` / `transition.ts:240` — the worktree had
  advanced past the review's read).
- **Running (1):** test-isolation fix (`.worktrees/test-isolation-fix`). Everything
  else held per the user directive — no new agents.

**Update (2026-09-22 — ALL AGENTS DRAINED; test-isolation COMPLETE; bleed stopped):**
- **Test-isolation fix DONE — commit `59b08868`** (branch `fix/backlog-test-isolation`,
  NOT pushed — human-gated): HOME redirects added to every spawned-bin helper across
  10 spec files (+74/−28, test-only; `install.e2e.spec.ts`'s explicit real-HOME pass
  fixed). RED→GREEN probe transcript captured (real HOME → production dbPath; temp HOME
  → temp path). Targeted 10 specs: 88 tests green. Full gate `nx affected -t test lint
  build --base=origin/main`: **GREEN** (64 files, 701 passed, 3 skipped; lint + build
  clean). **PRODUCTION BLEED STOPPED — proven: live-item count 1683 before the gate →
  1683 after (zero rows added; an earlier +6 was other agents' legitimate filings,
  inspected by title).**
- Filed `40d9da12` (cli-envelope.spec.ts `afterEach` no-op → tmpRoot leak, DEBT);
  dedupe respected for `c68ce863` (IR-cache cold-under-temp-HOME latency, latency-only)
  and `44f7535a` (load flakiness). The filer's own create hit `e68be52c`
  (double-create on retry — its duplicate deleted, `2ba9a2a8`).
- **RUNNING: 0.** All dispatched work has returned; everything queued is held per the
  user directive. Next steps are user-gated: push `fix/backlog-test-isolation` → PR →
  merge to main → resume the apigen split; push the backlog branch; deploy/cleanup;
  Phase 0.1–0.3; sox publish (0.3.1/0.5.1); etc.

**Open threads:** `cd34ba0d` (gate break — one-line fix); review of the Seg F+G+citations
group (directive 5) → push; F3 implementation; sox singleton + lock identity; Wave 1/2/3.

**Update (2026-09-22 — review-fix batch COMPLETE: all four items closed; gate red only on load-flakes):**

Blind-review fix batch executed in `.worktrees/backlog-v2` (branch
`feat/backlog-hard-replacement`). All four queued items closed:

- **`a934e089` (MEDIUM) — citation `citationRequiresSha` waiver observability** —
  commit `1704fb77` (code) + `acb2acc1` (tests). Both gate sites now emit an
  operator-visible `console.error` on the path-less waiver branch (`createIssue` +
  `transition`), naming the project uid and the cited file. Permissive behaviour is
  unchanged and NO audit node is added (SPEC §4a one-audit-node-per-state-change
  stands). Teeth: two tests per verb — positive (warning fires, names project+file)
  and negative (a path-PRESENT hard-fail emits NO waiver warning); negative control
  (log removed) proven RED.
- **`2b1d8a22` (LOW) — combined lows** — commits `1704fb77` + `acb2acc1`:
  (a) the 3× inline path-known predicate is gone — `projectHasKnownPath` is now the
  single shared helper, upgraded to a TYPE PREDICATE so both `computeCitationSha`
  call sites narrow `metadata.path` to `string` with no assertion;
  (b) the "nothing is written" test now asserts live node/edge counts unchanged +
  zero issues reachable through the project filter (it had no write-absence
  assertion) — negative control (injected pre-throw write) proven RED on the count
  while `rejects.toThrow` stayed green;
  (c) new `catalog.spec.ts` boundary tests (undefined / no-key / empty / non-string /
  valid / whitespace + the narrowing contract);
  (d) `isVectorSpacePopulated`'s capability-miss now warns ONCE per process (per-query
  spam avoided) — the `false` return is unchanged.
- **`8a09824c` (MEDIUM) — `sox-embedding-provider` range skew** — commit `ff599403`.
  `package.json` `^0.4.1` → `^0.5.0`; `pnpm-lock.yaml` regenerated with pnpm 8.15.9
  (the lockfile's own version — no manager switch). The nested 0.4.1 entry and its
  `sox-telemetry@0.2.1` are removed; ONE 0.5.0 entry remains. One-copy proof: all five
  consumer anchors (backlog/src, backlog/pkg, sox-hybrid-search, sox-semantic, root)
  resolve the SAME realpath → 1 distinct module file.
- **`1e12507f` (LOW) — CONTRACT.md line-reference drift** — commit `cb1fbbff`.
  Re-anchored ALL anchors, not just the six errors.ts ones: the drift was systematic
  across tx.ts (+280), catalog.ts (up to +148), errors.ts (up to +75), audit.ts (up to
  +8). New `contract-anchors.spec.ts` guards it (parses every heading anchor, asserts
  the cited line opens the named declaration, and that the parser saw every reference);
  negative control (revert one anchor) proven RED.

**Incident (self-inflicted, contained):** the first `adhd-backlog update` call passed
the JSON through an UNQUOTED shell arg, so the body's backticks were command-
substituted — an `npm pack` ran (stray `adhd-backlog-1.0.0.tgz`, deleted) and the
update superseded `68aeea15` → `3baf3c31` with a backtick-stripped body. Repaired by
re-updating through a non-shell `spawnSync` argv array; the live item is now
`d98e4d49` with the correct body + new evidence. **Lesson: never pass `--input` JSON
through a shell — use an argv array or a file.**

**Discovery (enriched an existing item, no duplicate):** the published
`@adhd/sox-embedding-provider@0.5.0` tarball ships a STALE `dist/package.json`
declaring `version: "0.4.1"` (verified via `npm pack` + `tar -O`). Enriched the open
`68aeea15` (same class as `2654570b`) rather than filing a duplicate.

**Gate — `nx affected -t test lint build --uncommitted`:** red, but ONLY on
environmental load-flakes; the machine ran at load-avg 60→155 with 45 users
(concurrent agents). Evidence, per run:
- Run 1 (15:23): lint 4 ERRORS (my empty-arrow console spies → fixed to the repo's
  `mockImplementation(() => undefined)` convention, lint then 0 errors); test 622
  passed / 2 failed — `cli.spec.ts` sandbox timing (2028ms vs <1000ms) and
  `server.published-layout.spec.ts` (`spawnSync … ETIMEDOUT`). BOTH re-run isolated
  and GREEN (load 60).
- Run 2 (15:47): failed on `meta-wire.spec.ts` (`spawnSync … ETIMEDOUT`; the built
  bin's cold start measured 33.67s at load 143 — its spawn bound is 60s).
- Run 3 (16:37, `--maxWorkers=2`): failed on `server.spec.ts` (`fetch failed`),
  `serve.spec.ts` (30000ms timeout) and `search-shortcut-wire.spec.ts` (error arm) at
  load 155 — all spawned-server/wire specs, and a DIFFERENT set than run 2, i.e.
  non-deterministic saturation, not a fixed defect.
- The touched specs are all green: `catalog.spec` 7, `contract-anchors.spec` 2,
  `create-issue.spec` 9, `transition.spec` 27, `bootstrap.spec` 3 = 48 passed.
- Verdict: the gate is blocked by machine saturation, not by this batch; the
  spawn/wire tests have hardcoded 30–60s bounds that load-avg >100 cannot meet.
  Re-run when the box is quiet.

**Residuals:** none for the four items. The underlying published `dist/package.json`
staleness is upstream (sox-ecosystem, `68aeea15`/`d98e4d49`).


