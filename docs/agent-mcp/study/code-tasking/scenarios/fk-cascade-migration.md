# Scenario: `fk-cascade-migration`

**Difficulty:** hard (the discriminator). **Real fix shipped in:** commit `6dc8fdf`.

---

## The coding task

SQLite (via Drizzle ORM, `better-sqlite3` driver). Migration `0005` recreates the
`tasks` table using SQLite's standard table-rebuild pattern (to make `session_id`
nullable + add a column). After `runMigrations()` applies it to an **existing,
populated** database, **every pre-existing `task_events` row is gone**. The
`task_events.task_id → tasks.id ON DELETE CASCADE` is **intentional** for normal
row deletes and must **not** be weakened.

Relevant code (the "before" state):

```ts
// db/schema.ts
taskId: text("task_id").notNull().references(() => tasksTable.id, { onDelete: "cascade" }),

// db/client.ts
const sqlite = new Database(resolvedPath);   // module-private; NOT exported
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
export const db = drizzle(sqlite, { schema });   // only `db` is exported

// db/migrate.ts
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { db } from "./client.js";
export function runMigrations(): void {
    migrate(db, { migrationsFolder: "…drizzle" });
}
```

```sql
-- drizzle/0005_*.sql (drizzle-kit's standard SQLite table-rebuild)
PRAGMA foreign_keys=OFF;
CREATE TABLE `__new_tasks` ( …session_id text… );
INSERT INTO `__new_tasks`(...) SELECT ... FROM `tasks`;
DROP TABLE `tasks`;
ALTER TABLE `__new_tasks` RENAME TO `tasks`;
PRAGMA foreign_keys=ON;
```

Facts a competent engineer has/discovers: drizzle's better-sqlite3 migrator runs
each migration file **inside a transaction**; the connection is opened with
`foreign_keys = ON`.

## The subtlety

The migration *already* contains `PRAGMA foreign_keys=OFF`, yet the cascade still
fires. **`PRAGMA foreign_keys` is a no-op when issued inside a transaction**
(SQLite ignores it), and the migrator wraps the file in a transaction — so the
in-SQL `PRAGMA OFF` does nothing, FK enforcement stays ON, and `DROP TABLE tasks`
cascades into `task_events`. The fix therefore **cannot live in the SQL**; it must
toggle FK enforcement on the *connection*, where no transaction is open — i.e. in
`runMigrations()`, before `migrate()`.

## Raw correct solution (as shipped)

`db/client.ts` — export the raw connection:
```ts
export const sqlite: Database.Database = new Database(resolvedPath);
```

`db/migrate-runner.ts` (new) — FK-safe runner:
```ts
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

interface PragmaConn { pragma(source: string, options?: { simple: boolean }): unknown; }

export function runMigrationsOn(
    conn: PragmaConn,
    drizzleDb: Parameters<typeof migrate>[0],
    migrationsFolder: string = MIGRATIONS_FOLDER
): void {
    const fkWasOn = conn.pragma("foreign_keys", { simple: true }) === 1;
    if (fkWasOn) conn.pragma("foreign_keys = OFF");   // outside any transaction → takes effect
    try {
        migrate(drizzleDb, { migrationsFolder });
    } finally {
        if (fkWasOn) conn.pragma("foreign_keys = ON"); // restore, even if migrate throws
    }
}
```

`db/migrate.ts` delegates: `runMigrationsOn(sqlite, db)`. The integration harness
routes all migrations through `runMigrationsOn` too. Regression guard:
`scripts/verify-fk-safe-migration.mjs` — seeds a pre-0005 DB with a `task_events`
row, applies 0005 via the runner, asserts the row survives (teeth-checked: a bare
`migrate()` wipes it → 0).

## Rubric (0–5; "pass" = root cause correct **and** fix would actually work)

| # | Criterion | Weight |
|---|---|---|
| R1 | **Root cause** identifies the in-SQL `PRAGMA OFF` is a *no-op inside the migrator's transaction* (FK stays ON) | ★★★ |
| R2 | **Fix layer** is the connection/`runMigrations()` (toggle FK before `migrate()`), NOT the SQL file | ★★★ |
| R3 | **Compiles / uses real APIs** — no fabricated methods (`Migrator.up()`, `db.run("BEGIN")`, `ALTER TABLE … ADD FOREIGN KEY`) | ★★ |
| R4 | **Valid SQLite** (no MySQL/Postgres dialect; respects table-rebuild constraints) | ★★ |
| R5 | **Preserves the cascade** (doesn't switch to RESTRICT/SET NULL or drop the FK) | ★★ |
| R6 | **Restores FK enforcement** after migrate (and ideally `try/finally`) | ★ |
| R7 | Includes a regression test that fails before / passes after | ★ |

**Common failure signatures observed:** adding `BEGIN/COMMIT` inside the SQL (R2 ✗);
`ALTER TABLE … ADD FOREIGN KEY … DEFERRABLE` (R4 ✗); switching to `ON DELETE RESTRICT`
(R5 ✗); fabricating `migrate.up({ transaction: false })` (R3 ✗); concluding "ensure
`foreign_keys=ON`" (R1 inverted).
