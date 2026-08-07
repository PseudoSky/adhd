# done — TERMINAL STATE

**Phase:** convergence · **Depends on:** audit-final · **Guard:** `node -e "process.exit(0)"`

---

## Goal

All 8 DoD clauses are confirmed. The `@adhd/apigen-*` system is complete.

---

## Transition requirements

This state is entered when `audit-final` passes and the architect-reviewer has recorded a verdict in `state.json`'s `amendment_log`. No new code is written here.

### Final state.json update

Update `state.json` with:
- `current_state: "done"`
- `status.done: "complete"`
- `completed_at: <timestamp>`

### Commit

```bash
git commit -m "feat(apigen): complete @adhd/apigen-* system — all DoD clauses passing"
```

---

## Acceptance criteria

No acceptance criteria — terminal state. The DoD is the contract; `audit-final` is the proof.

---

## Reservations

Machine-parseable reservation block (mutates set === this node's dag.json artifacts).

```text
mutates:    ["docs/plan/apigen-client-generation/state.json"]
read_only:  []
```
