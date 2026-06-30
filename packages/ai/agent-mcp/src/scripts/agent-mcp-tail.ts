#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";

const dbPath = process.env["ADHD_AGENT_DATABASE_PATH"]
  ?? path.join(os.homedir(), ".adhd", "agent-mcp", "agents.db");

const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
const db = drizzle(sqlite, { schema });

function ts(): string {
  const d = new Date();
  return d.toLocaleTimeString("en-US", { hour12: false }) + "." +
    String(d.getMilliseconds()).padStart(3, "0");
}

function humanize(payload: string | null, maxLen = 240): string {
  if (!payload) return "";
  try {
    const parsed = JSON.parse(payload);
    const formatted = JSON.stringify(parsed, null, 0);
    return formatted.length > maxLen
      ? formatted.slice(0, maxLen) + "..."
      : formatted;
  } catch {
    return payload.length > maxLen ? payload.slice(0, maxLen) + "..." : payload;
  }
}

interface EventRow {
  type: string;
  payload: string | null;
  createdAt: string;
  taskId: string;
  agentName: string | null;
  sessionId: string | null;
}

let lastRowId = 0;

function poll(): void {
  const rows = sqlite.prepare(`
    SELECT
      e.rowid,
      e.type,
      e.payload,
      e.created_at AS createdAt,
      e.task_id AS taskId,
      u.agent_name AS agentName,
      t.session_id AS sessionId
    FROM task_events e
    LEFT JOIN task_usage u ON u.task_id = e.task_id
    LEFT JOIN tasks t ON t.id = e.task_id
    WHERE e.rowid > ?
    ORDER BY e.rowid ASC
  `).all(lastRowId) as (EventRow & { rowid: number })[];

  for (const row of rows) {
    lastRowId = row.rowid;
    const time = ts();
    const agent = row.agentName ?? "?";
    const sess = row.sessionId ? row.sessionId.slice(0, 8) : "ephemeral";
    const icons: Record<string, string> = {
      TOOL_CALL: "🔧", TOOL_RESULT: "📦", MODEL_REQUEST: "🤖",
      MODEL_RESPONSE: "💬", TASK_COMPLETED: "✅", TASK_FAILED: "❌",
      TASK_CANCELLED: "🚫",
    };
    const icon = icons[row.type] ?? "📝";

    console.log(`${time} ${icon} ${agent.padEnd(20)} ${sess.padEnd(8)} ${row.type.padEnd(16)} ${humanize(row.payload)}`);
  }
}

console.log(`🧵 agent-mcp-tail — watching ${dbPath}`);
console.log(`${ts()} ─── started ───`);

setInterval(poll, 500);
