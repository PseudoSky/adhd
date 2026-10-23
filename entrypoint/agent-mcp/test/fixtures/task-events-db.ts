/**
 * Shared fixture for the `task_events` tests (facd4aaa). A file-backed SQLite database built through the
 * shipped agent-mcp migrations, a real `TaskStore` on the same handle, and helpers that seed raw
 * `task_events` rows with explicit ids and timestamps. Every database lives under the repository
 * `tmp/agent-mcp/task-events/` root and is removed by {@link TaskEventsFixture.dispose}.
 *
 * Foreign keys are OFF, matching `createMigratedSqlite` in the orchestrator fixtures: the reader under
 * test does not depend on the owning session row, and seeding it would only add setup noise.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import * as schema from "@adhd/agent-store-runtime";
import { TaskStore, taskEventsTable } from "@adhd/agent-store-runtime";

const HERE = dirname(fileURLToPath(import.meta.url));
/** `entrypoint/agent-mcp`, the package whose shipped migrations the fixture applies. */
const AGENT_MCP_ROOT = resolve(HERE, "../..");
const MIGRATIONS_FOLDER = join(AGENT_MCP_ROOT, "drizzle");
/** Repository `tmp/` root: `entrypoint/agent-mcp` is two levels below the worktree root. */
const TMP_ROOT = resolve(AGENT_MCP_ROOT, "..", "..", "tmp", "agent-mcp", "task-events");

/** A `task_events` row as seeded by the fixture; `payloadText` is written verbatim (it may be corrupt JSON). */
export interface SeedEventInput {
  id?: string;
  taskId: string;
  type: string;
  createdAt: string;
  /** Raw text stored in the `payload` column. `undefined` stores SQL NULL. */
  payloadText?: string;
}

export interface TaskEventsFixture {
  /** The raw better-sqlite3 handle (used for corrupt-row inserts the typed API cannot express). */
  readonly sqlite: Database.Database;
  /** Drizzle handle on the same connection, the shape `taskEvents` takes as `deps.db`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly db: any;
  readonly taskStore: TaskStore;
  /** Creates a task row through the real `TaskStore` and returns its id. */
  createTask(): string;
  /** Inserts one `task_events` row. Ids default to a fresh UUID. */
  seedEvent(input: SeedEventInput): string;
  /** Closes the connection and removes the database directory. Safe to call once per fixture. */
  dispose(): void;
}

/**
 * Creates a migrated, file-backed database under `tmp/agent-mcp/task-events/<unique>/` and returns the
 * fixture. The caller owns teardown: call `dispose()` in `afterEach`.
 */
export function createTaskEventsFixture(): TaskEventsFixture {
  mkdirSync(TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TMP_ROOT, "run-"));
  const sqlite = new Database(join(dir, "task-events.db"));
  sqlite.pragma("foreign_keys = OFF");
  migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS_FOLDER });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sqlite, { schema }) as any;
  const taskStore = new TaskStore(db);
  let disposed = false;

  return {
    sqlite,
    db,
    taskStore,
    createTask(): string {
      const id = randomUUID();
      taskStore.create({ sessionId: randomUUID(), prompt: "task_events fixture", id });
      return id;
    },
    seedEvent(input: SeedEventInput): string {
      const id = input.id ?? randomUUID();
      db.insert(taskEventsTable)
        .values({
          id,
          taskId: input.taskId,
          type: input.type,
          payload: input.payloadText ?? null,
          createdAt: input.createdAt,
        })
        .run();
      return id;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
