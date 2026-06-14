# code-review

**Phase:** convergence · **Depends on:** audit-foundation · **Guard:**
```bash
test -f docs/plan/task-schema-foundation/.code-review-complete
```

---

## Goal

Human hold point. A reviewer (or code-reviewer subagent) inspects the full diff and creates the
sentinel file when satisfied.

---

## Reviewer checklist

- [ ] Migration `0004_*.sql` adds all four columns in one statement — no extra columns, no column drops
- [ ] Status enum extension includes exactly `"waiting"` and `"awaiting_input"` (no typos)
- [ ] `agent-mcp-types` `TaskStatus` export updated before `validation/task.ts` (see commit ordering)
- [ ] `taskStatusSchema` enum matches `schema.ts` status enum exactly
- [ ] `taskSchema` new fields (`dependsOn`, `onUpstreamFailure`, `inputs`, `resumeToken`) are all optional
- [ ] `taskToolInputSchema` gains `depends_on` and `on_upstream_failure` but NOT `resume_token`
- [ ] `TaskStore.create()` correctly sets `status = "waiting"` when `dependsOn.length > 0`
- [ ] `TaskStore.updateStatus()` accepts and persists `resumeToken` only when provided
- [ ] `TaskStore.read()` / `list()` parse JSON fields (`depends_on`, `inputs`) back to arrays/objects
- [ ] Build is green (no TypeScript errors in agent-mcp or agent-mcp-types)

## Creating the sentinel

When satisfied:
```bash
touch docs/plan/task-schema-foundation/.code-review-complete
git add docs/plan/task-schema-foundation/.code-review-complete
git commit -m "chore(agent-mcp): schema-foundation code-review-complete sentinel"
```

---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/task-schema-foundation/.code-review-complete"]
```

---

## Contract Promise

Sentinel file exists → code-review complete → proceed to audit-final.
