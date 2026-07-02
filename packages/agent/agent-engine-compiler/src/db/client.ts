import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import * as schema from './schema.js';

// One shared SQLite file for the whole registry family. This package opens ONE
// handle and queries all four registry prefixes (registry_*, tool_*, provider_*,
// policy_*) through it — NO ATTACH DATABASE, NO second DB file, NO cross-package
// SQLite foreign keys. Cross-prefix reads go through the upstream store classes
// (CompositionStore, BindingStore, ModelStore, AgentPolicyStore) which are
// constructed with this same `sqlite` / `db` handle in compileAgent({..., db}).
// See decisions.md Decision C and REGISTRY-PACKAGE-RULES.md §2.
const databasePath =
  process.env['REGISTRY_DATABASE_PATH'] ||
  process.env['DATABASE_PATH'] ||
  './data/registry.db';

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

// The compiler's Drizzle instance covers the compiler_ prefix tables only.
// Upstream schemas are accessed through the upstream packages' store classes
// (passed the same `db` / `sqlite` handle), not merged here. This keeps each
// package's schema namespace isolated while sharing one physical connection.
export const db = drizzle(sqlite, { schema });
