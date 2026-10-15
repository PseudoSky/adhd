/**
 * facd4aaa AC1 — `task_events` pages a finished task oldest-first with `total`, `has_more` and `offset`,
 * rejects out-of-range input, and degrades per row rather than per page.
 *
 * Failure modes covered (ranked):
 *   1. Ordering: events sharing one `created_at` lose their emit order (an `ORDER BY id` or a type index
 *      scan would pass a naive test; this one inserts with ids and types that disagree with emit order).
 *   2. Paging arithmetic: `total`, `has_more` or the offset window drift, so a pager skips or repeats events.
 *   3. Input bounds: `limit` 0 / 501 or `offset` -1 reach SQL instead of being rejected at the boundary.
 *   4. Unknown task: an empty page is returned where the caller needs TASK_NOT_FOUND.
 *   5. One corrupt `payload` row fails the whole page instead of only that row.
 *   6. Byte guard: an oversized page is returned whole (MCP output limit) or as an empty page that claims
 *      `has_more: true`, which makes a pager loop forever.
 *
 * Tier: S. Real `TaskStore` and drizzle handle on a migrated file database under `tmp/agent-mcp/task-events/`
 * (removed in `afterEach`); no mocks. The only seam faked is none: every row is seeded through the real
 * schema table, with explicit timestamps (no sleeps, no wall clock).
 *
 * Red evidence: pending; tests cannot run until the hold is released. Expected red at facd4aaa^ (the module
 * does not exist there) and at facd4aaa for the byte-guard and corrupt-row cases until the corrector's
 * byte guard and per-row parse guard land.
 */
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { taskEvents, taskEventsInputSchema } from "../tools/task-events.js";
import { createTaskEventsFixture, type TaskEventsFixture } from "./fixtures/task-events-db.js";

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

describe("facd4aaa AC1 ordering: events sharing one created_at keep their emit order", () => {
  // Failure mode 1. The production reader sorts `ORDER BY rowid` (insertion order); `created_at` is not the
  // sort key. Insertion order below is the expected page order. The ids sort in the reverse of that order,
  // the types are not alphabetical, and the last-inserted row carries an EARLIER created_at: an
  // ORDER BY id, a type-index scan, or a created_at sort each return a different list.
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

  it("facd4aaa AC1 NEGATIVE CONTROL: an id-ordered list of the same rows would not match the expected emit order", () => {
    // Pins the test's teeth: the seeding above is only meaningful if id order differs from emit order.
    const emitIds = [
      "ffffffff-0000-4000-8000-000000000001",
      "eeeeeeee-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000003",
    ];
    expect([...emitIds].sort()).not.toEqual(emitIds);
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
  // Failure mode 6. Budget is 256 KiB of serialized page. Case A: several rows that together exceed it.
  // Case B: one row over the whole budget, which must still come back alone (an empty page with has_more
  // true would make a pager loop forever on the same offset).
  const SIXTY_FOUR_KIB = "x".repeat(64 * 1024);

  it("facd4aaa AC1: six 64 KiB rows return a truncated page with truncated_by_bytes true, at least one and fewer than six events, and has_more true", () => {
    const fx = open();
    const taskId = fx.createTask();
    for (let i = 0; i < 6; i++) {
      fx.seedEvent({ taskId, type: "TOOL_RESULT", createdAt: `2026-01-01T00:00:0${i}.000Z`, payloadText: JSON.stringify({ blob: SIXTY_FOUR_KIB }) });
    }

    const page = taskEvents({ task_id: taskId }, depsOf(fx)) as unknown as Record<string, unknown> & { events: unknown[]; total: number; has_more: boolean };

    expect(page.total).toBe(6);
    expect(page.truncated_by_bytes).toBe(true);
    expect(page.events.length).toBeGreaterThanOrEqual(1);
    expect(page.events.length).toBeLessThan(6);
    expect(page.has_more).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(256 * 1024);
  });

  it("facd4aaa AC1: a single 300 KiB row (over the budget alone) is returned as exactly one event with truncated_by_bytes true", () => {
    const fx = open();
    const taskId = fx.createTask();
    const huge = JSON.stringify({ blob: "y".repeat(300 * 1024) });
    fx.seedEvent({ taskId, type: "TOOL_RESULT", createdAt: T0, payloadText: huge });
    fx.seedEvent({ taskId, type: "TOOL_RESULT", createdAt: "2026-01-01T00:00:01.000Z", payloadText: JSON.stringify({ small: true }) });

    const page = taskEvents({ task_id: taskId }, depsOf(fx)) as unknown as Record<string, unknown> & { events: unknown[]; has_more: boolean };

    expect(page.events).toHaveLength(1);
    expect(page.truncated_by_bytes).toBe(true);
    expect(page.has_more).toBe(true);
  });

  it("facd4aaa AC1 NEGATIVE CONTROL: a small page carries no truncated_by_bytes flag", () => {
    const fx = open();
    const taskId = fx.createTask();
    fx.seedEvent({ taskId, type: "TOOL_CALL", createdAt: T0, payloadText: JSON.stringify({ tiny: 1 }) });

    const page = taskEvents({ task_id: taskId }, depsOf(fx)) as unknown as Record<string, unknown>;

    expect(page.truncated_by_bytes).not.toBe(true);
  });
});
