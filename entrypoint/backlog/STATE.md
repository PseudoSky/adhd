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

- [ ] D1. Commit everything from A/B/C.
- [ ] D2. Push to PR #9 ("feat(backlog): 1.0.0 — one surface, one identity,
      no predecessor left behind").
- [ ] D3. Get the PR reviewed and merged.
- [ ] D4. Publish to npm (currently blocked from earlier in the session —
      cause not yet diagnosed; revisit before this step).

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
