# agent-registry-release — binding closeout decisions `[def:release-strategy]`

> Authored by the planner; the `closeout-design` state confirms and pins the live
> values (the baseline ref SHA, the final version bumps). Markers are grepped by
> `audit_release.py --phase design`.

## R1. Merge strategy

**Decision: merge `agent-registry-execution` → `main` with `--no-ff`** (a single
merge commit preserving the initiative's history), AFTER Plans 6, 7, 8 are `done`
and the `agent-mcp-backout-gate` is green. Rationale: the work is a coherent
initiative (12 packages/plans); a `--no-ff` merge keeps it revertible as one unit,
which reinforces the back-out guarantee (reverting the merge commit restores
`main` including agent-mcp). The alternative (rebase-and-squash) would lose the
per-plan state-transition history the audits depend on.

> If the owner prefers NOT to merge yet (keep shipping from the worktree), this
> state records that explicit no-merge decision and `merge-to-main` becomes a
> documentation-only state — the gate (`agent-mcp-backout-gate`) and publish still
> run from the worktree. The decision is the owner's; the plan supports either.

## R2. agent-mcp pre-initiative baseline `agent-mcp-baseline-ref:`

```text
agent-mcp-baseline-ref: <FILLED AT EXECUTION: the git rev of packages/ai/agent-mcp
                         {,-types} state at the point main was branched into the
                         agent-registry-execution worktree — i.e. the merge-base of
                         main and agent-registry-execution. Record the actual SHA.>
```

This is the byte-identical reference the back-out gate compares against. If Plan 8
ran, changes are reconciled against Plan 8's modification manifest; if not, the
trees must equal this ref exactly.

## R3. Publish order + versions

Publish via `nx release publish` (clean cached build+test — never
`--skip-nx-cache`) in dependency order so a consumer resolving a freshly-published
package never hits an unpublished dependency:

```text
1. @adhd/agent-mcp-types      (if bumped — types other packages depend on)
2. @adhd/agent-registry
3. @adhd/agent-tool-registry
4. @adhd/agent-provider
5. @adhd/agent-policy
6. @adhd/agent-compiler       (depends on 2–5)
7. @adhd/agent-mcp@2.0.0      (depends on types; consumes registry+compiler post-Plan-6)
```

Version bumps are pinned in `closeout-design` from each package's actual delta;
`agent-mcp` is `2.0.0` (SPEC §11 — breaking required→optional `systemPrompt`).

## R4. Artifact disposition policy

Every untracked file under `docs/plan/agent-registry/` is dispositioned in
`CLOSEOUT.md`'s table as one of: **commit** (design docs of lasting value — SPEC,
GOAL, DEMO, COVERAGE, DATA_MODEL, USAGE, SCOPE, REFERENCES, RUNTIME_GAPS,
SEED_DATA, the achieves/defers map); **relocate** (the maintained demo →
`compose-via-mcp.mjs` integration test belongs with Plan 8's e2e artifacts);
**remove** (throwaway `demo/tmp/`, `diff.txt`, scratch `.mjs` scripts superseded by
the maintained test). `.claude/` stays gitignored (project memory: never commit it).
Default is **commit** — these are the initiative's design record; nothing is
deleted that wasn't demonstrably scratch.

## R5. Initiative plan set for the agent-mcp back-out union `[def:initiative-plans]`

The back-out gate (`check_agent_mcp_baseline.py`, dod.2) proves every change to
`packages/ai/agent-mcp{,-types}/src` between the pinned baseline and `HEAD` was
made by a **sanctioned registry-initiative plan**. The sanctioned set is the
**UNION** of the guarded `…/src` paths each initiative plan declares in its
`plan-index.json` `mutate_set` — derived per-plan, so it stays correct without
hand-transcription (F-P6-6). The initiative plans (CLOSEOUT.md §3) are:

```text
agent-registry-schema
agent-tool-registry
agent-provider
agent-policy
agent-compiler
agent-mcp-refactor
agent-registry-migration
agent-mcp-authoring
agent-registry-release
```

Notes that make this fail-closed-correct:

- **Plan 6 (`agent-mcp-refactor`) does NOT touch `agent-mcp-types/src`.** The only
  initiative source of `agent-mcp-types/src` drift is **`agent-provider`**
  (`domain.ts` + `index.ts`). A literal "Plans 6+8" union would FALSE-FAIL on those
  two files — hence the union spans *every* initiative plan, not a hardcoded pair.
- **Plan 8 keeps its finer "only these" guarantee.** `agent-mcp-authoring`'s
  `decisions.md` modification manifest (`def:agent-mcp-modification-manifest`) is
  still enforced by Plan 8's own `check_manifest.py` (dod.8) and is also folded into
  this gate's allowed union — so Plan 8's surface is bounded twice.
- **The pre-registry agent-mcp roadmap is BELOW baseline and deliberately EXCLUDED.**
  `0.0.6`, `usage-tracking`, `task-schema-foundation`, `task-dependency-dag`,
  `task-streaming-sse`, `hitl-interrupts`, `parallel-tool-execution` shipped to
  `main` as `@adhd/agent-mcp@1.0.1` (back-out tag `agent-mcp-baseline-pre-registry`)
  BEFORE this branch. They are not initiative plans and their `mutate_set`s are NOT
  in the allowed union. If the pinned baseline = `merge-base(main,
  agent-registry-execution)` ever reveals one of them (or anything else) ABOVE the
  merge-base that is NOT covered by an initiative plan's `mutate_set`, the gate
  **fails closed and surfaces it** — correct behavior, never softened.

## R6. agent-mcp@2.0.0 runtime dependency version pinning `[def:runtime-dep-versions]`

`@adhd/agent-mcp@2.0.0`'s built `dist` imports `@adhd/agent-compiler`,
`@adhd/agent-policy`, and `@adhd/agent-mcp-types` (which transitively pull
`@adhd/agent-registry`, `@adhd/agent-tool-registry`, `@adhd/agent-provider`, and
`@adhd/agent-mcp-budget`). Today those `@adhd/*` deps are declared **`"*"`** in
`packages/ai/agent-mcp/package.json` and left external by the build — so a consumer
who installs the *published* `agent-mcp` cannot resolve them (F-P6-13).

**Decision:** publish is gated on resolving this two ways:

1. **No `"*"` workspace dep ships.** Before publish, every `@adhd/*` dependency
   declared `"*"` in a to-be-published `package.json` (agent-mcp + the registry
   packages) is replaced with the **real published version** (`nx release` writes
   these from the version plan; the runbook asserts none remain `"*"`). Publish in
   the R3 dependency order so no consumer hits an unpublished dep.
2. **Runtime resolution comes from the PUBLISHED package graph, not workspace
   symlinks.** The post-publish smoke installs `@adhd/agent-mcp` into a throwaway
   project OUTSIDE the workspace (no local `node_modules` symlinks reachable) and
   `require()`s it plus its transitive `@adhd/*` deps — proving npm resolution
   alone satisfies the graph. A green smoke is the consumer-outcome proof; the
   runbook's no-`"*"` assertion is the pre-publish guard.
