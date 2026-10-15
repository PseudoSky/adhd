import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database, TaskDeps } from '@adhd/agent-engine-orchestrator';

/** Page size when `limit` is omitted. */
export const TASK_EVENTS_DEFAULT_LIMIT = 50;

/** Largest page a single `task_events` call may request (bounds the MCP response size). */
export const TASK_EVENTS_MAX_LIMIT = 500;

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

/** One persisted `task_events` row as the tool returns it; `payload` is the parsed JSON. */
export interface TaskEventRecord {
  id: string;
  type: string;
  created_at: string;
  payload: unknown;
}

/** One page of a task's events. `has_more` is true when `offset + events.length < total`. */
export interface TaskEventsPage {
  task_id: string;
  total: number;
  offset: number;
  limit: number;
  has_more: boolean;
  events: TaskEventRecord[];
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

/**
 * Reads one page of the events recorded for a task, ordered by `created_at` then insertion
 * order (`rowid`), so events written in the same millisecond keep their emit order.
 *
 * Throws the task store's not-found error for an unknown `task_id`, rather than returning an
 * empty page that would look like a task with no events. The `payload` column is JSON as
 * written by the orchestrator; it is parsed here, so a consumer gets structured data.
 *
 * @param input - validated `task_id`, optional `limit` and `offset`.
 * @param deps - the task store (existence check) and the database handle.
 * @returns the requested page plus the total event count for the task.
 */
export function taskEvents(input: TaskEventsInput, deps: TaskEventsDeps): TaskEventsPage {
  deps.taskStore.read(input.task_id);
  const limit = input.limit ?? TASK_EVENTS_DEFAULT_LIMIT;
  const offset = input.offset ?? 0;

  const countRows = deps.db.all(
    sql`SELECT COUNT(*) AS n FROM task_events WHERE task_id = ${input.task_id}`,
  ) as Array<{ n: number }>;
  const total = Number(countRows[0]?.n ?? 0);

  const rows = deps.db.all(
    sql`SELECT id, type, payload, created_at FROM task_events
        WHERE task_id = ${input.task_id}
        ORDER BY created_at, rowid
        LIMIT ${limit} OFFSET ${offset}`,
  ) as TaskEventRow[];

  const events: TaskEventRecord[] = rows.map((row) => ({
    id: row.id,
    type: row.type,
    created_at: row.created_at,
    payload: row.payload === null ? null : JSON.parse(row.payload),
  }));

  return {
    task_id: input.task_id,
    total,
    offset,
    limit,
    has_more: offset + events.length < total,
    events,
  };
}
