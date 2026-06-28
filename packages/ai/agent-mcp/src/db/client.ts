import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { config } from "../config.js";
import * as schema from "./schema.js";

const resolvedPath = path.resolve(config.db.path);

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
