import { sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  clipForStorage,
  TOOL_RESULT_EVENT_MAX_CHARS,
  type Database,
  type TaskDeps,
} from '@adhd/agent-engine-orchestrator';

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
 * Longest top-level string field, in UTF-16 code units, a returned payload carries. A longer
 * string is clipped head+tail on read (see `payload_clipped`). The same value bounds what the
 * orchestrator stores in `TOOL_RESULT.result`, so a row written by the current writer is never
 * re-clipped; rows written before that bound existed, or by another writer, are.
 */
export const TASK_EVENTS_MAX_FIELD_CHARS = TOOL_RESULT_EVENT_MAX_CHARS;

/**
 * Largest stored payload, in bytes (UTF-8), the tool will load and parse (1 MiB, 4x the page
 * budget). A row over it is returned as `payload: null` with `payload_error: 'too_large'` and
 * `payload_bytes`; its payload is never read from the database.
 */
export const TASK_EVENTS_MAX_ROW_BYTES = 1024 * 1024;

/**
 * Most payload bytes one call loads from the database (twice the page budget): the page byte
 * bound trims the serialized result, this bounds the memory spent before that trim.
 */
export const TASK_EVENTS_MAX_LOAD_BYTES = 2 * TASK_EVENTS_MAX_PAGE_BYTES;

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
 * `null` when the row has no payload (no `payload_error`), its stored payload is not valid JSON
 * (`payload_error: 'invalid_json'`), or it is larger than {@link TASK_EVENTS_MAX_ROW_BYTES}
 * (`payload_error: 'too_large'`, with `payload_bytes` the stored size).
 *
 * `payload_clipped` is present only when a top-level string field of the payload was longer than
 * {@link TASK_EVENTS_MAX_FIELD_CHARS} and was replaced by its head+tail clip; it lists each such
 * field with its original length. Rows that needed no clip carry none of these keys.
 */
export interface TaskEventRecord {
  id: string;
  type: string;
  created_at: string;
  payload: unknown;
  payload_error?: 'invalid_json' | 'too_large';
  payload_bytes?: number;
  payload_clipped?: Array<{ field: string; original_chars: number }>;
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

/** One row of the phase-1 read: identity and stored payload size, never the payload. */
interface TaskEventMeta {
  rid: number;
  id: string;
  type: string;
  created_at: string;
  bytes: number | null;
}

/** One row of the phase-2 read: the payload of a row phase 1 chose to load. */
interface TaskEventPayloadRow {
  rid: number;
  payload: string | null;
}

/** Size in bytes (UTF-8) of a value's wire text, as the MCP response carries it. */
function wireByteLength(value: unknown): number {
  return Buffer.byteLength(toWireText(value), 'utf8');
}

/**
 * Replaces every top-level string field of a parsed payload longer than
 * {@link TASK_EVENTS_MAX_FIELD_CHARS} with its head+tail clip. Returns the payload unchanged (same
 * reference, no list) when nothing is over the bound or the payload is not a plain object.
 */
function clipLongFields(payload: unknown): {
  payload: unknown;
  clipped: Array<{ field: string; original_chars: number }>;
} {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { payload, clipped: [] };
  }
  const clipped: Array<{ field: string; original_chars: number }> = [];
  let out: Record<string, unknown> | undefined;
  for (const [field, value] of Object.entries(payload as Record<string, unknown>)) {
    if (typeof value !== 'string' || value.length <= TASK_EVENTS_MAX_FIELD_CHARS) continue;
    out ??= { ...(payload as Record<string, unknown>) };
    out[field] = clipForStorage(value, TASK_EVENTS_MAX_FIELD_CHARS).text;
    clipped.push({ field, original_chars: value.length });
  }
  return { payload: out ?? payload, clipped };
}

/**
 * Builds one returned record. A row whose stored payload is larger than
 * {@link TASK_EVENTS_MAX_ROW_BYTES} (`bytes`) is not parsed (its text was never loaded) and
 * yields `payload: null, payload_error: 'too_large'`. A null payload yields `payload: null`; text
 * that is not valid JSON yields `payload: null` with `payload_error: 'invalid_json'`, so one
 * corrupt row cannot fail the whole page. A parsed payload has its over-long top-level string
 * fields clipped (see {@link clipLongFields}).
 */
function toRecord(meta: TaskEventMeta, payloadText: string | null): TaskEventRecord {
  const base = { id: meta.id, type: meta.type, created_at: meta.created_at };
  if (meta.bytes !== null && meta.bytes > TASK_EVENTS_MAX_ROW_BYTES) {
    return { ...base, payload: null, payload_error: 'too_large', payload_bytes: meta.bytes };
  }
  if (payloadText === null) return { ...base, payload: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadText) as unknown;
  } catch {
    return { ...base, payload: null, payload_error: 'invalid_json' };
  }
  const { payload, clipped } = clipLongFields(parsed);
  return clipped.length > 0
    ? { ...base, payload, payload_clipped: clipped }
    : { ...base, payload };
}

/**
 * How many of the page's rows to load. A row costs its stored size, except a row over
 * {@link TASK_EVENTS_MAX_ROW_BYTES}, which is never loaded and costs nothing. The longest prefix
 * whose total stays within {@link TASK_EVENTS_MAX_LOAD_BYTES} is kept, and always at least one row,
 * so a page is never empty because of its size: the most a call reads is therefore
 * max({@link TASK_EVENTS_MAX_LOAD_BYTES}, {@link TASK_EVENTS_MAX_ROW_BYTES}).
 */
function loadablePrefix(meta: readonly TaskEventMeta[]): number {
  let total = 0;
  for (let i = 0; i < meta.length; i++) {
    const bytes = meta[i]!.bytes ?? 0;
    total += bytes > TASK_EVENTS_MAX_ROW_BYTES ? 0 : bytes;
    if (i > 0 && total > TASK_EVENTS_MAX_LOAD_BYTES) return i;
  }
  return meta.length;
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
 * as written by the orchestrator; it is parsed per row (see {@link toRecord}).
 *
 * Memory is bounded before the page is built: only the rows within {@link TASK_EVENTS_MAX_LOAD_BYTES}
 * have their payload read, a row over {@link TASK_EVENTS_MAX_ROW_BYTES} is never read, and rows left
 * unread are reported as trimmed (`truncated_by_bytes`, `has_more`, next offset `offset +
 * events.length`). The serialized page is then bounded by {@link boundPageBytes}.
 *
 * @param input - validated `task_id`, optional `limit` and `offset`.
 * @param deps - the task store (existence check) and the database handle.
 * @returns the requested page plus the total event count for the task.
 */
export function taskEvents(input: TaskEventsInput, deps: TaskEventsDeps): TaskEventsPage {
  deps.taskStore.read(input.task_id);
  const limit = input.limit ?? TASK_EVENTS_DEFAULT_LIMIT;
  const offset = input.offset ?? 0;

  // Phase 1 reads identity and stored size only; phase 2 loads payload text for the rows phase 1
  // chose, skipping any over TASK_EVENTS_MAX_ROW_BYTES. Both run in one read transaction, so
  // `total`, the chosen rows and their payloads come from the same snapshot.
  const { total, kept, payloads } = deps.db.transaction((tx) => {
    const countRows = tx.all(
      sql`SELECT COUNT(*) AS n FROM task_events WHERE task_id = ${input.task_id}`,
    ) as Array<{ n: number }>;
    const meta = tx.all(
      sql`SELECT rowid AS rid, id, type, created_at, length(CAST(payload AS BLOB)) AS bytes
          FROM task_events
          WHERE task_id = ${input.task_id}
          ORDER BY rowid
          LIMIT ${limit} OFFSET ${offset}`,
    ) as TaskEventMeta[];
    const chosen = meta.slice(0, loadablePrefix(meta));
    const loadIds = chosen
      .filter((m) => (m.bytes ?? 0) > 0 && (m.bytes ?? 0) <= TASK_EVENTS_MAX_ROW_BYTES)
      .map((m) => m.rid);
    const loaded =
      loadIds.length === 0
        ? []
        : (tx.all(
            sql`SELECT rowid AS rid, payload FROM task_events
                WHERE rowid IN (${sql.join(
                  loadIds.map((rid) => sql`${rid}`),
                  sql`, `,
                )})`,
          ) as TaskEventPayloadRow[]);
    return {
      total: Number(countRows[0]?.n ?? 0),
      kept: { rows: chosen, trimmed: chosen.length < meta.length },
      payloads: new Map(loaded.map((r) => [r.rid, r.payload] as const)),
    };
  });

  const events = kept.rows.map((m) => toRecord(m, payloads.get(m.rid) ?? null));
  const page: TaskEventsPage = {
    task_id: input.task_id,
    total,
    offset,
    limit,
    has_more: offset + events.length < total,
    events,
    ...(kept.trimmed ? { truncated_by_bytes: true as const } : {}),
  };
  // Rows phase 1 left unloaded are already marked `truncated_by_bytes` on the page; the byte bound
  // keeps that mark when it trims further and when it trims nothing.
  return boundPageBytes(page);
}
