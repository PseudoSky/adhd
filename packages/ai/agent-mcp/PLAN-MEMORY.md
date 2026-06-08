# agent-mcp Implementation Plan

## Status: READY — all blocking gaps resolved (Gap 1–17 reconciled below). Remaining notes are non-blocking version-resolution tasks; see "Notes for Implementer" at bottom.

---

## Context

### Package identity
- **Name:** `@adhd/agent-mcp`
- **Nx project name:** `agent-mcp` (NOT `ai-agent-mcp` — README and SPEC's quick-start say `nx build ai-agent-mcp`, but `project.json` registers it as `agent-mcp`. Implementer should use `npx nx build agent-mcp`. See Note A.)
- **Tags:** `layer:ai`, `platform:node`
- **TS path alias:** `@adhd/agent-mcp` → `./packages/ai/agent-mcp/src/index.ts` (already wired in `tsconfig.base.json`)
- **package.json scripts** currently reference `nx build agent-runtime` — wrong project name, must be fixed (see Note B).

### Build setup
- **Build executor:** `@nx/js:tsc` via `tsconfig.lib.json` → outputs to `dist/packages/ai/agent-mcp/`.
- **Module system:** ESM (`"type": "module"`) with TS `module: "ESNext"`, `moduleResolution: "Bundler"`, `target: "ES2022"`, `types: ["node"]`.
- **Test runner:** Vitest (configured in `vite.config.ts`, includes `src/**/*.{test,spec}.ts`, `environment: "node"`, globals enabled, `tsconfig.spec.json` references `vitest/globals`).
- **Note about vite vs tsc:** `vite.config.ts` declares a library build but the active executor is `@nx/js:tsc`. Vite is used only for tests. This is fine.
- **Lint:** Standard Nx `@nx/dependency-checks` (root `.eslintrc.base.json` extended).
- **`outputs` from build:** `dist/packages/ai/agent-mcp/` with `index.js` + `index.d.ts`. The SPEC's quick-start path `dist/index.js` is wrong — actual path is `dist/packages/ai/agent-mcp/index.js`. README/SPEC clarification needed (see Note C).

### Drizzle config
- `drizzle.config.js` exists and points to `./src/storage/schema.ts`, output `./drizzle`. Per the new SPEC §16, schema lives at `./src/db/schema.ts`. Update drizzle.config.js when moving schema.
- `dbCredentials.url` defaults to `./data/runtime.db`; SPEC defaults to `./data/agents.db`. Align with SPEC.
- No `./drizzle` migrations directory exists yet — `drizzle-kit generate` must be run as part of Step 2.

### Existing dependencies in package.json
Already declared:
- `@anthropic-ai/sdk@^0.24.0` (root has `0.96.0` — see Note D)
- `openai@^4.0.0` (root has `6.37.0`)
- `@modelcontextprotocol/sdk@^1.0.0` (root has `1.29.0`)
- `drizzle-orm@^0.33.0` (root has `0.45.2`)
- `better-sqlite3@^11.0.0` (root has `12.10.0`)

Missing from package.json `dependencies` but already in workspace root (just need to be declared):
- `pino@10.3.1`
- `p-queue@9.2.0`
- `zod@4.4.3`
- `uuid@14.0.0` (already used by `utils/ids.ts`)
- `dotenv@17.4.2` (already used by `drizzle.config.js`)

Missing from workspace root entirely (need `yarn add`):
- `p-retry` — root has `p-retry@4.6.2` as transitive only; promote to direct dep for SPEC §10.

Missing from `devDependencies` of agent-mcp's package.json (root has them):
- `drizzle-kit@^0.31.10`
- `@types/better-sqlite3@^7.6.13`
- `@types/uuid` (not in root — verify; uuid v14 ships its own types so likely OK)
- `vitest`, `vite`, `@vitest/ui`, `vite-plugin-dts` (root has them; Nx `@nx/dependency-checks` will demand explicit declaration)
- `pino-pretty` for dev (already in root)

### Existing source — file-by-file audit vs SPEC §17

| Existing file                              | SPEC §17 says           | Audit verdict                                                                                                                                                                                                                          |
| ------------------------------------------ | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `providers/anthropic.ts`                   | Keep                    | Confirmed correct. `server__tool` encoding present. Needs `signal?: AbortSignal` added to `chat()` per SPEC §10. Imports from `../types/index.js` will need rewrite when types are deleted in favor of `validation/*.ts` z.infer.       |
| `providers/openai.ts`                      | Keep                    | Confirmed. Same notes — add `signal`, retarget type imports.                                                                                                                                                                            |
| `providers/lmstudio.ts`                    | Keep                    | Confirmed. Trivial subclass.                                                                                                                                                                                                            |
| `providers/core/base.ts`                   | Keep, rename            | Confirmed. Move to `providers/types.ts`. Add optional `signal?: AbortSignal` to `ProviderChatRequest` per SPEC §10.                                                                                                                     |
| `providers/core/factory.ts`                | Keep                    | Confirmed. Exhaustive switch with `never` guard. Move to `providers/factory.ts`.                                                                                                                                                        |
| `validation/agents.ts`                     | Reference, migrate      | EXISTING SCHEMA DIVERGES FROM SPEC §5.1: it has `mcp.servers` array of references, `agentRuntimeConfigSchema`, and per-agent `maxRecursionDepth`/`maxToolCalls`/`maxExecutionMs`. SPEC §5.1 wants `mcpServers: Record<string, McpServerConfig>` (full embedded configs) plus `permissions.allowedAgents?: string[]` plus `maxToolLoops?: number` plus `version: number`. Rewrite needed. |
| `validation/mcp.ts`                        | Reference, migrate      | EXISTING uses `transport.type` discriminator nested under a `transport` field. SPEC §5.1 uses `transport` as the discriminator AT THE TOP LEVEL of the union (`{ transport: "stdio" } & McpStdioConfig`). Rewrite needed.               |
| `validation/tasks.ts`                      | (not mentioned)         | Existing covers `taskRequestSchema` allowing either `session_id` OR `agent`. SPEC §7.3 `task` only accepts `session_id` — agent-by-name path is gone. Rewrite to match SPEC.                                                            |
| `runtime/policyEngine.ts`                  | Refactor                | Existing uses depth + allowed/denied servers/tools. SPEC §9 wants depth + toolLoops + allowedAgents (per-agent override of server default). Full rewrite shaped by `PolicyCheckInput`. Tests TBD.                                       |
| `utils/ids.ts`                             | Keep                    | Confirmed: `uuidv4()` wrapper.                                                                                                                                                                                                          |
| `utils/timestamps.ts`                      | Keep                    | Confirmed.                                                                                                                                                                                                                              |
| `utils/logger.ts`                          | (not mentioned)         | EXISTING WRITES TO STDOUT (default pino destination) and uses `pino-pretty` transport. SPEC §13 mandates `pino({...}, process.stderr)` — stdout-write would corrupt MCP stdio framing. Rewrite to bind stderr destination.              |
| `storage/sqlite/db.ts`                     | Keep                    | Confirmed. Move to `db/client.ts` per SPEC §16.                                                                                                                                                                                         |
| `storage/schema.ts`                        | Adapt                   | Existing has all 5 tables but missing: `version` on agents, `agent_version`/`agent_data`/`status`/`closed_at` on sessions, `parent_task_id`/`recursion_depth`/`cancelled_at` on tasks, FK cascades, `mcp_servers` table needs removal. Rewrite. |
| `mcp/server.ts`                            | Discard                 | Confirmed: hand-rolled HTTP, not MCP-compliant.                                                                                                                                                                                         |
| `mcp/client.ts`                            | Discard                 | Confirmed: stdio throws, fetch-based, signature mismatch (`callTool(server, tool, args, request)` 4 args called with 1 arg in orchestrator).                                                                                            |
| `mcp/tools.ts`                             | (not mentioned)         | Stub file — discard.                                                                                                                                                                                                                    |
| `runtime/agentRegistry.ts`                 | Discard                 | Confirmed: in-memory, wrong AgentDefinition shape.                                                                                                                                                                                      |
| `runtime/sessionStore.ts`                  | Discard                 | Confirmed: file-based JSON.                                                                                                                                                                                                             |
| `runtime/toolExecutor.ts`                  | Discard                 | Confirmed: 4-arg `callTool` against 3-arg client = runtime crash. References `crypto.randomUUID` w/o import — TS-error in strict mode anyway.                                                                                            |
| `runtime/toolRegistry.ts`                  | (not mentioned)         | Not used by SPEC architecture; discard. Tool listing happens via `McpClientRegistry.listAllTools()`.                                                                                                                                     |
| `runtime/kernel/runtime.ts`                | Discard                 | Confirmed: sync only, imports `runtimeTools.js` that doesn't exist (already broken).                                                                                                                                                    |
| `runtime/kernel/orchestrator.ts`           | Discard                 | Confirmed.                                                                                                                                                                                                                              |
| `index.ts`                                 | Discard                 | Confirmed: imports `runtime/runtimeTools.js` which does not exist; will fail to start.                                                                                                                                                   |
| `types/agent.ts`                           | Discard                 | Empty file (0 bytes — file shorter than offset 1).                                                                                                                                                                                      |
| `types/execution.ts`                       | Replace                 | Replaced by `z.infer` on the new `validation/` schemas (per SPEC §5: "Zod schema IS the type"). Also missing `agentName`, `agentDefinition`, `callingAgentName` fields needed by SPEC §5.6.                                              |
| `types/index.ts`                           | Discard                 | Re-export hub. Replaced by per-validation-file exports.                                                                                                                                                                                  |
| `types/mcp.ts`                             | Discard                 | Diverges from SPEC §5.1 transport union shape.                                                                                                                                                                                          |
| `types/message.ts`                         | Discard                 | Replaced by `z.infer` on new `validation/message.ts` (or the consolidated session schema). Field names align (`toolCalls`, `toolResults`).                                                                                                |
| `types/session.ts`                         | Discard                 | Missing `status`, `agentVersion`, `closedAt`.                                                                                                                                                                                            |
| `types/task.ts`                            | Discard                 | Missing `parentTaskId`, `recursionDepth`, `cancelledAt`, `cancelled` status, `TASK_CANCELLED` event.                                                                                                                                     |
| `mcp/transports/`                          | (empty)                 | Discard the empty directory.                                                                                                                                                                                                            |
| `.env.example`                             | (not mentioned)         | Update to match SPEC §6 env var names: `DATABASE_PATH=./data/agents.db`, add `MAX_DEPTH`, `MAX_TOOL_LOOPS`, `ALLOWED_AGENTS`, `TRANSPORT`, `QUEUE_CONCURRENCY`. Drop `MCP_*` and `MAX_GLOBAL_*` legacy vars and `API_KEY`.                  |
| `drizzle.config.js`                        | (not mentioned)         | Update `schema:` path to `./src/db/schema.ts` and `dbCredentials.url` default to `./data/agents.db`.                                                                                                                                     |
| `package.json`                             | (not mentioned)         | Fix `scripts.build`/`dev` (currently `nx build agent-runtime` — should be `nx build agent-mcp`); add missing deps (pino, p-queue, p-retry, zod, uuid, dotenv) and devDeps (drizzle-kit, @types/better-sqlite3, vitest etc.). Replace `main` field — currently `./index.js`, should be `./dist/index.js` if package is consumed; for an entrypoint binary, also add `bin: { "agent-mcp": "./dist/index.js" }` (optional). |

---

## Dependency Graph

```
Step 0 (deps install) ──┐
                        ├──► Step 1 (validation/) ──┐
                        │                            │
Step 0 ─────────────────┘                            ▼
                                              Step 2 (db/schema, db/client, db/migrate)
                                                     │
                                                     ▼
                                              Step 3 (store/)
                                                     │
        ┌────────────────────────────────────────────┴───────────────┐
        ▼                                                            ▼
Step 4 (providers/)                                Step 5 (clients/) — depends on Step 1 only
        │                                                            │
        └────────────────────────┬───────────────────────────────────┘
                                 ▼
                          Step 6 (engine/policy.ts) — depends on Step 1
                                 │
                                 ▼
                          Step 7 (engine/orchestrator.ts) — depends on 3,4,5,6
                                 │
                                 ▼
                          Step 8 (background queue inside store/task-store.ts wiring)
                                 │
        ┌────────────────────────┼────────────────────────┐
        ▼                        ▼                        ▼
Step 9 (tools/agent-crud)  Step 10 (tools/session)  Step 11 (tools/task)
        └────────────────────────┬────────────────────────┘
                                 ▼
                          Step 12 (server.ts — MCP SDK wiring)
                                 │
                                 ▼
                          Step 13 (logger refactor — but logger should be created at Step 0.5; structured events are wired throughout)
                                 │
                                 ▼
                          Step 14 (index.ts entry point)
                                 │
                                 ▼
                          Step 15 (tests across all layers)
```

Logger (`logger.ts`) is touched in Step 13 conceptually but is created early (right after Step 0) because every other module imports it. Treat Step 13 as "audit that all modules use the logger correctly."

---

## Steps

### Step 0: Project hygiene & dependency install

- **Files:**
  - Modify `packages/ai/agent-mcp/package.json` — fix scripts, add deps
  - Modify `packages/ai/agent-mcp/.env.example` — align with SPEC §6
  - Modify `packages/ai/agent-mcp/drizzle.config.js` — repoint schema path
- **Keeps from existing:** none (config-only step)
- **Deps to install (yarn add at workspace root, then declare in package's package.json):**
  - dependencies: `pino@10.3.1`, `p-queue@9.2.0`, `p-retry@^6.2.0` (workspace currently has v4 transitively; v6+ recommended for native ESM + AbortSignal; **VERIFY VERSION** before bumping), `zod@4.4.3`, `uuid@14.0.0`, `dotenv@17.4.2`
  - dependencies (already in package, just version-bump to match root): `@anthropic-ai/sdk@0.96.0`, `openai@6.37.0`, `@modelcontextprotocol/sdk@1.29.0`, `drizzle-orm@0.45.2`, `better-sqlite3@12.10.0`
  - devDependencies: `drizzle-kit@^0.31.10`, `@types/better-sqlite3@^7.6.13`, `@types/uuid` if needed, `vitest@^1.6.0`, `vite@~5.0.13`, `@vitest/coverage-v8@^1.0.4`, `vite-plugin-dts@~3.8.3`, `pino-pretty@13.1.3`
- **Exports:** none
- **Tests:** none
- **Build check:** `npx nx lint agent-mcp` should pass `@nx/dependency-checks` (i.e., declared deps match imports).

### Step 1: Validation schemas (Zod source-of-truth)

> **Gap 11 — extension files:** This plan intentionally extends the SPEC §17 `validation/` listing with three additional files: `message.ts` (required by data model §5.3), `execution.ts` (required by data model §5.6), and `errors.ts` (required by tool-error contract §7). These are listed below alongside the SPEC-named files.

- **Files to create:**
  - `src/validation/mcp.ts` — `mcpStdioConfigSchema`, `mcpHttpConfigSchema`, `mcpSseConfigSchema`, `mcpServerConfigSchema` (discriminatedUnion on `transport`); export `McpServerConfig` via `z.infer`. SPEC §5.1.
  - `src/validation/agent.ts` — `retryConfigSchema`, `providerConfigSchema` (discriminatedUnion on `type` for anthropic|openai|lmstudio per SPEC §5.1), `agentPermissionsSchema`, `agentDefinitionSchema`, plus `agentCreateInputSchema = agentDefinitionSchema.omit({ version: true, createdAt: true, updatedAt: true })`, `agentUpdateInputSchema`, `agentReadInputSchema`, `agentDeleteInputSchema`. Export all types via `z.infer`.
  - `src/validation/session.ts` — `sessionStatusSchema = z.enum(["active","closed"])`, `sessionSchema`, plus tool input/output schemas: `agentInputSchema`, `agentOutputSchema`, `sessionListInputSchema`, `sessionCloseInputSchema`. SPEC §5.2 + §7.2.
  - `src/validation/message.ts` — `messageRoleSchema`, `toolCallSchema`, `toolResultSchema`, `messageSchema`. SPEC §5.3.
  - `src/validation/task.ts` — `taskStatusSchema`, `taskSchema`, `taskEventTypeSchema`, `taskEventSchema`, plus tool input/output schemas: `taskInputSchema`, `taskOutputSchema`, `taskListInputSchema`, `taskCancelInputSchema`, `resultInputSchema`. SPEC §5.4 + §5.5 + §7.3.
  - `src/validation/execution.ts` — `executionContextSchema` (or hand-typed since it carries a runtime `agentDefinition` and is never persisted). SPEC says all types are Zod-derived; if `agentDefinition` reuse forces Zod re-validation each time, this is fine — declare with `agentDefinitionSchema` reference. SPEC §5.6.
    - **Gap 6 — required fields with explicit semantics:**
      - `agentName: string` — the agent currently executing.
      - `agentDefinition: AgentDefinition` — the snapshotted `AgentDefinition` for the executing agent. **This IS what `PolicyEngine` uses as `callingAgent` in check #3 (`allowedAgents`).**
      - `callingAgentName?: string` — the agent that *spawned* this task (undefined for top-level tasks). Used for **logging only**, never for policy checks.
      - `sessionId: string`, `taskId: string`, `parentTaskId?: string`, `recursionDepth: number` — per SPEC §5.6.
      - **Gap 1 — `toolCallCount: number`** — starts at 0 at orchestrator entry; the orchestrator increments it after each tool call result is appended. `PolicyEngine` check #2 reads this value to enforce the toolLoops ceiling.
  - `src/validation/errors.ts` — `errorCodeSchema = z.enum([...])` per SPEC §7. Define `ToolError` type.
  - `src/validation/index.ts` — barrel export.
- **Files to delete:**
  - `src/validation/agents.ts` (replaced by `agent.ts` + `mcp.ts`)
  - `src/validation/mcp.ts` (rewrite, see above — same path, but full rewrite)
  - `src/validation/tasks.ts` (replaced by `task.ts`)
  - All of `src/types/` (agent.ts, execution.ts, index.ts, mcp.ts, message.ts, session.ts, task.ts) — replaced by `z.infer` exports from `validation/`.
- **Exports:** All Zod schemas + inferred types listed above.
- **Tests:** Per SPEC §18 step 15, no validation-specific tests required, but Vitest unit tests on each schema's `safeParse` are recommended.
- **Build check:** `npx nx typecheck agent-mcp` (no src code yet imports these; verifies schemas compile).

### Step 2: DB schema + client + migrate

- **Files to create:**
  - `src/db/schema.ts` — Drizzle table defs per SPEC §14. Five tables: `agents` (with `version` INTEGER NOT NULL DEFAULT 1), `sessions` (with `agent_version`, `agent_data`, `status` DEFAULT 'active', `closed_at`), `messages` (FK ON DELETE CASCADE), `tasks` (with `parent_task_id`, `recursion_depth` DEFAULT 0, `cancelled_at`, FK CASCADE), `task_events` (FK CASCADE).
  - `src/db/client.ts` — re-create from existing `storage/sqlite/db.ts`. Same content (better-sqlite3 + drizzle, WAL pragma, foreign_keys ON, mkdirSync for parent dir). Export `db`. Default `DATABASE_PATH` to `./data/agents.db`.
  - `src/db/migrate.ts` — calls `migrate(db, { migrationsFolder: "./drizzle" })` from `drizzle-orm/better-sqlite3/migrator`. Synchronous wrapper exposed as `runMigrations()`.
  - `drizzle/` (generated) — run `npx drizzle-kit generate` after schema is written; commit the SQL migration files.
- **Files to delete:**
  - `src/storage/schema.ts`
  - `src/storage/sqlite/db.ts`
  - Whole `src/storage/` directory.
- **Files to modify:**
  - `drizzle.config.js` — `schema: "./src/db/schema.ts"`, `dbCredentials.url` default `"./data/agents.db"`.
- **Deps to install:** drizzle-kit (Step 0).
- **Exports:** `db`, table objects (`agentsTable`, `sessionsTable`, `messagesTable`, `tasksTable`, `taskEventsTable`), `runMigrations`.
- **Tests:** None this step.
- **Build check:** `npx nx build agent-mcp` should compile. `npx drizzle-kit generate` should produce a `drizzle/0000_*.sql` file with all tables and FK constraints.

### Step 2.5: Logger (foundation — needed by every later step)

- **Files to create:** `src/logger.ts`
- **Content:** `import pino from "pino"; export const logger = pino({ level: process.env.LOG_LEVEL ?? "info", base: undefined }, pino.destination(2));` — explicitly bind to fd 2 (stderr). No `pino-pretty` in production path.
- **Files to delete:** `src/utils/logger.ts` (after migration).
- **Exports:** `logger`.
- **Tests:** trivial smoke (logger.info doesn't throw). Vitest test asserting destination is fd 2 by writing `process.stderr.write` mock.
- **Build check:** typecheck.

### Step 3: Store layer

- **Files to create:**
  - `src/store/agent-store.ts` — class `AgentStore` with `create(input)`, `read(name)`, `update(name, patch)` (auto-bump version), `delete(name)` (rejects if active sessions exist for this agent), `list()`. Persists `AgentDefinition` JSON in `agents.data`.
  - `src/store/session-store.ts` — class `SessionStore` with `create({ agentName, agentDefinition })` (snapshots `agentVersion` and `agentData`), `read(id)`, `list({ agentName?, status? })`, `close(id)`, `appendMessage(sessionId, message)`, `getMessages(sessionId)`.
    - **Gap 4 — `agentData` is storage-only:** the `Session` Zod type does **NOT** include `agentData`. Instead, `SessionStore` exposes a separate method `getAgentDefinition(sessionId): AgentDefinition` which reads the `agent_data` column and rehydrates via `agentDefinitionSchema.parse(...)`. Callers (notably `tools/task.ts`) use this method to load the snapshotted definition before constructing `ExecutionContext`. The standard `read(id)` returns the public `Session` shape (without `agentData`).
  - `src/store/task-store.ts` — class `TaskStore` with `create({ sessionId, parentTaskId?, recursionDepth })`, `updateStatus(id, status, fields?)` (sets `completedAt`/`cancelledAt` as appropriate), `read(id)`, `list({ sessionId?, status? })`, `appendEvent({ taskId, type, payload })`.
    - **Gap 5 — cancellation methods (in-memory):** `TaskStore` owns a `Map<string, AbortController>` and exposes:
      - `registerCancellation(taskId: string, controller: AbortController): void` — store mapping.
      - `unregisterCancellation(taskId: string): void` — remove mapping. Called by the orchestrator's `finally` (see Gap 3).
      - `cancel(taskId: string): void` — looks up the registered controller (if any) and calls `controller.abort()`, **then** calls `this.updateStatus(taskId, "cancelled", { cancelledAt: now() })`.
    - **Gap 16 — `TaskStore` does NOT depend on `BackgroundQueue`:** the queue lives in `engine/queue.ts` (Step 8) and is injected into `tools/task.ts` (Step 11) at wire-up time in `index.ts`. `TaskStore`'s constructor takes only `db` and (optionally) `logger`. It does not import or know about `BackgroundQueue`.
  - `src/store/index.ts` — barrel.
- **Files to delete:** none (already deleted in earlier steps).
- **Exports:** `AgentStore`, `SessionStore`, `TaskStore`.
- **Dependencies:** `db/client`, `db/schema`, validation schemas, `utils/ids`, `utils/timestamps`, `logger`.
- **Tests:** Integration tests using `:memory:` SQLite for each store: agent CRUD round-trip, session create/snapshot/list/close, task create/update/event-append, FK cascade verification (deleting session deletes messages + tasks + task_events).
- **Build check:** `npx nx build agent-mcp` + `npx nx test agent-mcp -- store`.

### Step 4: Provider layer

- **Files to create:**
  - `src/providers/types.ts` — copy from `providers/core/base.ts` and add `signal?: AbortSignal` to `ProviderChatRequest`. Re-export `LLMProvider`, `ProviderChatRequest`, `ProviderChatResponse`, plus `ToolDefinition` (per SPEC §10).
  - `src/providers/factory.ts` — copy from `providers/core/factory.ts`. Update import paths.
  - `src/providers/anthropic.ts` — keep file but: (a) update type imports (no more `../types/index.js`; use `validation/agent.ts` for `ProviderConfig` and `validation/message.ts` for `Message`/`ToolCall`/`ToolDefinition`); (b) add `signal` plumbing to `client.messages.create({ ..., signal: request.signal })`; (c) wrap `chat()` in `pRetry()` using the agent-level `retryConfig` passed in via constructor. (d) Use `Message` type instead of `RuntimeMessage`.
    - **Gap 8 — signal source:** the `signal` passed in to `chat()` is **already composed** by the orchestrator (cancellation + provider timeout). Providers must NOT reapply timeouts of their own. `ProviderConfig.timeoutMs` is consumed at the orchestrator boundary (Step 7), not inside the provider.
  - `src/providers/openai.ts` — same treatment.
  - `src/providers/lmstudio.ts` — same treatment.
  - `src/providers/index.ts` — barrel.
- **Files to delete:** `src/providers/core/` (after migration).
- **Exports:** `LLMProvider`, `ProviderChatRequest`, `ProviderChatResponse`, `ToolDefinition`, `createProvider`, `AnthropicProvider`, `OpenAIProvider`, `LMStudioProvider`.
- **Deps:** `p-retry`.
- **Tests:** Provider chat() unit tests with mocked SDK clients (verify tool-encoding round-trip `server__tool`, AbortSignal pass-through, retry behavior).
- **Build check:** `npx nx build agent-mcp` + `npx nx test agent-mcp -- providers`.

### Step 5: MCP client layer

- **Files to create:**
  - `src/clients/types.ts` — `IMcpClient` interface per SPEC §11.
  - `src/clients/in-process.ts` — `InProcessMcpClient` implementing `IMcpClient`. Constructor receives the runtime tool-handler set (the same handlers wired into the MCP server in Step 12). `listTools()` returns `agent`, `task`, `result`, etc. as `ToolDefinition[]`. `callTool(tool, args)` dispatches directly to handlers, threading `ExecutionContext` via a `currentContext` AsyncLocalStorage or constructor param. Critical: this client is what makes recursive delegation work without a real network round-trip.
  - `src/clients/stdio-client.ts` — wraps `StdioClientTransport` from `@modelcontextprotocol/sdk/client/stdio`. Spawns child, calls `connect()`, exposes `listTools()` + `callTool()` via `Client` from `@modelcontextprotocol/sdk/client`. Tracks child PID for `close()` (SIGTERM → SIGKILL after 5s).
    - **Gap 10 — child exit log:** when spawning the child process, attach `childProcess.on("exit", (code, signal) => logger.warn({ server: serverName, exitCode: code, signal }, "Child process exit"))`. This is the only required structured log event for this layer.
  - `src/clients/http-client.ts` — `HttpMcpClient` (uses `StreamableHTTPClientTransport`) and `SseMcpClient` (uses `SSEClientTransport`). Honor `timeoutMs` via `AbortSignal.timeout()`. **Note:** `McpServerConfig.timeoutMs` here governs MCP **client** calls; this is fully independent from `ProviderConfig.timeoutMs` which governs LLM API calls (see Gap 8 in Step 4).
  - `src/clients/registry.ts` — `McpClientRegistry`. Constructor: `(mcpServers, selfUrl, inProcessHandler)`. Self-ref detection per SPEC §11: key `"agent-mcp"` OR matching `selfUrl`. `getClient(name)`, `listAllTools()`, `closeAll()`.
    - **Gap 12 — stdio self-ref:** when `TRANSPORT=stdio`, `selfUrl` is `undefined`. Condition 2 (URL match) is therefore skipped. Only condition 1 (`key === "agent-mcp"`) applies. The constructor must accept `selfUrl?: string` and tolerate the undefined branch without throwing.
    - **Gap 15 — lifetime is per-task:** the registry is **created in `tools/task.ts` (Step 11) at the start of each `task()` call** and **closed in `Orchestrator.run()`'s `finally` block** (Step 7). It is **not** session-scoped, server-scoped, or singleton. Each `task()` invocation gets a fresh registry with fresh child processes / connections.
  - `src/clients/index.ts` — barrel.
- **Exports:** All client classes + `IMcpClient` + `McpClientRegistry`.
- **Deps:** `@modelcontextprotocol/sdk`.
- **Tests:** McpClientRegistry self-ref detection unit tests (mock servers map). InProcessMcpClient round-trip with mock handlers.
- **Build check:** `npx nx build agent-mcp` + `npx nx test agent-mcp -- clients`.

### Step 6: Policy engine

- **Files to create:** `src/engine/policy.ts`
- **Files to delete:** `src/runtime/policyEngine.ts` (after migration).
- **Content:** `class PolicyEngine` per SPEC §9. Constructor takes `PolicyConfig` (server-level ceilings + default allowlist). Method `check(input: PolicyCheckInput): void` — throws `ToolError` with appropriate `ErrorCode` on failure. Implements the three checks in SPEC order:
  1. **Depth check** — reads `executionContext.recursionDepth` against `min(callingAgent.maxRecursionDepth ?? serverMaxDepth, serverMaxDepth)`.
  2. **toolLoops check (Gap 1):** reads `executionContext.toolCallCount` against `min(callingAgent.maxToolLoops ?? serverMaxToolLoops, serverMaxToolLoops)`. The orchestrator (Step 7) is responsible for incrementing `toolCallCount` after each tool result; the policy engine only **reads** the field.
  3. **allowedAgents check** — applies only when `targetTool` is `agent-mcp__agent`. Uses `callingAgent.permissions.allowedAgents ?? serverAllowedAgents`. The `callingAgent` value passed in is `executionContext.agentDefinition` (Gap 6).
- **Exports:** `PolicyEngine`, `PolicyConfig`, `PolicyCheckInput`.
- **Tests:** Comprehensive unit tests per SPEC §18 step 15. Cover: depth at exactly the boundary, toolLoops boundary, agent definition `allowedAgents: undefined` → fall through to server default, agent `allowedAgents: []` → block all, target ∈ allowlist, target ∉ allowlist, server allowlist `undefined` AND agent allowlist `undefined` → unrestricted.
- **Build check:** `npx nx build agent-mcp` + `npx nx test agent-mcp -- policy`.

### Step 7: Orchestrator

- **Files to create:** `src/engine/orchestrator.ts`
- **Files to delete:** `src/runtime/kernel/orchestrator.ts`, `src/runtime/kernel/runtime.ts`, `src/runtime/kernel/`, `src/runtime/toolExecutor.ts`, `src/runtime/toolRegistry.ts`, `src/runtime/agentRegistry.ts`, `src/runtime/sessionStore.ts`, `src/runtime/` (whole directory).
- **Content:** `class Orchestrator` with `run({ executionContext, messages, registry, provider, policy, taskStore, sessionStore, signal, taskId }): Promise<{ result: string }>`.
  - **Wrap entire body in try/finally (Gap 3):**
    ```ts
    try {
      // … loop body below …
    } finally {
      await registry.closeAll();
      taskStore.unregisterCancellation(taskId);
    }
    ```
    This guarantees registry teardown and cancellation-map cleanup on success, failure, AND cancellation. Per Gap 15, the registry's lifetime equals one `task()` call; closing it here is the canonical teardown point.
  - Tool-use loop up to `min(agent.maxToolLoops ?? serverMaxToolLoops, serverMaxToolLoops)`.
  - **Signal composition (Gap 8):** at the top of each loop iteration build `const composedSignal = AbortSignal.any([signal, AbortSignal.timeout(executionContext.agentDefinition.provider.timeoutMs ?? 60_000)])` and pass it to `provider.chat({ ..., signal: composedSignal })`. The outer `signal` is the orchestrator's per-task cancellation signal (registered with `TaskStore.registerCancellation` upstream in `tools/task.ts`). `MCPServerConfig.timeoutMs` is unrelated and is consumed by the MCP client layer.
  - Each iteration: check `signal.aborted` (cancellation) → throw `TaskCancelled`; emit `MODEL_REQUEST` event → `provider.chat({ messages, tools: registry.listAllTools(), signal: composedSignal })` → emit `MODEL_RESPONSE`. If `stopReason === "completed"` break. Otherwise per `tool_call`: `policy.check({ executionContext, targetTool, targetAgent? })` → emit `TOOL_CALL` → `registry.getClient(server).callTool(tool, args)` → emit `TOOL_RESULT`. Append the `tool` role message to `currentMessages` and persist via `sessionStore.appendMessage`. **Then increment `executionContext.toolCallCount++` (Gap 1)** so the next policy check sees the updated count.
  - On exit: persist final assistant message, return `{ result: assistantMessage.content }`.
- **Exports:** `Orchestrator`.
- **Deps:** validation, providers, clients/registry, engine/policy, store, logger, utils.
- **Tests:** Unit tests with mock provider + mock McpClientRegistry: success path, depth-exceeded, toolLoops-exceeded, mid-loop cancellation, provider error after retries → `PROVIDER_ERROR`, MCP client error → `MCP_CLIENT_ERROR`.
- **Build check:** `npx nx build agent-mcp` + `npx nx test agent-mcp -- orchestrator`.

### Step 8: Background queue (`p-queue` integration)

- **Files to create/modify:**
  - `src/engine/queue.ts` — wraps `PQueue` with `concurrency: parseInt(process.env.QUEUE_CONCURRENCY ?? "5")`. Exposes `enqueue(taskId, runFn)`. Persists final `Task` row via injected `TaskStore`.
  - Modify `src/store/task-store.ts` — accept queue instance; expose `enqueue(taskId, runFn)` passthrough.
- **Exports:** `BackgroundQueue`.
- **Deps:** `p-queue`.
- **Tests:** Queue concurrency-limit test (10 tasks, concurrency=2, observe ≤2 in-flight).
- **Build check:** `npx nx build agent-mcp` + `npx nx test agent-mcp -- queue`.

### Step 9: Agent CRUD tools

- **Files to create:** `src/tools/agent-crud.ts`
- **Content:** Five handler functions (not classes): `agentCreate(input, deps)`, `agentRead(input, deps)`, `agentUpdate(input, deps)`, `agentDelete(input, deps)`, `agentList(input, deps)`. Each validates input via Zod schema, calls the relevant `AgentStore` method, catches store-level errors and re-throws as `ToolError` with the right `ErrorCode`.
- **Deps:** `AgentStore`, validation schemas, logger.
- **Tests:** Unit tests against in-memory `AgentStore`; verify `AGENT_ALREADY_EXISTS`, `AGENT_NOT_FOUND`, immutability of `name`/`createdAt`, version-bump on update, refusal-to-delete with active sessions.
- **Build check:** `npx nx build agent-mcp` + `npx nx test agent-mcp -- agent-crud`.

### Step 10: Session tools

- **Files to create:** `src/tools/session.ts`
- **Content:** `agent({ name }, deps)` → snapshots agent, creates Session row, returns `{ session_id }`. Inside-task path requires `executionContext` (from in-process client) → run policy `allowedAgents` check. `sessionList({ agentName?, status? }, deps)`. `sessionClose({ session_id }, deps)`.
  - **Gap 9 — `AGENT_DELEGATION` log:** when `agent()` is called from within a running task context (i.e., `executionContext` is defined), emit `logger.info({ taskId: ctx.taskId, targetAgent: name, newDepth: ctx.recursionDepth + 1 }, "AGENT_DELEGATION")` immediately before returning the `session_id`. This is the only log event owned by this file.
- **Deps:** `AgentStore`, `SessionStore`, `PolicyEngine`, validation, logger.
- **Tests:** Snapshot integrity (subsequent agent updates do not affect open sessions), `DELEGATION_NOT_ALLOWED` when called from within a task.
  - **Gap 7 — explicit error-code coverage required in this file:**
    - `SESSION_NOT_FOUND` — `sessionList`/`sessionClose` invoked with an unknown `session_id`.
    - `SESSION_CLOSED` — `sessionClose` invoked on an already-closed session (and, indirectly via `task()` in Step 11, when `task()` is invoked on a closed session).
    - `DELEGATION_NOT_ALLOWED` — `agent()` invoked from within a task context where the target is not in the calling agent's `allowedAgents` (per-agent override) nor in the server default allowlist.
- **Build check:** `npx nx build agent-mcp` + `npx nx test agent-mcp -- session-tools`.

### Step 11: Task tools

- **Files to create:** `src/tools/task.ts`
- **Content:**
  - `task({ session_id, prompt, background }, deps)` — `background: false` runs synchronously (await `Orchestrator.run`); `background: true` enqueues onto `BackgroundQueue` and returns immediately.
    - **Gap 17 — explicit `task()` flow (mandatory order):**
      1. Validate `session_id` exists and `status === "active"` (else throw `SESSION_NOT_FOUND` / `SESSION_CLOSED`).
      2. Call `sessionStore.getAgentDefinition(sessionId)` (Gap 4) to load the snapshotted `AgentDefinition`. **Do not** read `agentData` off the public `Session` shape — that field is intentionally absent from the Zod type.
      3. Create the `Task` row via `taskStore.create({ sessionId, parentTaskId: ctx?.taskId, recursionDepth: (ctx?.recursionDepth ?? -1) + 1 })`.
      4. Build `ExecutionContext` with all SPEC §5.6 fields, including `toolCallCount: 0` (Gap 1) and `agentDefinition` from step 2.
      5. `const controller = new AbortController();`
      6. `taskStore.registerCancellation(task.id, controller)` (Gap 5).
      7. Build `provider` via `createProvider(agentDefinition.provider)`.
      8. Build `registry = new McpClientRegistry(agentDefinition.mcpServers, selfUrl, inProcessHandler)` (per-task lifetime — Gap 15).
      9. Call `Orchestrator.run({ executionContext, messages, registry, provider, policy, taskStore, sessionStore, signal: controller.signal, taskId: task.id })`. The orchestrator's `finally` block (Gap 3) handles `registry.closeAll()` and `taskStore.unregisterCancellation(task.id)`.
  - `taskList({ session_id?, status? }, deps)`.
  - `taskCancel({ task_id }, deps)` — must validate `task_id` exists (else `TASK_NOT_FOUND`) and that the current status is `running` or `pending` (else `TASK_NOT_CANCELLABLE`); then call `taskStore.cancel(task_id)` which both aborts the registered controller (if any) and writes `cancelled` status (Gap 5).
  - `result({ task_id }, deps)` — reads `Task` row, returns current state. Throws `TASK_NOT_FOUND` if absent.
  - Wires `InProcessMcpClient` so recursive `agent`/`task`/`result` calls from within an orchestrator loop resolve via these handlers.
- **Deps:** `SessionStore`, `TaskStore`, `Orchestrator`, `BackgroundQueue` (injected here at wire-up — Gap 16), `McpClientRegistry`, `provider factory`, validation, logger.
- **Tests:** Sync task happy path (mocked provider); background task pending-then-completed via `result()` polling; `task_cancel` mid-loop; `MAX_DEPTH_EXCEEDED` error.
  - **Gap 7 — explicit error-code coverage required in this file:**
    - `TASK_NOT_FOUND` — `result()` and `taskCancel()` invoked with an unknown `task_id`.
    - `TASK_NOT_CANCELLABLE` — `taskCancel()` invoked on a task whose status is `completed`, `failed`, or `cancelled`.
- **Build check:** `npx nx build agent-mcp` + `npx nx test agent-mcp -- task-tools`.

### Step 12: MCP server

- **Files to create:** `src/server.ts`
- **Files to delete:** `src/mcp/` directory (whole tree).
- **Content:**
  - Creates `Server` from `@modelcontextprotocol/sdk/server`.
  - Registers tool list handlers for the 12 tools: `agent_create`, `agent_read`, `agent_update`, `agent_delete`, `agent_list`, `agent`, `session_list`, `session_close`, `task`, `task_list`, `task_cancel`, `result`.
  - Each handler validates input via the corresponding Zod schema, dispatches to the handler from Steps 9/10/11, and wraps thrown `ToolError` into MCP `isError: true` content per SPEC §7.
  - Wires transport based on `TRANSPORT` env var: `stdio` → `StdioServerTransport`; `http` → `StreamableHTTPServerTransport` on `PORT`; `sse` → `SSEServerTransport`.
  - **Gap 13 — Per-tool input JSON schemas:** use Zod 4's built-in `z.toJsonSchema(schema)` to derive the JSON Schema fragment for each tool's `inputSchema`. **Do NOT add the legacy `zod-to-json-schema` dep** — it is unnecessary on Zod 4. Note E (below) is therefore obsolete and removed.
- **Exports:** `createServer({ deps }): Server`, `startServer(): Promise<void>`.
- **Tests:** Tool-listing test (mock SDK transport), happy-path single tool call.
- **Build check:** `npx nx build agent-mcp`.

### Step 13: Logging audit

- **Files to modify:** all of the above (touch-ups).
- **Content:** Walk every file created in Steps 2–12 and confirm:
  - No `console.log`/`console.error` anywhere (would corrupt stdio framing on stdout, OK on stderr but not structured).
  - All log calls use `logger.info/.debug/.warn/.error` from `src/logger.ts`.
  - Structured event payloads match SPEC §13 table (taskId, sessionId, agentName, etc.).
- **Tests:** Snapshot a child stderr in a Vitest run with stubbed `process.stderr.write` to confirm log shape.
- **Build check:** `grep -rn "console\." src/` returns 0 hits.

### Step 14: Entry point

- **Files to create:** `src/index.ts`
- **Files to delete:** existing `src/index.ts` (broken).
- **Content:**
  ```ts
  import "dotenv/config";
  import { runMigrations } from "./db/migrate.js";
  import { db } from "./db/client.js";
  import { AgentStore } from "./store/agent-store.js";
  // ...
  import { startServer } from "./server.js";

  async function main() {
    runMigrations();           // synchronous before tools advertised
    const stores = { agents: new AgentStore(db), sessions: ..., tasks: ... };
    const queue = new BackgroundQueue({ concurrency: parseInt(process.env.QUEUE_CONCURRENCY ?? "5") });
    const policy = new PolicyEngine({
      serverMaxDepth: parseInt(process.env.MAX_DEPTH ?? "5"),
      serverMaxToolLoops: parseInt(process.env.MAX_TOOL_LOOPS ?? "10"),
      serverAllowedAgents: process.env.ALLOWED_AGENTS?.split(",").map(s => s.trim()).filter(Boolean),
    });
    const server = await startServer({ stores, queue, policy });

    // Gap 2 — graceful shutdown. Per-task registries are torn down by the
    // orchestrator's finally (Gap 3); no global registry tracker is needed.
    const shutdown = async (signal: string) => {
      logger.info({ signal }, "Server shutdown");
      await server.close();
      process.exit(0);
    };
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
  }

  main().catch((err) => { logger.fatal({ err }, "Fatal startup error"); process.exit(1); });
  ```
- **Exports:** none (binary entry).
- **Tests:** boot-up smoke (run for 100 ms, assert no thrown error, assert tool list advertised).
- **Build check:** `npx nx build agent-mcp` + `node dist/packages/ai/agent-mcp/index.js` should start, log to stderr, accept a `tools/list` JSON-RPC request on stdin, respond, and exit cleanly on close.

### Step 15: Tests

Per SPEC §18 step 15, ensure coverage:

- **Policy engine unit tests** — Step 6 (already enumerated).
- **Store layer integration tests** — Step 3.
- **Orchestrator unit tests with mock clients** — Step 7.
- **End-to-end test:** new file `src/__tests__/e2e-delegation.test.ts`. Spins up two stored agents A and B (B reachable from A's `allowedAgents`), wires the in-process MCP server via Vitest fixtures, calls `agent({ name: "A" })`, `task({ session_id, prompt: "delegate to B" })` with a stubbed Anthropic provider that emits a tool_call to `agent-mcp__agent` then `agent-mcp__task`, and asserts both completion paths (sync + background) yield correct nested Task rows with `parent_task_id` chain and `recursion_depth=1` on B's task.
- **Build check:** `npx nx test agent-mcp` (all tests green) + `npx nx lint agent-mcp` (clean) + `npx nx build agent-mcp` (clean).

---

## Notes for Implementer

- **Note A:** `package.json scripts` reference `nx build agent-runtime` (a project name that doesn't exist in this workspace). The actual Nx project is `agent-mcp`. The README and SPEC quick-start say `nx build ai-agent-mcp`, also wrong. Standardize on `npx nx build agent-mcp`. Update both `package.json` scripts and `README.md` accordingly. Non-blocking — implementer can fix in passing.
- **Note B:** SPEC §2 quick-start references `dist/index.js` but the build executor (`@nx/js:tsc`) outputs to `dist/packages/ai/agent-mcp/index.js`. Either (a) update SPEC's quick-start path, or (b) change the build outputPath, or (c) add a top-level `bin: { "agent-mcp": "./dist/index.js" }` in `package.json` after `nx-release-publish` packs into `dist/{projectRoot}`. Recommend option (a) — least invasive.
- **Note C:** Workspace root has `@anthropic-ai/sdk@0.96.0` while package.json declares `^0.24.0`. The existing `providers/anthropic.ts` was written against the older API but happens to use the still-supported `messages.create` surface, so the bump should be transparent. Verify after install with `npx nx build agent-mcp`.
- **Note D:** `p-retry` is currently transitive at v4. SPEC mandates `p-retry` direct usage; v6+ is ESM-native and supports `AbortSignal`. Confirm v6 is acceptable; otherwise pin to v4 and use the v4 API which lacks signal support (would require workaround).
- **Note E:** *(Removed — Gap 13.)* Zod 4's built-in `z.toJsonSchema()` replaces the legacy `zod-to-json-schema` dep. Step 12 uses it directly; no dependency needs to be added.

These four notes are non-blocking — they are deterministic version-resolution / docs-fix tasks. Implementer can resolve each at the moment they encounter it without further spec input.

---

## Verification gate (after Step 14, before Step 15)

```bash
npx nx lint agent-mcp     # @nx/dependency-checks clean
npx nx build agent-mcp    # tsc clean
node dist/packages/ai/agent-mcp/index.js < /dev/null  # boots without crash, exits on stdin close
```

After Step 15:

```bash
npx nx test agent-mcp     # all tests green
```

---

## State Machine

Linear, single-implementer execution checklist. Each STATE has explicit INPUT (must be true to enter), ACTIONS (concrete file paths and edits), OUTPUT (what is produced), and TRANSITION (next state). No forward references — every INPUT cites an OUTPUT from an earlier state.

```
STATE: S0_PROJECT_HYGIENE
  INPUT: Working tree on branch fix/transform-query-improvements; packages/ai/agent-mcp exists with current broken sources.
  ACTIONS:
    [ ] Modify packages/ai/agent-mcp/package.json — replace scripts.build/dev "agent-runtime" → "agent-mcp"; bump @anthropic-ai/sdk to 0.96.0, openai to 6.37.0, @modelcontextprotocol/sdk to 1.29.0, drizzle-orm to 0.45.2, better-sqlite3 to 12.10.0; add deps pino@10.3.1, p-queue@9.2.0, p-retry@^6.2.0, zod@4.4.3, uuid@14.0.0, dotenv@17.4.2; add devDeps drizzle-kit@^0.31.10, @types/better-sqlite3@^7.6.13, vitest@^1.6.0, vite@~5.0.13, @vitest/coverage-v8@^1.0.4, vite-plugin-dts@~3.8.3, pino-pretty@13.1.3.
    [ ] Modify packages/ai/agent-mcp/.env.example — drop MCP_*, MAX_GLOBAL_*, API_KEY; add DATABASE_PATH=./data/agents.db, MAX_DEPTH=5, MAX_TOOL_LOOPS=10, ALLOWED_AGENTS=, TRANSPORT=stdio, QUEUE_CONCURRENCY=5.
    [ ] Modify packages/ai/agent-mcp/drizzle.config.js — schema "./src/db/schema.ts", dbCredentials.url default "./data/agents.db".
    [ ] Run `yarn install` at workspace root.
    [ ] Run `npx nx lint agent-mcp` — must pass @nx/dependency-checks (or fail only on imports not yet written).
  OUTPUT: package.json scripts pointing to "agent-mcp"; all required deps resolvable in node_modules; .env.example aligned with SPEC §6.
  TRANSITION: → S1_VALIDATION

STATE: S1_VALIDATION
  INPUT: S0 deps installed (zod@4.4.3 resolvable).
  ACTIONS:
    [ ] Create packages/ai/agent-mcp/src/validation/mcp.ts (rewrite — discriminator on top-level "transport").
    [ ] Create packages/ai/agent-mcp/src/validation/agent.ts (retryConfigSchema, providerConfigSchema discriminator on "type", agentPermissionsSchema, agentDefinitionSchema with version+createdAt+updatedAt, plus *Input schemas).
    [ ] Create packages/ai/agent-mcp/src/validation/session.ts.
    [ ] Create packages/ai/agent-mcp/src/validation/message.ts (Gap 11 — extension file).
    [ ] Create packages/ai/agent-mcp/src/validation/task.ts.
    [ ] Create packages/ai/agent-mcp/src/validation/execution.ts (Gap 11 — extension file). MUST include fields per Gap 1 + Gap 6: agentName, agentDefinition, callingAgentName?, sessionId, taskId, parentTaskId?, recursionDepth, toolCallCount.
    [ ] Create packages/ai/agent-mcp/src/validation/errors.ts (Gap 11 — extension file). errorCodeSchema enumerates SESSION_NOT_FOUND, SESSION_CLOSED, TASK_NOT_FOUND, TASK_NOT_CANCELLABLE, DELEGATION_NOT_ALLOWED, MAX_DEPTH_EXCEEDED, MAX_TOOL_LOOPS_EXCEEDED, AGENT_ALREADY_EXISTS, AGENT_NOT_FOUND, PROVIDER_ERROR, MCP_CLIENT_ERROR, etc. Define ToolError class.
    [ ] Create packages/ai/agent-mcp/src/validation/index.ts (barrel).
    [ ] Delete packages/ai/agent-mcp/src/validation/agents.ts, src/validation/tasks.ts, and the entire src/types/ directory.
    [ ] Run `npx nx build agent-mcp` — must be error-free for the validation/ tree (existing broken sources may still error, but validation/ files must compile).
    [ ] (Optional) Add Vitest cases asserting safeParse round-trips for each schema.
  OUTPUT: All Zod schemas + z.infer types exported from src/validation/index.ts; src/types/ deleted.
  TRANSITION: → S2_DB

STATE: S2_DB
  INPUT: S1 validation/ exports available (Drizzle column types do not depend on Zod, but downstream stores will).
  ACTIONS:
    [ ] Create packages/ai/agent-mcp/src/db/schema.ts — five tables per SPEC §14 with all required columns (agents.version, sessions.{agent_version,agent_data,status,closed_at}, tasks.{parent_task_id,recursion_depth,cancelled_at}) and FK ON DELETE CASCADE.
    [ ] Create packages/ai/agent-mcp/src/db/client.ts — better-sqlite3 + drizzle, WAL pragma, foreign_keys ON, mkdirSync(parent), default DATABASE_PATH ./data/agents.db, export `db`.
    [ ] Create packages/ai/agent-mcp/src/db/migrate.ts — `runMigrations()` calling drizzle-orm/better-sqlite3/migrator.
    [ ] Run `npx drizzle-kit generate` from packages/ai/agent-mcp/ — produces drizzle/0000_*.sql; commit it.
    [ ] Delete packages/ai/agent-mcp/src/storage/ (whole dir).
    [ ] Run `npx nx build agent-mcp` — db/ tree must compile.
  OUTPUT: src/db/{schema,client,migrate}.ts exporting `db`, all *Table objects, and `runMigrations`; drizzle/0000_*.sql committed.
  TRANSITION: → S2_5_LOGGER

STATE: S2_5_LOGGER
  INPUT: S0 deps installed (pino@10 resolvable).
  ACTIONS:
    [ ] Create packages/ai/agent-mcp/src/logger.ts — `pino({ level: process.env.LOG_LEVEL ?? "info", base: undefined }, pino.destination(2))`.
    [ ] Delete packages/ai/agent-mcp/src/utils/logger.ts.
    [ ] Add a Vitest smoke test asserting log output writes to fd 2 (mock process.stderr.write).
    [ ] Run `npx nx test agent-mcp -- logger` — 1+ tests pass.
  OUTPUT: src/logger.ts exporting `logger` bound to stderr.
  TRANSITION: → S3_STORE

STATE: S3_STORE
  INPUT: S1 validation/ + S2 db/ + S2.5 logger.
  ACTIONS:
    [ ] Create packages/ai/agent-mcp/src/store/agent-store.ts — AgentStore class; create/read/update(version-bump)/delete(reject-if-active-sessions)/list.
    [ ] Create packages/ai/agent-mcp/src/store/session-store.ts — SessionStore class; create snapshots agentVersion+agentData; read returns public Session shape WITHOUT agentData; expose separate `getAgentDefinition(sessionId): AgentDefinition` (Gap 4) that parses agent_data via agentDefinitionSchema.
    [ ] Create packages/ai/agent-mcp/src/store/task-store.ts — TaskStore class. Constructor: `(db, logger?)` ONLY — no BackgroundQueue (Gap 16). Methods: create, updateStatus, read, list, appendEvent, plus Gap 5: `registerCancellation`, `unregisterCancellation`, `cancel` operating over an in-memory `Map<string, AbortController>`.
    [ ] Create packages/ai/agent-mcp/src/store/index.ts (barrel).
    [ ] Add Vitest integration tests using :memory: SQLite — agent CRUD round-trip, session snapshot+getAgentDefinition, task lifecycle, FK cascade verification.
    [ ] Run `npx nx test agent-mcp -- store` — all tests pass.
    [ ] Run `npx nx build agent-mcp` — must be error-free.
  OUTPUT: AgentStore, SessionStore (with getAgentDefinition), TaskStore (with cancellation map) exported from src/store/index.ts.
  TRANSITION: → S4_PROVIDERS

STATE: S4_PROVIDERS
  INPUT: S1 validation/ (for ProviderConfig, Message, ToolCall, ToolDefinition).
  ACTIONS:
    [ ] Create packages/ai/agent-mcp/src/providers/types.ts — LLMProvider, ProviderChatRequest (with `signal?: AbortSignal`), ProviderChatResponse, ToolDefinition.
    [ ] Create packages/ai/agent-mcp/src/providers/factory.ts — createProvider(config) exhaustive switch.
    [ ] Rewrite packages/ai/agent-mcp/src/providers/anthropic.ts — retarget imports to validation/*; pass `signal` to client.messages.create; wrap chat() in pRetry per agent retryConfig; do NOT introduce internal timeouts (Gap 8).
    [ ] Rewrite packages/ai/agent-mcp/src/providers/openai.ts — same treatment.
    [ ] Rewrite packages/ai/agent-mcp/src/providers/lmstudio.ts — same treatment.
    [ ] Create packages/ai/agent-mcp/src/providers/index.ts (barrel).
    [ ] Delete packages/ai/agent-mcp/src/providers/core/.
    [ ] Add Vitest unit tests with mocked SDK clients — verify server__tool encoding, signal pass-through, retry behavior.
    [ ] Run `npx nx test agent-mcp -- providers` — all tests pass.
    [ ] Run `npx nx build agent-mcp` — must be error-free.
  OUTPUT: createProvider, AnthropicProvider, OpenAIProvider, LMStudioProvider, LLMProvider, ProviderChatRequest, ProviderChatResponse, ToolDefinition.
  TRANSITION: → S5_CLIENTS

STATE: S5_CLIENTS
  INPUT: S1 validation/ (McpServerConfig, ToolDefinition).
  ACTIONS:
    [ ] Create packages/ai/agent-mcp/src/clients/types.ts — IMcpClient interface.
    [ ] Create packages/ai/agent-mcp/src/clients/in-process.ts — InProcessMcpClient threading ExecutionContext to handlers.
    [ ] Create packages/ai/agent-mcp/src/clients/stdio-client.ts — wraps StdioClientTransport; attach `childProcess.on("exit", ...)` warn log (Gap 10); SIGTERM→SIGKILL teardown.
    [ ] Create packages/ai/agent-mcp/src/clients/http-client.ts — HttpMcpClient + SseMcpClient honoring McpServerConfig.timeoutMs (independent of provider timeout, Gap 8).
    [ ] Create packages/ai/agent-mcp/src/clients/registry.ts — McpClientRegistry(mcpServers, selfUrl?: string, inProcessHandler). Self-ref: key === "agent-mcp" OR selfUrl matches; when selfUrl is undefined (stdio transport — Gap 12), only the key check applies. Per-task lifetime — closed by orchestrator finally (Gap 15).
    [ ] Create packages/ai/agent-mcp/src/clients/index.ts (barrel).
    [ ] Add Vitest tests — registry self-ref detection (with and without selfUrl), in-process round-trip with mock handlers.
    [ ] Run `npx nx test agent-mcp -- clients` — all tests pass.
    [ ] Run `npx nx build agent-mcp` — must be error-free.
  OUTPUT: IMcpClient, InProcessMcpClient, StdioMcpClient, HttpMcpClient, SseMcpClient, McpClientRegistry.
  TRANSITION: → S6_POLICY

STATE: S6_POLICY
  INPUT: S1 validation/ (ExecutionContext with toolCallCount; AgentDefinition).
  ACTIONS:
    [ ] Create packages/ai/agent-mcp/src/engine/policy.ts — PolicyEngine class. Check #1 reads executionContext.recursionDepth; check #2 reads executionContext.toolCallCount (Gap 1, read-only — orchestrator owns increments); check #3 reads executionContext.agentDefinition.permissions.allowedAgents with server fallback (Gap 6).
    [ ] Delete packages/ai/agent-mcp/src/runtime/policyEngine.ts.
    [ ] Add Vitest unit tests — boundaries for depth and toolLoops, allowedAgents undefined→server default, allowedAgents [] → block all, target ∈/∉ list, both undefined → unrestricted.
    [ ] Run `npx nx test agent-mcp -- policy` — all tests pass.
    [ ] Run `npx nx build agent-mcp` — must be error-free.
  OUTPUT: PolicyEngine, PolicyConfig, PolicyCheckInput.
  TRANSITION: → S7_ORCHESTRATOR

STATE: S7_ORCHESTRATOR
  INPUT: S3 stores (TaskStore.registerCancellation/unregisterCancellation), S4 providers, S5 McpClientRegistry, S6 PolicyEngine.
  ACTIONS:
    [ ] Create packages/ai/agent-mcp/src/engine/orchestrator.ts — Orchestrator.run({executionContext, messages, registry, provider, policy, taskStore, sessionStore, signal, taskId}).
    [ ] Wrap entire body in try { … } finally { await registry.closeAll(); taskStore.unregisterCancellation(taskId); } (Gap 3).
    [ ] Compose per-iteration signal as `AbortSignal.any([signal, AbortSignal.timeout(executionContext.agentDefinition.provider.timeoutMs ?? 60_000)])` and pass to provider.chat (Gap 8).
    [ ] Increment `executionContext.toolCallCount++` after each tool result append (Gap 1).
    [ ] Persist messages via sessionStore.appendMessage; emit MODEL_REQUEST / MODEL_RESPONSE / TOOL_CALL / TOOL_RESULT events.
    [ ] Delete packages/ai/agent-mcp/src/runtime/ (whole directory).
    [ ] Add Vitest unit tests with mock provider + mock McpClientRegistry — success path, depth/toolLoops exceeded, mid-loop cancellation, provider error after retries, MCP client error.
    [ ] Run `npx nx test agent-mcp -- orchestrator` — all tests pass.
    [ ] Run `npx nx build agent-mcp` — must be error-free.
  OUTPUT: Orchestrator with per-task try/finally registry teardown and toolCallCount management.
  TRANSITION: → S8_QUEUE

STATE: S8_QUEUE
  INPUT: S3 TaskStore + S7 Orchestrator.
  ACTIONS:
    [ ] Create packages/ai/agent-mcp/src/engine/queue.ts — BackgroundQueue wrapping PQueue with `concurrency: parseInt(process.env.QUEUE_CONCURRENCY ?? "5")`. Method `enqueue(taskId, runFn)`. Persists final Task row via injected TaskStore. (Gap 16: standalone module — TaskStore does NOT import this file.)
    [ ] Add Vitest concurrency-limit test (10 tasks, concurrency=2, observe ≤2 in-flight).
    [ ] Run `npx nx test agent-mcp -- queue` — all tests pass.
    [ ] Run `npx nx build agent-mcp` — must be error-free.
  OUTPUT: BackgroundQueue exported from src/engine/queue.ts.
  TRANSITION: → S9_AGENT_CRUD

STATE: S9_AGENT_CRUD
  INPUT: S3 AgentStore + S1 validation/.
  ACTIONS:
    [ ] Create packages/ai/agent-mcp/src/tools/agent-crud.ts — agentCreate, agentRead, agentUpdate, agentDelete, agentList handler functions; each validates input via Zod and rethrows store errors as ToolError with the right ErrorCode.
    [ ] Add Vitest tests — AGENT_ALREADY_EXISTS, AGENT_NOT_FOUND, immutability of name/createdAt, version-bump on update, refusal-to-delete with active sessions.
    [ ] Run `npx nx test agent-mcp -- agent-crud` — all tests pass.
    [ ] Run `npx nx build agent-mcp` — must be error-free.
  OUTPUT: Five agent_* tool handlers exported from src/tools/agent-crud.ts.
  TRANSITION: → S10_SESSION_TOOLS

STATE: S10_SESSION_TOOLS
  INPUT: S3 AgentStore+SessionStore, S6 PolicyEngine, S1 validation/.
  ACTIONS:
    [ ] Create packages/ai/agent-mcp/src/tools/session.ts — agent({name}, deps), sessionList, sessionClose handlers.
    [ ] Inside agent() handler: when called from within a task context, run policy.check (allowedAgents) AND emit `logger.info({ taskId: ctx.taskId, targetAgent: name, newDepth: ctx.recursionDepth + 1 }, "AGENT_DELEGATION")` immediately before returning session_id (Gap 9).
    [ ] Add Vitest tests — snapshot integrity (agent updates do not affect open sessions); explicit error-code coverage (Gap 7): SESSION_NOT_FOUND (sessionList/sessionClose with bad id), SESSION_CLOSED (sessionClose on already-closed session), DELEGATION_NOT_ALLOWED (agent() called from within a task where target not in allowedAgents).
    [ ] Run `npx nx test agent-mcp -- session-tools` — all tests pass.
    [ ] Run `npx nx build agent-mcp` — must be error-free.
  OUTPUT: agent, sessionList, sessionClose handlers + AGENT_DELEGATION log event.
  TRANSITION: → S11_TASK_TOOLS

STATE: S11_TASK_TOOLS
  INPUT: S3 SessionStore (with getAgentDefinition) + TaskStore (with cancellation), S4 createProvider, S5 McpClientRegistry, S7 Orchestrator, S8 BackgroundQueue, S6 PolicyEngine.
  ACTIONS:
    [ ] Create packages/ai/agent-mcp/src/tools/task.ts — task, taskList, taskCancel, result handlers.
    [ ] task() flow MUST be (Gap 17): (1) validate session exists+active (else SESSION_NOT_FOUND/SESSION_CLOSED); (2) call sessionStore.getAgentDefinition(sessionId) (Gap 4); (3) taskStore.create(...); (4) build ExecutionContext with toolCallCount: 0 (Gap 1); (5) `const controller = new AbortController()`; (6) taskStore.registerCancellation(task.id, controller) (Gap 5); (7) build provider; (8) build registry per-task (Gap 15); (9) call Orchestrator.run({...signal: controller.signal, taskId}).
    [ ] taskCancel() — validate exists (else TASK_NOT_FOUND); validate cancellable status (else TASK_NOT_CANCELLABLE); call taskStore.cancel(task_id).
    [ ] result() — validate exists (else TASK_NOT_FOUND).
    [ ] Wire BackgroundQueue here — it is injected at index.ts wire-up time (Gap 16).
    [ ] Wire InProcessMcpClient handler set so recursive tool calls resolve here.
    [ ] Add Vitest tests — sync happy path, background pending→completed via result() polling, task_cancel mid-loop, MAX_DEPTH_EXCEEDED. Explicit error-code coverage (Gap 7): TASK_NOT_FOUND (result/taskCancel with bad id), TASK_NOT_CANCELLABLE (taskCancel on completed/failed/cancelled task).
    [ ] Run `npx nx test agent-mcp -- task-tools` — all tests pass.
    [ ] Run `npx nx build agent-mcp` — must be error-free.
  OUTPUT: task, taskList, taskCancel, result handlers wired with full Gap-1/4/5/15/17 semantics.
  TRANSITION: → S12_SERVER

STATE: S12_SERVER
  INPUT: S9 + S10 + S11 handlers, S1 validation/ (Zod 4 z.toJsonSchema available).
  ACTIONS:
    [ ] Create packages/ai/agent-mcp/src/server.ts — createServer({deps}) registering all 12 tools (agent_create, agent_read, agent_update, agent_delete, agent_list, agent, session_list, session_close, task, task_list, task_cancel, result).
    [ ] For each tool's inputSchema, derive JSON Schema via `z.toJsonSchema(zodSchema)` (Gap 13 — do NOT add zod-to-json-schema dep).
    [ ] Wire transport from TRANSPORT env: stdio | http (StreamableHTTPServerTransport on PORT) | sse.
    [ ] Each handler validates input via the Zod schema, dispatches, and wraps thrown ToolError into MCP `isError: true` content per SPEC §7.
    [ ] Export `createServer` and `startServer(): Promise<Server>`.
    [ ] Delete packages/ai/agent-mcp/src/mcp/ (whole dir).
    [ ] Add Vitest tests — tool listing assertion, single-tool happy path with mocked transport.
    [ ] Run `npx nx test agent-mcp -- server` — all tests pass.
    [ ] Run `npx nx build agent-mcp` — must be error-free.
  OUTPUT: createServer, startServer; src/mcp/ deleted.
  TRANSITION: → S13_LOGGING_AUDIT

STATE: S13_LOGGING_AUDIT
  INPUT: S2.5 logger + every file from S2–S12.
  ACTIONS:
    [ ] Run `grep -rn "console\." packages/ai/agent-mcp/src/` — must return 0 hits.
    [ ] Verify all log calls use src/logger.ts and structured payloads match SPEC §13 (taskId, sessionId, agentName, etc.).
    [ ] Add a Vitest fixture stubbing process.stderr.write to snapshot a log shape from one orchestrator run.
    [ ] Run `npx nx test agent-mcp -- logging` — passes.
    [ ] Run `npx nx build agent-mcp` — must be error-free.
  OUTPUT: All modules audited; 0 console.* hits; structured-log shape test passes.
  TRANSITION: → S14_INDEX

STATE: S14_INDEX
  INPUT: S2 db (runMigrations), S3 stores, S6 policy, S8 queue, S12 startServer, S2.5 logger.
  ACTIONS:
    [ ] Create packages/ai/agent-mcp/src/index.ts — `import "dotenv/config"`, runMigrations() synchronously, instantiate AgentStore/SessionStore/TaskStore + BackgroundQueue + PolicyEngine, await startServer({stores, queue, policy}), capture returned `server`.
    [ ] Register graceful shutdown handlers (Gap 2): `process.on("SIGTERM", () => void shutdown("SIGTERM"))` and `process.on("SIGINT", () => void shutdown("SIGINT"))`, where `shutdown` calls `await server.close()` then `process.exit(0)`. No global registry tracker — per-task registries are torn down in the orchestrator finally (Gap 3).
    [ ] Wrap main() in `.catch((err) => { logger.fatal({err}, "Fatal startup error"); process.exit(1); })`.
    [ ] Run `npx nx build agent-mcp` — must be error-free.
    [ ] Smoke: `node dist/packages/ai/agent-mcp/index.js < /dev/null` — boots, logs to stderr, exits cleanly on stdin close.
    [ ] Smoke: send SIGTERM to a running instance — must exit code 0 and emit "Server shutdown" log.
  OUTPUT: src/index.ts boots the server; SIGTERM/SIGINT exit cleanly.
  TRANSITION: → S15_TESTS

STATE: S15_TESTS
  INPUT: All states S0–S14 complete.
  ACTIONS:
    [ ] Verify policy unit tests (S6) cover all SPEC §18 step 15 cases.
    [ ] Verify store integration tests (S3) cover FK cascade.
    [ ] Verify orchestrator unit tests (S7) include cancellation, depth, toolLoops, provider error, MCP error paths.
    [ ] Create packages/ai/agent-mcp/src/__tests__/e2e-delegation.test.ts — two stored agents A and B; B in A.allowedAgents; stub Anthropic provider that emits agent-mcp__agent then agent-mcp__task tool calls; assert nested Task rows with correct parent_task_id chain and recursion_depth=1 on B's task. Cover both sync (background:false) and background (background:true → poll result()) paths.
    [ ] Run `npx nx lint agent-mcp` — clean.
    [ ] Run `npx nx test agent-mcp` — all tests green.
    [ ] Run `npx nx build agent-mcp` — clean.
  OUTPUT: Full test suite green; e2e recursive delegation passes.
  TRANSITION: → DONE

DONE: All tests green, server boots, recursive delegation e2e passes.
```
