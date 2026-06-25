# Agent Registry — Release & Closeout (worktree merge, publish, cleanup)

The agent-registry-execution worktree is merged to main (or an explicit no-merge decision recorded) with the agent-mcp byte-identical back-out guarantee verified as a gate; the 5 registry packages + agent-mcp@2.0.0 are published via nx release publish (clean cached build+test); every untracked design/demo artifact is committed/relocated/removed; and a written worktree-clarity artifact eliminates the owner's confusion about where the work lives and how to land it.

## Consumer

<who walks through the change, and in what role>

## Value delta

<the observable before → after change the consumer experiences>

## Definition of Done

- `[dod.1]` **A written, unambiguous artifact tells the owner exactly where the work lives, why it is in a worktree off main, and the precise path to land it — eliminating the worktree confusion. (behavioral)** — A written, unambiguous artifact tells the owner exactly where the work lives, why it is in a worktree off main, and the precise path to land it — eliminating the worktree confusion..
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `docs/plan/agent-registry/CLOSEOUT.md read by the owner`
  - observable: `CLOSEOUT.md names the worktree path (/Users/nix/dev/node/adhd-agent-registry), the branch (agent-registry-execution), the base (main), the merge command, and the agent-mcp back-out gate; a reader with zero context can locate and land the work`
  - negative-control: `removing the worktree-path or merge-command section makes the clarity audit (grep for both anchors) fail`
  - delivered-by: `worktree-clarity`

- `[dod.2]` **The merge of agent-registry-execution to main is gated on agent-mcp byte-identical verification — the back-out guarantee cannot be silently lost at merge. (behavioral)** — The merge of agent-registry-execution to main is gated on agent-mcp byte-identical verification — the back-out guarantee cannot be silently lost at merge..
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `check_agent_mcp_baseline.py run before merge-to-main`
  - observable: `the gate compares packages/ai/agent-mcp{,-types} against the recorded pre-initiative baseline ref and PASSES only if every change is within Plan 8's modification manifest (or the trees are byte-identical when no agent-mcp plan ran); a drift outside the manifest blocks the merge`
  - negative-control: `introducing an unmanifested agent-mcp src edit makes check_agent_mcp_baseline.py exit non-zero and the merge-gate stays red`
  - delivered-by: `agent-mcp-backout-gate, merge-to-main`
