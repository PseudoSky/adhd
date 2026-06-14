# docs-and-publish

**Phase:** convergence · **Depends on:** audit-final · **Guard:**
```bash
node -e "const p=require('./packages/ai/agent-mcp/package.json');process.exit(p.version==='0.1.5'?0:1)" && \
npm info @adhd/agent-mcp version 2>/dev/null | grep -q '0.1.5'
```

---

## Goal

Bump `agent-mcp` to `0.1.5`, bump `agent-mcp-types`, publish both. Update `ROADMAP.md` to mark
this foundation plan as shipped and note the parallel dispatch model it enables.

---

## Semantic Distillation

- **Primitive:** version bump + publish + ROADMAP note.

- **Steps:**
  1. Bump `packages/ai/agent-mcp/package.json` → `"version": "0.1.5"`
  2. Bump `packages/ai/agent-mcp-types/package.json` (patch or minor — `TaskStatus` gained new values)
  3. `npx --yes nx build agent-mcp agent-mcp-types` — verify clean build
  4. `cd packages/ai/agent-mcp && npm publish --access public`
  5. `cd packages/ai/agent-mcp-types && npm publish --access public`
  6. Update `ROADMAP.md`:
     - Add entry for `0.1.5: task-schema-foundation` noting columns and status values
     - Note the parallel dispatch model: "0.2.0 (dag) ║ 0.1.0 (parallel) → merge → 0.3.0 (hitl) → 0.4.0 (stream)"

- **Downstream awareness note (for ROADMAP.md):**
  ```markdown
  ### 0.1.5 — task-schema-foundation (prerequisite)
  Adds `depends_on`, `on_upstream_failure`, `inputs`, `resume_token` columns and
  `"waiting"`, `"awaiting_input"` status values. Prerequisite for 0.2.0 and 0.3.0.
  After this lands, 0.2.0 (task-dependency-dag) and 0.1.0 (parallel-tool-execution)
  may execute in parallel — they touch disjoint files.
  ```

---

## Reservations

```text
read_only:  []
mutates:    ["packages/ai/agent-mcp/package.json",
             "packages/ai/agent-mcp-types/package.json",
             "ROADMAP.md"]
```

---

## Contract Promise

- **Modified:** `agent-mcp/package.json` version → `"0.1.5"`
- **Modified:** `agent-mcp-types/package.json` version bumped
- **Modified:** `ROADMAP.md` — foundation plan entry + parallel dispatch model noted

---

## Commit points

- [ ] **After version bumps + publish** (mandatory):
      `chore(agent-mcp): bump to 0.1.5 — task-schema-foundation`

---

## Notes

- Follow the full publish checklist in `PUBLISHING.md`.
- The `agent-mcp-types` version bump is required because `TaskStatus` changed (callers who depend on the type union need to pull the new version to use `"waiting"` / `"awaiting_input"` without `as any` casts).
- After this plan publishes, the corpus index must be updated: `node scripts/plan-index.js docs/plan --update docs/plan/task-schema-foundation`.
