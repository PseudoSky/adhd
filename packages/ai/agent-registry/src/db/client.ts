import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema.js";

// Decision 1 (decisions.md): one shared SQLite file for all registry-family packages.
// The path is shared across @adhd/agent-registry, @adhd/agent-tool-registry,
// @adhd/agent-provider, and @adhd/agent-policy — each opens its own Drizzle
// instance against the same file. No ATTACH DATABASE; no cross-package SQLite FKs.
const databasePath =
    process.env["REGISTRY_DATABASE_PATH"] ||
    process.env["DATABASE_PATH"] ||
    "./data/registry.db";

const resolvedPath =
    path.resolve(databasePath);

const directory =
    path.dirname(resolvedPath);

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
