/**
 * live-guard-core.spec.ts — default-running, model-free coverage for the guarded
 * live runner's hard guards (`./live-guard-core.ts`).
 *
 * The live runner itself (`run-live-guarded.ts`) is env-gated because it calls a
 * real, billed model. The GUARDS it relies on, however, are pure functions over a
 * SQLite telemetry store and MUST be provably correct without spending a cent —
 * so they live in `live-guard-core.ts` and are driven here against a real
 * better-sqlite3 DB seeded with the production tables.
 *
 * Assertions have teeth: each cap is tested at the boundary (== cap passes) and
 * just over it (throws a `GuardAbort` with the matching reason), so loosening a
 * comparison in `live-guard-core.ts` turns a case red.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { REPO_ROOT } from '../helpers/agent-mcp-registry.js';

import {
  enforcePostRun,
  GuardAbort,
  readUsageSnapshot,
  RunMonitor,
  type GuardConfig,
  type UsageSnapshot,
} from './live-guard-core.js';

// Reuse the helper's repo root (it resolves it correctly; its `import.meta`
// usage is an already-baselined spec-corpus type error, so importing it adds no
// NEW error here). Own `tmp/<package>/` namespace for this spec.
const TMP_ROOT = join(REPO_ROOT, 'tmp', 'dispatch-cli', 'live-guard-core');

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

/** Create the production table subset the guards read, and return the db path. */
function seedDb(seed: (db: InstanceType<typeof Database>) => void): string {
  mkdirSync(TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TMP_ROOT, 'db-'));
  scratchDirs.push(dir);
  const dbPath = join(dir, 'agents.db');
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE task_usage (task_id TEXT PRIMARY KEY, est_cost_usd REAL, model_calls INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE messages (content TEXT, tool_calls TEXT, tool_results TEXT);
      CREATE TABLE tasks (prompt TEXT, result TEXT);
      CREATE TABLE task_events (payload TEXT);
    `);
    seed(db);
  } finally {
    db.close();
  }
  return dbPath;
}

function cfg(dbPath: string, overrides: Partial<GuardConfig> = {}): GuardConfig {
  return {
    dbPath,
    maxTurns: 12,
    maxCostUsd: 0.1,
    maxMsgBytes: 262144,
    pollMs: 1000,
    proxy: undefined,
    modelLabel: 'deepseek-v4-flash',
    ...overrides,
  };
}

function snap(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return { costUsd: 0, modelCalls: 0, tasks: 0, unpricedTasks: 0, maxMsgBytes: 0, ...overrides };
}

describe('readUsageSnapshot', () => {
  it('returns null for a missing DB (a skipped tick), never throws', () => {
    expect(readUsageSnapshot(join(TMP_ROOT, 'does-not-exist.db'))).toBeNull();
  });

  it('sums cumulative cost + model calls, counts tasks, and flags unpriced tasks', () => {
    const dbPath = seedDb((db) => {
      db.exec(`
        INSERT INTO task_usage (task_id, est_cost_usd, model_calls) VALUES
          ('t1', 0.5, 3),
          ('t2', NULL, 2);
      `);
    });
    const s = readUsageSnapshot(dbPath);
    expect(s).not.toBeNull();
    expect(s?.costUsd).toBeCloseTo(0.5, 9);
    expect(s?.modelCalls).toBe(5);
    expect(s?.tasks).toBe(2);
    expect(s?.unpricedTasks).toBe(1);
  });

  it('measures the largest single message byte-length across every message table', () => {
    // `€` is 3 UTF-8 bytes: plain LENGTH() would report 3, so a byte-accurate
    // read must report 9 — the difference between this and character count is
    // exactly what the message-size guard must not under-report.
    const dbPath = seedDb((db) => {
      db.prepare(`INSERT INTO messages (content, tool_calls, tool_results) VALUES (?, ?, ?)`).run(
        '€€€',
        '{"a":1}',
        null
      );
      db.prepare(`INSERT INTO tasks (prompt, result) VALUES (?, ?)`).run('short', 'x'.repeat(40));
      db.prepare(`INSERT INTO task_events (payload) VALUES (?)`).run('{"z":1}');
    });
    const s = readUsageSnapshot(dbPath);
    expect(s?.maxMsgBytes).toBe(40); // the 40-byte task result dominates
    expect(s?.maxMsgBytes).toBeGreaterThanOrEqual(9); // the multibyte content is counted in bytes
  });

  it('counts a multibyte message at its byte length, not its character length', () => {
    const dbPath = seedDb((db) => {
      db.exec(`INSERT INTO messages (content) VALUES ('€€€');`);
    });
    expect(readUsageSnapshot(dbPath)?.maxMsgBytes).toBe(9);
  });

  it('returns all-zero metrics for an empty (but present) store', () => {
    const s = readUsageSnapshot(seedDb(() => undefined));
    expect(s).toEqual({ costUsd: 0, modelCalls: 0, tasks: 0, unpricedTasks: 0, maxMsgBytes: 0 });
  });
});

describe('enforcePostRun — turn cap', () => {
  it('passes at exactly the cap and throws one over it', () => {
    expect(() => enforcePostRun(snap({ modelCalls: 12 }), cfg('x'))).not.toThrow();
    expect(() => enforcePostRun(snap({ modelCalls: 13 }), cfg('x'))).toThrowError(
      expect.objectContaining({ reason: 'turn-count-exceeded' })
    );
  });
});

describe('enforcePostRun — cost cap', () => {
  it('passes at exactly the cap and throws one over it', () => {
    expect(() => enforcePostRun(snap({ costUsd: 0.1 }), cfg('x'))).not.toThrow();
    expect(() => enforcePostRun(snap({ costUsd: 0.1 + 1e-9 }), cfg('x'))).toThrowError(
      expect.objectContaining({ reason: 'cost-exceeded' })
    );
  });
});

describe('enforcePostRun — message-size cap', () => {
  it('passes at exactly the cap and throws one byte over it', () => {
    expect(() => enforcePostRun(snap({ maxMsgBytes: 262144 }), cfg('x'))).not.toThrow();
    expect(() => enforcePostRun(snap({ maxMsgBytes: 262145 }), cfg('x'))).toThrowError(
      expect.objectContaining({ reason: 'message-size-exceeded' })
    );
  });
});

describe('enforcePostRun — unpriceable telemetry', () => {
  it('fails loudly when a task made model calls but its cost is NULL and no proxy meters it', () => {
    expect(() =>
      enforcePostRun(snap({ modelCalls: 1, unpricedTasks: 1 }), cfg('x'))
    ).toThrowError(expect.objectContaining({ reason: 'cost-telemetry-unavailable' }));
  });

  it('does NOT fail on unpriceable cost when a proxy is configured to meter spend', () => {
    expect(() =>
      enforcePostRun(snap({ modelCalls: 1, unpricedTasks: 1 }), cfg('x', { proxy: 'http://meter' }))
    ).not.toThrow();
  });

  it('does NOT fail when nothing made a model call yet', () => {
    expect(() =>
      enforcePostRun(snap({ modelCalls: 0, unpricedTasks: 0 }), cfg('x'))
    ).not.toThrow();
  });
});

describe('enforcePostRun — missing store', () => {
  it('refuses to report success when the spawned agent-mcp wrote no telemetry', () => {
    expect(() => enforcePostRun(null, cfg('x'))).toThrowError(
      expect.objectContaining({ reason: 'telemetry-store-missing' })
    );
  });
});

describe('RunMonitor', () => {
  it('fires onKill exactly once with cost-exceeded when the running cost crosses the cap', () => {
    const dbPath = seedDb((db) => {
      db.exec(`INSERT INTO task_usage (task_id, est_cost_usd, model_calls) VALUES ('t1', 0.5, 1);`);
    });
    const kills: GuardAbort[] = [];
    const monitor = new RunMonitor(cfg(dbPath, { maxCostUsd: 0.1 }), (err) => kills.push(err));
    monitor.tickNow(); // no interval timer — deterministic
    expect(kills).toHaveLength(1);
    expect(kills[0]).toBeInstanceOf(GuardAbort);
    expect(kills[0]?.reason).toBe('cost-exceeded');
    // It stopped itself: a second poll must not fire again.
    monitor.tickNow();
    expect(kills).toHaveLength(1);
  });

  it('does not fire while under every cap', () => {
    const dbPath = seedDb((db) => {
      db.exec(`INSERT INTO task_usage (task_id, est_cost_usd, model_calls) VALUES ('t1', 0.01, 1);`);
    });
    const kills: GuardAbort[] = [];
    const monitor = new RunMonitor(cfg(dbPath), (err) => kills.push(err));
    monitor.tickNow();
    expect(kills).toHaveLength(0);
    expect(monitor.snapshot?.costUsd).toBeCloseTo(0.01, 9);
  });

  it('fires cost-telemetry-unavailable on an unpriced task with no proxy', () => {
    const dbPath = seedDb((db) => {
      db.exec(`INSERT INTO task_usage (task_id, est_cost_usd, model_calls) VALUES ('t1', NULL, 1);`);
    });
    const kills: GuardAbort[] = [];
    new RunMonitor(cfg(dbPath), (err) => kills.push(err)).tickNow();
    expect(kills[0]?.reason).toBe('cost-telemetry-unavailable');
  });
});
