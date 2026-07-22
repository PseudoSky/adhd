# docs-and-publish

**Phase:** convergence · **Depends on:** audit-final
**Guard:**
```bash
node -e "const p=require('./packages/ai/agent-mcp/package.json');process.exit(p.version==='0.1.0'?0:1)" && \
npm info @adhd/agent-mcp version 2>/dev/null | grep -q '0.1.0'
```

---

## Goal

Bump `agent-mcp` to `0.1.0`. Document parallel tool execution in `CLAUDE.md` and `README.md`.
Publish to npm following `PUBLISHING.md`.

---

## Semantic Distillation

- **Primitive:** MODIFY `package.json` (version bump) + MODIFY `CLAUDE.md`/`README.md` (document
  parallel tool execution behavior).

- **Delta Spec:**

  1. `packages/ai/agent-mcp/package.json`: `"version": "0.0.9"` → `"0.1.0"`

  2. `CLAUDE.md` — add to "Key design decisions" section:
     > **Parallel tool execution.** When the model returns multiple tool calls in a single
     > response, the orchestrator executes them concurrently via `Promise.all`. Policy checks
     > (including `MAX_TOOL_LOOPS_EXCEEDED`) still fire for each call before dispatch. A single
     > tool failure surfaces as `isError: true` in its result slot; the other calls in the batch
     > are not interrupted. Fatal policy violations (`MAX_DEPTH_EXCEEDED`,
     > `MAX_TOOL_LOOPS_EXCEEDED`, `DELEGATION_NOT_ALLOWED`) abort the entire batch.

  3. `README.md` — note parallel execution in the tool call section.

  4. Follow `PUBLISHING.md` exactly for the pre-publish smoke test, MCP reload, and `npm publish`.

---

## Acceptance criteria

- [ ] **[docs-and-publish.1]** `package.json` version is `0.1.0`
- [ ] **[docs-and-publish.2]** `npm info @adhd/agent-mcp version` returns `0.1.0`

---

## Reservations

```text
read_only:  []
mutates:    [
  "packages/ai/agent-mcp/package.json",
  "packages/ai/agent-mcp/CLAUDE.md",
  "packages/ai/agent-mcp/README.md"
]
```

---

## Commit points

- [ ] **After version bump + doc update** (mandatory):
      `chore(agent-mcp): bump to 0.1.0 — parallel tool execution`

---

## Notes

- `agent-mcp-types` does NOT need a version bump — no types changed in this plan.
- Pre-publish checklist from `PUBLISHING.md` is mandatory: build → MCP reload → smoke test → publish.
