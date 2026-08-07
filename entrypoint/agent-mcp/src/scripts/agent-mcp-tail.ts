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
    "json":           { type: "boolean", short: "j", default: false },
    "follow":         { type: "boolean", short: "F", default: false },
  },
  allowPositionals: true,
});

const verbose = args["full"] as boolean;
const filterAgent = (args["agent"] || "").trim();
const includeHistory = args["include-history"] as boolean;
const limit = parseInt(args["limit"] || "0", 10) || 0;
const jsonOut = args["json"] as boolean;
const follow = args["follow"] as boolean;

const defaultMaxLen = verbose ? 100000 : 2000;

const dbPath = process.env["ADHD_AGENT_DATABASE_PATH"]
  ?? path.join(os.homedir(), ".adhd", "agent-mcp", "agents.db");

// In follow mode we replay history (0) or start from the live tail (-1);
// in one-shot mode the full stored transcript is always the result set.
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
  cacheReadTokens: number | null;
  uncachedTokens: number | null;
  peakContextTokens: number | null;
  modelCalls: number | null;
}

type ToolCallEntry = { id?: string; callId?: string; server?: string; tool?: string; arguments?: Record<string, unknown> };
type ToolResultEntry = { toolCallId?: string; id?: string; callId?: string; result?: unknown; content?: unknown; text?: unknown; isError?: boolean };

interface SessionMsgs { tc: ToolCallEntry[]; tr: ToolResultEntry[]; content: string }

/**
 * Per-task usage aggregate (the single `task_usage` row per task). Attached ONLY to a
 * task's terminal event — never fanned across every event, which made per-event token
 * sums nonsense (a 12-call task read as 12× its real spend). See BUG-AGENTMCP-006.
 */
interface TaskUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  uncachedInputTokens: number | null;
  peakContextTokens: number | null;
  modelCalls: number | null;
}

/** A single rendered event — the shared shape behind both text and JSON output. */
interface TailRecord {
  rowid: number;
  createdAt: string;
  type: string;
  agent: string;
  sessionId: string | null;
  taskId: string;
  model: string | null;
  /** Task-total usage — present ONLY on TASK_COMPLETED / TASK_FAILED; null on every other event. */
  taskUsage: TaskUsage | null;
  detail: string;
}

/** Fetch matching events with rowid greater than `sinceRowId`, oldest first. */
function queryRows(db: Database.Database, sinceRowId: number): EventRow[] {
  const whereExtra = filterAgent ? " AND u.agent_name = ?" : "";
  const params = filterAgent ? [sinceRowId, filterAgent] : [sinceRowId];
  return db.prepare(`
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
      u.output_tokens AS outputTokens,
      u.cache_read_input_tokens AS cacheReadTokens,
      u.uncached_input_tokens AS uncachedTokens,
      u.peak_context_tokens AS peakContextTokens,
      u.model_calls AS modelCalls
    FROM task_events e
    LEFT JOIN task_usage u ON u.task_id = e.task_id
    LEFT JOIN tasks t ON t.id = e.task_id
    WHERE e.rowid > ?${whereExtra}
    ORDER BY e.rowid ASC
  `).all(...params) as EventRow[];
}

/** Aggregate the recent tool-call/result/content messages for every session in `rows`. */
function buildMsgCache(db: Database.Database, rows: EventRow[], msgLimit: number): Record<string, SessionMsgs> {
  const sessionIds = [...new Set(rows.map(r => r.sessionId).filter((s): s is string => !!s))];
  const cache: Record<string, SessionMsgs> = {};
  for (const sid of sessionIds) {
    const msgs = db.prepare(
      "SELECT tool_calls, tool_results, content FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?"
    ).all(sid, msgLimit) as Array<{ tool_calls: string | null; tool_results: string | null; content: string | null }>;
    const allTc: ToolCallEntry[] = [];
    const allTr: ToolResultEntry[] = [];
    let latestContent = "";
    for (const m of msgs) {
      if (m.tool_calls) try { allTc.push(...JSON.parse(m.tool_calls) as ToolCallEntry[]); } catch { /* skip */ }
      if (m.tool_results) try { allTr.push(...JSON.parse(m.tool_results) as ToolResultEntry[]); } catch { /* skip */ }
      if (m.content) latestContent = m.content;
    }
    cache[sid] = { tc: allTc, tr: allTr, content: latestContent };
  }
  return cache;
}

/** Build the human-readable detail string for one event. */
function buildDetail(row: EventRow, tcList: ToolCallEntry[], trList: ToolResultEntry[], msgContent: string): string {
  const parsed: Payload = row.payload ? JSON.parse(row.payload) : null;
  const p = parsed ?? {};

  switch (row.type) {
    case "MODEL_REQUEST": {
      const model = row.model ?? p["model"] ?? "?";
      const mc = p["messageCount"] ?? p["messagesCount"] ?? p["message_count"] ?? "?";
      const tc = p["toolCount"] ?? p["tool_count"] ?? "?";
      return `model=${model} messages=${mc} tools=${tc}`;
    }
    case "MODEL_RESPONSE": {
      const stop = p["stopReason"] ?? p["stop_reason"] ?? p["stop"] ?? "?";
      let content = msgContent ?? "";
      if (content) {
        if (!verbose && content.length > 500) content = content.slice(0, 500) + "...";
        return `${stop} ${content}`;
      }
      const msgCount = p["messageCount"] ?? p["messagesCount"] ?? p["message_count"] ?? "?";
      const toolCount = p["toolCount"] ?? p["tool_count"] ?? "?";
      return `${stop} msgs=${msgCount} tools=${toolCount}`;
    }
    case "TOOL_CALL": {
      const tool = p["tool"] ?? p["name"] ?? "?";
      const callId = p["callId"] ?? "";
      const tcMatch = tcList.find((t: ToolCallEntry) => t.id === callId || t.callId === callId);
      const argObj = tcMatch?.arguments ?? {};
      const argsStr = JSON.stringify(argObj);
      const trimmed = !verbose && argsStr.length > 500 ? argsStr.slice(0, 500) + "..." : argsStr;
      return `${tool} ${trimmed}`;
    }
    case "TOOL_RESULT": {
      const tool = p["tool"] ?? "?";
      const callId = p["callId"] ?? "";
      const err = p["isError"] ? " ERROR" : "";
      const trMatch = trList.find((t: ToolResultEntry) => t.toolCallId === callId || t.id === callId || t.callId === callId);
      const result = trMatch?.result ?? trMatch?.content ?? trMatch?.text ?? p["content"] ?? p["result"] ?? "";
      let resultStr = typeof result === "string" ? result : JSON.stringify(result, null, verbose ? 2 : 0);
      if (!verbose && resultStr.length > 2000) resultStr = resultStr.slice(0, 2000) + "...";
      return `${tool}${err} ${resultStr}`;
    }
    case "TASK_COMPLETED": {
      const text = p["result"] ?? p["text"] ?? p["content"] ?? p["error"] ?? "";
      if (!text) return "";
      const s = typeof text === "string" ? text : JSON.stringify(text);
      if (verbose) return s;
      return s.length > 2000 ? s.slice(0, 2000) + "..." : s;
    }
    case "TASK_FAILED":
      return `Error: ${pretty(JSON.stringify(p), 500)}`;
    default:
      return pretty(row.payload, 500);
  }
}

function isTerminal(type: string): boolean {
  return type === "TASK_COMPLETED" || type === "TASK_FAILED";
}

function fmtK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : `${n}`;
}

/**
 * Task-total usage annotation, shown ONLY on the terminal event of a task.
 * Previously this rendered on every MODEL_REQUEST/RESPONSE using the joined per-task
 * aggregate — the whole-task total repeated on every row, so summing per-event tokens
 * looked like N× the real spend (BUG-AGENTMCP-006). Now it appears once, as a total,
 * with the cache-hit rate so a heavily-cached task doesn't read as expensive.
 */
function buildUsageCol(row: EventRow): string {
  if (!isTerminal(row.type) || row.inputTokens == null) return "";
  const inp = row.inputTokens ?? 0;
  const out = row.outputTokens ?? 0;
  const cacheRead = row.cacheReadTokens ?? 0;
  const pct = inp > 0 && cacheRead > 0 ? ` ${Math.round((100 * cacheRead) / inp)}%cache` : "";
  const peak = row.peakContextTokens != null ? ` peak=${fmtK(row.peakContextTokens)}` : "";
  return `Σ in=${fmtK(inp)} out=${fmtK(out)}${pct}${peak}`;
}

function toRecord(row: EventRow, cache: Record<string, SessionMsgs>): TailRecord {
  const msgData = row.sessionId ? cache[row.sessionId] : undefined;
  const detail = buildDetail(row, msgData?.tc ?? [], msgData?.tr ?? [], msgData?.content ?? "");
  const taskUsage: TaskUsage | null = isTerminal(row.type) && row.inputTokens != null ? {
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    uncachedInputTokens: row.uncachedTokens,
    peakContextTokens: row.peakContextTokens,
    modelCalls: row.modelCalls,
  } : null;
  return {
    rowid: row.rowid,
    createdAt: row.createdAt,
    type: row.type,
    agent: row.agentName ?? "?",
    sessionId: row.sessionId,
    taskId: row.taskId,
    model: row.model,
    taskUsage,
    detail,
  };
}

function renderLine(rec: TailRecord, row: EventRow): string {
  const sess = rec.sessionId ? rec.sessionId.slice(0, 8) : "ephemeral";
  const tokenDisplay = buildUsageCol(row);
  return `${ts()} ${rec.agent.padEnd(18)} ${sess.padEnd(8)} ${rec.type.padEnd(15)} ${tokenDisplay.padStart(12)} ${rec.detail}`;
}

function emit(rec: TailRecord, row: EventRow): void {
  if (jsonOut) {
    // NDJSON: one self-contained object per line, stream-friendly.
    console.log(JSON.stringify(rec));
    return;
  }
  for (const part of renderLine(rec, row).split("\n")) {
    console.log(part);
  }
}

/** Follow mode: poll the DB every 500ms and stream new events forever. */
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

  const rows = queryRows(db, lastRowId);
  const cache = buildMsgCache(db, rows, 10);

  for (const row of rows) {
    if (limit > 0 && shownCount >= limit) { db.close(); process.exit(0); }
    lastRowId = row.rowid;
    shownCount++;
    emit(toRecord(row, cache), row);
  }

  db.close();
}

/** One-shot mode: return the full stored transcript once, then exit. */
function runOnce(): void {
  const db = open();
  const rows = queryRows(db, 0);
  // Full transcript wanted, so pull deeper message history than the live tail.
  const cache = buildMsgCache(db, rows, verbose ? 5000 : 1000);
  let records = rows.map(row => ({ rec: toRecord(row, cache), row }));
  if (limit > 0) records = records.slice(-limit);
  db.close();

  if (jsonOut) {
    console.log(JSON.stringify(records.map(r => r.rec), null, verbose ? 2 : 0));
  } else {
    for (const { rec, row } of records) {
      for (const part of renderLine(rec, row).split("\n")) {
        console.log(part);
      }
    }
  }
}

// --- banner (suppressed in JSON mode so stdout stays pure JSON) ---
if (!jsonOut) {
  console.log(`agent-mcp-tail -- ${dbPath}`);
  if (verbose) console.log("  --full: no truncation");
  if (filterAgent) console.log("  --agent: " + filterAgent);
  if (includeHistory) console.log("  --include-history");
  if (limit > 0) console.log("  --limit: " + limit);
  console.log(`  --mode: ${follow ? "follow (polling)" : "one-shot"}`);
}

const startDb = open();
const count = startDb.prepare("SELECT COUNT(*) as c FROM task_events").get() as { c: number };
if (count.c === 0) {
  const devPath = path.join(process.cwd(), "data", "agent-mcp", "agents-dev.db");
  if (existsSync(devPath) && !jsonOut) {
    console.log("Warning: empty -- try ADHD_AGENT_DATABASE_PATH=" + devPath);
  }
}
startDb.close();

if (follow) {
  if (!jsonOut) console.log(`${ts()} --- started ---`);
  setInterval(poll, 500);
} else {
  runOnce();
}
