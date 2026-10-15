/**
 * guards: task_events loads or returns an unbounded payload (a 300 KiB string field returned whole, a multi-MiB row read into memory, 500 large rows parsed before the byte trim), or breaks paging/neighbours while bounding
 * tier: S
 * cites: plan discovery-sweep-1014 blind-review A2 TEB-B1, TEB-B2, TEB-B3, TEB-B4, TEB-B5, TEB-B6
 *
 * plan discovery-sweep-1014 blind-review A2 TEB-B1..B6 — the read-side bound of the `task_events` tool.
 *
 * Failure modes: (a) a legacy row with a 300 KiB `result` string is returned whole (TEB-B1); (b) the bound
 * disturbs under-cap rows, re-clips an already-clipped stored row, or adds keys to rows that needed no clip
 * (TEB-B2); (c) a 2 MiB row's payload is selected and parsed (TEB-B3); (d) the tool loads all 500 rows of 900 KiB
 * before trimming, so memory is `rows x row size` (TEB-B4); (e) rows left unloaded are not reported as trimmed, so
 * a pager skips or repeats events (TEB-B5); (f) a `too_large` or `invalid_json` row poisons its neighbours or the
 * `total` (TEB-B6).
 *
 * Tier: S. Real `taskEvents`, real `TaskStore`, real file-backed SQLite built from the shipped migrations
 * (`fixtures/task-events-db.ts`, under `tmp/agent-mcp/task-events/`, removed in afterEach). Rows are seeded
 * through the real schema table with explicit timestamps. The "spy" wraps the real transaction handle and records
 * every statement and the rows it returned, so the memory bound is asserted on bytes actually read, never on
 * timing. No sleeps, no wall clock.
 *
 * Red run (pre-change `tools/task-events.ts` restored from the parent commit, `npx vitest run
 * src/__tests__/task-events-bounds.test.ts`): 6 of 7 tests fail on assertions (TEB-B1 `payload_clipped` undefined and
 * `result` 307200 chars; TEB-B3 no `too_large` record and the oversize row's payload is read; both TEB-B4 cases read
 * every row's payload; TEB-B5 page not trimmed by the load budget; TEB-B6 no `too_large` record). TEB-B2 passes
 * pre-change by design: it guards behaviour that must not change (under-cap rows, no new keys).
 *
 * Bound note: a call reads at most max(TASK_EVENTS_MAX_LOAD_BYTES, one row <= TASK_EVENTS_MAX_ROW_BYTES), because a
 * page always holds its first row; the 200 KiB case pins the 2 x page-budget limit, the 900 KiB case pins the lone row.
 */
import { afterEach, describe, expect, it } from "vitest";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";

import {
  taskEvents,
  TASK_EVENTS_MAX_FIELD_CHARS,
  TASK_EVENTS_MAX_LOAD_BYTES,
  TASK_EVENTS_MAX_PAGE_BYTES,
  TASK_EVENTS_MAX_ROW_BYTES,
  toWireText,
} from "../tools/task-events.js";
import { createTaskEventsFixture, type TaskEventsFixture } from "./fixtures/task-events-db.js";

const fixtures: TaskEventsFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});

function open(): TaskEventsFixture {
  const fixture = createTaskEventsFixture();
  fixtures.push(fixture);
  return fixture;
}

const ts = (i: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)).toISOString();

interface SpiedStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly rows: readonly Record<string, unknown>[];
}

/**
 * The deps `taskEvents` takes in production, with the transaction handle wrapped so every `tx.all` statement is
 * recorded with the rows it returned. The wrapped handle delegates to the real one.
 */
function spiedDeps(fixture: TaskEventsFixture) {
  const statements: SpiedStatement[] = [];
  const dialect = new SQLiteSyncDialect();
  const db = {
    transaction: <T>(fn: (tx: { all: (q: never) => unknown[] }) => T): T =>
      fixture.db.transaction((tx: { all: (q: never) => unknown[] }) =>
        fn({
          all: (q: never): unknown[] => {
            const rows = tx.all(q) as Record<string, unknown>[];
            const built = dialect.sqlToQuery(q as never);
            statements.push({ sql: built.sql, params: built.params, rows });
            return rows;
          },
        }),
      ),
  };
  return { deps: { taskStore: fixture.taskStore, db: db as never }, statements };
}

/** Bytes of payload text that statements returned in a `payload` column. */
function payloadBytesRead(statements: readonly SpiedStatement[]): number {
  let n = 0;
  for (const s of statements) {
    for (const r of s.rows) if (typeof r["payload"] === "string") n += Buffer.byteLength(r["payload"], "utf8");
  }
  return n;
}

const wireBytes = (v: unknown): number => Buffer.byteLength(toWireText(v), "utf8");

describe("plan discovery-sweep-1014 blind-review A2 TEB-B1/B2 per-field clip on read", () => {
  it("plan discovery-sweep-1014 blind-review A2 TEB-B1: a legacy row with a 300 KiB result string returns exactly 16000 chars, lists payload_clipped, and the page is not truncated_by_bytes", () => {
    const fx = open();
    const taskId = fx.createTask();
    const result = `BEGIN${"r".repeat(300 * 1024 - 8)}END`;
    expect(result).toHaveLength(307_200);
    fx.seedEvent({ taskId, type: "TOOL_RESULT", createdAt: ts(0), payloadText: JSON.stringify({ tool: "t", result }) });

    const page = taskEvents({ task_id: taskId }, { taskStore: fx.taskStore, db: fx.db });
    const ev = page.events[0]!;
    const payload = ev.payload as { tool: string; result: string };

    expect(payload.result).toHaveLength(16_000);
    expect(payload.result.startsWith("BEGIN")).toBe(true);
    expect(payload.result.endsWith("END")).toBe(true);
    expect(payload.tool).toBe("t");
    expect(ev.payload_clipped).toEqual([{ field: "result", original_chars: 307_200 }]);
    expect(page.truncated_by_bytes).toBeUndefined();
    expect(TASK_EVENTS_MAX_FIELD_CHARS).toBe(16_000);
  });

  it("plan discovery-sweep-1014 blind-review A2 TEB-B2: under-cap rows serialize byte-identically to the stored payload, carry no new keys, and an already-clipped stored row is not re-clipped", () => {
    const fx = open();
    const taskId = fx.createTask();
    const small = { callId: "c1", result: "x".repeat(15_999), nested: { long: "y".repeat(40_000) }, list: ["z".repeat(20_000)] };
    const atBound = { result: "b".repeat(16_000) };
    fx.seedEvent({ id: "00000000-0000-4000-8000-00000000000a", taskId, type: "TOOL_RESULT", createdAt: ts(0), payloadText: JSON.stringify(small) });
    fx.seedEvent({ id: "00000000-0000-4000-8000-00000000000b", taskId, type: "TOOL_RESULT", createdAt: ts(1), payloadText: JSON.stringify(atBound) });
    // A row as the current writer stores it: head + marker + tail inside 16000.
    const stored = "S".repeat(11_000) + "\n[stored text clipped: showing first 11000 and last 4000 of 100000 chars]\n" + "T".repeat(4_900);
    expect(stored.length).toBeLessThanOrEqual(16_000);
    fx.seedEvent({ id: "00000000-0000-4000-8000-00000000000c", taskId, type: "TOOL_RESULT", createdAt: ts(2), payloadText: JSON.stringify({ result: stored, result_stored_clipped: true }) });

    const page = taskEvents({ task_id: taskId }, { taskStore: fx.taskStore, db: fx.db });

    // Golden: the exact record shape of an under-cap row (no payload_clipped / payload_error / payload_bytes keys).
    expect(page.events[0]).toEqual({
      id: "00000000-0000-4000-8000-00000000000a",
      type: "TOOL_RESULT",
      created_at: ts(0),
      payload: small,
    });
    expect(Object.keys(page.events[0]!)).toEqual(["id", "type", "created_at", "payload"]);
    expect(page.events[1]!.payload).toEqual(atBound);
    expect(page.events[1]!.payload_clipped).toBeUndefined();
    expect((page.events[2]!.payload as { result: string }).result).toBe(stored);
    expect(page.events[2]!.payload_clipped).toBeUndefined();
    expect(JSON.stringify(page.events.map((e) => Object.keys(e)))).not.toContain("payload_clipped");
  });
});

describe("plan discovery-sweep-1014 blind-review A2 TEB-B3/B4 the load is bounded before the page is built", () => {
  it("plan discovery-sweep-1014 blind-review A2 TEB-B3: a 2 MiB row returns payload null, too_large and payload_bytes; its payload is never selected", () => {
    const fx = open();
    const taskId = fx.createTask();
    fx.seedEvent({ taskId, type: "TOOL_CALL", createdAt: ts(0), payloadText: JSON.stringify({ a: 1 }) });
    const big = JSON.stringify({ blob: ["q".repeat(1024)].concat(Array.from({ length: 2047 }, () => "q".repeat(1024))) });
    expect(Buffer.byteLength(big, "utf8")).toBeGreaterThan(2 * 1024 * 1024);
    const bigId = fx.seedEvent({ taskId, type: "TOOL_RESULT", createdAt: ts(1), payloadText: big });
    fx.seedEvent({ taskId, type: "TOOL_CALL", createdAt: ts(2), payloadText: JSON.stringify({ b: 2 }) });
    const bigRid = (fx.sqlite.prepare("SELECT rowid AS rid FROM task_events WHERE id = ?").get(bigId) as { rid: number }).rid;

    const { deps, statements } = spiedDeps(fx);
    const page = taskEvents({ task_id: taskId }, deps);

    const rec = page.events[1]!;
    expect(rec.id).toBe(bigId);
    expect(rec.payload).toBeNull();
    expect(rec.payload_error).toBe("too_large");
    expect(rec.payload_bytes).toBe(Buffer.byteLength(big, "utf8"));
    // The oversize row's rowid is in no statement's parameters, and no statement returned its text.
    for (const s of statements) expect(s.params).not.toContain(bigRid);
    expect(payloadBytesRead(statements)).toBeLessThan(1_000);
    expect(page.events.map((e) => e.payload)).toEqual([{ a: 1 }, null, { b: 2 }]);
  });

  it("plan discovery-sweep-1014 blind-review A2 TEB-B4: 500 rows of 200 KiB read at most 2 x the page budget of payload bytes, and the page fits the budget", () => {
    const fx = open();
    const taskId = fx.createTask();
    // 200 KiB as an array of 200 strings of 1 KiB: under the row bound, no string over the field bound.
    const row = JSON.stringify({ blob: Array.from({ length: 200 }, () => "m".repeat(1024)) });
    fx.sqlite.transaction(() => {
      for (let i = 0; i < 500; i++) fx.seedEvent({ taskId, type: "TOOL_RESULT", createdAt: ts(i), payloadText: row });
    })();

    const { deps, statements } = spiedDeps(fx);
    const page = taskEvents({ task_id: taskId, limit: 500 }, deps);

    expect(TASK_EVENTS_MAX_LOAD_BYTES).toBe(2 * TASK_EVENTS_MAX_PAGE_BYTES);
    expect(page.total).toBe(500);
    // Without the bound the tool reads 500 x ~205 KB = ~100 MB.
    expect(payloadBytesRead(statements)).toBeLessThanOrEqual(TASK_EVENTS_MAX_LOAD_BYTES);
    expect(page.events.length).toBeGreaterThanOrEqual(1);
    expect(page.events.length).toBeLessThan(500);
    expect(page.truncated_by_bytes).toBe(true);
    expect(page.has_more).toBe(true);
    expect(wireBytes(page)).toBeLessThanOrEqual(TASK_EVENTS_MAX_PAGE_BYTES);
  });

  it("plan discovery-sweep-1014 blind-review A2 TEB-B4: 500 rows of 900 KiB (each over the load budget alone) read exactly one row, which is returned as the lone first event", () => {
    const fx = open();
    const taskId = fx.createTask();
    const row = JSON.stringify({ blob: Array.from({ length: 900 }, () => "m".repeat(1024)) });
    const rowBytes = Buffer.byteLength(row, "utf8");
    expect(rowBytes).toBeLessThanOrEqual(TASK_EVENTS_MAX_ROW_BYTES);
    expect(rowBytes).toBeGreaterThan(TASK_EVENTS_MAX_LOAD_BYTES);
    fx.sqlite.transaction(() => {
      for (let i = 0; i < 500; i++) fx.seedEvent({ taskId, type: "TOOL_RESULT", createdAt: ts(i), payloadText: row });
    })();

    const { deps, statements } = spiedDeps(fx);
    const page = taskEvents({ task_id: taskId, limit: 500 }, deps);

    expect(payloadBytesRead(statements)).toBe(rowBytes);
    expect(page.events).toHaveLength(1);
    expect(page.truncated_by_bytes).toBe(true);
    expect(page.has_more).toBe(true);
  });
});

describe("plan discovery-sweep-1014 blind-review A2 TEB-B5/B6 paging and neighbours", () => {
  it("plan discovery-sweep-1014 blind-review A2 TEB-B5: with rows left unloaded, has_more and truncated_by_bytes are true and offset += events.length yields every event once, in rowid order", () => {
    const fx = open();
    const taskId = fx.createTask();
    // 12 rows of ~100 KiB (array of 1 KiB strings): the load budget (512 KiB) takes about five per call.
    const total = 12;
    const ids: string[] = [];
    for (let i = 0; i < total; i++) {
      ids.push(
        fx.seedEvent({ taskId, type: "TOOL_RESULT", createdAt: ts(i), payloadText: JSON.stringify({ i, blob: Array.from({ length: 100 }, () => "p".repeat(1024)) }) }),
      );
    }

    const seen: string[] = [];
    let offset = 0;
    let firstPage: ReturnType<typeof taskEvents> | undefined;
    for (let guard = 0; guard < total + 2; guard++) {
      const { deps, statements } = spiedDeps(fx);
      const page = taskEvents({ task_id: taskId, offset, limit: 500 }, deps);
      firstPage ??= page;
      expect(page.events.length).toBeGreaterThanOrEqual(1);
      expect(payloadBytesRead(statements)).toBeLessThanOrEqual(TASK_EVENTS_MAX_LOAD_BYTES);
      seen.push(...page.events.map((e) => e.id));
      offset += page.events.length;
      expect(page.has_more).toBe(offset < total);
      if (!page.has_more) break;
      expect(page.truncated_by_bytes).toBe(true);
    }

    expect(firstPage!.truncated_by_bytes).toBe(true);
    expect(firstPage!.events.length).toBeLessThan(total);
    expect(seen).toEqual(ids);
  });

  it("plan discovery-sweep-1014 blind-review A2 TEB-B6: neighbours of an invalid_json row and a too_large row still parse, and total is unchanged", () => {
    const fx = open();
    const taskId = fx.createTask();
    const huge = JSON.stringify({ blob: Array.from({ length: 1100 }, () => "h".repeat(1024)) });
    expect(Buffer.byteLength(huge, "utf8")).toBeGreaterThan(TASK_EVENTS_MAX_ROW_BYTES);
    fx.seedEvent({ taskId, type: "A", createdAt: ts(0), payloadText: JSON.stringify({ n: 0 }) });
    fx.seedEvent({ taskId, type: "B", createdAt: ts(1), payloadText: "{not json" });
    fx.seedEvent({ taskId, type: "C", createdAt: ts(2), payloadText: JSON.stringify({ n: 2 }) });
    fx.seedEvent({ taskId, type: "D", createdAt: ts(3), payloadText: huge });
    fx.seedEvent({ taskId, type: "E", createdAt: ts(4), payloadText: JSON.stringify({ n: 4 }) });
    fx.seedEvent({ taskId, type: "F", createdAt: ts(5) });

    const page = taskEvents({ task_id: taskId }, { taskStore: fx.taskStore, db: fx.db });

    expect(page.total).toBe(6);
    expect(page.events.map((e) => e.type)).toEqual(["A", "B", "C", "D", "E", "F"]);
    expect(page.events.map((e) => e.payload)).toEqual([{ n: 0 }, null, { n: 2 }, null, { n: 4 }, null]);
    expect(page.events.map((e) => e.payload_error)).toEqual([undefined, "invalid_json", undefined, "too_large", undefined, undefined]);
    expect(page.events[3]!.payload_bytes).toBeGreaterThan(TASK_EVENTS_MAX_ROW_BYTES);
    expect(page.has_more).toBe(false);
    expect(page.truncated_by_bytes).toBeUndefined();
  });
});
