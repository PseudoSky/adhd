# docs-and-publish

**Phase:** convergence · **Depends on:** audit-final · **Guard:**
```bash
node -e "const p=require('./packages/ai/agent-mcp/package.json'); process.exit(p.version==='0.4.0'?0:1)" && \
npm view @agent-mcp/server@0.4.0 version 2>/dev/null | grep -q '0.4.0'
```

---

## Goal

Bump `agent-mcp` to 0.4.0, build, publish to npm, and update ROADMAP.md to mark #30 as shipped.

---

## Semantic Distillation

- **Primitive:** Follow PUBLISHING.md workflow.

- **Version bumps:**
  - `packages/ai/agent-mcp/package.json`: `0.3.0` → `0.4.0`

- **Smoke test:** Start server. Create a task with `stream: true`. Verify:
  1. Response includes `stream_url`.
  2. `curl -N <stream_url>` shows SSE events: `status_change`, `token`*, `done`.
  3. Connection closes after `done`.
  4. Keep-alive pings visible (`: ping`) every 15 seconds for long tasks.

- **ROADMAP:** Mark #30 (SSE streaming) as shipped in 0.4.0.

---

## Acceptance criteria

- [ ] `packages/ai/agent-mcp/package.json` version = `0.4.0`.
- [ ] npm registry shows `0.4.0`.
- [ ] ROADMAP.md marks #30 as shipped.

---

## Reservations

```text
read_only:  ["PUBLISHING.md", "ROADMAP.md"]
mutates:    ["packages/ai/agent-mcp/package.json",
             "ROADMAP.md"]
```

---

## Commit points

- [ ] **After version bump** (mandatory):
      `chore(agent-mcp): bump to 0.4.0`
