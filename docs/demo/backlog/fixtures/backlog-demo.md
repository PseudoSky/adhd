# Backlog Interface v2 — Demo Fixture (canonical dataset, §2.2)

Seed target: `backlog admin --action import --store tmp/backlog-demo --file
docs/demo/backlog/fixtures/backlog-demo.md` (DEMO.md §2.4).

> The v2 import file format is not pinned by the specs (⟦U12⟧ in UNRESOLVED.md). This
> fixture uses a plausible metadata-directive convention so the demo's data is exact and
> re-importable; the implementer confirms the real syntax against the import action.

---

## Repo: adhd  (aliases: PseudoSky/adhd)  (project: core-platform)

### PLAN-001 — EPIC — Interface v2 rollout
- status: OPEN  priority: HIGH  author: researcher  reporter: researcher
- criteria: yes  citations: yes

### BUG-1 — BUG — nx build fails after fastify bump
- status: IN_PROGRESS  priority: HIGH  author: researcher:a1b2c3  reporter: researcher:a1b2c3
- repo: adhd  project-path: packages/workspace  plan: PLAN-001  claimed-by: maya
- files: packages/workspace/workspace-codegen-nx/src/generators/executor.ts
- depends-on: FEAT-1  criteria: yes  citations: yes
- updated-at: 2026-08-06T09:12:00Z

### BUG-2 — BUG — sign-in button unresponsive on rate-limit page
- status: OPEN  priority: HIGH  author: researcher:x9y8z7  reporter: researcher:x9y8z7
- repo: adhd  project-path: packages/ui-react
- files: packages/ui-react/ui-react-base-storybook/src/stories/rate-limit.stories.tsx
- dupe-hits: 2  criteria: no  citations: no

### BUG-3 — BUG — storybook mcp bridge times out
- status: OPEN  priority: MEDIUM  author: ops  reporter: ops
- repo: PseudoSky/adhd  project-path: packages/ui-react
- criteria: no  citations: no

### BUG-8 — BUG — auth flow hangs under throttled requests
- status: OPEN  priority: MEDIUM  author: researcher  reporter: researcher
- repo: adhd  project-path: packages/ui-react
- criteria: no  citations: no

### FEAT-1 — FEAT — apigen java javalin plugin slice 2/3
- status: OPEN  priority: MEDIUM  author: researcher:a1b2c3  reporter: researcher:a1b2c3
- repo: adhd  project-path: packages/apigen/apigen-plugin-java-javalin  plan: PLAN-001
- files: packages/apigen/apigen-plugin-java-javalin/src/extract.ts
- depends-on: BUG-4  criteria: yes  citations: yes

### TASK-1 — TASK — document 6-tool surface in SKILL.md
- status: DONE  priority: LOW  author: researcher  reporter: researcher
- repo: adhd  project-path: entrypoint/backlog  plan: PLAN-001
- files: entrypoint/backlog/skill/SKILL.md
- criteria: yes  citations: yes  updated-at: 2026-08-06T15:04:00Z

### TASK-2 — TASK — shell completion for enum flags
- status: OPEN  priority: LOW  author: researcher  reporter: researcher
- repo: adhd  project-path: entrypoint/backlog  plan: PLAN-001
- files: entrypoint/backlog/src/cli.ts
- criteria: no  citations: no  updated-at: 2026-07-30T10:00:00Z

---

## Repo: sox-ecosystem  (project: sox-platform)

### BUG-4 — BUG — embedding server OOM on batch
- status: OPEN  priority: HIGH  author: researcher:x9y8z7  reporter: researcher:x9y8z7
- repo: sox-ecosystem  project-path: extensions/bundles/sox-embedding-bundle
- files: extensions/bundles/sox-embedding-bundle/members/embedding-server/backend.ts
- depends-on: BUG-5  criteria: yes  citations: yes  updated-at: 2026-08-07T15:40:00Z

### BUG-5 — BUG — turso adapter offset ignored
- status: OPEN  priority: HIGH  author: researcher  reporter: researcher
- repo: sox-ecosystem  project-path: packages/sox-store-adapter
- criteria: no  citations: no

### BUG-6 — BUG — memory server crash on embed batch
- status: OPEN  priority: MEDIUM  author: anna  reporter: anna
- repo: sox-ecosystem  project-path: packages/sox-memory-core
- files: packages/sox-memory-core/src/host.ts, packages/sox-memory-core/src/embed-pipeline.ts
- criteria: no  citations: no  created-at: 2026-06-08  (last transition 2026-06-20 — outside the demo's summary window)

### BUG-9 — BUG — sign-in button unresponsive on rate-limit page (dupe of BUG-2)
- status: OPEN  priority: MEDIUM  author: researcher  reporter: researcher
- repo: sox-ecosystem  project-path: extensions/bundles/sox-web-console
- criteria: no  citations: no

### FEAT-2 — FEAT — port apigen host to memory-server
- status: OPEN  priority: MEDIUM  author: researcher  reporter: researcher
- repo: sox-ecosystem  project-path: packages/sox-memory-core
- files: packages/sox-memory-core/src/host.ts
- criteria: yes  citations: no

---

## Repos with no items (ambiguity fixture, DEMO.md §2.4)
- agent-tools/embedding-server  (project: tools)
- sox/embedding-server  (project: tools)

---

## Audit events (referenced by DEMO.md §5.1 summary and §4.1 plan delta)
- TASK-1: OPEN → IN_PROGRESS @ 2026-07-28T09:00:00Z; IN_PROGRESS → DONE @ 2026-08-06T15:04:00Z
- BUG-1: claim by maya @ 2026-08-06T09:12:00Z; OPEN → IN_PROGRESS @ 2026-08-06T09:14:00Z
- BUG-4: claim by researcher:x9y8z7 @ 2026-08-07T15:40:00Z
- BUG-6: OPEN → IN_PROGRESS @ 2026-06-15; IN_PROGRESS → OPEN @ 2026-06-20 (outside window)
