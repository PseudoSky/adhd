/**
 * guards: task_events pages out of insertion order, miscounts total/has_more, accepts out-of-range input, or fails a whole page on one corrupt row
 * tier: S
 * cites: facd4aaa AC1; plan discovery-sweep-1014 blind-review A2 TEB-B1 (amended byte-guard cases)
 *
 * facd4aaa AC1 — `task_events` pages a finished task oldest-first with `total`, `has_more` and `offset`,
 * rejects out-of-range input, and degrades per row rather than per page.
 *
 * Failure modes covered (ranked):
 *   1. Ordering: the page is sorted by `created_at` or by `id`/`type` instead of insertion (rowid) order. The
 *      ordering test inserts four rows whose id order, type order and created_at order each differ from
 *      insertion order (the last-inserted row carries the EARLIEST created_at), so any of those sorts fails it.
 *   2. Paging arithmetic: `total`, `has_more` or the offset window drift, so a pager skips or repeats events.
 *   3. Input bounds: `limit` 0 / 501 or `offset` -1 reach SQL instead of being rejected at the boundary.
 *   4. Unknown task: an empty page is returned where the caller needs TASK_NOT_FOUND.
 *   5. One corrupt `payload` row fails the whole page instead of only that row.
 *   6. Byte guard: an oversized page is returned whole (MCP output limit), is measured on compact JSON while
 *      the wire sends 2-space-indented JSON (a page that "fits" compact overflows on the wire), or comes back
 *      as an empty page that claims `has_more: true`, which makes a pager loop forever.
 *
 * Tier: S. Real `TaskStore` and drizzle handle on a migrated file database under `tmp/agent-mcp/task-events/`
 * (removed in `afterEach`); no mocks, no faked seam: every row is seeded through the real schema table, with
 * explicit timestamps (no sleeps, no wall clock).
 *
 * Tag: regression:facd4aaa (AC1: ordering, paging, bounds, per-row parse, byte budget on the wire text).
 * Red: pending (user hold). Tests cannot run until the hold is released. Expected red at facd4aaa^ (the module
 * does not exist there) and at facd4aaa for the byte-guard and corrupt-row cases until the corrector's
 * byte guard and per-row parse guard land.
 */
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { taskEvents, taskEventsInputSchema, TASK_EVENTS_MAX_PAGE_BYTES } from "../../src/tools/task-events.js";
import { createTaskEventsFixture, type TaskEventsFixture } from "../fixtures/task-events-db.js";

const T0 = "2026-01-01T00:00:00.000Z";
const EARLIER = "2025-12-31T23:59:59.000Z";

const fixtures: TaskEventsFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});

function open(): TaskEventsFixture {
  const fixture = createTaskEventsFixture();
  fixtures.push(fixture);
  return fixture;
}

/** The deps `taskEvents` takes in production: the real task store and the drizzle handle. */
function depsOf(fixture: TaskEventsFixture) {
  return { taskStore: fixture.taskStore, db: fixture.db };
}

describe("facd4aaa AC1 ordering: events come back in insertion (rowid) order, not created_at, id or type order", () => {
  // Failure mode 1 (the single ordering test, and its own negative control). The production reader sorts
  // `ORDER BY rowid` (insertion order); `created_at` is not the sort key. Insertion order below is the
  // expected page order. The ids do not sort in insertion order, the types are not
  // alphabetical, and the last-inserted row carries an EARLIER created_at: an ORDER BY id, an ORDER BY type
  // or an ORDER BY created_at each return a different list from the one asserted.
  it("facd4aaa AC1: events are returned in insertion (rowid) order even when a later-inserted event carries an earlier created_at", () => {
    const fx = open();
    const taskId = fx.createTask();
    fx.seedEvent({ id: "ffffffff-0000-4000-8000-000000000001", taskId, type: "TOOL_RESULT", createdAt: T0, payloadText: "{}" });
    fx.seedEvent({ id: "eeeeeeee-0000-4000-8000-000000000002", taskId, type: "MODEL_REQUEST", createdAt: T0, payloadText: "{}" });
    fx.seedEvent({ id: "00000000-0000-4000-8000-000000000003", taskId, type: "TOOL_CALL", createdAt: T0, payloadText: "{}" });
    fx.seedEvent({ id: "99999999-0000-4000-8000-000000000004", taskId, type: "TASK_COMPLETED", createdAt: EARLIER, payloadText: "{}" });

    const page = taskEvents({ task_id: taskId }, depsOf(fx));

    expect(page.events.map((e) => e.type)).toEqual(["TOOL_RESULT", "MODEL_REQUEST", "TOOL_CALL", "TASK_COMPLETED"]);
    expect(page.events.map((e) => e.id)).toEqual([
      "ffffffff-0000-4000-8000-000000000001",
      "eeeeeeee-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000003",
      "99999999-0000-4000-8000-000000000004",
    ]);
  });
});

describe("facd4aaa AC1 paging: total, has_more and offset agree with the stored events", () => {
  // Failure mode 2. Five events, paged in windows of two; the concatenation must be the full list.
  it("facd4aaa AC1: windows of two cover all five events once, total is 5, has_more falls to false on the last window", () => {
    const fx = open();
    const taskId = fx.createTask();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        fx.seedEvent({ id: `0000000${i}-0000-4000-8000-00000000000${i}`, taskId, type: "MODEL_RESPONSE", createdAt: `2026-01-01T00:00:0${i}.000Z`, payloadText: JSON.stringify({ n: i }) }),
      );
    }

    const first = taskEvents({ task_id: taskId, limit: 2, offset: 0 }, depsOf(fx));
    const second = taskEvents({ task_id: taskId, limit: 2, offset: 2 }, depsOf(fx));
    const third = taskEvents({ task_id: taskId, limit: 2, offset: 4 }, depsOf(fx));
    const past = taskEvents({ task_id: taskId, limit: 2, offset: 5 }, depsOf(fx));

    expect(first.total).toBe(5);
    expect(first.has_more).toBe(true);
    expect(second.has_more).toBe(true);
    expect(third.events).toHaveLength(1);
    expect(third.has_more).toBe(false);
    expect(past.events).toHaveLength(0);
    expect(past.has_more).toBe(false);
    expect(past.total).toBe(5);
    const concatenated = [...first.events, ...second.events, ...third.events].map((e) => e.id);
    expect(concatenated).toEqual(ids);
  });

  // Failure mode 2 (boundary). The default page is 50 events; with 51 seeded, the 51st is on the next page.
  it("facd4aaa AC1: an omitted limit returns 50 events with has_more true for 51 seeded events", () => {
    const fx = open();
    const taskId = fx.createTask();
    for (let i = 0; i < 51; i++) {
      fx.seedEvent({ taskId, type: "TOOL_CALL", createdAt: T0, payloadText: "{}" });
    }

    const page = taskEvents({ task_id: taskId }, depsOf(fx));

    expect(page.limit).toBe(50);
    expect(page.events).toHaveLength(50);
    expect(page.total).toBe(51);
    expect(page.has_more).toBe(true);
  });

  // Failure mode 2 (scope). Events of another task must not leak into this task's total or page.
  it("facd4aaa AC1: total and events count only the requested task's rows", () => {
    const fx = open();
    const mine = fx.createTask();
    const other = fx.createTask();
    fx.seedEvent({ taskId: mine, type: "TOOL_CALL", createdAt: T0, payloadText: "{}" });
    fx.seedEvent({ taskId: other, type: "TOOL_CALL", createdAt: T0, payloadText: "{}" });
    fx.seedEvent({ taskId: other, type: "TOOL_RESULT", createdAt: T0, payloadText: "{}" });

    const page = taskEvents({ task_id: mine }, depsOf(fx));

    expect(page.total).toBe(1);
    expect(page.events).toHaveLength(1);
    expect(page.events[0]!.type).toBe("TOOL_CALL");
  });
});

describe("facd4aaa AC1 input bounds: out-of-range input is rejected at the schema", () => {
  // Failure mode 3. Each rejection asserts the issue path, so a schema that rejects for an unrelated reason
  // (for example a missing field) cannot satisfy the test.
  const valid = { task_id: "11111111-1111-4111-8111-111111111111" };

  it("facd4aaa AC1: limit 501 is rejected with an issue on the limit path", () => {
    const result = taskEventsInputSchema.safeParse({ ...valid, limit: 501 });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join("."))).toContain("limit");
  });

  it("facd4aaa AC1: limit 500 (the maximum) is accepted", () => {
    expect(taskEventsInputSchema.safeParse({ ...valid, limit: 500 }).success).toBe(true);
  });

  it("facd4aaa AC1: limit 0 is rejected (the lower boundary is positive)", () => {
    const result = taskEventsInputSchema.safeParse({ ...valid, limit: 0 });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join("."))).toContain("limit");
  });

  it("facd4aaa AC1: offset -1 is rejected with an issue on the offset path", () => {
    const result = taskEventsInputSchema.safeParse({ ...valid, offset: -1 });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join("."))).toContain("offset");
  });

  it("facd4aaa AC1: offset 0 is accepted (the lower boundary is non-negative)", () => {
    expect(taskEventsInputSchema.safeParse({ ...valid, offset: 0 }).success).toBe(true);
  });

  it("facd4aaa AC1: a non-uuid task_id is rejected with an issue on the task_id path", () => {
    const result = taskEventsInputSchema.safeParse({ task_id: "not-a-uuid" });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join("."))).toContain("task_id");
  });
});

describe("facd4aaa AC1 unknown task: a missing task is an error, not an empty page", () => {
  // Failure mode 4. Asserts the store's TASK_NOT_FOUND code, not merely that something rejected.
  it("facd4aaa AC1: an unknown uuid rejects with code TASK_NOT_FOUND", () => {
    const fx = open();
    const unknown = randomUUID();

    let caught: unknown;
    try {
      taskEvents({ task_id: unknown }, depsOf(fx));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(caught).toMatchObject({ code: "TASK_NOT_FOUND" });
  });

  it("facd4aaa AC1: a known task with no events returns total 0 and an empty page (not an error)", () => {
    const fx = open();
    const taskId = fx.createTask();

    const page = taskEvents({ task_id: taskId }, depsOf(fx));

    expect(page.total).toBe(0);
    expect(page.events).toEqual([]);
    expect(page.has_more).toBe(false);
  });
});

describe("facd4aaa AC1 corrupt payload: one unparseable row degrades that row only", () => {
  // Failure mode 5. The corrupt row is written as raw text with the sqlite handle; the typed insert cannot
  // express it. The neighbouring rows must still parse and carry no payload_error.
  it("facd4aaa AC1: a row whose payload is not JSON returns payload null and payload_error invalid_json; the page still resolves", () => {
    const fx = open();
    const taskId = fx.createTask();
    const goodA = fx.seedEvent({ taskId, type: "MODEL_REQUEST", createdAt: "2026-01-01T00:00:01.000Z", payloadText: JSON.stringify({ advertisedToolNames: ["a"] }) });
    const bad = randomUUID();
    fx.sqlite
      .prepare("INSERT INTO task_events (id, task_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(bad, taskId, "TOOL_RESULT", "{not json", "2026-01-01T00:00:02.000Z");
    const goodB = fx.seedEvent({ taskId, type: "TASK_COMPLETED", createdAt: "2026-01-01T00:00:03.000Z", payloadText: JSON.stringify({ ok: true }) });

    const page = taskEvents({ task_id: taskId }, depsOf(fx));

    expect(page.total).toBe(3);
    expect(page.events.map((e) => e.id)).toEqual([goodA, bad, goodB]);
    const corrupt = page.events[1]!;
    expect(corrupt.payload).toBeNull();
    expect((corrupt as { payload_error?: string }).payload_error).toBe("invalid_json");
    expect(page.events[0]!.payload).toEqual({ advertisedToolNames: ["a"] });
    expect(page.events[2]!.payload).toEqual({ ok: true });
    expect((page.events[0] as { payload_error?: string }).payload_error).toBeUndefined();
    expect((page.events[2] as { payload_error?: string }).payload_error).toBeUndefined();
  });

  it("facd4aaa AC1: a row with SQL NULL payload returns payload null with no payload_error (absent is not corrupt)", () => {
    const fx = open();
    const taskId = fx.createTask();
    fx.seedEvent({ taskId, type: "TASK_COMPLETED", createdAt: T0 });

    const page = taskEvents({ task_id: taskId }, depsOf(fx));

    expect(page.events[0]!.payload).toBeNull();
    expect((page.events[0] as { payload_error?: string }).payload_error).toBeUndefined();
  });
});

describe("facd4aaa AC1 byte guard: an oversized page is cut to the response budget, never emptied", () => {
  // Failure mode 6. The budget is TASK_EVENTS_MAX_PAGE_BYTES of the WIRE text, which the MCP server builds with
  // JSON.stringify(value, null, 2). Every size below is measured that way, never on compact JSON.
  // A payload field is an ARRAY of 1 KiB strings, not one 64 KiB string: a top-level string field over
  // TASK_EVENTS_MAX_FIELD_CHARS is clipped on read (plan discovery-sweep-1014 blind-review A2 TEB-B1), so a
  // single long string no longer makes a big payload. The array keeps the stored size (about 64 KiB) and
  // the byte-guard intent, and no string in it reaches the field bound.
  const SIXTY_FOUR_KIB = Array.from({ length: 64 }, () => "x".repeat(1024));
  const wireBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value, null, 2), "utf8");
  type Page = Record<string, unknown> & { events: unknown[]; total: number; has_more: boolean };

  it("facd4aaa AC1: six 64 KiB rows return a page whose wire size fits the budget, truncated_by_bytes true, at least one and fewer than six events, has_more true", () => {
    const fx = open();
    const taskId = fx.createTask();
    for (let i = 0; i < 6; i++) {
      fx.seedEvent({ taskId, type: "TOOL_RESULT", createdAt: `2026-01-01T00:00:0${i}.000Z`, payloadText: JSON.stringify({ blob: SIXTY_FOUR_KIB }) });
    }

    const page = taskEvents({ task_id: taskId }, depsOf(fx)) as unknown as Page;

    expect(page.total).toBe(6);
    expect(page.truncated_by_bytes).toBe(true);
    expect(page.events.length).toBeGreaterThanOrEqual(1);
    expect(page.events.length).toBeLessThan(6);
    expect(page.has_more).toBe(true);
    expect(wireBytes(page)).toBeLessThanOrEqual(TASK_EVENTS_MAX_PAGE_BYTES);
  });

  // Failure mode 6 (indentation). 500 events of ~350 byte payloads: the page is under the budget as compact
  // JSON (239613 bytes) and over it as the 2-space-indented wire text (269141 bytes). A bound that measures
  // compact JSON returns all 500 events and the wire text overflows the 256 KiB (262144) budget.
  it("facd4aaa AC1: a page that fits as compact JSON but overflows as indented wire text is trimmed, flagged truncated_by_bytes, and has_more stays truthful", () => {
    const fx = open();
    const taskId = fx.createTask();
    const blob = "z".repeat(350);
    const count = 500;
    for (let i = 0; i < count; i++) {
      fx.seedEvent({ taskId, type: "TOOL_RESULT", createdAt: T0, payloadText: JSON.stringify({ blob }) });
    }

    const page = taskEvents({ task_id: taskId, limit: count }, depsOf(fx)) as unknown as Page;

    // Precondition, computed from the returned events' own shape: the untrimmed page sits between the two measures.
    const untrimmed = { ...page, events: Array.from({ length: count }, (_, i) => ({ ...(page.events[0] as object), id: String(i).padStart(36, "0") })) };
    expect(Buffer.byteLength(JSON.stringify(untrimmed), "utf8")).toBeLessThanOrEqual(TASK_EVENTS_MAX_PAGE_BYTES);
    expect(wireBytes(untrimmed)).toBeGreaterThan(TASK_EVENTS_MAX_PAGE_BYTES);

    expect(page.total).toBe(count);
    expect(page.truncated_by_bytes).toBe(true);
    expect(page.events.length).toBeGreaterThanOrEqual(1);
    expect(page.events.length).toBeLessThan(count);
    expect(page.has_more).toBe(true);
    expect(wireBytes(page)).toBeLessThanOrEqual(TASK_EVENTS_MAX_PAGE_BYTES);
  });

  it("facd4aaa AC1: a single oversized event (300 KiB, over the budget alone) is returned whole as exactly one event, with has_more true while another follows", () => {
    const fx = open();
    const taskId = fx.createTask();
    // 300 KiB as an array of 1 KiB strings (non-string structure): a lone event over the page budget that
    // the per-field clip does not shrink, so the "first event is always kept" rule is what returns it whole.
    const huge = JSON.stringify({ blob: Array.from({ length: 300 }, () => "y".repeat(1024)) });
    fx.seedEvent({ taskId, type: "TOOL_RESULT", createdAt: T0, payloadText: huge });
    fx.seedEvent({ taskId, type: "TOOL_RESULT", createdAt: "2026-01-01T00:00:01.000Z", payloadText: JSON.stringify({ small: true }) });

    const page = taskEvents({ task_id: taskId }, depsOf(fx)) as unknown as Page;

    expect(page.events).toHaveLength(1);
    expect((page.events[0] as { payload: { blob: string[] } }).payload.blob.join("")).toHaveLength(300 * 1024);
    expect(page.truncated_by_bytes).toBe(true);
    expect(page.has_more).toBe(true);
    // The pager can advance: the next window starts at offset 1 and returns the second event.
    const next = taskEvents({ task_id: taskId, offset: 1 }, depsOf(fx)) as unknown as Page;
    expect(next.events).toHaveLength(1);
    expect(next.has_more).toBe(false);
  });

  it("facd4aaa AC1 NEGATIVE CONTROL: a small page carries no truncated_by_bytes flag", () => {
    const fx = open();
    const taskId = fx.createTask();
    fx.seedEvent({ taskId, type: "TOOL_CALL", createdAt: T0, payloadText: JSON.stringify({ tiny: 1 }) });

    const page = taskEvents({ task_id: taskId }, depsOf(fx)) as unknown as Page;

    expect(page.truncated_by_bytes).toBeUndefined();
    expect(page.has_more).toBe(false);
  });
});
