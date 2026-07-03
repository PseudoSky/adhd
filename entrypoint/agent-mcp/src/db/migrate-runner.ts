import { migrate } from "drizzle-orm/better-sqlite3/migrator";

export const MIGRATIONS_FOLDER = new URL(
    "../../drizzle",
    import.meta.url
).pathname;

interface PragmaConn {
    pragma(source: string, options?: { simple: boolean }): unknown;
}

export function runMigrationsOn(
    conn: PragmaConn,
    drizzleDb: Parameters<typeof migrate>[0],
    migrationsFolder: string = MIGRATIONS_FOLDER
): void {
    const fkWasOn =
        conn.pragma("foreign_keys", { simple: true }) === 1;

    if (fkWasOn) {
        conn.pragma("foreign_keys = OFF");
    }

    try {
        migrate(drizzleDb, { migrationsFolder });
    } finally {
        if (fkWasOn) {
            conn.pragma("foreign_keys = ON");
        }
    }
}
