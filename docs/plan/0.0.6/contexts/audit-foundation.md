# State: audit-foundation

## Goal

Verify that all Gap #6 work (types, providers, schema, plugin, report) meets its acceptance criteria. No new source code is written in this state — only verification and fixes.

## Guard

```bash
python3 docs/plan/0.0.6/scripts/audit_006.py --phase foundation
```

The script is pre-written by the planner at `docs/plan/0.0.6/scripts/audit_006.py`. Do not edit it unless a check command is factually wrong (wrong path, wrong grep pattern). If a check fails because the source is wrong, fix the source.

## File ownership

**mutates:**
- `docs/plan/0.0.6/scripts/audit_006.py` (only if a check command itself is incorrect — record any such change in the amendment_log)

**read_only:** all source files in packages/ai/

## Fix protocol

1. Run the audit script to identify which criterion IDs fail.
2. Fix the relevant source file (not the audit script).
3. Re-run: `python3 docs/plan/0.0.6/scripts/audit_006.py --phase foundation`
4. Repeat until exit 0.
5. List every fix in the transition log entry for this state.

## Most likely failures

| Criterion | Likely cause | Fix |
|-----------|--------------|-----|
| stop-reason-types.2 | `maxTokens` grep matches ProviderConfig not TokenUsage | Check the TokenUsage interface block specifically |
| stop-reason-types.4 | Build fails with TypeScript errors | Check for missing imports or type mismatches |
| provider-stop-reason.3 | `stop_reason` grep misses the Anthropic SDK field | Ensure `response.stop_reason` is bound before the return |
| schema-migration.4 | Newest migration file not found | Verify drizzle-kit generate ran successfully |
| usage-plugin-stop.3 | Severity map uses different variable name | Ensure `SEVERITY`, `severity`, `mostSevere`, or `most_severe` appears |

## Commit points

**R2 (post-guard):**
```
test(agent-mcp): audit-foundation passes — Gap #6 implementation complete
```
