# Goal: store-move — fold `agents` + `AgentStore` into `agent-store-runtime`

> Plan 1 of the agent-final consolidation. Owner-decided 2026-07-16: **fold into
> `agent-store-runtime`** (not a new `agent-store-registry` package — the architecture
> doc's TARGET STATE diagram is overruled on this point; see `../INVALIDATIONS.md` I-13).

## Problem

1. **A schema regression is armed and on a timer.** The DB has the
   `sessions.agent_name → agents.name ON DELETE CASCADE` FK (restored by hand-written
   migration `entrypoint/agent-mcp/drizzle/0009_restore_sessions_agent_fk.sql`), but the
   drizzle schema does **not declare it** —
   `packages/agent/agent-store-runtime/src/db/schema.ts:14-15` is a bare
   `text("agent_name").notNull()` while sibling `messages.sessionId` (`:32-36`) shows the
   correct `.references()` pattern. 0009's own header explains why: the `agents` table
   lives in `entrypoint/agent-mcp` (`src/db/schema.ts:3-9`), a different package, so
   drizzle-kit cannot see the relationship. The next `drizzle-kit generate` diff can
   silently rebuild `sessions` without the FK — **exactly what migration 0007 already did
   once.** 0009 patched the symptom; the package boundary that caused it is still there.

2. **The runtime agent store is stranded in the host.** `AgentStore`
   (`entrypoint/agent-mcp/src/store/agent-store.ts:20-152`) is 152 lines of real
   persistence + business rules (`AGENT_ALREADY_EXISTS` :42, `AGENT_NOT_FOUND` :71,
   `AGENT_HAS_ACTIVE_SESSIONS` :131, version bump, patch-merge) that nothing outside the
   entrypoint can reuse. The orchestrator ships only the *interface*
   (`packages/agent/agent-engine-orchestrator/src/tools/agent-crud.ts` — `AgentStore`,
   `SessionStoreForCrud`); the sole implementation lives in the host. This is the one
   clear separability violation in the verified topology (SYNTHESIS §1.2) and the
   load-bearing half of the future client-factory move (arch doc §3b).

3. **A dead twin invites wrong writes.** `agent-store-runtime`'s schema also declares
   `composed_prompts` (`src/db/schema.ts:99-115`) — zero consumers, shadowing the live
   `registry_composed_prompts` in `agent-store-prompts`. Same file, same migration cycle:
   remove it while we are here (arch doc gap #2).

## Goal

- `agents` table + `AgentStore` (implementation and business rules, byte-for-byte
  behavior) live in `@adhd/agent-store-runtime`.
- `sessionsTable.agentName` declares
  `.references(() => agentsTable.name, { onDelete: "cascade" })` **in-file**.
- **The disarm proof:** after the move, `drizzle-kit generate` produces **no new
  migration** — the schema finally agrees with the DB that 0009 built. (Negative
  control: on the pre-move schema it wants to drop the FK.)
- `entrypoint/agent-mcp` imports `AgentStore` from the package; its local
  `src/store/agent-store.ts` and the `agents` table in `src/db/schema.ts` are deleted.
  The host thins; the 15-tool MCP surface (`server.ts:445-538`) is unchanged.
- The dead `composed_prompts` twin is gone from `agent-store-runtime`.

## Constraints

- **No wire-format change.** All 15 MCP tools keep names, arg shapes, and error codes.
  `AGENT_ALREADY_EXISTS` / `AGENT_NOT_FOUND` / `AGENT_HAS_ACTIVE_SESSIONS` behavior is
  preserved exactly — proven by the existing agent-mcp test suite passing unmodified.
- **Migrations stay in `entrypoint/agent-mcp`** — it owns the DB and already runs the
  journal for store-runtime's tables (0000–0009). Only the schema *declaration* moves.
- **Existing DBs need no new migration.** The fold makes code agree with the 0009 DB
  state; it must not touch the data. A fresh DB and a 0009-upgraded DB end bit-identical
  in `sessions`/`agents` DDL.
- Proof runs through the **real loaded MCP tools** (`mcp__agent-mcp__*` via `.mcp.json` →
  built dist), never by importing store internals — per AGENTS.md §7 "drive the real
  tools, never a bypass."
- No `git stash`, no `-A` staging, worktree under `.worktrees/` per repo convention
  (nx-ignore fix `0fd51e78` makes that safe now).

## Non-Goals

- **Not the client factory.** `createAgentEngineClient()` / host-becomes-transport is the
  next plan; this one only makes it possible (the store must be importable first).
- **Not the registry.** No `registry_agents`, no name↔slug seam, no authoring lane.
- **Not retrieval.** Nothing tagged rag/enrichment/graph/embedding/vector — owner ruling
  2026-07-16: those are sox-ecosystem improvements, consumed not reimplemented.
- **Not dispatch.** `ensureAgent`'s bare `agent_create` path is the seam plan's problem.
