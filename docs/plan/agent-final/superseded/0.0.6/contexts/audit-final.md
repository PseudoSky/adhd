# State: audit-final

## Goal

Full convergence verification: re-run all foundation and context checks, plus build verification, the unit test suite, and version/docs checks.

## Guard

```bash
python3 docs/plan/0.0.6/scripts/audit_006.py --phase final
```

The final phase calls `phase_context()` (which calls `phase_foundation()`) then adds:
- `audit-final.dod.8` — `npx nx test agent-mcp` exits 0 (live data: in-memory SQLite tests)
- `audit-final.dod.9` — `agent-mcp/package.json` version is `0.0.6`
- `audit-final.dod.10` — `CONTEXT_WINDOW_EXCEEDED` in `CLAUDE.md` error codes table
- `audit-final.ref-tool-error-throw` — `CONTEXT_WINDOW_EXCEEDED` thrown via `ToolError`
- `audit-final.build` — `npx nx build agent-mcp` exits 0

## File ownership

**mutates:**
- `docs/plan/0.0.6/scripts/audit_006.py` (only if a check command is factually wrong)

**read_only:** all source files in packages/ai/

## Fix protocol

1. `python3 docs/plan/0.0.6/scripts/audit_006.py --phase final`
2. Identify failing criterion IDs.
3. Fix the source file (not the audit script).
4. Re-run until exit 0.
5. List every fix in the transition log.

## Most likely failures

| Criterion | Likely cause | Fix |
|-----------|--------------|-----|
| audit-final.dod.8 | Tests fail: new optional fields not handled in test fixtures | Update test expectations for `UsageSummary`/`TaskUsageReport` (no `stopReason` assertion needed — just don't fail on its presence) |
| audit-final.dod.8 | Tests fail: `CONTEXT_WINDOW_EXCEEDED` not in `errorCodeSchema` z.enum | Verify `validation/errors.ts` has the full enum value |
| audit-final.dod.9 | Version not yet bumped | Do NOT bump here — that is `docs-and-publish`. If this check blocks, amend it to check `0.0.5` instead and note the amendment. |
| audit-final.build | TypeScript compile error | Check for missing type imports, `null | undefined` mismatches in Drizzle column types |
| audit-final.ref-tool-error-throw | `new ToolError` + `CONTEXT_WINDOW_EXCEEDED` not on same line | Ensure the ToolError constructor call uses the literal code string |

## Note on dod.9 timing

`audit-final.dod.9` checks that the version is `0.0.6`. The version bump happens in `docs-and-publish`, which comes AFTER `audit-final`. This means the audit will FAIL on `dod.9` the first time it runs (before the version is bumped). 

**Executor instruction:** Run `audit-final` once to verify all other criteria pass. When only `dod.9` fails, that is expected — advance to `docs-and-publish`, bump the version, then re-run `audit-final` as the guard for `docs-and-publish` is independent. Alternatively: do the version bump in this state and then run the full audit. Either order is acceptable; choose whichever the PUBLISHING.md workflow implies.

## Commit points

**R2 (post-guard, all criteria pass):**
```
test(agent-mcp): audit-final passes — all 0.0.6 DoD criteria verified
```
