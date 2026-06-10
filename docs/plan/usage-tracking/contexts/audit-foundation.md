# State: audit-foundation

**Phase:** foundation  
**Kind:** audit  
**Depends on:** provider-token-signal, hook-token-payload

## Goal

Verify that the token signal and hook payload changes are correct, complete, and type-safe before any database or plugin work begins.

## Audit script invocation

```bash
cd /Users/nix/dev/node/adhd
python3 docs/plan/usage-tracking/scripts/audit_usage_tracking.py --phase foundation
```

Exit 0 = all checks pass. Non-zero = failure count.

## Checks run (foundation phase)

Each check maps to an acceptance criterion ID from prior states. The script runs these and prints failures with file+line detail.

**[provider-token-signal.1]** `TokenUsage` exported from compiled agent-mcp-types  
**[provider-token-signal.2]** `ProviderChatResponse.usage?: TokenUsage` in compiled types  
**[provider-token-signal.3]** openai.ts returns `inputTokens` in usage  
**[provider-token-signal.4]** anthropic.ts returns `inputTokens` in usage  
**[provider-token-signal.5]** All 49 tests pass (or current count — check `npx nx test agent-mcp` baseline)

**[hook-token-payload.1]** `PostModelResponsePayload.tokenUsage?: TokenUsage` in compiled types  
**[hook-token-payload.2]** Orchestrator emit includes `tokenUsage: providerResponse.usage`  
**[hook-token-payload.3]** TypeScript build exits 0  
**[hook-token-payload.4]** All tests still pass

**[audit-foundation.neg.1]** No raw `prompt_tokens` or `completion_tokens` reference left in providers (they should have been mapped to `inputTokens`/`outputTokens`)  
**[audit-foundation.neg.2]** No duplicate `TokenUsage` definition — it must exist in exactly one source file

## No deferrable items

All checks must pass before this state is marked complete. If a check fails, fix the source file, re-run the test suite, and re-run the audit script. Do not weaken a check to make it pass.

## Commit points

**R1:** Audit script creation committed (one commit, message: `chore(agent-mcp): add usage-tracking audit script phase=foundation`).

**R2:** After audit exits 0, update `state.json` and commit:
```
chore(agent-mcp): audit-foundation passed
```

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/usage-tracking/scripts/audit_usage_tracking.py"]
```

Note: `state.json` is also updated each state via the execution protocol (R1/R2) but is excluded from the formal artifacts list since every state implicitly updates it.
