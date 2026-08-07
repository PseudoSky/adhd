---
name: backlog-remediation
description: "Use when the user wants to work down a large backlog / issue list with many agents at once — triaging, confirming, and fixing a whole corpus of open items rather than one ticket. Examples: \"Clear the backlog\", \"Work through all the open DEBT items\", \"Triage and fix everything in BACKLOG.md\", \"Multi-agent remediation run\", \"How many of these open items are actually still real?\""
---

# Multi-Agent Backlog Remediation

A run methodology for taking a **whole backlog** (tens to hundreds of open items)
from "nobody knows what's still true" to "merged, verified, documented" using many
agents in parallel — without closing real bugs by accident and without agents
colliding in the working tree.

Derived from a run against 99 open items in this repo (2026-08-05/06). Every rule
below exists because that run either needed it or got burned by not having it.
Artifacts: `tmp/backlog-run/` (`EXECUTION-STRATEGY.md`, `phase2.js`, `wave0.js`,
`wave1.js`, `wave1-resume.js`, `docs-pass.js`, `triage.json`, `phase2.json`).

**This file is the procedure. It is not the operator.** How the orchestrator *behaves*
while running these stages — context-preservation discipline (never read bulk output,
generate wave scripts programmatically, disk as the medium between stages), the router
discipline, question routing, the five-class escalation policy, and the failure-mode
catalog — lives in **`.claude/agents/backlog-remediation-orchestrator.md`**. Read that
too if you are driving a run; do not restate it here.

## When to Use

- ≥ ~20 open backlog items, of unknown current validity
- A backlog suspected of having drifted from the code (the run found **53 of 99
  already fixed**)
- Work that is naturally decomposable into independent packages of files
- You have a real verification gate (lint/build/test/artifact-load) to key on

## When NOT to Use

- **< ~10 items.** The staging overhead dominates. Just fix them.
- **One deep, coupled change.** This methodology parallelizes across independent
  units; a single refactor that touches everything has no units.
- **No mechanical verification gate.** If nothing can be proven by exit code, the
  review stages have nothing to stand on and degrade into opinion.
- **Exploratory/product work.** Every stage here assumes a stated defect and a
  provable fixed state.

---

## Stage sequence

Run in order. **After every stage, reconcile item counts** (see Guardrail G1).

### Stage artifact contracts — every stage writes a named file

Six stages are **deliberately not scripted** (S0–S5, S11 — see the script header for
why). *Not scripted is not not-specified.* The whole context-preservation property
depends on each stage writing a named artifact to the run directory that the next
stage **reads from disk**, instead of a corpus travelling through the orchestrator's
context. A stage that returns prose instead of writing its file has broken the run.

Default run directory: `tmp/backlog-run/`.

| Stage | Artifact | Shape |
|---|---|---|
| S0 cluster + coverage | `clusters.json` | `{"<cluster>": ["<humanId>", …]}` — plus the recorded result of the set-equality assertion (flattened id set == pulled id set, zero duplicates). Do not proceed on a mismatch. |
| S1 triage | `triage.json` | `{clusters:[{cluster, items:[{humanId, cluster, title, verdict, evidence, severity, effort, discipline, notes, duplicateOf?, blockedBy?, citations?}]}]}` |
| S2 refutation | `phase2.json` | `{verdicts:[{humanId, refuted, evidence, recommendedStatus?, closingNote?, residualWork?}]}` |
| S3 architect | `packages.json` | `{packages:[…], deferred:[{humanId, reason}]}` — each element per the **package schema** in S3 below. This is the array fed straight to `remediation-pipeline.js` as `args.packages`. |
| S5 wave planning | `wave<N>-pkgs.json` | The subset of `packages[]` admitted to wave N (same element schema), plus the wave's explicit serialization rules. One file per wave; feed the pipeline one wave at a time. |
| S10 docs targeting | `doc-dispatch.json` | `{"<project>": {files:[…], commits:[…], branches:[…], worktree?, new?: bool, dir?: string}}` — the object passed as `args.docs`. See S10 for field semantics. |

Everything is keyed by global id and lives on disk (guardrail G10) — that is what makes
a mid-run resume possible at all.

### S0 — Inventory + cluster

Pull *all* open items. Cluster **mechanically by id family** (`DEBT-DISPATCH-*`,
`ENV-PLAN-*`, …) — not by semantic judgment, which is unreproducible and drops
items silently.

Gate before any other stage: **100% coverage, zero duplicates.**
`sum(len(cluster) for cluster in clusters) == len(all_open_items)` and the flattened
id set equals the pulled id set. Write `clusters.json`; do not proceed on a mismatch.

### S1 — Triage for confirmation

One agent per cluster. It re-verifies each item **against current HEAD**.

Verdicts:

| Verdict | Meaning |
|---|---|
| `CONFIRMED` | still live; proceed to implementation |
| `ALREADY_FIXED` | landed since filing |
| `INVALID` | never was true / premise wrong |
| `DUPLICATE` | set `duplicateOf` |
| `SUPERSEDED` | covered by a later item/design; name it |
| `NEEDS_HUMAN` | product call, credential, external decision |

Every verdict carries `evidence` that is **real command output or a `file:line`
actually opened**. A grep hit is not reading. Also assign `severity`, `effort`,
`discipline`, and free-form `notes` (mixed verdicts are common — record which
sub-claims closed and which stayed open).

Item schema: `{humanId, cluster, title, verdict, evidence, severity, effort,
discipline, notes, duplicateOf?, blockedBy?, citations?}`.

### S2 — Adversarial refutation of closures ← highest ROI stage

**Do not skip this.** It is the cheapest stage and it caught a real data-loss bug.

Independent agents (never the triager) attempt to **refute** every non-`CONFIRMED`
verdict. Standing instruction: *default to refuted when uncertain — closing a real
bug is far worse than leaving one open.*

The refuter re-derives evidence itself and hunts specifically for these five
failure shapes, which is what makes the stage work:

1. **Partial fix presented as full** — one of several sub-claims fixed, residue left.
2. **Source fixed, artifact not** — `dist/` or the published package still broken.
3. **Type hardened, runtime stale** — the signature changed, the call site didn't.
4. **Doc updated, behavior not** (or the reverse).
5. **Holds in source but not through the real consumer seam** — built artifact,
   loaded MCP tool, CLI entry.

For `SUPERSEDED` specifically: prove the superseding thing *exists* and *covers it*.

Output per item: `{humanId, refuted, evidence, recommendedStatus?, closingNote?,
residualWork?}`. The refuter **acts** on non-refuted items (append closing note,
transition status) and leaves refuted items untouched and OPEN.

Observed yield: **4 of 60 closures refuted (6.7%)**.

### S3 — Architect spec + task packing

One architect per cluster, over `CONFIRMED ∪ refuted-reopened` (G1!).

**Pack** items that share files or a root cause into one implementation package —
a package is *one implementer's coherent unit of work*. Split an item across
packages only if genuinely separable. Every item lands in exactly one package or in
`deferred[]` with a reason.

- The **spec** must be precise enough that the implementer makes **no architectural
  choices**: exact files, exact change, exact approach, exact new APIs/types.
- The architect **resolves open design questions itself** and records the rationale.
  It does not defer them back up.
- **Acceptance criteria must be consumer-visible outcomes, each provable by a
  runnable command.** `"Promise.all is present"` is banned; `"an agent gets N
  results back"` is the standard.
- Assign `discipline` (routes to the implementer agent type), `risk`,
  `filesTouched`, `dependsOn`, `sequencing`.

#### Package schema — the architect's output contract

This is what `remediation-pipeline.js` actually consumes. Every field below was
verified against the script; nothing here is aspirational. An architect that returns
prose instead of this shape has produced nothing the pipeline can run.

| Field | Req | Type | Consumed for |
|---|---|---|---|
| `gid` | **yes** | string `<cluster>/<packageId>` | Pipeline key. Uniqueness is enforced — the script **throws** on a missing or duplicate `gid` (guardrail G5). |
| `cluster` | **yes** | string | **Resolves the worktree and branch** (`.worktrees/bl-<cluster>` / `bl/<cluster>`). Omit it and every agent is told to `cd` to a path containing `undefined`. |
| `packageId` | **yes** | string | Progress labels (`impl:`/`review:`/`fix:`/`review2:`) and the missing-`gid` error message. |
| `title` | **yes** | string | Header line in all four stage prompts. |
| `items` | **yes** | string[] | Backlog ids this package closes; shown to implementer, reviewer, fixer. |
| `discipline` | **yes** | string | Routes to the implementer agent type via `agentFor` (`typescript`\|`devops`\|`debug`\|`performance`); unknown values silently fall back to `defaultAgent`. |
| `spec` | **yes** | string | The authoritative instruction. Must be precise enough that the implementer makes **no** architectural choices. |
| `acceptanceCriteria` | **yes** | string[] | Numbered into the implement, review, and fix prompts, and re-checked at both review gates. |
| `filesTouched` | **yes** | string[] | The reviewer's **scope check** — anything changed outside this list is a finding. Empty renders as "(not enumerated)" and the scope check degrades to opinion. |
| `project` | **yes in practice** | string | Substituted into the gate's **`{project}` placeholder**. If omitted the gate is emitted as the literal `npx nx lint <project>` — it does not error, it just **silently stops verifying anything**. |
| `risk` | no | `low`\|`medium`\|`high` | Shown in prompts; defaults to `unknown`. |
| `verificationCommands` | no | string[] | Suggested commands appended to the implement prompt. |
| `extraReviewMandate` | no | string | Prepended to the **first** review as a MANDATORY audit (e.g. a `--no-verify` bypass audit), recorded in the review's `bypassAudit`. Ignored on the final review. |
| `startAt` | no | `implement`(default)\|`review`\|`fix`\|`review2` | Per-package resume point. |
| `priorReport` | conditional | object | **Required when `startAt` is `review` or `review2`** — the implementation report the reviewer judges. |
| `priorReview` | conditional | object | **Required when `startAt` is `fix`** — the review whose findings the fixer applies. |

`cluster` and `project` are the two easy omissions, and neither fails loudly:
a missing `cluster` sends agents to a nonexistent worktree, a missing `project`
neuters the verification gate. Assert both are present on every element before
dispatching a wave.

**`dependsOn` and `sequencing` are NOT read by the pipeline.** They are S5 inputs —
they feed topological wave admission and the collision matrix, which a human decides.
Carry them in `packages.json` (the wave planner needs them), but never expect the
script to honour them; the script runs exactly the wave you hand it, in parallel.

**Quality bar, attached to the field:** every `acceptanceCriteria` entry is a
**consumer-visible outcome provable by a runnable command**, phrased
**worktree-relative** (guardrail G2 — never an absolute repo path). `"Promise.all is
present"` is banned; `"an agent gets N results back"` is the standard. A criterion
that names an implementation shape instead of an observable outcome is a defective
spec — reject it at the architect stage, not at the review gate.

### S4 — Execution substrate

- **One git worktree per cluster.** Not per package (redundant installs, and
  intra-cluster `dependsOn` chains would need cross-worktree rebase choreography),
  not one shared checkout (forces repo-wide serialization of every writer, since the
  build tool does not isolate concurrent writers to one tree).
- **One dependency install per worktree**, up front, before any implementer starts.
- **One shared build cache directory** across all worktrees, at an absolute path
  outside every worktree. Safe because cache keys are content hashes, not paths.
  **Prove it with a real cross-worktree cache hit before trusting it.**
- Record each worktree's **branch-point SHA** at creation (`git rev-parse HEAD`
  right after `git worktree add`). It is the `--base` for every affected-scoped
  command and the baseline for the docs stage.

Two agents may share one cluster worktree **only** if their files are fully disjoint.

### S5 — Collision-aware wave planning

Wave admission = **topological order over `dependsOn`** ∩ **pairwise `filesTouched`
collision matrix**. Dependency order alone is not enough — it misses same-wave file
contention between *different* clusters (the run found 3 cross-cluster collisions:
`ci.yml`, `AGENTS.md`, root `package.json`) and even *within* a cluster between
packages that have no mutual dependency.

Rules:

- Packages in one wave must be mutually file-disjoint.
- A collision with no `dependsOn` relation gets an **explicit serialization rule**
  added to the wave plan; do not rely on merge conflict resolution to catch it.
- Where two packages touch the same file at disjoint line ranges, still serialize —
  the risk is a silent overwrite, not a conflict.
- Sanity-check the arithmetic: `Σ waves + held == total packages`.

Max concurrency is capped by **cluster count**, not by an arbitrary number — and in
practice by reviewer capacity before file collisions.

### S6 — Per-package pipeline

`implement → review → fix → review`, **pipelined, not barriered** (package N+1's
implement starts while package N reviews). Skip the fix round when the first review
is `APPROVED` with zero blocker/major findings, and pass the first verdict through.

Report schema (implement/fix):
`{gid, status: DONE|PARTIAL|BLOCKED|FAILED, summary, filesChanged[], commits[],
verification[{command, exitCode, result}], acceptanceEvidence[{criterion, proof}],
negativeControl, deviations, blockers, newIssues[]}`

Review schema:
`{gid, verdict: APPROVED|CHANGES_REQUESTED|REJECTED,
findings[{severity: blocker|major|minor|nit, summary, file, line, why, fix}],
acceptanceVerified, testsHaveTeeth, scopeClean, bypassAudit, notes}`

`bypassAudit` carries the result of the package's `extraReviewMandate` when one was
set — every re-run gate command and its exit code. It is passed through to the fix
round.

Implementers append a note on each backlog item recording what they did, and
**never resolve/close it** — a reviewer gates that.

### S7 — Verify state-side, never from reports

The reviewer judges **the actual diff** (`git diff <base>...HEAD`) and **re-runs the
gate itself**, citing its own exit codes. It must not accept the implementer's
reported numbers as substitutes. This caught things reports hid, repeatedly.

Reviewer checklist:

1. Correctness against the spec — does it fix the cited defect?
2. Acceptance — every criterion proven through the **real consumer seam**, not a
   proxy and not a mock of the thing under test.
3. **Tests have teeth** (S8).
4. Scope — did anything outside `filesTouched` change? Did a commit sweep in another
   agent's work (`git show --stat`)? Evidence of `git add -A` is a blocker.
5. Project rules — banned commands, import paths, dependency direction, platform
   isolation, no env-gated tests except a paid third-party service.
6. Quality — reuse over reinvention, no dead code, docs on new public API, lint clean.

Every finding names `file:line` and the fix. **The reviewer does not edit code and
does not commit** — it is the gate, not the author.

Where a bypass is suspected (e.g. commits made with the pre-commit hook skipped),
add a **mandatory bypass audit** as the reviewer's *first* task: re-run every skipped
gate, record each exit code, and check `git log --stat` for anything outside declared
scope.

### S8 — Tests must have teeth

Every fix needs a **negative control**: revert the fix (or inject the wrong value),
confirm the test goes **red**, restore. A test that stays green on broken code proves
nothing — that is a blocker finding.

The reviewer **verifies or re-runs** the negative control. The run caught a
"negative control" that silently skipped its own assertion step; that is exactly the
failure this re-run exists to catch.

Also required: real components (mock only a paid external boundary); deterministic
without sleeps/wall-clock (latches, barriers, bounded deadlines); tests run **by
default, unflagged** — being slow, spawning a process, or needing a build are not
reasons to gate; assert the outcome, not the implementation shape.

### S9 — Chase, don't park

Only a **genuine human-input block** may be reported `BLOCKED`:

- a missing credential/secret
- a product-scope call with no defensible default
- approval to install a **new** external tool
- **another session's in-flight work** you would have to overwrite (the run hit
  exactly this: a target repo sat mid-`cherry-pick`; those packages were held out of
  every wave rather than forced)

**Not** blockers — these are the implementer's to resolve and record in
`deviations[]`: a stale or wrong spec, a hard bug, a flaky test, an ambiguous
acceptance criterion, a package that needs scaffolding first, a missing but
installable toolchain, a design question that can be decided from the code.

### S10 — Doc steward per touched package

One steward per touched project, **scoped to the incremental diff since the run's
baseline SHA** — not a general docs review.

Mechanics that matter:

- Map changed files → projects. **Detect NEW packages separately**: their
  `project.json` does not exist at the baseline, so naive baseline-driven mapping
  misses them entirely. Flag them (`new: true`) and tell the steward it is authoring
  first-ever docs.
- **Separate substantive changes from mechanical config sweeps** so stewards do not
  write prose about a lockfile bump.
- Record non-project changes (repo-root files, CI, docs dirs) in their own bucket.
- The bar: docs must be **factually true**, not aspirational. Every claim resolves to
  something that ships; commands are actually run; examples are runnable against the
  real API.
- **Correcting an existing false claim is the highest-value find** — report those in
  `claimsCorrected[]`. The run found a README asserting a provably false dogfooding
  claim.
- `NO_CHANGE_NEEDED` is a legitimate outcome. Do not manufacture edits.

Return schema: `{project, status: UPDATED|NO_CHANGE_NEEDED|BLOCKED|FAILED, summary,
filesWritten[], commits[], claimsCorrected[], gapsFound[], deviations, blockers}`.

**Dispatch schema** — `doc-dispatch.json`, passed to the pipeline as `args.docs`,
one entry per touched project:

| Field | Req | Consumed for |
|---|---|---|
| `files[]` | **yes** | The incremental change set shown to the steward, and the pathspec of the `git diff <baseline>..HEAD -- …` it is told to run. |
| `commits[]` | **yes** | Commits touching those files, listed in the prompt. |
| `branches[]` | **yes** (unless `worktree`) | **`branches[0]` is used as a CLUSTER key**, not a branch name — it is fed to the worktree/branch templates. Put the cluster there, despite the field name. |
| `worktree` | no | Absolute path overriding the `branches[0]` lookup. Supply it and `branches` becomes cosmetic. |
| `new` | no | `true` marks a package absent at baseline; flips the prompt to "author first-ever docs". |
| `dir` | no | Package directory, shown to the steward so it does not have to hunt for it. |

### S11 — Merge

Per-cluster, in **wave-completion order** — never one giant merge at the end. That
lets later clusters rebase onto the real merged state rather than a stale copy.
Order clusters so that whichever cluster *writes* a shared file lands before any
cluster that *rebases onto* it.

The merge resolver, beyond a clean merge:

- Re-runs the full gate against post-merge state **for every project the merge
  touched**, not just the merging cluster's own projects. A mergeable-but-broken
  combination is the failure mode (two additive edits to one CI file that must both
  be present and syntactically valid).
- Checks additive edits **by symbol name, not line range** — ranges drift after each
  sequential merge.
- For bulk/sweep packages, **diffs the actual file count against the expected count**
  before accepting. A partial sweep is invisible in a normal diff review.
- `git status` immediately before every commit; pathspec-scoped commits only.

---

## Guardrails — the mistakes this run actually made

| # | Guardrail | What went wrong |
|---|---|---|
| **G1** | **Reconcile coverage after EVERY stage.** `confirmed + reopened + deferred + blocked == total`, asserted at each boundary. | Architects were handed only `CONFIRMED` items, so the 4 refuted-reopened items silently had **no implementation package**. The single most expensive mistake of the run. |
| **G2** | **Phrase acceptance criteria worktree-relative.** Never an absolute repo path in an AC. | An AC hardcoded an absolute path and failed when run from a worktree. |
| **G3** | **Validate a guard against the ACTUAL usage pattern, not the default one.** | A guard was written that stripped `GIT_INDEX_FILE`, which would have silently broken the pre-commit gate for pathspec commits (`git commit -- <paths>`) — the repo's *mandated* commit form. |
| **G4** | **Verify artifacts on the filesystem.** Never take "built and proven" from a report. | A subagent reported work as built and proven that was **not on disk**. |
| **G5** | **Namespace package ids globally from the start** (`<cluster>/<packageId>`). | Three packages were literally named `PKG-1`, across three clusters. |
| **G6** | **Never dump environments into a transcript.** Use `pgrep -l`, not `pgrep -fl`. | `pgrep -fl` dumped a secret-bearing environment into the transcript. |
| **G7** | **Never bypass the pre-commit gate.** If the hook misbehaves, STOP and report — do not `--no-verify`. | An implementer made all 6 of its commits with the gate skipped, forcing a full retroactive bypass audit. |
| **G8** | **Verify the ambient git environment before trusting it.** | An ambient `GIT_DIR`/`GIT_WORK_TREE` broke bare `git -C <root>` invocations for the whole session; every agent had to prove `git status` worked in its own shell first. |
| **G9** | **Re-run `git status` immediately before each wave's first commit.** | Unrelated uncommitted work from another session was already sitting on the branch; "clean main" was stale by the time real work started. |
| **G10** | **Design for resume.** Keep every stage's inputs and outputs as JSON on disk, keyed by global id. | An agent died mid-run on a session limit; recovery was only possible because the package record and prior verdicts were on disk (`wave1-resume.js`). |

---

## Standing rules block (give this to every writing agent)

```
- Work ONLY inside your assigned worktree. Never edit the main checkout or another
  cluster's worktree.
- BANNED: git stash, git reset --hard, git clean -f, git push, git add -A,
  git add ., git commit -a, --no-verify, chained rm, rm with a variable path.
- Commit with an explicit pathspec ONLY: git commit -- <path> [<path>…]
  (a shared git index means `git add` sweeps other agents' files into your commit).
- Conventional Commits, scoped to the library.
- Never discard or revert changes you did not author. If you find unexpected edits,
  STOP and report.
- Never call a failure "pre-existing", "legacy", or "out of scope". If a test goes
  red after your edit, fixing it is your sole priority regardless of origin.
- Ephemeral/test artifacts write under tmp/ only; tests clean up after themselves.
- Every claim cites a file:line you actually opened or a command whose real output
  you saw.
- Trust EXIT CODES, never a stdout grep.
```

## Verification gate — literal commands (this repo)

Run from the worktree root before declaring done. Trust exit codes.

```bash
export NX_CACHE_DIRECTORY=<shared-cache-abs-path>
npx nx lint <project>
npx nx run <project>:sync-deps        # only if lint surfaced dependency drift; never hand-edit deps
npx nx build <project>                # type-check via the real target — NEVER invoke tsc directly
npx nx affected -t test --base=<branch-point-sha>            # NOT targeted `nx test`, unless zero dependents is PROVEN via nx graph
npx nx affected -t verify-dist-load --base=<branch-point-sha> # prove the shipped artifact actually loads
git status --porcelain                # confirm ONLY your intended files changed
```

Note: in this repo a `PreToolUse` hook intercepts bare `nx lint <project>` and
requires the `affected`/`--base` form. Never `--skip-nx-cache`; if output looks
stale, change an input or `npx nx reset`.

---

## Portability — what is adhd-specific vs. universal

| Universal (keep) | adhd-specific (swap) |
|---|---|
| Inventory → cluster → triage → **refute** → architect → wave → implement/review/fix/review → docs → merge | The backlog MCP (`mcp__backlog__*`) and `backlog` CLI as the item store |
| Verdict + review + report vocabularies and schemas | `nx lint / build / affected -t test / verify-dist-load / sync-deps` gate commands |
| Adversarial refutation and its five failure shapes | `NX_CACHE_DIRECTORY` as the shared-cache mechanism |
| Negative-control requirement and reviewer re-run | `pnpm install --frozen-lockfile` per worktree |
| Verify state-side, never from reports | `.worktrees/bl-<cluster>` + `bl/<cluster>` branch naming |
| Collision matrix ∩ topological wave admission | Agent type names (`typescript-pro`, `code-reviewer`, `architect-reviewer`, `sox-active:doc-steward`) |
| Worktree-per-cluster + one shared cache | `@adhd/workspace-codegen-nx` scaffolding rule, `packages/<domain>/<domain>-<tier>-<name>` layout |
| Chase-don't-park blocker definition | The `PreToolUse` lint hook and `.git/adhd-hooks` pre-commit gate |
| Doc steward scoped to incremental diff + new-package detection | `project.json` as the file→project mapping key |
| All ten guardrails | |

To port: replace the **gate command list**, the **item store calls**, the
**worktree/branch templates**, and the **agent type names**. Everything else is
structure. The workflow script (below) takes all four as parameters.

---

## Running it

`remediation-pipeline.js` (beside this file) generalizes the run's `wave0/wave1/
wave1-resume/docs-pass` scripts. It executes S6 (per-package pipeline) and S10
(docs), which are the stages worth automating.

```
Workflow(script: .claude/skills/backlog-remediation/remediation-pipeline.js,
         args: { … })
```

Its `args` are documented in the header of the script itself. Minimum viable call:
`repoRoot`, `baselineRef`, `packages[]`. Everything else defaults to this repo's
conventions.

- `packages[]` element shape → the **package schema** in S3. That is the contract; do
  not re-derive it by reading the script's arg parsing.
- `docs` object shape → the **dispatch schema** in S10.
- Feed it **one wave at a time** — `wave<N>-pkgs.json`, never the whole package set.

Stages S0–S5 and S11 are **deliberately not scripted** — see the script header for
why — but every one of them still has a defined output artifact. See *Stage artifact
contracts* above.
