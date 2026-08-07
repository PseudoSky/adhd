# audit-final

**Phase:** convergence · **Depends on:** code-review
**Guard:** `python3 docs/plan/parallel-tool-execution/scripts/audit_parallel.py --phase final`

---

## Goal

Verify all DoD clauses and reference patterns against the actual codebase. Proves the plan is
complete and correct before publishing 0.1.0.

---

## Semantic Distillation

- **Primitive:** EXTEND `scripts/audit_parallel.py --phase final` — adds DoD + reference checks.
- **Delta Spec:** `--phase final` runs all foundation checks plus:
  - `[dod.1]` Promise.all is the dispatch mechanism
  - `[dod.2]` isError=true for failed tools
  - `[dod.4]` Fatal policy codes still abort
  - `[dod.7.build]` `npx nx build agent-mcp` succeeds
  - `[dod.7.tests]` `npx nx test agent-mcp` passes
  - `[audit-final.ref-tool-error-throw]` All ToolError throws conform to [ref:tool-error-throw]
  - `[audit-final.ref-policy-before-dispatch]` policy.check appears before Promise.all
- **Validation:** Exits 0, prints `FINAL AUDIT PASSED`.

---

## Acceptance criteria

- [ ] All foundation checks pass.
- [ ] Every `[dod.N]` clause has a proving check in the script.
- [ ] Both reference pattern checks (`ref-tool-error-throw`, `ref-policy-before-dispatch`) pass.
- [ ] Full build and test suite pass.

---

## Reservations

```text
read_only:  ["packages/ai/agent-mcp/src/"]
mutates:    ["docs/plan/parallel-tool-execution/scripts/audit_parallel.py"]
```

---

## Commit points

- [ ] **After each source fix**: `fix(agent-mcp): audit-final.<id> — <what>`
- [ ] **After audit passes** (mandatory):
      `chore(parallel-tool-execution): audit-final green — all DoD verified`
