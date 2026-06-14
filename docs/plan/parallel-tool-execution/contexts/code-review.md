# code-review

**Phase:** convergence · **Depends on:** audit-foundation
**Guard:** `test -f docs/plan/parallel-tool-execution/.code-review-complete`

---

## Goal

Human hold point between implementation and `audit-final`. The executor pauses here; the
human reviewer inspects the diff, confirms correctness, and creates a sentinel file to unblock
the plan.

---

## For the reviewer: what to check

```bash
# Full diff of orchestrator changes
git diff main...HEAD -- packages/ai/agent-mcp/src/engine/orchestrator.ts
git diff main...HEAD -- packages/ai/agent-mcp/src/__tests__/orchestrator.test.ts

# Run foundation audit
python3 docs/plan/parallel-tool-execution/scripts/audit_parallel.py --phase foundation
```

Review checklist:

- [ ] `Promise.all` pattern present; sequential `for (const toolCall of toolCalls)` absent
- [ ] `toolCallCount++` appears in the serial pre-dispatch loop, before `policy.check()`
- [ ] `toolCallId: toolCall.id` used in result messages (not index, not generated ID)
- [ ] Non-fatal tool errors set `isError = true` and continue (no re-throw)
- [ ] Fatal policy codes (`MAX_DEPTH_EXCEEDED`, `MAX_TOOL_LOOPS_EXCEEDED`, `DELEGATION_NOT_ALLOWED`) still re-throw
- [ ] Tool results appended in the original `toolCalls` order after `Promise.all` resolves
- [ ] New test(s) in `orchestrator.test.ts` cover parallel dispatch and one-fails-rest-continue
- [ ] All tests pass: `npx nx test agent-mcp`

## After reviewing

```bash
touch docs/plan/parallel-tool-execution/.code-review-complete
```

Do NOT create the sentinel if you find issues. Fix the source, re-run the audit, then create it.

---

## Reservations

```text
read_only:  ["packages/ai/agent-mcp/src/"]
mutates:    ["docs/plan/parallel-tool-execution/.code-review-complete"]
```

## Acceptance criteria

- [ ] **[code-review.1]** `docs/plan/parallel-tool-execution/.code-review-complete` exists.
