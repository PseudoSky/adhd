# agent-final

**Status: INVENTORY. This is not yet a plan. Do not execute anything here.**

**Created:** 2026-07-16

This directory replaces the entire agent + dispatch plan corpus (21 plans, now quarantined
in [`superseded/`](./superseded/README.md)). Its purpose is to hold **one** coherent
account of the agent system so that the next plan is written once, with the whole vision
in view — instead of the incremental, contradictory decisions that produced the corpus.

## Why the corpus was replaced

The old plans made architectural decisions piecemeal and **at least one certified work
that never happened** (`agent-mcp-refactor`'s `agent-store-retire` is `complete`; the code
shows the opposite). Of 27 plan dirs, only **3** were cleanly closed. Full evidence:
[`superseded/README.md`](./superseded/README.md) §Why.

**The operative rule here: a plan document is not evidence.** Anything labelled
"Decision" in `superseded/` may be planner-generated with no human ratification. Verify
against code, or ask.

## Layout

| Path | What |
|---|---|
| `README.md` | this — status + reading rules |
| `SYNTHESIS.md` | **the inventory**: what is actually built (verified), what the old plans claimed, and the open questions |
| `superseded/` | all 21 quarantined plans + a loud README explaining why nothing in there is ground truth |
| `superseded/dispatch-completion/demo/` | **preserved** — the dispatcher demo |
| `superseded/agent-registry/demo/` | **preserved** — the registry ingest/run demo |

## What is NOT in scope of this directory

`adhd-environment`, `apigen-*`, `infrastructure-backlog`, and `workspace-cleanup` remain
in `docs/plan/` untouched — they are not part of the agent/dispatch system.

## Next step

**Pause for inventory.** Read `SYNTHESIS.md`, decide what is actually being built, then
author the plan. Do not resume any superseded plan.
