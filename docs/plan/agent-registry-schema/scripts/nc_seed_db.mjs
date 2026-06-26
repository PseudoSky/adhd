#!/usr/bin/env node
/**
 * nc_seed_db.mjs — Create and seed a fresh DB at a given path for nc testing.
 *
 * Usage:
 *   node nc_seed_db.mjs <db-path>
 *
 * Creates the DB file, runs all migrations, seeds prompt types and components.
 * Used by the negative-control proof to establish a real on-disk DB that
 * nc_mutate and nc_restore can target.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const DB_PATH = process.argv[2];
if (!DB_PATH) {
    console.error("Usage: node nc_seed_db.mjs <db-path>");
    process.exit(1);
}

// Resolve paths relative to the worktree root.
const REPO_ROOT = path.resolve(__dirname, "../../../../");
const DIST_SEED = path.join(
    REPO_ROOT,
    "dist/packages/ai/agent-registry/src/seed/index.js"
);
const MIGRATIONS_FOLDER = path.join(
    REPO_ROOT,
    "packages/ai/agent-registry/drizzle"
);

// Use require() for CommonJS dist output.
const Database = require("better-sqlite3");
const { drizzle } = require("drizzle-orm/better-sqlite3");
const { migrate } = require("drizzle-orm/better-sqlite3/migrator");
const { seed } = require(DIST_SEED);

const conn = new Database(DB_PATH);
conn.pragma("journal_mode = WAL");
conn.pragma("foreign_keys = OFF");

const db = drizzle(conn);
migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

conn.pragma("foreign_keys = ON");

seed(db);
conn.close();

console.log(`nc_seed_db: seeded ${DB_PATH} with all prompt types and components.`);
