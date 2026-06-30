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

// Track per-task accumulated token counts from task_usage
const taskTokens: Record<string, { in: number; out: number }> = {};

function getContextSize(taskId: string | null): string {
  if (!taskId) return "";
  const t = taskTokens[taskId];
  if (!t) return "";
  const total = t.in + t.out;
  if (total === 0) return "";
  const inStr = t.in >= 1000 ? `${(t.in / 1000).toFixed(1)}K` : `${t.in}`;
  const outStr = t.out >= 1000 ? `${(t.out / 1000).toFixed(1)}K` : `${t.out}`;
  return `${inStr}/${outStr}`;
}

function open(): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  return db;
}

function ts(): string {
  const d = new Date();
  return d.toLocaleTimeString("en-US", { hour12: false }) + "." +
    String(d.getMilliseconds()).padStart(3, "0");
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

function formatToolCall(p: any, toolCalls: any[]): string {
  if (!p) return "";
  const tool = p.tool ?? p.name ?? "?";
  const callId = p.callId ?? p.id ?? "";
  const msgDetail = toolCalls.find((tc: any) => tc.id === callId || tc.callId === callId);
  const rawArgs = msgDetail?.arguments ?? msgDetail?.args ?? msgDetail?.input ?? {};
  const argsStr = JSON.stringify(rawArgs, null, verbose ? 2 : 0);
  const trimmed = !verbose && argsStr.length > 1000 ? argsStr.slice(0, 1000) + "..." : argsStr;
  return `${tool} ${trimmed}`;
}

function formatToolResult(p: any, toolResults: any[]): string {
  if (!p) return "";
  const tool = p.tool ?? p.name ?? "?";
  const callId = p.callId ?? p.id ?? "";
  const err = p.isError ? " ERROR" : "";
  const msgDetail = toolResults.find((tr: any) => tr.id === callId || tr.callId === callId);
  const content = msgDetail?.result ?? msgDetail?.content ?? msgDetail?.text ?? msgDetail ?? p.content ?? p.result ?? p.text ?? "";
  let resultStr = typeof content === "string" ? content : JSON.stringify(content, null, verbose ? 2 : 0);
  if (!verbose && resultStr.length > 2000) resultStr = resultStr.slice(0, 2000) + "...";
  return `${tool}${err} ${resultStr}`;
}

function formatModelResponse(p: any): string {
  if (!p) return "";
  const msgCount = p.messageCount ?? p.messagesCount ?? p.message_count ?? "?";
  const toolCount = p.toolCount ?? p.tool_count ?? "?";
  const stop = p.stopReason ?? p.stop_reason ?? p.stop ?? "?";
  return `[msgs=${msgCount} tools=${toolCount} stop=${stop}]`;
}

function formatModelRequest(p: any): string {
  if (!p) return "";
  const model = p.model ?? "?";
  const tokens = p.tokens ?? p.inputTokens ?? p.input_tokens ?? p.maxTokens ?? p.max_tokens ?? "";
  return `model=${model}${tokens ? " tokens="+tokens : ""}`;
}

function formatTaskDone(p: any): string {
  if (!p) return "";
  const text = p.result ?? p.text ?? p.content ?? p.error ?? "";
  if (!text) return "";
  const s = typeof text === "string" ? text : JSON.stringify(text);
  if (verbose) return s;
  return s.length > 2000 ? s.slice(0, 2000) + "..." : s;
}

const eventTypes: Record<string, { icon: string; fmt: (p: any, tc?: any[], tr?: any[]) => string }> = {
  TOOL_CALL:       { icon: "\uD83D\uDD27", fmt: (p, tc) => formatToolCall(p, tc ?? []) },
  TOOL_RESULT:     { icon: "\uD83D\uDCE6", fmt: (p, tc, tr) => formatToolResult(p, tr ?? []) },
  MODEL_REQUEST:   { icon: "\u2B06",  fmt: (p) => formatModelRequest(p) },
  MODEL_RESPONSE:  { icon: "\u2B07",  fmt: (p) => formatModelResponse(p) },
  TASK_COMPLETED:  { icon: "\u2705", fmt: (p) => formatTaskDone(p) },
  TASK_FAILED:     { icon: "\u274C", fmt: (p) => `Error: ${pretty(JSON.stringify(p), 500)}` },
  TASK_CANCELLED:  { icon: "\uD83D\uDEAB", fmt: () => "" },
};

interface EventRow {
  rowid: number;
  type: string;
  payload: string | null;
  createdAt: string;
  taskId: string;
  agentName: string | null;
  sessionId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

function poll(): void {
  if (limit > 0 && shownCount >= limit) {
    process.exit(0);
  }

  const db = open();

  // If this is the first poll (no --include-history), skip to current max rowid
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
      u.input_tokens AS inputTokens,
      u.output_tokens AS outputTokens
    FROM task_events e
    LEFT JOIN task_usage u ON u.task_id = e.task_id
    LEFT JOIN tasks t ON t.id = e.task_id
    WHERE e.rowid > ?${whereExtra}
    ORDER BY e.rowid ASC
  `).all(...(filterAgent ? [lastRowId, filterAgent] : [lastRowId])) as EventRow[];

  // Update accumulated token counts per task
  for (const row of rows) {
    if (row.taskId && row.inputTokens != null) {
      taskTokens[row.taskId] = {
        in: Math.max(taskTokens[row.taskId]?.in ?? 0, row.inputTokens),
        out: Math.max(taskTokens[row.taskId]?.out ?? 0, row.outputTokens ?? 0),
      };
    }
  }

  // Batch-fetch tool call/result details from messages table
  const sessionIds = [...new Set(rows.map(r => r.sessionId).filter(Boolean))];
  const msgCache: Record<string, { tc: any[]; tr: any[] }> = {};
  for (const sid of sessionIds) {
    const msgs = db.prepare(
      "SELECT tool_calls, tool_results FROM messages WHERE session_id = ? AND (tool_calls IS NOT NULL OR tool_results IS NOT NULL) ORDER BY created_at DESC LIMIT 3"
    ).all(sid) as Array<{ tool_calls: string | null; tool_results: string | null }>;
    const tc: any[] = [];
    const tr: any[] = [];
    for (const m of msgs) {
      if (m.tool_calls) try { tc.push(...JSON.parse(m.tool_calls)); } catch {}
      if (m.tool_results) try { tr.push(...JSON.parse(m.tool_results)); } catch {}
    }
    msgCache[sid] = { tc, tr };
  }

  for (const row of rows) {
    if (limit > 0 && shownCount >= limit) { process.exit(0); }
    lastRowId = row.rowid;
    shownCount++;

    const time = ts();
    const agent = row.agentName ?? "?";
    const sess = row.sessionId ? row.sessionId.slice(0, 8) : "ephemeral";
    const ctxSize = getContextSize(row.taskId);
    const ctxPad = ctxSize ? ctxSize.padStart(10) : "          ";

    const ev = eventTypes[row.type] ?? { icon: "\uD83D\uDCDD", fmt: (p: any) => pretty(JSON.stringify(p)) };
    let detail = "";
    try {
      const parsed = row.payload ? JSON.parse(row.payload) : null;
      if (parsed && row.sessionId && msgCache[row.sessionId]) {
        const ctx = msgCache[row.sessionId];
        detail = ev.fmt(parsed, ctx.tc, ctx.tr);
      } else {
        detail = ev.fmt(parsed);
      }
    } catch {
      detail = pretty(row.payload, 500);
    }

    const line = `${time} ${ev.icon} ${ctxPad} ${agent.padEnd(20)} ${sess.padEnd(8)} ${row.type.padEnd(15)} ${detail}`;
    for (const part of line.split("\n")) {
      console.log(part);
    }
  }

  db.close();
}

console.log(`agent-mcp-tail -- watching ${dbPath}`);
if (verbose) console.log("  --full: no truncation");
if (filterAgent) console.log(`  --agent: ${filterAgent}`);
if (includeHistory) console.log("  --include-history: showing all events");
if (limit > 0) console.log(`  --limit: ${limit} events`);

const startDb = open();
const count = startDb.prepare("SELECT COUNT(*) as c FROM task_events").get() as { c: number };
if (count.c === 0) {
  const devPath = path.join(process.cwd(), "data", "agent-mcp", "agents-dev.db");
  if (existsSync(devPath)) {
    console.log(`Warning: ${dbPath} is empty -- try ${devPath}`);
    console.log(`   ADHD_AGENT_DATABASE_PATH=${devPath}`);
  }
}
startDb.close();
console.log(`${ts()} --- started ---`);

setInterval(poll, 500);
