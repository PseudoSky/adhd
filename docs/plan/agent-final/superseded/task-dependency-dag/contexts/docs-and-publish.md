# docs-and-publish

**Phase:** convergence · **Depends on:** audit-final · **Guard:**
```bash
node -e "const p=require('./packages/ai/agent-mcp/package.json'); process.exit(p.version==='0.2.0'?0:1)" && \
npm view @agent-mcp/server@0.2.0 version 2>/dev/null | grep -q '0.2.0'
```

---

## Goal

Bump `agent-mcp` to 0.2.0, build, publish to npm, and update ROADMAP.md to mark #23 and #14
as shipped.

---

## Semantic Distillation

- **Primitive:** Follow PUBLISHING.md workflow for agent-mcp version bump + publish.

- **Version bumps:**
  - `packages/ai/agent-mcp/package.json`: `0.1.0` → `0.2.0`
  - `agent-mcp-types`: **already bumped** by `task-schema-foundation`. Do not bump here.

- **Changelog / ROADMAP:** Mark ROADMAP.md issues #23 (task dependency DAG) and #14 (task
  chaining) as shipped in 0.2.0.

- **Steps** (see PUBLISHING.md for authoritative workflow):
  1. `cd packages/ai/agent-mcp && npm version minor` (or manual bump to 0.2.0)
  2. `npx nx build agent-mcp`
  3. Smoke-test: start server locally, create two tasks where task B depends on task A.
     Verify B starts in `waiting` status, transitions to `running` after A completes.
  4. `npm publish --access public` from `dist/packages/ai/agent-mcp/`
  5. Update ROADMAP.md.

---

## Acceptance criteria

- [ ] `packages/ai/agent-mcp/package.json` version = `0.2.0`.
- [ ] npm registry shows `@agent-mcp/server@0.2.0` (or whichever the published name is).
- [ ] ROADMAP.md marks #23 and #14 as shipped.

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
      `chore(agent-mcp): bump to 0.2.0`

---

## Notes

- The published package name is confirmed by checking `packages/ai/agent-mcp/package.json`'s
  `name` field before running `npm publish`.
- Do NOT bump agent-mcp-types unless `TaskStatus` is exported from it — check
  `packages/ai/agent-mcp-types/src/index.ts` first.
- Smoke-test the `on_upstream_failure` paths too: create a failing upstream and verify downstream
  is marked failed (default) or dispatched (skip).
