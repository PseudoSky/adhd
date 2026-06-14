# State Machine — task-schema-foundation

```
[schema-columns] ──► [task-types] ──► [audit-foundation] ──► [code-review] ──► [audit-final] ──► [docs-and-publish] ──► done
  (work/foundation)  (work/foundation)  (audit/foundation)    (review/conv.)    (audit/conv.)     (work/convergence)
```

## Node summary

| Slug | Kind | Phase | Depends on |
|---|---|---|---|
| schema-columns | work | foundation | — |
| task-types | work | foundation | schema-columns |
| audit-foundation | audit | foundation | task-types |
| code-review | review | convergence | audit-foundation |
| audit-final | audit | convergence | code-review |
| docs-and-publish | work | convergence | audit-final |

## Files mutated

| Node | Files |
|---|---|
| schema-columns | `src/db/schema.ts`, `drizzle/` |
| task-types | `packages/ai/agent-mcp-types/src/index.ts`, `src/validation/task.ts`, `src/store/task-store.ts` |
| code-review | `docs/plan/task-schema-foundation/.code-review-complete` |
| docs-and-publish | `packages/ai/agent-mcp/package.json`, `packages/ai/agent-mcp-types/package.json`, `ROADMAP.md` |
