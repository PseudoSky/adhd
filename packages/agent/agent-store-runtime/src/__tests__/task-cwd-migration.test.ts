/**
 * 9ed453c1 CWD -- migration 0014: `tasks.cwd` (the dispatching cwd, ADR-0008 D4/D9). Built through the
 * migrations agent-mcp ships (no mocks); additive and legacy-safe.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { getTableColumns } from "drizzle-orm";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "../db/schema.js";
import { tasksTable } from "../db/schema.js";
import { TaskStore } from "../store/task-store.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");
const REAL_FOLDER = join(REPO_ROOT, "entrypoint/agent-mcp/drizzle");
const SCRATCH_ROOT = join(REPO_ROOT, "tmp/agent-store-runtime");

interface IJournal {
  entries: Array<{ idx: number; tag: string }>;
}

/** Copy the real migrations folder, keeping only entries with idx <= maxIdx. */
function folderUpTo(dest: string, maxIdx: number): string {
  const out = join(dest, `upto-${maxIdx}`);
  mkdirSync(join(out, "meta"), { recursive: true });
  const journal = JSON.parse(readFileSync(join(REAL_FOLDER, "meta/_journal.json"), "utf8")) as IJournal & Record<string, unknown>;
  journal.entries = journal.entries.filter((e) => e.idx <= maxIdx);
  writeFileSync(join(out, "meta/_journal.json"), JSON.stringify(journal));
  for (const e of journal.entries) cpSync(join(REAL_FOLDER, `${e.tag}.sql`), join(out, `${e.tag}.sql`));
  return out;
}

const columnsOf = (db: Database.Database, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name);

describe("migration 0014: tasks.cwd", () => {
  let scratch: string;
  let conn: Database.Database;

  beforeEach(() => {
    mkdirSync(SCRATCH_ROOT, { recursive: true });
    scratch = mkdtempSync(join(SCRATCH_ROOT, "task-cwd-mig-"));
    conn = new Database(":memory:");
  });
  afterEach(() => {
    conn.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("9ed453c1 CWD: adds exactly one nullable `cwd` column and keeps a legacy task row byte-for-byte", () => {
    migrate(drizzle(conn), { migrationsFolder: folderUpTo(scratch, 13) });
    const before = columnsOf(conn, "tasks");
    expect(before).not.toContain("cwd");
    conn
      .prepare(
        "INSERT INTO tasks (id, prompt, status, created_at, updated_at) VALUES ('t1','legacy','pending','2026-10-09T00:00:00.000Z','2026-10-09T00:00:00.000Z')"
      )
      .run();

    migrate(drizzle(conn), { migrationsFolder: REAL_FOLDER });

    expect(columnsOf(conn, "tasks").filter((c) => !before.includes(c))).toEqual(["cwd"]);
    expect(conn.prepare("SELECT id, prompt, status, cwd FROM tasks WHERE id='t1'").get()).toEqual({
      id: "t1",
      prompt: "legacy",
      status: "pending",
      cwd: null,
    });
  });

  it("9ed453c1 CWD: drizzle schema.ts columns match the migrated DB exactly (no schema/migration drift)", () => {
    migrate(drizzle(conn), { migrationsFolder: REAL_FOLDER });
    const schemaCols = Object.values(getTableColumns(tasksTable)).map((c) => c.name).sort();
    expect(columnsOf(conn, "tasks").sort()).toEqual(schemaCols);
  });

  it("9ed453c1 CWD: TaskStore persists the dispatching cwd and reads it back (read + list); a task without one reads null", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = drizzle(conn, { schema }) as any;
    migrate(db, { migrationsFolder: REAL_FOLDER });
    const store = new TaskStore(db);
    const withCwd = store.create({ sessionId: null, isEphemeral: true, prompt: "a", cwd: "/work/P" });
    const without = store.create({ sessionId: null, isEphemeral: true, prompt: "b" });
    expect(store.read(withCwd.id).cwd).toBe("/work/P");
    expect(store.read(without.id).cwd).toBeNull();
    const listed = store.list({}) as unknown as Array<{ id: string; cwd?: string | null }>;
    expect(listed.find((t) => t.id === withCwd.id)?.cwd).toBe("/work/P");
  });
});
