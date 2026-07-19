import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { env } from "../config.js";
import * as localSchema from "./schema.js";
import * as runtimeSchema from "@adhd/agent-store-runtime";

// Zero-config default: when `db.path` is unset (no env var/file override),
// fall back to `env.files.db` — the resolved, zero-config DB location under
// the active scope root (ARCHITECTURE.md §6, AGENTS.md §10: never the repo
// tree, never `process.cwd()`).
const resolvedPath = path.resolve(env.config.db.path ?? env.files['db']);

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

const mergedSchema = { ...localSchema, ...runtimeSchema };
export const db = drizzle(sqlite, { schema: mergedSchema });
