# APPROVAL - tripwire package

APPROVER: Dispatcher (run dispatch-2026-10-12-ca18), relaying the human's decisions under the brief for this amendment pass
DATE: 2026-10-12
BACKLOG: `8468f7b1-8adc-4237-9986-21ea1e27c537`

## Summary

This approval covers the three new packages of the plan: `@adhd/stealth-search`, `@adhd/stealth-core-browser` and `@adhd/resilience-core-tripwire`.

Summary corrected 2026-10-24.

## Human approval carried by the request

The human's verbatim request: "Implement tripwire package in this plan covering all 3"

It approves creating ONE additional new package, `@adhd/resilience-core-tripwire` at `packages/resilience/resilience-core-tripwire`, in this plan. "All 3" are the three tripwire consumers: the reverse-apis request-builder gate, the reverse-apis unlock tool and the agent-search tripwire. The other new packages approved for this plan are listed in the summary above and in `APPROVAL.md`. No project.json beyond those packages may be added.

The same request direction also states: "Preserve every FEATURE and failsafe ... Legacy code, legacy tests and legacy names are not constraints" and "Group kill add up front if its genuinely a useful feature, and dont write it one way and then rewrite it later with the versioning plan, we're going to run this e2e as quickly as possible".

## Decisions recorded

- D1: a new `resilience` workspace group is created in `.adhd/workspace.json` (description: "Fail-safe primitives - persistent kill-switches and guards that protect callers and upstream services from compounding failures"). The package is generated with `npx nx g @adhd/workspace-codegen-nx:core --name=tripwire --group=resilience ...`. The `agent` group fallback (`agent-core-tripwire`) is declined.
- D2: the tripwire is a kill-switch file protocol (presence of a human-readable file means stopped; `rm` is the break-glass), not a record store, so ADR-0001 does not apply. Persistence sits behind the `TripwireStorage` seam; multi-process safety comes from atomic primitives (`link`, `rename`, O_APPEND), proven by the interleaving suite.
- D3: behavior changes versus the three sources are accepted: a corrupt or unreadable lock BLOCKS (fail closed); blocked sends are counted and audited, and every trip and clear is audited; a second trip keeps the first record; reverse gains a blocked count and an audit log; search keeps its agent-callable clear (policy `open`) while reverse keeps the confirm-token clear (policy `confirm-token`).
- D4: the tripwire package ships on the same publish branch as stealth-browser (`stealth-browser`), in the same release.

## Not approved (human gates remain)

- Publishing and the consumer relinks: blocker `hb-release-decision`, owned by the dispatcher.
- Publishing `@adhd/sox-service-proxy` 0.6.0 (a different repository): blocker `hb-sp-release`.
