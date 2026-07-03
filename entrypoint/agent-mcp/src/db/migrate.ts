import { db, sqlite } from "./client.js";
import { runMigrationsOn } from "./migrate-runner.js";

export function runMigrations(): void {
    runMigrationsOn(sqlite, db);
}
