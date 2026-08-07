# USE_CASES — dispatch-completion

Concrete, observable scenarios derived from `SCOPE.md`. Each has real inputs and an observable outcome. These are the green examples that make `demo/DEMO.md` evaluable. Grouped by phase; happy / edge / recovery paths marked `[H]`/`[E]`/`[R]`.

## Reconciliation & triage

1. **[H]** A maintainer runs the triage state; it emits a table where DEBT-DISPATCH-009, -010, -021 are marked `ALREADY-FIXED` with the live `types.ts:85`/`:579` and `package.json:7` evidence, and they are struck from the work list. Observable: the outstanding list has ≤17 items, not 20.
2. **[E]** DEBT-DISPATCH-011's orphan dirs are checked; `optimize/` and `snapshot/` contain only `index.ts` and `compiler.ts` is absent → item closed as CONFIRMED-FIXED in BACKLOG.md with a dated verdict. Observable: no code change, one BACKLOG edit.
3. **[E]** The triage finds `dispatch-base-types` exports only the Nx placeholder stub with 1 generated test → flagged for deletion with a dependency check (grep shows zero `@adhd/dispatch-base-types` importers). Observable: a delete-decision row with evidence.

## Spec foundations (dispatch-base-spec)

4. **[H]** `ExecutionMode = 'generative' | 'tool-call' | 'guard-only'` is exported; a milestone with zero ops compiles to a `DispatchUnit` with `execution_mode:'guard-only'`. Observable: `import { ExecutionMode } from '@adhd/dispatch-spec'` resolves; unit test asserts the three derivations.
5. **[H]** A complete milestone (all ops done in `dispatch_log`) reports `snapshot.milestones[x].eligible === false`. Observable: a spec test that was impossible before (eligible never flipped) now passes; reverting the definition turns it red.
6. **[E]** `snapshot()` called with `IOptimizerDeps` missing the `weak` tier throws a validation error at entry (or clamps to a finite sentinel) instead of silently emitting `context_window_per_tier: null` after JSON round-trip. Observable: round-trip test asserts the field stays a finite number.
7. **[H]** `DispatchLogEntry.provider` accepts `'claudecli'` and `'teammate'`; `validateDagJson` on the live `dispatch-production` dag (which contains `'teammate'`) still passes, and a garbage provider value now fails validation. Observable: two validation tests, one positive one negative.
8. **[H]** `ICalibrationStore` is exported from dispatch-spec with `get/put` per-tier B semantics; `dispatch-orchestrator`'s `ICalibrationPlaceholder` is replaced by it with no behavioral change to cold-start defaults. Observable: `ICalibrationPlaceholder` removed, `ICalibrationStore` imported.
9. **[E]** `compilePrompt()` on an op whose `type_spec` references a nested interface inlines the sub-shape fields into the prompt (BL-104), not just the top-level name. Observable: a golden prompt fixture contains the nested field list.

## Optimizer + client propagation

10. **[H]** `optimize()` sets `execution_mode` on every emitted `DispatchUnit`: a batch containing one generative op → `'generative'`; an all-tool-call batch → `'tool-call'`. Observable: optimizer test asserts per-unit mode.
11. **[H]** `snapshot()` accepts `{previousSnapshotVersion}` and increments; two successive snapshots of the same dag report versions N and N+1. Observable: monotonic version test.
12. **[E]** A `DispatchUnit` compiled for a claudecli agent carries `mcp_servers` from a real catalog lookup (BL-105) rather than `null`, and the orchestrator creates the agent definition without the `{}` bypass. Observable: unit `mcp_servers` is a populated object for a catalog-known server.
13. **[H]** The systemPrompt/prompt split (DEBT-012): a compiled unit exposes a stable `systemPrompt` preamble and a per-fire `prompt` body; `AgentMcpRunner.ensureAgent` bakes only the preamble, `fire()` sends only the body. Observable: a test asserts the agent's static systemPrompt ≠ the per-task prompt (no full-text duplication).

## Orchestrator hardening

14. **[R]** A runner whose `fire()` rejects mid-cycle produces a `dispatch_log` entry with `status:'failed'` + an error note, `orchestrateCycle` returns normally, and prior units in the cycle remain persisted. Observable: no uncaught rejection; one `failed` entry.
15. **[E]** An op with `type:'automated', action:'guard'` and NO milestone-level duplicate guard actually runs its verification command through the guard seam (DEBT-016), instead of being silently marked `skipped`. Observable: the guard command executes; a test with a non-duplicated op-guard sees a real guard result.
16. **[E]** `capOutput` truncating an 8KB guard output that ends mid-multi-byte-char cuts on a character boundary — no replacement glyph. Observable: truncated output is valid UTF-8.
17. **[R]** After a guard failure injects a correction milestone that completes, downstream milestones depending on the failed slug rewire onto the correction and a resume cycle reaches terminal instead of `'no-eligible-work'` (DEBT-020). Observable: resume cycle terminates cleanly; downstream `depends_on` points at the correction.

## Enrichment plugins

18. **[H]** `@adhd/dispatch-plugin-io` provides `fileSizes(paths)` + `readFiles(paths)`; injected into the optimizer, a snapshot's `pairwise_overlap` reflects real shared source bytes rather than zeros. Observable: overlap matrix non-zero for milestones sharing a file.
19. **[H]** `@adhd/dispatch-plugin-gitnexus` runs a blast-radius enrichment pass between `snapshot()` and `optimize()`, populating `blast_radius` on ops. Observable: an op targeting a high-fan-in symbol carries a non-null blast radius.
20. **[E]** Both plugins degrade gracefully: with the plugin absent/injection null, `optimize()` still produces valid `DispatchUnit[]` (P3 purity). Observable: optimizer test with null deps stays green.

## Storage adapter + calibration + validation

21. **[H]** `@adhd/dispatch-serializer-sqlite` writes then reloads a dag; the reloaded object equals the JSON serializer's reload of the same dag (adapter parity, P1). Observable: cross-serializer equality test.
22. **[H]** `validateDagJson` rejects a `dispatch_log[].provider` outside the extended enum, and accepts the real `claudecli` and `teammate` values (DEBT-019). Observable: one positive + one negative validation test.
23. **[H]** `ICalibrationStore` is formalized in dispatch-spec and replaces the orchestrator's `ICalibrationPlaceholder`; cold-start B (`DEFAULT_B_PER_TIER`, BL-106) seeds the optimizer with no behavioral change. Observable: `ICalibrationPlaceholder` removed, `ICalibrationStore` imported.
24. **[E]** BL-107 back-compat: a legacy object-keyed dag loads through `normalizeDag` in the serializer (not `run.ts`) and validates. Observable: legacy-shape dag loads + validates green.

## Preconditions (fixed directly — NOT this plan; listed for context only)

- **BUG-DISPATCH-EXEC-001** (tool-call execution wired; `@adhd/dispatch-tools` primitives) and **BUG-DISPATCH-PUBLISH-001** (import↔name conformance to the repo standard) land as preconditions. Phase 0 triage confirms them; this plan builds on them and adds no use cases for them.

## Cleanup + MCP authoring tools

H3. **[H]** `@adhd/dispatch-base-types` (0 consumers) is deleted (if PUBLISH-001 didn't); `nx run-many` still green afterward. Observable: package dir gone, build unaffected.
25. **[H]** `@adhd/dispatch-tools` `dag.milestone_add` + `dag.pending_clear` author a 3-milestone dag through `DagClient`; the resulting file passes `validateDagJson` and has no orphans/cycles. Observable: authored-via-tools dag validates. *(If EXEC-001 already shipped the full dispatch-tools surface, Phase 0 drops this.)*
26. **[E]** A `dag.milestone_add` that would create a dependency cycle is rejected by the tool (referential-integrity guard, P2) with a structured error. Observable: cycle rejected, dag unchanged.

## CLI completion

27. **[H]** After adding the `bin` field + `build-bin` esbuild target, `npx @adhd/dispatch-cli status docs/plan/dispatch-completion` runs from a fresh install and prints the milestone status table. Observable: bin resolves, exit 0.
28. **[E]** `dispatch snapshot`, `dispatch status`, `dispatch run` on a nonexistent dag path all return the same shaped error including the offending path (DEBT-025), matching `validate`'s existing graceful case. Observable: consistent error shape across the four commands.
29. **[E]** `dispatch calibrate` with an invalid model tier rejects **before** constructing the AgentMcpRunner (DEBT-024 lazy factory). Observable: no runner construction on the bad-tier path (spy asserts factory not called).

## Optimizer algorithms (data-gated) + tests

30. **[E/R]** With <3 recorded cycles or <15% greedy shortfall, the algorithm phase records a `HELD` marker citing the measured baseline and the plan still reaches terminal. Observable: a held-state note, no algorithm code shipped.
31. **[H]** When the gate fires, the cascade `optimize()` beats greedy on ≥1 golden fixture (strictly fewer total tokens) and matches on the rest. Observable: algorithm suite comparison test.
32. **[H]** The `stepwise-dispatch` A/B experiment runs packed-vs-stepwise on one sandbox work order and records per-turn tokens + an artifact-equivalence assertion; a negative result is persisted as a packing input, not a default. Observable: A/B result file with both arms measured.
33. **[H]** `nx run-many -t test,build` across all 10 dispatch projects exits 0; running it twice shows an nx cache hit on the second run (no `--skip-nx-cache`). Observable: green build + proven cache hit.
