# DEMO — store-move

> The plan is done when this sequence works exactly as described. Every string is literal
> and diffable; ⟨…⟩ varies per run with the invariant stated beside it. ⟦U#⟧ marks a
> guessed interface, logged in [`UNRESOLVED.md`](./UNRESOLVED.md) — resolve before trusting
> that step. Gate on **exit codes**, never grep'd stdout (AGENTS.md §7).

## Setup

```bash
cd /Users/nix/dev/node/adhd
npx nx run-many -t build -p agent-store-runtime,agent-engine-orchestrator,agent-mcp
export DEMO_DB=tmp/agent-mcp/store-move-demo.db && rm -f "$DEMO_DB"*
# .mcp.json already points agent-mcp at dist/entrypoint/agent-mcp/src/index.js — /mcp reload
```

## The Run

### 1 · The bomb, demonstrated before it is defused   (negative control first)

```bash
# On the PRE-move schema (baseline commit), ask drizzle what it thinks is missing:
npx drizzle-kit generate --config entrypoint/agent-mcp/drizzle.config.ts ⟦U1⟧
```

```
⟨drizzle-kit⟩  sessions: foreign key "agent_name" present in database, absent in schema
  → generated: 0010_⟨name⟩.sql   ← rebuilds `sessions` WITHOUT the FK
```

**Proves:** the regression is real, not theoretical — drizzle-kit *wants* to undo 0009,
by the same mechanism that produced 0007. This artifact is discarded, never committed.

### 2 · The fold

```
agents table        entrypoint/agent-mcp/src/db/schema.ts:3-9      → packages/agent/agent-store-runtime/src/db/schema.ts
AgentStore impl     entrypoint/agent-mcp/src/store/agent-store.ts  → packages/agent/agent-store-runtime/src/store/agent-store.ts
sessions.agentName  text("agent_name").notNull()                   → .notNull().references(() => agentsTable.name, { onDelete: "cascade" })
composed_prompts    agent-store-runtime schema.ts:99-115           → DELETED (zero consumers — asserted in beat 6)
host store file     entrypoint/agent-mcp/src/store/agent-store.ts  → DELETED; imports repoint to @adhd/agent-store-runtime
```

```bash
npx nx run-many -t build,test -p agent-store-runtime,agent-engine-orchestrator,agent-mcp; echo "EXIT=$?"
```

```
EXIT=0        ← agent-mcp's suite passes UNMODIFIED — the business rules moved intact
```

### 3 · The disarm proof — drizzle has nothing left to say

```bash
npx drizzle-kit generate --config entrypoint/agent-mcp/drizzle.config.ts ⟦U1⟧
```

```
No schema changes, nothing to migrate 😴
```

**Proves:** schema now agrees with the DB 0009 built. The class of bug that produced 0007
is structurally gone — there is no cross-package FK for drizzle-kit to be blind to.
✅ No file `entrypoint/agent-mcp/drizzle/0010_*.sql` exists after this beat.

### 4 · The cascade, driven through the real loaded tools

Host-loaded `mcp__agent-mcp__*` (never store imports — the tool surface is the consumer seam):

```
▸ agent_create {name:"demo-fold", provider:{type:"claudecli"...}}     → ✅ created
▸ agent      {agent_name:"demo-fold"}                                 → session ⟨s1⟩ open
▸ agent_delete {name:"demo-fold"}
    → ❌ ToolError AGENT_HAS_ACTIVE_SESSIONS                          ← rule survived the move
▸ session_close {session_id:⟨s1⟩}
▸ agent_delete {name:"demo-fold"}                                     → ✅ deleted
▸ sqlite3 $DEMO_DB "SELECT COUNT(*) FROM sessions WHERE agent_name='demo-fold'"
    → 0                                                               ← CASCADE fired; zero orphans
```

**Negative control:** on a checkout with 0009 reverted (FK absent), the same sequence
leaves count = ⟨≥1⟩ — the assertion has teeth.

### 5 · Same store, importable — the separability payoff

```bash
npx tsx -e 'import {AgentStore} from "@adhd/agent-store-runtime";
            /* construct against $DEMO_DB, read demo agents, print count */' ⟦U2⟧
```

```
agents: ⟨n⟩     ← a NON-host consumer just used the runtime agent store
```

**Proves:** the orchestrator's `agentCrud` interface (`agent-crud.ts:9-15`) now has an
importable implementation — the precondition the client-factory plan builds on.

### 6 · Nothing left behind

```bash
grep -rn "composedPromptsTable" packages entrypoint --include="*.ts" | grep -v agent-store-prompts | wc -l   # → 0
test ! -f entrypoint/agent-mcp/src/store/agent-store.ts && echo HOST-STORE-GONE                              # → HOST-STORE-GONE
grep -c "agentsTable" entrypoint/agent-mcp/src/db/schema.ts                                                  # → 0
```

## What Proves It's Done

1. `npx nx run-many -t build,test -p agent-store-runtime,agent-engine-orchestrator,agent-mcp`
   exits 0 **with agent-mcp's existing tests unmodified** — behavior preservation is proven
   by the old suite, not by new tests written to match new behavior.
2. `drizzle-kit generate` after the fold emits **no migration**; before the fold it emits
   an FK-dropping one (beat 1 vs beat 3 — the armed/disarmed pair).
3. Through real loaded `mcp__agent-mcp__*` tools: `agent_delete` with an open session
   throws `AGENT_HAS_ACTIVE_SESSIONS`; after `session_close` + `agent_delete`, orphaned
   `sessions` rows for that agent = **0**; with 0009 reverted the same run leaves ≥1
   (negative control).
4. `entrypoint/agent-mcp/src/store/agent-store.ts` does not exist; the host's schema
   declares no `agents` table; the 15-tool list from `server.ts` is byte-identical.
5. The `composed_prompts` twin is gone from `agent-store-runtime` and repo-wide grep for
   its symbol outside `agent-store-prompts` returns 0.
6. Every ⟦U#⟧ in `UNRESOLVED.md` is resolved or risk-accepted.

> PASS only if every item is literally true. Items passing today: **none** — plan unbuilt.
