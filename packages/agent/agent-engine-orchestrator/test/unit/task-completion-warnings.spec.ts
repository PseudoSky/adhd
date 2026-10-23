/**
 * guards: completionWarningsOf throws on a non-JSON TASK_COMPLETED payload, reads an arbitrary row when a task has several TASK_COMPLETED events, or stops filtering unknown warning values
 * tier: S
 * cites: plan discovery-sweep-1014 blind-review A AC1, AC2, AC3
 *
 * plan discovery-sweep-1014 blind-review A AC1 / AC2 / AC3 -- `completionWarningsOf` (tools/task.ts).
 *
 * Failure modes covered:
 *   AC1 (defect): a non-JSON `TASK_COMPLETED` payload makes the unguarded `JSON.parse` throw after the
 *       task already finished, so the tool call loses the result. The read must return undefined, not throw.
 *   AC2 (defect): a task with several `TASK_COMPLETED` events (e.g. after resume) is read with an
 *       unordered `.get()`, so the arbitrary first row wins. The most recent event must win
 *       (ORDER BY created_at DESC, rowid DESC tie-break).
 *   AC3 (regression guard): a single valid event keeps its warnings, a clean event stays undefined,
 *       and unknown warning values stay filtered out (forward compatibility).
 *
 * Tier: S (default). Real migrated sqlite (`createMigratedSqlite`, production migrations, production
 * CHECK enums) and the real `TaskStore`. No stubs: the seam under test is a pure read of persisted rows.
 * Fidelity gap: none; the read is exercised against the same table and index the orchestrator writes.
 *
 * Risk map (Light): the only behaviour changed is the read path of one private helper; the two call sites
 * (taskTool sync and ephemeral returns) are covered by no-tool-use-warning.test.ts for the AC3 happy path.
 *
 * Red run (unfixed completionWarningsOf, before the ORDER BY / guarded-parse change):
 *   `npx vitest run src/__tests__/task-completion-warnings.test.ts` exit 1; 4 failed | 3 passed (7).
 *   AC1 "corrupt ... does not throw": SyntaxError: Unterminated string in JSON at position 21.
 *   AC1 "JSON null ...": TypeError: Cannot read properties of null (reading 'warnings').
 *   AC2 "most recent by created_at": expected undefined to deeply equal [ 'no_tool_use' ].
 *   AC2 "created_at tie": expected [ 'no_tool_use' ] to be undefined.
 *   AC3 controls passed on the unfixed code (they guard the unchanged happy path).
 * Green (after the fix): `npx vitest run src/__tests__/task-completion-warnings.test.ts` exit 0, 7 passed.
 */
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import { TaskStore, taskEventsTable } from '@adhd/agent-store-runtime';

import { completionWarningsOf } from '../../src/tools/task.js';
import { generateId } from '../../src/utils/ids.js';
import { createMigratedSqlite } from '../fixtures/real-schema-db.js';

type Db = Parameters<typeof completionWarningsOf>[0];

interface ISeed {
  db: Db;
  taskId: string;
  insertCompleted(opts: { id: string; payload: string; createdAt: string }): void;
}

/** A migrated database holding one task, plus a helper that appends raw TASK_COMPLETED rows. */
function seed(): ISeed {
  const sqlite = createMigratedSqlite();
  const db = drizzle(sqlite) as unknown as Db;
  const store = new TaskStore(db as never);
  const taskId = generateId();
  store.create({ sessionId: generateId(), prompt: 'do the work', id: taskId });
  return {
    db,
    taskId,
    insertCompleted({ id, payload, createdAt }) {
      (db as unknown as ReturnType<typeof drizzle>)
        .insert(taskEventsTable)
        .values({ id, taskId, type: 'TASK_COMPLETED', payload, createdAt })
        .run();
    },
  };
}

describe('completionWarningsOf (plan discovery-sweep-1014 blind-review A)', () => {
  // AC1: failure mode = unguarded JSON.parse of a corrupt payload throws after the task finished.
  it('AC1: a corrupt TASK_COMPLETED payload reads as no warnings and does not throw', () => {
    const s = seed();
    s.insertCompleted({ id: generateId(), payload: '{"result": "truncated', createdAt: '2026-01-01T00:00:00.000Z' });
    expect(() => completionWarningsOf(s.db, s.taskId)).not.toThrow();
    expect(completionWarningsOf(s.db, s.taskId)).toBeUndefined();
  });

  // AC1 (second corrupt shape): a payload that parses to null has no `.warnings`; the read must not throw.
  it('AC1: a TASK_COMPLETED payload of JSON null reads as no warnings and does not throw', () => {
    const s = seed();
    s.insertCompleted({ id: generateId(), payload: 'null', createdAt: '2026-01-01T00:00:00.000Z' });
    expect(() => completionWarningsOf(s.db, s.taskId)).not.toThrow();
    expect(completionWarningsOf(s.db, s.taskId)).toBeUndefined();
  });

  // AC2: failure mode = arbitrary (insertion-order) row chosen when several TASK_COMPLETED events exist.
  // The STALE event is inserted FIRST, so an unordered .get() returns it (no warning) and the assertion
  // fails; the ordered read returns the newest row's warnings.
  it('AC2: with two TASK_COMPLETED events, the most recent by created_at is read', () => {
    const s = seed();
    s.insertCompleted({
      id: generateId(),
      payload: JSON.stringify({ result: 'r1' }),
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    s.insertCompleted({
      id: generateId(),
      payload: JSON.stringify({ result: 'r2', warnings: ['no_tool_use'] }),
      createdAt: '2026-01-02T00:00:00.000Z',
    });
    expect(completionWarningsOf(s.db, s.taskId)).toEqual(['no_tool_use']);
  });

  // AC2 tie-break: identical created_at, the higher rowid (the later insert) must win.
  it('AC2: on a created_at tie, the later-inserted row (rowid DESC) is read', () => {
    const s = seed();
    const at = '2026-01-03T00:00:00.000Z';
    s.insertCompleted({ id: generateId(), payload: JSON.stringify({ result: 'a', warnings: ['no_tool_use'] }), createdAt: at });
    s.insertCompleted({ id: generateId(), payload: JSON.stringify({ result: 'b' }), createdAt: at });
    expect(completionWarningsOf(s.db, s.taskId)).toBeUndefined();
  });

  // AC3: valid single-event behaviour is unchanged.
  it('AC3: a single valid event keeps its known warnings and drops unknown values', () => {
    const s = seed();
    s.insertCompleted({
      id: generateId(),
      payload: JSON.stringify({ result: 'ok', warnings: ['no_tool_use', 'future_warning_from_newer_engine'] }),
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(completionWarningsOf(s.db, s.taskId)).toEqual(['no_tool_use']);
  });

  it('AC3: a single clean event (no warnings key) reads as undefined', () => {
    const s = seed();
    s.insertCompleted({ id: generateId(), payload: JSON.stringify({ result: 'ok' }), createdAt: '2026-01-01T00:00:00.000Z' });
    expect(completionWarningsOf(s.db, s.taskId)).toBeUndefined();
  });

  it('AC3: no TASK_COMPLETED event at all reads as undefined', () => {
    const s = seed();
    expect(completionWarningsOf(s.db, s.taskId)).toBeUndefined();
  });
});
