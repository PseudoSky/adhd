# removal-runbook — GATED RETIREMENT: remove only when the report is all-PASS

**Phase:** removal · **Kind:** work · **Depends on:** roundtrip-equivalence-gate, audit-migration · **Guard:** `npx --yes nx test agent-registry-migration --testFile=packages/ai/agent-registry-migration/src/__tests__/removal-runbook.test.ts`

---

## Goal

`retire(report, paths)` removes migrated source files ONLY when the equivalence
report is all-PASS, and refuses (throws / returns blocked) on any `FAIL` — the
zero-data-loss forcing function. On a fixture it removes the fixture `.md` and
proves the compiler still produces the agent (removal didn't break anything). The
`RUNBOOK.md` documents the cross-repo `claude-agents` removal as a gated operator
step. Proves `[dod.4]` (behavioral) and `[dod.6]` (structural).

---

## Semantic Distillation

- **Primitive:** ADD `src/removal/retire.ts` + `removal-runbook.test.ts` +
  `docs/plan/agent-registry-migration/RUNBOOK.md`.
- **Reference Pattern:** `[def:retire]`, `[inv:zero-loss-before-removal]`,
  `[inv:cross-repo]`. SCOPE.md "Systems Replaced"; REFERENCES.md "Superseded
  Systems — Removal Targets".
- **Delta Spec:**
  - `retire(report, paths)`:
    1. If `!report.allPass` → REFUSE: throw a typed error / return `{ removed: [],
       blocked: true }` and touch NO files. This is the gate.
    2. If `report.allPass` → for each path: assert `compile <slug>` still emits the
       agent, THEN delete the file. (Compile-before-delete: never delete if the
       agent can't be reproduced.)
  - `removal-runbook.test.ts` — two cases:
    1. `"retire refuses when report is not all-PASS"`: build a report with one
       `FAIL`, call `retire`, assert it throws/blocks AND the fixture path STILL
       EXISTS (`existsSync` true). [proves `[dod.4]`]
    2. `"all-PASS retire removes the fixture and compile still produces the
       agent"`: copy a fixture to a tmp path, all-PASS report, `retire`, assert the
       tmp path no longer exists (`!existsSync`) AND `compile <slug>` still emits
       the agent. [proves `[dod.6]`]
  - `RUNBOOK.md` — the operator procedure for the REAL cross-repo removal in
    `~/dev/ai/claude-agents`: (a) requires an all-PASS report for the FULL corpus
    (the forcing function), (b) lists the removal targets (REFERENCES.md table:
    `categories/`, `.claude/skills/`, `worker-template.md`, `00-active/`,
    `docs/catalog/`), (c) states explicitly that this step is run by an operator
    OUTSIDE these guards (`[inv:cross-repo]`), gated on the report.

---

## Acceptance criteria

- [removal-runbook.1] removal aborts when equivalence report is not all-PASS (gated); fixture removed + compile still produces the agent when all-PASS
- [removal-runbook.2] retire requires all-PASS report as forcing function
- [removal-runbook.3] RUNBOOK documents cross-repo claude-agents removal as gated step

---

## Reservations

```text
read_only:  ["packages/ai/agent-registry-migration/src/verify/equivalence-gate.ts", "packages/ai/agent-registry-migration/src/import/import-agent.ts"]
mutates:    ["packages/ai/agent-registry-migration/src/removal/retire.ts", "packages/ai/agent-registry-migration/src/index.ts", "packages/ai/agent-registry-migration/src/__tests__/removal-runbook.test.ts", "docs/plan/agent-registry-migration/RUNBOOK.md"]
```

---

## Commit points

- `feat(agent-registry-migration): gated removal runbook + cross-repo retirement procedure`

## Notes for executor

- `[dod.4]` negative control: REMOVING the all-PASS guard in `retire()` must let
  it delete the fixture despite a `FAIL` entry → `removal-runbook.test.ts` goes
  RED. Confirm it bites (CLAUDE.md standard #2).
- The removal test MUST operate on a COPY of the fixture in a tmp path — never
  delete the checked-in `src/__fixtures__/*.md` (later states + reruns read them).
- NEVER reach into `~/dev/ai/claude-agents` from a test or guard
  (`[inv:cross-repo]`). The real corpus removal is a RUNBOOK.md operator step,
  gated on a full-corpus all-PASS report — documented here, executed by a human.
- Gate on the vitest EXIT CODE.
