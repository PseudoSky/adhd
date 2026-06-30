# Agent Interrupts — Structured Inter-Agent Messaging

## Current State

The existing HITL implementation in `@adhd/agent-mcp` provides a single-purpose
interrupt mechanism:

- A `builtin__request_human_input` tool, hardcoded to target a single recipient
  (the human operator), accepting only a free-text `prompt` string.
- The tool is only available on session-based tasks (forbidden for ephemeral
  tasks, which have no durable DB row for the resume token).
- Resumption uses `task_resume` with a `resumeToken` and free-text `userInput`.
- Suspended tasks carry status `awaiting_input` and the resume token is persisted
  to the tasks row.
- The in-memory resolver map (`hitlResolvers`) has no lifetime beyond the server
  process — restart orphans any suspended task.

This design treats agent→human as the only meaningful interrupt target. As
agent-mcp gains hierarchical team structures and recursive delegation, the same
pattern is needed for agent→parent, agent→orchestrator, and agent→peer
communication.

## Proposed Architecture

A structured messaging system where any agent can pause execution and wait for a
response from any target. The core abstraction is a typed message with options,
timeouts, and auto-resume semantics, replacing the single-purpose
`request_human_input` with a general message bus.

### Message Type

```
type MessageTarget = "human" | "parent" | "orchestrator" | "peer";
type MessageKind = "question" | "clarification" | "approval" | "error" | "status" | "decision";

interface StructuredMessage {
  id: string;
  target: MessageTarget;
  kind: MessageKind;
  prompt: string;
  options?: Array<{
    id: string;
    label: string;
    description?: string;
    severity?: "info" | "warn" | "error";
    suggested?: boolean;
  }>;
  default?: string;           // auto-resume with this option_id
  timeoutMs?: number;         // auto-resume after N ms
  context?: {
    from_agent: string;
    milestone?: string;
    operation?: string;
    task_id?: string;
    session_id?: string;
  };
  response?: {
    option_id?: string;
    text?: string;
    by: "human" | "parent" | "orchestrator" | "system";
    at: string;
  };
}
```

### New Tools (replacing builtin `request_human_input`)

- `send_message({target, kind, options, prompt, default, timeout, context})` —
  emits a `StructuredMessage` and suspends the sending task, awaiting a response.
  The existing `request_human_input` becomes a specific case of
  `send_message({target: "human", kind: "question", prompt: "..."})`.

- `poll_messages({from, status})` — check for pending messages from child
  agents or peers. Returns an array of `StructuredMessage` objects. Used by
  orchestrators and parent agents to discover outstanding interrupts.

- `respond_to_message({message_id, option_id, text})` — answer a pending
  message by selecting an option or providing free-text, triggering the
  sender's task to resume.

### Routing Logic

| target      | routed to            | behavior                                                              |
| :---------- | :------------------- | :-------------------------------------------------------------------- |
| human       | Human operator       | Task suspends with `awaiting_input`, surfaced via chat or UI gateway. |
| parent      | Calling agent        | Parent's delegation loop intercepts via `poll_messages`, presents as  |
|             |                      | a tool the parent agent can answer.                                   |
| orchestrator| Dispatch orchestrator| Orchestrator's message handler routes known patterns to auto-resolve, |
|             |                      | escalates unknown patterns upward.                                    |
| peer        | Named peer agent     | Direct to specific agent's message queue (requires peer agent ID in   |
|             |                      | the context or a peer registry).                                      |

### Implementation Impact

**New files:**

- `src/validation/message.ts` — Zod schemas for `StructuredMessage`,
  `MessageTarget`, `MessageKind`, and the `send_message`/`poll_messages`/
  `respond_to_message` tool inputs.
- `src/tools/messaging.ts` — tool handlers for the three new tools, managing a
  persistent message store.
- `src/store/message-store.ts` — message persistence (SQLite table for
  structured messages, indexed by target + status).

**Changes to existing files:**

- `src/engine/orchestrator.ts` — generalize the HITL intercept from a single
  hardcoded tool name to a dispatch table over message targets. The intercept
  checks whether the tool call matches `send_message` with `target: "human"`,
  `target: "parent"`, or `target: "peer"` and routes accordingly. The existing
  `hitlResolvers` map becomes a more general `suspendedTasks` registry keyed by
  message ID.
- `src/server.ts` — register the three new tools in the in-process descriptor
  list, handler switch, and tool listing.
- `src/validation/task.ts` — add a `pending_message_id` field to the task schema
  for tracking which message (if any) a task is suspended on.
- `src/store/task-store.ts` — persist and query the `pending_message_id` field.

The existing `request_human_input` tool can be deprecated in favor of
`send_message`, or kept as a backward-compatible alias that the orchestrator
rewrites internally.

### Hierarchical Team Structure

```
Human operator
  └── Root orchestrator agent
        │  handles: human questions, orchestrator-scope errors
        │  delegates via delegate_and_handle (which auto-handles child messages)
        ├── Client implementer
        │     send_message(target:parent, kind:clarification) → orchestrator answers
        │     send_message(target:human, kind:approval) → routes to human
        └── Optimizer implementer
              send_message(target:parent, kind:error) → orchestrator auto-resolves
```

In this structure, a child agent that needs clarification sends
`send_message({target: "parent", kind: "clarification"})`. The orchestrator's
delegation loop picks this up via `poll_messages`, presents it as a tool for
the orchestrator agent to answer, and on response, resumes the child.

A child that needs a human decision sends
`send_message({target: "human", kind: "approval"})`. The orchestrator routes
this directly to the human operator (the current HITL path), preserving the
existing UX.

### Relationship to Existing ROADMAP

This proposal extends ROADMAP feature #20 (HITL interrupts, Strategic 5.0,
TABLE STAKES, CORE) from a single-purpose interrupt to a general message bus.
The existing implementation (shipped in 1.0.0) provides the suspension/resume
infrastructure; this design generalizes the target, kind, and response shape
while maintaining the same CORE placement. The middleware architecture's
lifecycle hooks (`pre:tool_call`, `post:tool_call`) remain the integration
points for plugin-based message monitoring and audit logging.
