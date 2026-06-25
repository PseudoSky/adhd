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
