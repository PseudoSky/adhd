# Agent Registry — Release & Closeout (worktree merge, publish, cleanup)

> ## ⚠ Note (2026-06-28): the suite was PUBLISHED out-of-band — this plan is still `pending`
>
> The 6 registry/agent-mcp packages were published to npm **outside** this plan's state
> machine (an owner-approved pragmatic publish to unblock the compiler chain), following
> only the **runbook mechanics** (R3 dependency order, R6 no-`"*"` concrete pinning,
> out-of-workspace smoke). **This plan's gates were NOT run** — no baseline pin, back-out
> gate, `--no-ff` worktree merge, or final audit. The published set + divergences (notably
> `agent-mcp@2.0.1`, not `2.0.0`, and `@adhd/agent-compiler` now an *optional* dep) are
> logged in [`POST_PUBLISH.md` → Run log](./POST_PUBLISH.md). The related in-package env
> overhaul that triggered this is `docs/mcp-env/SPEC.md`. If this plan is later executed
> for a proper closeout, reconcile against those already-published versions.

The `agent-registry-execution` worktree is merged to `main` (or an explicit
no-merge decision is recorded) with the agent-mcp byte-identical back-out
guarantee verified as a gate; the 5 registry packages + `agent-mcp@2.0.0` are
published via `nx release publish` (clean cached build+test); every untracked
design/demo artifact is committed, relocated, or removed; and a written
worktree-clarity artifact eliminates the owner's confusion about where the work
lives and how to land it.

> **Plan set & ordering.** This is **Plan 9 of 9** — the operational closeout for
> the Agent Registry initiative. It runs LAST: `dag.json` declares
> `depends_on_plans: ["agent-mcp-authoring", "agent-mcp-refactor",
> "agent-registry-migration"]` (Plans 8, 6, 7) so the closeout lands only after the
> code plans are done. It is the home of the **CLOSEOUT.md** sequencing map the
> whole initiative points back to.
>
> **HARD CONSTRAINT — agent-mcp back-out guarantee.** The owner retains the right
> to back out `packages/ai/agent-mcp/` and `packages/ai/agent-mcp-types/`. This
> plan makes that guarantee a **gate on both merge and publish**: the
> `agent-mcp-backout-gate` state precedes `merge-to-main`, and the publish runbook
> re-verifies the baseline before `nx release publish`. If Plan 8 ran, the gate
> confirms every agent-mcp change is within Plan 8's recorded modification
> manifest; if no agent-mcp plan ran, the trees must be byte-identical to baseline.

## Consumer

The **repository owner / release operator** who must land the initiative. Today
they face a worktree off `main` they have repeatedly been confused by, a pile of
untracked design/demo artifacts, six packages awaiting a coordinated publish, and
a standing requirement that agent-mcp remain backable-out. They need a single,
unambiguous, gated path from "work sits in a worktree" to "published on npm and
merged to main, with the back-out guarantee provably intact."

## Value delta

- **Before:** the work lives on `agent-registry-execution` in
  `/Users/nix/dev/node/adhd-agent-registry`, a worktree off `main` that the owner
  finds confusing; `docs/plan/agent-registry/` holds untracked SPEC/DEMO/COVERAGE/
  demo artifacts and ledgers with no disposition; the 6 packages are unpublished or
  at old versions; and there is no mechanical check that a merge or publish hasn't
  silently broken the agent-mcp back-out guarantee.
- **After:** `CLOSEOUT.md` states exactly where the work is, why, and the precise
  merge command; every untracked artifact is committed/relocated/removed per a
  recorded disposition table; the 6 packages are published via `nx release publish`
  on a clean cached build (never `--skip-nx-cache`) and verified on the registry;
  and the agent-mcp baseline gate has confirmed — as a hard precondition of both
  merge and publish — that the back-out guarantee is intact.

## Glossary

> Consumer-owned vocabulary for THIS plan (the release/closeout surface).

- **worktree** — the git worktree at `/Users/nix/dev/node/adhd-agent-registry` on
  branch `agent-registry-execution`, checked out off `main`. All initiative work
  lives here; `main` is untouched until `merge-to-main`.
- **back-out gate** — `check_agent_mcp_baseline.py`: the mechanical proof that
  agent-mcp{,-types} either is byte-identical to the pre-initiative baseline or
  changed only within Plan 8's sanctioned manifest. A precondition of merge AND
  publish.
- **disposition table** — the table in `CLOSEOUT.md` recording, for each untracked
  initiative artifact, whether it is committed, relocated, or removed-on-purpose.
- **nx release publish** — the publish path that runs a clean cached build+test and
  ships the right artifact; never `--skip-nx-cache` (which ships stale dist).

## Definition of Done

- `[dod.1]` **A written, unambiguous artifact tells the owner exactly where the work lives, why it is in a worktree off `main`, and the precise path to land it. (behavioral)** — eliminates the worktree confusion.
  - given: the owner with zero context on where the initiative work sits
  - when: the owner reads `CLOSEOUT.md`
  - then: they can locate the worktree and land it without asking
  - entrypoint: `docs/plan/agent-registry/CLOSEOUT.md read by the owner`
  - observable: `CLOSEOUT.md names the worktree path (/Users/nix/dev/node/adhd-agent-registry), the branch (agent-registry-execution), the base (main), the merge command, and the agent-mcp back-out gate; a reader with zero context can locate and land the work`
  - negative-control: `deleting the worktree-path or merge-command anchor from docs/plan/agent-registry/CLOSEOUT.md makes that file's own clarity audit (grep of CLOSEOUT.md for both anchors) fail`
  - delivered-by: `worktree-clarity`

- `[dod.2]` **The merge of `agent-registry-execution` to `main` is gated on agent-mcp byte-identical verification — the back-out guarantee cannot be silently lost at merge. (behavioral)**
  - given: the worktree ready to merge and a pinned pre-initiative agent-mcp baseline ref
  - when: the operator runs the back-out gate before `merge-to-main`
  - then: the merge proceeds only if agent-mcp is within the sanctioned manifest (or byte-identical)
  - entrypoint: `check_agent_mcp_baseline.py run before merge-to-main`
  - observable: `the gate compares packages/ai/agent-mcp{,-types} against the recorded pre-initiative baseline ref and PASSES only if every change is within Plan 8's modification manifest (or the trees are byte-identical when no agent-mcp plan ran); a drift outside the manifest blocks the merge`
  - negative-control: `introducing an unmanifested agent-mcp src edit makes check_agent_mcp_baseline.py exit non-zero and the merge-gate stays red`
  - delivered-by: `closeout-design, agent-mcp-backout-gate, merge-to-main`

- `[dod.3]` **The 5 registry packages + `agent-mcp@2.0.0` publish via `nx release publish` on a clean cached build+test — never `--skip-nx-cache`. (behavioral)**
  - given: a merged (or merge-ready) tree at the bumped versions
  - when: the operator runs the publish runbook
  - then: all six packages resolve on the registry at their bumped versions from a normally-cached build
  - entrypoint: `nx release publish driven by PUBLISH_RUNBOOK.md + post-publish npm-registry check`
  - observable: `each of @adhd/agent-registry, agent-tool-registry, agent-provider, agent-policy, agent-compiler, agent-mcp@2.0.0 resolves on the registry at its bumped version; the build that produced them was a normal cached nx build (no --skip-nx-cache anywhere in the runbook)`
  - negative-control: `a --skip-nx-cache token present in PUBLISH_RUNBOOK.md makes the publish audit fail (it ships stale dist)`
  - delivered-by: `publish-packages, post-publish-smoke`

- `[dod.4]` **Every untracked design/demo artifact (SPEC, DEMO, demo/, ledgers, orchestration-ledger.md, COVERAGE) is committed, relocated, or removed — no dangling threads. (behavioral)**
  - given: untracked initiative artifacts under `docs/plan/agent-registry/`
  - when: the operator runs the cleanup audit after disposing of each artifact
  - then: no untracked file is left unaccounted for
  - entrypoint: `git status --porcelain after artifact-cleanup, audited by audit_release.py --phase cleanup`
  - observable: `no untracked file under docs/plan/agent-registry/ remains unaccounted for; each is either committed (tracked) or listed in a recorded disposition table in CLOSEOUT.md; .claude/ stays gitignored`
  - negative-control: `leaving an untracked demo artifact absent from the disposition table makes the cleanup audit (git status vs disposition list) fail`
  - delivered-by: `artifact-cleanup`

- `[dod.5]` **agent-mcp non-modification is a guard on BOTH the merge and publish states — the owner's back-out guarantee holds through release. (structural)**
  - entrypoint: `the merge-to-main and publish-packages guards both transitively require check_agent_mcp_baseline.py (agent-mcp-backout-gate precedes merge-to-main; the publish runbook re-verifies the baseline)`
  - observable: `agent-mcp-backout-gate precedes merge-to-main in the DAG (audit_release.py --phase design asserts the dependency edge), and PUBLISH_RUNBOOK.md re-runs the baseline check before nx release publish`
  - negative-control: `removing the agent-mcp-backout-gate dependency from merge-to-main makes the design audit's dependency check fail`
  - delivered-by: `agent-mcp-backout-gate, publish-packages`

## State machine

| phase | state | kind | proves |
|---|---|---|---|
| closeout-design | `closeout-design` | work | `decisions.md`: merge strategy (or no-merge), pre-initiative agent-mcp baseline ref, publish order, artifact disposition policy |
| worktree-clarity | `worktree-clarity` | work | `CLOSEOUT.md`: worktree path/branch/base/merge-command + back-out gate |
| cleanup | `artifact-cleanup` | work | every untracked initiative artifact committed/relocated/removed (disposition table) |
| merge-gate | `agent-mcp-backout-gate` | work | `check_agent_mcp_baseline.py` passes — back-out guarantee intact |
| merge-gate | `merge-to-main` | work | `MERGE_RUNBOOK.md` lands the worktree, gated on the back-out check |
| publish | `publish-packages` | work | `PUBLISH_RUNBOOK.md` publishes 6 packages via `nx release publish`, no `--skip-nx-cache` |
| post-publish | `post-publish-smoke` | work | `smoke_test.sh` + `POST_PUBLISH.md`: published packages import + the USAGE journey works |
| post-publish | `audit-final` | audit | `audit_release.py --phase final`: every `[dod.N]` + back-out gate |

## Reviewer routing

This plan has no code-review state — it is operational (runbooks + gates), and its
correctness is mechanically auditable (the back-out gate, the no-`--skip-nx-cache`
absence check, the disposition check). The `audit-final` audit is the gate. If the
merge strategy is contested, `closeout-design` records the decision for the owner
to ratify before `merge-to-main` runs.
