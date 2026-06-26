import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema.js";

/**
 * Resolve the absolute path to the agents SQLite database.
 *
 * Priority:
 *  1. `DATABASE_PATH` environment variable (explicit override).
 *  2. Stable home-directory default: `~/.adhd/agent-mcp/agents.db`.
 *
 * Extracted as a pure function so tests can assert path-resolution
 * logic without actually opening the database.
 */
export function resolveDatabasePath(
    envOverride: string | undefined = process.env["DATABASE_PATH"]
): string {
    const raw = envOverride || path.join(os.homedir(), ".adhd", "agent-mcp", "agents.db");
    return path.resolve(raw);
}

const resolvedPath = resolveDatabasePath();

const directory = path.dirname(resolvedPath);

if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, {
        recursive: true
    });
}

export const sqlite: Database.Database =
    new Database(resolvedPath);

sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });
