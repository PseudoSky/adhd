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
 * Upper bound, in bytes, of the JSON-serialized page a `task_events` call returns (256 KiB).
 * Trailing events are dropped until the page fits; the first event of a page is always kept,
 * so a single event larger than this budget is returned whole.
 */
export const TASK_EVENTS_MAX_PAGE_BYTES = 256 * 1024;

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

/** Serialized size in bytes (UTF-8) of a value, as the MCP response carries it. */
function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
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
 * Trims trailing events until the serialized page fits {@link TASK_EVENTS_MAX_PAGE_BYTES}.
 *
 * The fit is computed from per-event sizes rather than by re-serializing the page per trim.
 * The envelope is measured with `has_more` and `truncated_by_bytes` set to `false`, the widest
 * boolean literal, so it bounds the final envelope and the returned page never exceeds the cap.
 * The first event is always kept.
 *
 * @param page - the page built from the row query, before the byte bound.
 * @returns the page unchanged when it fits, else a copy with trailing events dropped and
 *   `has_more` / `truncated_by_bytes` set.
 */
function boundPageBytes(page: TaskEventsPage): TaskEventsPage {
  if (jsonByteLength(page) <= TASK_EVENTS_MAX_PAGE_BYTES) return page;

  const envelope = jsonByteLength({ ...page, events: [], has_more: false, truncated_by_bytes: false });
  let used = envelope + jsonByteLength(page.events[0]);
  let keep = 1;
  while (keep < page.events.length) {
    const next = 1 + jsonByteLength(page.events[keep]); // the joining comma plus the event
    if (used + next > TASK_EVENTS_MAX_PAGE_BYTES) break;
    used += next;
    keep++;
  }
  // Nothing was dropped: the only event alone exceeds the budget and is returned whole.
  if (keep === page.events.length) return page;

  return {
    ...page,
    events: page.events.slice(0, keep),
    has_more: page.offset + keep < page.total,
    truncated_by_bytes: true,
  };
}

/**
 * Reads one page of the events recorded for a task, in recorded order (`rowid`, oldest first).
 *
 * Ordering is by `rowid`, the insertion order. `TaskStore.appendEvent` is the writer and inserts
 * each row in one statement, so `rowid` is the order the events were recorded. `created_at` is
 * taken just before that insert and is not used for ordering: under concurrent writers from
 * several processes (ADR-0012) it can disagree with insertion order by clock skew.
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
