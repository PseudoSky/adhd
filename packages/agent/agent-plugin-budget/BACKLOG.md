### FEAT-001 — : Rate-limit tool calls (token-bucket / sliding-window)

**Status:** UNKNOWN

**Problem:** `maxCalls` on a tool is a hard cap (0 calls allowed, or N calls total lifetime). There is no per-time-window rate limiting — e.g. "at most 10 `web_search` calls per minute" or "at most 100 tool calls per hour".

**Desired behaviour:** Add a rate-limiting mode to the tool dimension config:

```json
{
  "tool": {
    "overrides": {
      "web_search": {
        "rate": { "calls": 10, "windowMs": 60000 }
      }
    }
  }
}
```

- Use a token-bucket or sliding-window algorithm per (taskId, toolName) key, stored in memory for the current task and in DB (`task_events`) for cross-task windows.
- When the rate is exceeded in `warning` mode, the tool call is blocked and a diagnostic is returned to the agent (existing `IToolWarning` path).
- When exceeded in `block` mode, the task fails with `BUDGET_EXCEEDED`.

**Status:** Planned — not started.

**Related:** Per-tool call counting is done inline in `enforcePreTool()` via `BudgetAccumulator.toolCalls` (a `Map<string, number>`). The rate-limiter can leverage this existing counter and the `task_usage` DB table.

---
