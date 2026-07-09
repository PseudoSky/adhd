import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import * as schema from './schema.js';

const databasePath = process.env['DATABASE_PATH'] || path.join(os.homedir(), '.adhd', 'agent-core-provider', 'agents.db');

const resolvedPath = path.resolve(databasePath);

const directory = path.dirname(resolvedPath);

if (!fs.existsSync(directory)) {
  fs.mkdirSync(directory, {
    recursive: true,
  });
}

export const sqlite: Database.Database = new Database(resolvedPath);

sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

export const db = drizzle(sqlite, { schema });
