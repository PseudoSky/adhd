# Agent Registry — Release & Closeout (worktree merge, publish, cleanup)

The agent-registry-execution worktree is merged to main (or an explicit no-merge decision recorded) with the agent-mcp byte-identical back-out guarantee verified as a gate; the 5 registry packages + agent-mcp@2.0.0 are published via nx release publish (clean cached build+test); every untracked design/demo artifact is committed/relocated/removed; and a written worktree-clarity artifact eliminates the owner's confusion about where the work lives and how to land it.

## Consumer

<who walks through the change, and in what role>

## Value delta

<the observable before → after change the consumer experiences>

## Definition of Done

_No DoD clauses yet — author them with `plan-scaffold.js add-dod`._
