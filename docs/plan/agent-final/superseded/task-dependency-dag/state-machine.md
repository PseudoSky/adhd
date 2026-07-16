# State Machine — task-dependency-dag

## States

| Slug | Kind | Phase | Depends on | Guard |
|---|---|---|---|---|
| `dag-schema` | work | foundation | — | schema has depends_on + waiting + migration ≥4 |
| `dag-types` | work | foundation | dag-schema | validation types updated + build passes |
| `dag-engine` | work | engine | dag-types | DagEngine.ts exists + dispatchReady + cycle + tests pass |
| `audit-foundation` | audit | engine | dag-engine | `audit_dag.py --phase foundation` exits 0 |
| `code-review` | review | convergence | audit-foundation | `.code-review-complete` sentinel exists |
| `audit-final` | audit | convergence | code-review | `audit_dag.py --phase final` exits 0 |
| `docs-and-publish` | work | convergence | audit-final | version = 0.2.0 AND npm shows 0.2.0 |
| `done` | terminal | — | docs-and-publish | — |

## Topology

```
dag-schema
    │
    ▼
dag-types
    │
    ▼
dag-engine
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

- `dag-schema` → `dag-types`: new columns in schema.ts + drizzle migration generated.
- `dag-types` → `dag-engine`: taskStatusSchema has 'waiting', taskSchema has new fields, build passes.
- `dag-engine` → `audit-foundation`: DagEngine with dispatchReady + cycle check wired into tools/task.ts.
- `audit-foundation` → `code-review`: all acceptance criteria pass.
- `code-review` → `audit-final`: human sentinel created.
- `audit-final` → `docs-and-publish`: all DoD clauses verified.

## Rollback

Schema migration is additive (nullable columns + enum extension) — rollback requires a downward
migration that removes the new columns. DagEngine is a new file — delete to rollback. Types and
tools/task.ts changes are minimal additions — revert the specific hunks.
