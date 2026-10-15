import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database, TaskDeps } from '@adhd/agent-engine-orchestrator';

/** Page size when `limit` is omitted. */
export const TASK_EVENTS_DEFAULT_LIMIT = 50;

/**
 * Largest number of events a single `task_events` call may request. This caps the event
 * count, not the response size: a page of large events can still exceed the byte budget
 * {@link TASK_EVENTS_MAX_PAGE_BYTES}, which trims trailing events (see `truncated_by_bytes`).
 */
export const TASK_EVENTS_MAX_LIMIT = 500;

/**
 * Upper bound, in bytes, of the page a `task_events` call returns (256 KiB), measured on the
 * wire text {@link toWireText} produces. Trailing events are dropped until the page fits; the
 * first event of a page is always kept, so a single event larger than this budget is returned
 * whole.
 */
export const TASK_EVENTS_MAX_PAGE_BYTES = 256 * 1024;

/**
 * The MCP wire text of a tool result: the value serialized as 2-space-indented JSON. The MCP
 * server's tool-result serializer and the `task_events` byte budget both use this function, so
 * the budget measures exactly the bytes that are sent and the two cannot drift apart.
 *
 * @param value - the tool result payload.
 * @returns the JSON text placed in the MCP `text` content block.
 */
export function toWireText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * Input of the `task_events` MCP tool: every recorded event of one task, oldest first.
 * `limit` defaults to {@link TASK_EVENTS_DEFAULT_LIMIT} and is capped at
 * {@link TASK_EVENTS_MAX_LIMIT}; `offset` skips that many events from the start.
 */
export const taskEventsInputSchema = z.object({
  task_id: z.string().uuid(),
  limit: z.number().int().positive().max(TASK_EVENTS_MAX_LIMIT).optional(),
  offset: z.number().int().nonnegative().optional(),
});

export type TaskEventsInput = z.infer<typeof taskEventsInputSchema>;

/**
 * One persisted `task_events` row as the tool returns it. `payload` is the parsed JSON, or
 * `null` when the row has no payload or its stored payload is not valid JSON; in the latter
 * case `payload_error` is `'invalid_json'` so the consumer can tell the two apart.
 */
export interface TaskEventRecord {
  id: string;
  type: string;
  created_at: string;
  payload: unknown;
  payload_error?: 'invalid_json';
}

/**
 * One page of a task's events. `has_more` is true when `offset + events.length < total`, which
 * includes events trimmed by the byte budget. `truncated_by_bytes` is present (and `true`) only
 * when trailing events were dropped to keep the serialized page within
 * {@link TASK_EVENTS_MAX_PAGE_BYTES}.
 */
export interface TaskEventsPage {
  task_id: string;
  total: number;
  offset: number;
  limit: number;
  has_more: boolean;
  events: TaskEventRecord[];
  truncated_by_bytes?: true;
}

/** Dependencies of {@link taskEvents}: the task store (existence check) and the SQLite handle. */
export interface TaskEventsDeps {
  taskStore: Pick<TaskDeps, 'taskStore'>['taskStore'];
  db: Database;
}

interface TaskEventRow {
  id: string;
  type: string;
  payload: string | null;
  created_at: string;
}

/** Size in bytes (UTF-8) of a value's wire text, as the MCP response carries it. */
function wireByteLength(value: unknown): number {
  return Buffer.byteLength(toWireText(value), 'utf8');
}

/**
 * Parses one row's stored payload. A null column yields `payload: null`; a column that is not
 * valid JSON yields `payload: null` with `payload_error: 'invalid_json'`, so one corrupt row
 * cannot fail the whole page.
 */
function toRecord(row: TaskEventRow): TaskEventRecord {
  const base = { id: row.id, type: row.type, created_at: row.created_at };
  if (row.payload === null) return { ...base, payload: null };
  try {
    return { ...base, payload: JSON.parse(row.payload) as unknown };
  } catch {
    return { ...base, payload: null, payload_error: 'invalid_json' };
  }
}

/**
 * The page holding only its first `keep` events, in the exact shape the byte bound returns.
 * Trimming sets `truncated_by_bytes` and recomputes `has_more` from the kept count.
 */
function pageWithEvents(page: TaskEventsPage, keep: number): TaskEventsPage {
  return {
    ...page,
    events: page.events.slice(0, keep),
    has_more: page.offset + keep < page.total,
    truncated_by_bytes: true,
  };
}

/**
 * Trims trailing events until the page's wire text fits {@link TASK_EVENTS_MAX_PAGE_BYTES}.
 *
 * Each candidate is measured as the full page would be sent, by serializing it with
 * {@link toWireText}. Per-event sizes are not summed: pretty-printing indents a nested event by
 * its depth in the page, so an event's size inside the page differs from its standalone size, and
 * a sum taken outside the page can under-count. The size is monotone in the kept count, so the
 * largest count that fits is found by binary search. The first event is always kept.
 *
 * @param page - the page built from the row query, before the byte bound.
 * @returns the page unchanged when it fits or holds a single event, else a copy with trailing
 *   events dropped and `has_more` / `truncated_by_bytes` set.
 */
function boundPageBytes(page: TaskEventsPage): TaskEventsPage {
  if (wireByteLength(page) <= TASK_EVENTS_MAX_PAGE_BYTES) return page;
  // A lone event that exceeds the budget is returned whole: there is nothing to trim.
  if (page.events.length <= 1) return page;

  // Invariant: `lo` events fit, or `lo` is the first-event floor; `hi` is the largest count
  // still to test. The full page is already known not to fit, so the search starts below it.
  let lo = 1;
  let hi = page.events.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (wireByteLength(pageWithEvents(page, mid)) <= TASK_EVENTS_MAX_PAGE_BYTES) lo = mid;
    else hi = mid - 1;
  }
  return pageWithEvents(page, lo);
}

/**
 * Reads one page of the events recorded for a task, in recorded order (`rowid`, oldest first).
 *
 * Ordering is by `rowid`, the insertion order. Each `TaskStore.appendEvent` insert is one
 * statement that SQLite assigns a unique, monotonically increasing `rowid`, so `rowid` order is
 * the order the rows were inserted. That holds when several processes write concurrently
 * (ADR-0012), because each insert takes its own rowid. `created_at` is taken just before that
 * insert and is not used for ordering: across processes it can disagree with insertion order by
 * clock skew.
 *
 * The COUNT and the page SELECT run in one read transaction, so `total` and `events` come from the
 * same snapshot. Throws the task store's not-found error for an unknown `task_id`, rather than
 * returning an empty page that would look like a task with no events. The `payload` column is JSON
 * as written by the orchestrator; it is parsed per row (see {@link toRecord}). The serialized page is
 * bounded by {@link boundPageBytes}.
 *
 * @param input - validated `task_id`, optional `limit` and `offset`.
 * @param deps - the task store (existence check) and the database handle.
 * @returns the requested page plus the total event count for the task.
 */
export function taskEvents(input: TaskEventsInput, deps: TaskEventsDeps): TaskEventsPage {
  deps.taskStore.read(input.task_id);
  const limit = input.limit ?? TASK_EVENTS_DEFAULT_LIMIT;
  const offset = input.offset ?? 0;

  const { total, rows } = deps.db.transaction((tx) => {
    const countRows = tx.all(
      sql`SELECT COUNT(*) AS n FROM task_events WHERE task_id = ${input.task_id}`,
    ) as Array<{ n: number }>;
    const pageRows = tx.all(
      sql`SELECT id, type, payload, created_at FROM task_events
          WHERE task_id = ${input.task_id}
          ORDER BY rowid
          LIMIT ${limit} OFFSET ${offset}`,
    ) as TaskEventRow[];
    return { total: Number(countRows[0]?.n ?? 0), rows: pageRows };
  });

  const events = rows.map(toRecord);

  return boundPageBytes({
    task_id: input.task_id,
    total,
    offset,
    limit,
    has_more: offset + events.length < total,
    events,
  });
}
