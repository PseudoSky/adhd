# APPROVAL — dispatch-completion

**Gate:** GATE 2 (demo + tools dispatcher sign-off, per plan-builder P7).
**Verdict:** APPROVED.
**Approver:** coordinator (relayed dispatcher sign-off).
**Date:** 2026-07-15.

## What was approved
- The rebuilt, demo-creator-authored `demo/DEMO.md` (validator `validate_demo.py` exit 0: 15 stubs reconciled, 27 matrix ids proven) + `demo/UNRESOLVED.md`.
- `SCOPE.md`, `USE_CASES.md`, `TOOLS.md`, `RECONCILIATION.md`, `PLAN_STATE_MACHINE_PROPOSAL.md` at the re-scoped state.

## Approved scope (re-scoped)
- **Headline defects REMOVED from this plan** — fixed directly as landed preconditions:
  - **BUG-DISPATCH-PUBLISH-001** — package-name↔import↔alias conformance to the repo `<domain>-<tier>-<name>` standard + dropped duplicate aliases. **Status: LANDED** (names conformed, aliases dropped, build+test green, pack-resolvability verified).
  - **BUG-DISPATCH-EXEC-001** — wire real tool-call execution (+ `@adhd/dispatch-tools` execution primitives). **Status: IN PROGRESS** (separate executor). Phase 0 `V0` gate MUST confirm it landed before proceeding at execute time; the `dispatch-tools` authoring state drops if EXEC-001 shipped the full execution package.
- **This plan owns the residual:** 3 new packages (`dispatch-serializer-sqlite`, `dispatch-plugin-io`, `dispatch-plugin-gitnexus`), ~18 open DEBT-DISPATCH items, a held/data-gated `optimizer-algorithms` phase, test hardening, orphan-delete of `dispatch-base-types`, release-ready.

## Locked decisions
- Single merged plan; slug `dispatch-completion`.
- DEBT-DISPATCH-006 (per-turn `task_events`) handed to the agent-* stream; **no agent-mcp file touched**.
- `optimizer-algorithms` ships HELD / non-terminal-blocking (data gate: >15% greedy shortfall over ≥3 real cycles).
- Terminal = release-ready; human-gated `nx release publish`.
- apigen generated-CLI `$ref` crash deferred to `packages/apigen/BACKLOG.md`; hand-written `bin/cli.ts` canonical.

## Audit trail
Downstream states reference this committed file as the approval-of-record. The DoD for every work state derives from `demo/DEMO.md`'s binary assertions; the ~18 DEBT items are tracked in this plan's own `BACKLOG.md` (source of truth — the root `BACKLOG.md` is de-duplicated to remove plan-owned items).
