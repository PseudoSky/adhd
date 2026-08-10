import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { operationalEnv } from "../config.js";
import * as localSchema from "./schema.js";
import * as runtimeSchema from "@adhd/agent-store-runtime";

// DEBT-AGENTMCP-OPERATIONAL-DATA-SCOPE-001 (design decision 2): the
// operational store path is resolved from `operationalEnv` — the scope-FORCED
// (`scope:'global'`) Environment instance — NEVER from the ambient `env`
// singleton whose active scope reflects `ADHD_ENV_SCOPE`. A project-scope
// `config.yaml` setting `db.path`, or `ADHD_ENV_SCOPE=project`, can therefore
// never relocate agents.db into a repo tree (AGENTS.md §10); only an explicit
// `ADHD_AGENT_DATABASE_PATH` (env var) or a system/global config.yaml
// `db.path` still wins. Zero-config fallback: `operationalEnv.files.db` — the
// user-global namespaced location `~/.adhd/agent-mcp/production/data/agents.db`
// (ARCHITECTURE.md §6).
const resolvedPath = path.resolve(operationalEnv.config.db.path ?? operationalEnv.files['db']);

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
