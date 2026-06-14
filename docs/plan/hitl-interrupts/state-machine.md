# State Machine — hitl-interrupts

## States

| Slug | Kind | Phase | Depends on | Guard |
|---|---|---|---|---|
| `hitl-schema` | work | foundation | — | schema has awaiting_input + resume_token + migration ≥5 |
| `hitl-types` | work | foundation | hitl-schema | validation types updated + build passes |
| `hitl-orchestrator` | work | engine | hitl-types | orchestrator intercepts request_human_input + tests pass |
| `hitl-resume-tool` | work | engine | hitl-orchestrator | task_resume tool added to tools/task.ts + tests pass |
| `audit-foundation` | audit | engine | hitl-resume-tool | `audit_hitl.py --phase foundation` exits 0 |
| `code-review` | review | convergence | audit-foundation | `.code-review-complete` sentinel exists |
| `audit-final` | audit | convergence | code-review | `audit_hitl.py --phase final` exits 0 |
| `docs-and-publish` | work | convergence | audit-final | version = 0.3.0 AND npm shows 0.3.0 |
| `done` | terminal | — | docs-and-publish | — |

## Topology

```
hitl-schema
    │
    ▼
hitl-types
    │
    ▼
hitl-orchestrator
    │
    ▼
hitl-resume-tool
    │
    ▼
audit-foundation
    │
    ▼
code-review  ← human hold point
    │
    ▼
audit-final
    │
    ▼
docs-and-publish
    │
    ▼
  done
```

## Key transitions

- `hitl-schema` → `hitl-types`: `awaiting_input` in enum, `resume_token` column, migration generated.
- `hitl-types` → `hitl-orchestrator`: types + store updated, build passes.
- `hitl-orchestrator` → `hitl-resume-tool`: orchestrator suspends task on `request_human_input`.
- `hitl-resume-tool` → `audit-foundation`: `task_resume` tool resolves the suspension.
- `code-review` → `audit-final`: human sentinel created.
- `audit-final` → `docs-and-publish`: all DoD clauses verified.

## Rollback

Schema migration adds one nullable column (`resume_token`) + enum extension — rollback with a
downward migration. Orchestrator changes are surgical additions — revert specific hunks.
`task_resume` tool in tools/task.ts is a new handler — remove to rollback.
