# docs-and-publish

**Phase:** convergence · **Depends on:** audit-final · **Guard:**
```bash
node -e "const p=require('./packages/ai/agent-mcp/package.json'); process.exit(p.version==='0.3.0'?0:1)" && \
npm view @agent-mcp/server@0.3.0 version 2>/dev/null | grep -q '0.3.0'
```

---

## Goal

Bump `agent-mcp` to 0.3.0, build, publish to npm, and update ROADMAP.md to mark #20 as shipped.

---

## Semantic Distillation

- **Primitive:** Follow PUBLISHING.md workflow.

- **Version bumps:**
  - `packages/ai/agent-mcp/package.json`: `0.2.0` → `0.3.0`
  - `agent-mcp-types`: bump only if `TaskStatus` is exported and gained `"awaiting_input"`.

- **Smoke test:** Start server. Create a task with an agent that calls `request_human_input`.
  Verify:
  1. Task transitions to `awaiting_input` in DB.
  2. `task_resume` with correct token transitions task back to `running`.
  3. Agent receives `userInput` as tool result and continues.
  4. Wrong token returns `VALIDATION_ERROR`.

- **ROADMAP:** Mark #20 (HITL interrupts) as shipped in 0.3.0.

---

## Acceptance criteria

- [ ] `packages/ai/agent-mcp/package.json` version = `0.3.0`.
- [ ] npm registry shows `0.3.0`.
- [ ] ROADMAP.md marks #20 as shipped.

---

## Reservations

```text
read_only:  ["PUBLISHING.md", "ROADMAP.md"]
mutates:    ["packages/ai/agent-mcp/package.json",
             "ROADMAP.md",
             "packages/ai/agent-mcp-types/package.json"]
```

---

## Commit points

- [ ] **After version bump** (mandatory):
      `chore(agent-mcp): bump to 0.3.0`
