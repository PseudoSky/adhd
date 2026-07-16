# State: code-review

**Phase:** release
**Kind:** work
**Depends on:** audit-final

## Goal

Run the `code-reviewer` agent against all implementation changes from this plan. Apply any cleanup. Commit before proceeding to publish.

## Semantic distillation

The implementation spans 7+ files across providers, types, plugins, tools, validation, and server registration. A code review before publish catches quality issues, naming inconsistencies, missing error handling, and type-safety gaps that the audit script's structural checks do not cover.

Files in scope for review (all files mutated by this plan):
- `packages/ai/agent-mcp-types/src/domain.ts`
- `packages/ai/agent-mcp/src/providers/types.ts`
- `packages/ai/agent-mcp/src/providers/openai.ts`
- `packages/ai/agent-mcp/src/providers/anthropic.ts`
- `packages/ai/agent-mcp-types/src/hooks.ts`
- `packages/ai/agent-mcp/src/engine/orchestrator.ts`
- `packages/ai/agent-mcp/src/db/schema.ts`
- `packages/ai/agent-mcp/drizzle/` (migration files)
- `packages/ai/agent-mcp/src/plugins/usage-plugin.ts`
- `packages/ai/agent-mcp/src/plugins/index.ts`
- `packages/ai/agent-mcp/src/index.ts`
- `packages/ai/agent-mcp/src/tools/usage.ts`
- `packages/ai/agent-mcp/src/tools/task.ts`
- `packages/ai/agent-mcp/src/validation/usage.ts`
- `packages/ai/agent-mcp/src/validation/task.ts`
- `packages/ai/agent-mcp/src/validation/index.ts`
- `packages/ai/agent-mcp/src/server.ts`

## Reservations

```text
read_only:  []
mutates:    [all files listed above — cleanup edits may touch any of them]
```

## Contract promise

**Modified:** any file above that has review findings addressed
**Added:** `docs/plan/usage-tracking/code-review-evidence.md` — log of findings and resolutions

**Deleted:** nothing (deletions require planner-class approval)

## Acceptance criteria

```bash
# [code-review.1] Build passes after any cleanup
cd /Users/nix/dev/node/adhd
npx nx build agent-mcp --skip-nx-cache 2>&1 | tail -3 | grep -iv 'error'

# [code-review.2] Tests pass after any cleanup
npx nx test agent-mcp 2>&1 | tail -5 | grep -q 'pass\|PASS'

# [code-review.3] Review evidence file exists
test -f docs/plan/usage-tracking/code-review-evidence.md

# [code-review.4] Evidence file records completion
grep -q 'REVIEW_COMPLETE' docs/plan/usage-tracking/code-review-evidence.md
```

## Commit points

**R1 (plan write):** Plan file edits committed.

**R2 (cleanup):** After applying review findings, commit each fix:
```
fix(agent-mcp): code-review cleanup — <brief description>
```

**R3 (evidence):** After all cleanup:
```
chore(agent-mcp): code-review-evidence.md — all findings addressed
```

## Notes

Dispatch the code reviewer via the `code-reviewer` subagent type. Provide the list of changed files as context. The reviewer should focus on:
- Type safety and optionality correctness (especially `usage?: TokenUsage` propagation)
- Error handling in `UsagePlugin` handlers (must not throw — see `[inv:plugin-no-throw]`)
- SQL/drizzle query correctness in `buildTaskUsageReport`
- The `root_task_id` resolution walk (bounded recursion, handles null parent)
- Server.ts registration completeness (all 4 required points for `task_usage` tool)

Write `code-review-evidence.md` with this structure:
```markdown
# Code Review Evidence

Date: <ISO-8601>
Reviewer: code-reviewer (subagent)

## Findings

| # | File | Finding | Resolution | Status |
|---|------|---------|------------|--------|
| 1 | ... | ... | ... | fixed/accepted |

## Summary

<total findings>, <fixed>, <accepted as-is>

REVIEW_COMPLETE
```
