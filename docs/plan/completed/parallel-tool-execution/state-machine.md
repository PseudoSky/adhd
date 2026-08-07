# State Machine — parallel-tool-execution

## States

| Slug | Kind | Phase | Depends on | Guard |
|---|---|---|---|---|
| `parallel-dispatch` | work | foundation | — | `grep -q 'Promise.all' orchestrator.ts && ! grep -q 'for (const toolCall of toolCalls)'` + tests pass |
| `audit-foundation` | audit | foundation | parallel-dispatch | `audit_parallel.py --phase foundation` exits 0 |
| `code-review` | review | convergence | audit-foundation | `.code-review-complete` sentinel exists |
| `audit-final` | audit | convergence | code-review | `audit_parallel.py --phase final` exits 0 |
| `docs-and-publish` | work | convergence | audit-final | package.json version = 0.1.0 AND npm registry shows 0.1.0 |
| `done` | terminal | — | docs-and-publish | — |

## Topology

```
parallel-dispatch
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

- `parallel-dispatch` → `audit-foundation`: Promise.all loop present, sequential for-loop absent, tests green.
- `audit-foundation` → `code-review`: all acceptance criteria for parallel-dispatch pass the audit script.
- `code-review` → `audit-final`: human reviewer creates `.code-review-complete` sentinel.
- `audit-final` → `docs-and-publish`: all DoD clauses verified by audit.
- `docs-and-publish` → `done`: 0.1.0 published to npm.

## Rollback

No schema migrations — this is a pure code change. Rollback is `git revert` of the orchestrator change.
