# State Machine: agent-mcp 0.0.6

## States

| Slug | Kind | Phase | Status |
|------|------|-------|--------|
| stop-reason-types | work | foundation | pending |
| provider-stop-reason | work | foundation | pending |
| schema-migration | work | foundation | pending |
| usage-plugin-stop | work | foundation | pending |
| usage-report-stop | work | foundation | pending |
| env-var-fixes | work | correctness | pending |
| cache-tokens | work | correctness | pending |
| provider-error-codes | work | correctness | pending |
| context-error-code | work | context | pending |
| sliding-window | work | context | pending |
| claudecli-auth-fix | work | context | pending |
| robustness-fixes | work | context | pending |
| audit-foundation | audit | convergence | pending |
| code-review | review | convergence | pending |
| audit-final | audit | convergence | pending |
| docs-and-publish | work | convergence | pending |

## Topology

```
[stop-reason-types]
        │
        ▼
[provider-stop-reason]
        │
        ▼
[schema-migration]
        │
        ▼
[usage-plugin-stop]
        │
        ▼
[usage-report-stop]
        │
        ▼
[env-var-fixes]
        │
        ▼
[cache-tokens]
        │
        ▼
[provider-error-codes]
        │
        ▼
[context-error-code]
        │
        ▼
[sliding-window]
        │
        ▼
[claudecli-auth-fix]
        │
        ▼
[robustness-fixes]
        │
        ▼
[audit-foundation]  ← automated audit: all implementation criteria
        │
        ▼
[code-review]  ← human hold point (creates .code-review-complete sentinel)
        │
        ▼
[audit-final]  ← automated audit: full convergence + tests + build
        │
        ▼
[docs-and-publish]
        │
        ▼
      DONE
```

## Phase summary

| Phase | States | Purpose |
|-------|--------|---------|
| foundation | stop-reason-types → provider-stop-reason → schema-migration → usage-plugin-stop → usage-report-stop | Gap #6: max_tokens + stop_reason tracking |
| correctness | env-var-fixes → cache-tokens → provider-error-codes | Env var name bugs, cache token forwarding, granular error codes |
| context | context-error-code → sliding-window → claudecli-auth-fix → robustness-fixes | Gap #7: CONTEXT_WINDOW_EXCEEDED + sliding window; claudecli auth fix; loop robustness |
| convergence | audit-foundation → code-review → audit-final → docs-and-publish | Full verification, human review, version bump + publish |

## Transitions

Each state transitions to the next by:
1. Completing the work described in its context file.
2. Running the guard command until it exits 0.
3. Updating state.json: set current state `done_ts` + `status: done`, advance `current_state`.
4. Committing with the message named in the context file's Commit points section.

For the `code-review` state: the executor pauses and waits for the human reviewer to create `docs/plan/0.0.6/.code-review-complete`.

## Rollback

Any state can be re-entered by setting its `status` back to `pending` in state.json and re-running its guard. Audit states failing means the work state must be fixed — the audit script is read-only.
