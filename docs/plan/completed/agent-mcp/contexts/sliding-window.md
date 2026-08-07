# State: sliding-window

## Goal

Add `windowMessages()` pure function to `session-store.ts`. Read `AGENT_MCP_CONTEXT_LIMIT` from the environment in the orchestrator. Apply windowing to `currentMessages` before each provider call when the limit is set.

## Semantic distillation

The orchestrator already maintains a `currentMessages` working copy. Before calling `provider.chat()`, if `AGENT_MCP_CONTEXT_LIMIT > 0`, replace the messages passed to `provider.chat()` with a windowed view that preserves system messages and drops oldest non-system messages. The DB messages are NOT deleted — the window is ephemeral and applied per-iteration. See [inv:window-messages] for the algorithm.

## File ownership

**mutates:**
- `packages/ai/agent-mcp/src/store/session-store.ts`
- `packages/ai/agent-mcp/src/engine/orchestrator.ts`

**read_only:**
- `packages/ai/agent-mcp/CLAUDE.md` (add env var row — see Commit points)

## Contract

**Added: `packages/ai/agent-mcp/src/store/session-store.ts`**

Add these two exported functions at the bottom of the file (after the `SessionStore` class):

```typescript
/**
 * Estimates the token count for a set of messages using a 4-chars-per-token heuristic.
 * This is intentionally conservative — real tokenisers vary; set AGENT_MCP_CONTEXT_LIMIT
 * at least 10% below the model's actual limit.
 */
export function estimateTokens(messages: Message[]): number {
  return Math.ceil(
    messages.reduce((sum, m) => {
      return (
        sum +
        (m.content?.length ?? 0) +
        (m.toolCalls ? JSON.stringify(m.toolCalls).length : 0) +
        (m.toolResults ? JSON.stringify(m.toolResults).length : 0)
      );
    }, 0) / 4
  );
}

/**
 * Returns a windowed view of messages that fits within tokenLimit estimated tokens.
 * System messages are always preserved. Oldest non-system messages are dropped first.
 * Returns the original array unchanged if tokenLimit <= 0 or the array already fits.
 *
 * See [inv:window-messages] in docs/plan/0.0.6/contexts/_shared.md.
 */
export function windowMessages(messages: Message[], tokenLimit: number): Message[] {
  if (tokenLimit <= 0) return messages;
  if (estimateTokens(messages) <= tokenLimit) return messages;

  const systemMessages = messages.filter(m => m.role === "system");
  const nonSystemMessages = messages.filter(m => m.role !== "system");

  const systemBudget = estimateTokens(systemMessages);
  const remaining = Math.max(0, tokenLimit - systemBudget);

  const selected: Message[] = [];
  let used = 0;

  // Walk newest-to-oldest; include until budget exhausted
  for (let i = nonSystemMessages.length - 1; i >= 0; i--) {
    const msg = nonSystemMessages[i];
    const cost = estimateTokens([msg]);
    if (used + cost > remaining && selected.length > 0) break;
    selected.unshift(msg);
    used += cost;
  }

  return [...systemMessages, ...selected];
}
```

**Modified: `packages/ai/agent-mcp/src/engine/orchestrator.ts`**

1. Import `windowMessages` at the top:
```typescript
import { windowMessages } from "../store/session-store.js";
```

2. At the top of the `run()` method, parse the env var:
```typescript
const contextLimit = parseInt(process.env["AGENT_MCP_CONTEXT_LIMIT"] ?? "0", 10);
```

3. Before the `provider.chat(...)` call, apply windowing:
```typescript
// Apply sliding-window truncation if AGENT_MCP_CONTEXT_LIMIT is set
const messagesToSend = contextLimit > 0
  ? windowMessages(currentMessages, contextLimit)
  : currentMessages;

// ... then call provider.chat({ messages: messagesToSend, ... }) instead of messages: currentMessages
```

**Modified: `packages/ai/agent-mcp/CLAUDE.md`**

Add a new row to the `## Environment variables` table:

```markdown
| `AGENT_MCP_CONTEXT_LIMIT` | `0` (disabled) | Estimated token limit for the message window passed to each provider call. When > 0, oldest non-system messages are dropped to fit. Set 10% below the model's actual context window. |
```

## Acceptance criteria

[sliding-window.1] `AGENT_MCP_CONTEXT_LIMIT` is read in `orchestrator.ts`

[sliding-window.2] `windowMessages` or `estimateTokens` function exists in `session-store.ts`

[sliding-window.3] `AGENT_MCP_CONTEXT_LIMIT` is documented in `packages/ai/agent-mcp/CLAUDE.md`

[sliding-window.4] `system` role is referenced in the window function (system messages preserved)

## Commit points

**Checkpoint:** after adding the functions to `session-store.ts`, before editing `orchestrator.ts` — commit the pure utility separately to keep the diff readable.

**R2 (post-guard):**
```
feat(agent-mcp): sliding-window truncation via AGENT_MCP_CONTEXT_LIMIT env var
```

## Notes

- `windowMessages` must NOT mutate the `messages` parameter. The `currentMessages` array in the orchestrator must remain complete — the orchestrator continues to append to it after the provider call.
- The function is exported from `session-store.ts` for organizational reasons (message management lives there) but does not use any `SessionStore` instance methods or DB access.
- The `for (let i = nonSystemMessages.length - 1; i >= 0; i--)` loop includes at least one message even if it alone exceeds the budget (`selected.length > 0` guard). This prevents the edge case of an empty non-system message list, which would make the provider call fail.
- `CLAUDE.md` update: the env table is in the `## Environment variables` section. Add the row in alphabetical order or at the end.
- After the guard passes, also update `README.md` (the env section there mirrors CLAUDE.md). This can wait for `docs-and-publish` state.
