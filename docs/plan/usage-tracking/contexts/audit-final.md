# State: audit-final

**Phase:** convergence  
**Kind:** audit  
**Depends on:** usage-query-tool

## Goal

Verify the complete end-to-end implementation: token signal, hook payload, database schema, plugin behavior, and MCP tool exposure. Update GAPS.md.

## Audit script invocation

```bash
cd /Users/nix/dev/node/adhd
python3 docs/plan/usage-tracking/scripts/audit_usage_tracking.py --phase final
```

Exit 0 = all checks pass. Non-zero = failure count.

## Checks run (final phase — all prior + new)

### Foundation checks (re-run from audit-foundation)
**[provider-token-signal.1–5]** TokenUsage in types, openai/anthropic return usage, tests pass  
**[hook-token-payload.1–4]** PostModelResponsePayload.tokenUsage, orchestrator passes it, build clean  

### Plugin checks
**[usage-schema.1–5]** taskUsageTable defined, migration exists, journal updated, build clean  
**[usage-plugin.1–10]** Plugin exists, implements Plugin, registered in index.ts, handlers wired, barrel exported, UPSERT on post:model_response, root_task_id resolved, is_complete set, build/tests pass  
**[usage-query-tool.1–10,15–16]** `usage_query` tool in server.ts (all 4 registration points), `usage` guide renamed to `guide`, query supports root_task_id subtree + include_incomplete, INSTALL.md and README updated, build/tests pass  

### Conformance checks (`[ref:*]`)
**[audit-final.ref-provider-response]** `ProviderChatResponse.usage` is optional — grep for `usage?` in providers/types.ts; must be guarded  
**[audit-final.ref-hook-payload-optional]** `PostModelResponsePayload.tokenUsage` has `?` — grep for `tokenUsage?` in hooks.ts  
**[audit-final.ref-plugin-interface]** `UsagePlugin implements Plugin` and `install()` has no un-caught throw  
**[audit-final.ref-drizzle-migration]** Migration file generated (not hand-written) — check it contains `CREATE TABLE`  
**[audit-final.ref-server-tool-pattern]** `usage_query` appears in all 4 server.ts locations; `guide` tool registered  

### MCP response body checks (`[dod.2]`)
**[audit-final.dod2.schema]** `taskToolOutputSchema` in `validation/task.ts` has optional `usage` field referencing `TaskUsageReport` shape (`direct`, `subtree`, `taskCount`)  
**[audit-final.dod2.result]** `resultTool()` in `tools/task.ts` calls `buildTaskUsageReport` and includes `usage` in its return  
**[audit-final.dod2.task]** Sync `taskTool()` path (session mode) and `runEphemeralTask()` both call `buildTaskUsageReport` and include `usage` in their return values  
**[audit-final.dod2.helper]** `buildTaskUsageReport` in `tools/usage.ts` queries both `direct` (task_id = ?) and `subtree` (task_id = ? OR root_task_id = ?) rows

### Negative checks
**[audit-final.neg.1]** No raw `prompt_tokens` / `completion_tokens` in providers (mapped away)  
**[audit-final.neg.2]** No duplicate `TokenUsage` definition — canonical source is `domain.ts` in agent-mcp-types  
**[audit-final.neg.3]** `INSTALL.md` includes `usage_query` in permissions.allow list and `guide` replaces the old `usage` entry  
**[audit-final.claudecli.1]** `UsagePlugin` guards against undefined `tokenUsage` (claudecli returns `undefined` — must not throw)  

### Live data check (optional — requires LM Studio)
**[audit-final.live]** If `LMSTUDIO_BASE_URL` is set, run a task against the built server and verify a row appears in `task_usage`. Script prints SKIPPED if env var absent — this is acceptable; all other checks must still pass.

## No deferrable items

Every check except `audit-final.live` (when LM Studio is unavailable) must pass. Fix source, rebuild, re-run. Do not weaken checks.

Note: GAPS.md, ROADMAP.md, INSTALL.md, and README.md documentation updates (`[dod.6]`) are verified in the `docs-and-publish` state — after code review and before publish. The audit-final script does not re-check them. `[dod.7]` (code review), `[dod.8]` (npm publish), and `[dod.9]` (zero-knowledge acceptance) are also release-phase responsibilities with their own guards.

## Commit points

**R1:** Script updates committed.

**R2:** After audit exits 0, commit GAPS.md update and state.json:
```
chore(agent-mcp): audit-final passed; mark usage tracking implemented in GAPS.md
```

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/usage-tracking/scripts/audit_usage_tracking.py"]
```

Note: `state.json` is also updated each state via the execution protocol (R1/R2) but is excluded from the formal artifacts list since every state implicitly updates it.
