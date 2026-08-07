# stream-task-tool

**Phase:** engine · **Depends on:** stream-orchestrator · **Guard:**
```bash
grep -q 'stream_url' packages/ai/agent-mcp/src/tools/task.ts && \
grep -q 'stream' packages/ai/agent-mcp/src/validation/task.ts && \
npx nx test agent-mcp 2>&1 | grep -qE 'passed'
```

---

## Goal

Add `stream?: boolean` to the task tool input schema. When `stream: true`, include `stream_url`
in the task creation response so clients know where to connect for SSE events.

---

## Semantic Distillation

- **Primitive:** MODIFY `validation/task.ts` and `tools/task.ts`.

- **Delta Spec:**

  **`validation/task.ts`** — add to both `sessionModeSchema` and `ephemeralModeSchema`:
  ```typescript
  stream: z.boolean().optional(),
  ```

  **`tools/task.ts`** — in the task creation handler, after `taskStore.create()`:
  ```typescript
  const ssePort = process.env["SSE_PORT"] ?? "3001";
  const sseBaseUrl = process.env["SSE_BASE_URL"] ?? `http://localhost:${ssePort}`;

  const response: Record<string, unknown> = {
      taskId: task.id,
      status: task.status,
  };

  if (input.stream) {
      response["stream_url"] = `${sseBaseUrl}/tasks/${task.id}/stream`;
  }

  return response;
  ```

- **Invariants:** See `[def:StreamUrl]`, `[inv:no-schema-migration]`.

- **Validation:** grep for `stream_url` in tools/task.ts + `stream` in validation/task.ts; tests pass.

---

## Acceptance criteria

- [ ] **[stream-task-tool.1]** `stream` field in `taskToolInputSchema` (validation/task.ts).
      `grep -q '\bstream\b' packages/ai/agent-mcp/src/validation/task.ts`
- [ ] **[stream-task-tool.2]** `stream_url` in task creation response when stream=true.
      `grep -q 'stream_url' packages/ai/agent-mcp/src/tools/task.ts`
- [ ] **[stream-task-tool.3]** `SSE_BASE_URL` env var used for constructing the URL.
      `grep -q 'SSE_BASE_URL' packages/ai/agent-mcp/src/tools/task.ts`
- [ ] **[stream-task-tool.4]** `stream_url` NOT present when stream=false or omitted.
      (Verified by test, not by grep)
- [ ] **[stream-task-tool.5]** Tests pass.
      `npx nx test agent-mcp 2>&1 | grep -qE 'passed'`

---

## Reservations

```text
read_only:  ["packages/ai/agent-mcp/src/streaming/event-bus.ts",
             "packages/ai/agent-mcp/src/streaming/sse-server.ts",
             "packages/ai/agent-mcp/src/store/task-store.ts"]
mutates:    ["packages/ai/agent-mcp/src/validation/task.ts",
             "packages/ai/agent-mcp/src/tools/task.ts",
             "packages/ai/agent-mcp/src/__tests__/stream-task-tool.test.ts"]
```

---

## Contract Promise

- **Modified:** `validation/task.ts` — `stream?: boolean` in task tool input
- **Modified:** `tools/task.ts` — `stream_url` in response when `stream: true`

---

## Commit points

- [ ] **After task tool update + tests pass** (mandatory):
      `feat(agent-mcp): stream-task-tool — stream_url in task response for SSE clients`

---

## Notes

- `SSE_BASE_URL` env var is the correct hook for production deployments behind a reverse proxy
  where the external URL differs from `localhost:3001`.
- Tests should verify: (a) stream=true returns stream_url, (b) stream=false (or omitted) does
  NOT return stream_url, (c) stream_url format matches the expected pattern.
- No schema migration needed — `stream` is request-time only, not stored in DB.
