#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";

const { values: args } = parseArgs({
  options: {
    "full":           { type: "boolean", short: "f", default: false },
    "agent":          { type: "string",  short: "a", default: "" },
    "include-history":{ type: "boolean", short: "h", default: false },
    "limit":          { type: "string",  short: "n", default: "" },
  },
  allowPositionals: true,
});

const verbose = args["full"] as boolean;
const filterAgent = (args["agent"] || "").trim();
const includeHistory = args["include-history"] as boolean;
const limit = parseInt(args["limit"] || "0", 10) || 0;

const defaultMaxLen = verbose ? 100000 : 2000;

const dbPath = process.env["ADHD_AGENT_DATABASE_PATH"]
  ?? path.join(os.homedir(), ".adhd", "agent-mcp", "agents.db");

let lastRowId = includeHistory ? 0 : -1;
let shownCount = 0;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Payload = Record<string, any>;

function open(): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  return db;
}

function ts(): string {
  const d = new Date();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  const h = d.getHours() % 12 || 12;
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  const ampm = d.getHours() >= 12 ? "PM" : "AM";
  return `${mo}/${da} - ${h}:${m}:${s} ${ampm}`;
}

function pretty(payload: string | null, maxLen = defaultMaxLen): string {
  if (!payload) return "";
  try {
    const parsed = JSON.parse(payload);
    const formatted = JSON.stringify(parsed, null, verbose ? 2 : 0);
    return formatted.length > maxLen ? formatted.slice(0, maxLen) + "..." : formatted;
  } catch {
    return payload.length > maxLen ? payload.slice(0, maxLen) + "..." : payload;
  }
}

interface EventRow {
  rowid: number;
  type: string;
  payload: string | null;
  createdAt: string;
  taskId: string;
  agentName: string | null;
  sessionId: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

type ToolCallEntry = { id?: string; callId?: string; server?: string; tool?: string; arguments?: Record<string, unknown> };
type ToolResultEntry = { toolCallId?: string; id?: string; callId?: string; result?: unknown; content?: unknown; text?: unknown; isError?: boolean };

function poll(): void {
  if (limit > 0 && shownCount >= limit) {
    process.exit(0);
  }

  const db = open();

  if (lastRowId === -1) {
    const maxRow = db.prepare("SELECT MAX(rowid) as m FROM task_events").get() as { m: number };
    lastRowId = maxRow.m ?? 0;
    db.close();
    return;
  }

  let whereExtra = "";
  if (filterAgent) {
    whereExtra = " AND u.agent_name = ?";
  }

  const rows = db.prepare(`
    SELECT
      e.rowid,
      e.type,
      e.payload,
      e.created_at AS createdAt,
      e.task_id AS taskId,
      u.agent_name AS agentName,
      t.session_id AS sessionId,
      u.model AS model,
      u.input_tokens AS inputTokens,
      u.output_tokens AS outputTokens
    FROM task_events e
    LEFT JOIN task_usage u ON u.task_id = e.task_id
    LEFT JOIN tasks t ON t.id = e.task_id
    WHERE e.rowid > ?${whereExtra}
    ORDER BY e.rowid ASC
  `).all(...(filterAgent ? [lastRowId, filterAgent] : [lastRowId])) as EventRow[];

  // Batch-fetch message details for each unique session (last 10 messages)
  const sessionIds = [...new Set(rows.map(r => r.sessionId).filter((s): s is string => !!s))];
  const msgCache: Record<string, { tc: ToolCallEntry[]; tr: ToolResultEntry[]; content: string }> = {};
  for (const sid of sessionIds) {
    const msgs = db.prepare(
      "SELECT tool_calls, tool_results, content FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 10"
    ).all(sid) as Array<{ tool_calls: string | null; tool_results: string | null; content: string | null }>;
    const allTc: ToolCallEntry[] = [];
    const allTr: ToolResultEntry[] = [];
    let latestContent = "";
    for (const m of msgs) {
      if (m.tool_calls) try { allTc.push(...JSON.parse(m.tool_calls) as ToolCallEntry[]); } catch { /* skip */ }
      if (m.tool_results) try { allTr.push(...JSON.parse(m.tool_results) as ToolResultEntry[]); } catch { /* skip */ }
      if (m.content) latestContent = m.content;
    }
    msgCache[sid] = { tc: allTc, tr: allTr, content: latestContent };
  }

  for (const row of rows) {
    if (limit > 0 && shownCount >= limit) { process.exit(0); }
    lastRowId = row.rowid;
    shownCount++;

    const time = ts();
    const agent = row.agentName ?? "?";
    const sess = row.sessionId ? row.sessionId.slice(0, 8) : "ephemeral";

    const parsed: Payload = row.payload ? JSON.parse(row.payload) : null;
    const p = parsed ?? {};

    const msgData = row.sessionId ? msgCache[row.sessionId] : undefined;
    const tcList = msgData?.tc ?? [];
    const trList = msgData?.tr ?? [];
    const msgContent = msgData?.content ?? "";

    let detail = "";

    switch (row.type) {
      case "MODEL_REQUEST": {
        const model = row.model ?? p["model"] ?? "?";
        const mc = p["messageCount"] ?? p["messagesCount"] ?? p["message_count"] ?? "?";
        const tc = p["toolCount"] ?? p["tool_count"] ?? "?";
        detail = `model=${model} messages=${mc} tools=${tc}`;
        break;
      }
      case "MODEL_RESPONSE": {
        const stop = p["stopReason"] ?? p["stop_reason"] ?? p["stop"] ?? "?";
        let content = msgContent ?? "";
        if (content) {
          if (!verbose && content.length > 500) content = content.slice(0, 500) + "...";
          detail = `${stop} ${content}`;
        } else {
          const msgCount = p["messageCount"] ?? p["messagesCount"] ?? p["message_count"] ?? "?";
          const toolCount = p["toolCount"] ?? p["tool_count"] ?? "?";
          detail = `${stop} msgs=${msgCount} tools=${toolCount}`;
        }
        break;
      }
      case "TOOL_CALL": {
        const tool = p["tool"] ?? p["name"] ?? "?";
        const callId = p["callId"] ?? "";
        const tcMatch = tcList.find((t: ToolCallEntry) => t.id === callId || t.callId === callId);
        const args = tcMatch?.arguments ?? {};
        const argsStr = JSON.stringify(args);
        const trimmed = !verbose && argsStr.length > 500 ? argsStr.slice(0, 500) + "..." : argsStr;
        detail = `${tool} ${trimmed}`;
        break;
      }
      case "TOOL_RESULT": {
        const tool = p["tool"] ?? "?";
        const callId = p["callId"] ?? "";
        const err = p["isError"] ? " ERROR" : "";
        const trMatch = trList.find((t: ToolResultEntry) => t.toolCallId === callId || t.id === callId || t.callId === callId);
        const result = trMatch?.result ?? trMatch?.content ?? trMatch?.text ?? p["content"] ?? p["result"] ?? "";
        let resultStr = typeof result === "string" ? result : JSON.stringify(result, null, verbose ? 2 : 0);
        if (!verbose && resultStr.length > 2000) resultStr = resultStr.slice(0, 2000) + "...";
        detail = `${tool}${err} ${resultStr}`;
        break;
      }
      case "TASK_COMPLETED": {
        const text = p["result"] ?? p["text"] ?? p["content"] ?? p["error"] ?? "";
        if (text) {
          const s = typeof text === "string" ? text : JSON.stringify(text);
          if (verbose) {
            detail = s;
          } else {
            detail = s.length > 2000 ? s.slice(0, 2000) + "..." : s;
          }
        }
        break;
      }
      case "TASK_FAILED": {
        detail = `Error: ${pretty(JSON.stringify(p), 500)}`;
        break;
      }
      default:
        detail = pretty(row.payload, 500);
    }

    let inputTotal = "";
    if (row.taskId && row.inputTokens != null) {
      const inT = row.inputTokens;
      const outT = row.outputTokens ?? 0;
      const inStr = inT >= 1000 ? `${(inT / 1000).toFixed(1)}K` : `${inT}`;
      const outStr = outT >= 1000 ? `${(outT / 1000).toFixed(1)}K` : `${outT}`;
      inputTotal = `${inStr}/${outStr}`;
    }

    const line = `${time} ${agent.padEnd(18)} ${sess.padEnd(8)} ${row.type.padEnd(15)} ${inputTotal.padStart(10)} ${detail}`;
    for (const part of line.split("\n")) {
      console.log(part);
    }
  }

  db.close();
}

console.log(`agent-mcp-tail -- ${dbPath}`);
if (verbose) console.log("  --full: no truncation");
if (filterAgent) console.log("  --agent: " + filterAgent);
if (includeHistory) console.log("  --include-history");
if (limit > 0) console.log("  --limit: " + limit);

const startDb = open();
const count = startDb.prepare("SELECT COUNT(*) as c FROM task_events").get() as { c: number };
if (count.c === 0) {
  const devPath = path.join(process.cwd(), "data", "agent-mcp", "agents-dev.db");
  if (existsSync(devPath)) {
    console.log("Warning: empty -- try ADHD_AGENT_DATABASE_PATH=" + devPath);
  }
}
startDb.close();
console.log(`${ts()} --- started ---`);

setInterval(poll, 500);
