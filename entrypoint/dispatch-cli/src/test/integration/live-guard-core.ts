/**
 * live-guard-core.ts — the hard-guard primitives for the guarded live runner.
 *
 * Extracted from `run-live-guarded.ts` so they are (a) unit-testable with a real
 * SQLite fixture and no model cost, and (b) reusable. This module has NO
 * side effects: importing it never runs a run. The runner (`run-live-guarded.ts`)
 * is the self-executing consumer; `live-guard-core.spec.ts` drives these against
 * a seeded store.
 *
 * The guards read the SPAWNED agent-mcp's real telemetry store — the same
 * `task_usage` / `messages` / `tasks` / `task_events` tables `usage_query`
 * aggregates. `est_cost_usd` is written incrementally per model call (agent
 * `usage-plugin.ts`), so polling the store mid-run yields a live cumulative cost.
 */

import { existsSync } from 'node:fs';

import Database from 'better-sqlite3';

/** Thrown when a hard guard trips. Carries the reason + observed evidence. */
export class GuardAbort extends Error {
  constructor(
    readonly reason: string,
    readonly evidence: Record<string, unknown>
  ) {
    super(`[GUARD-KILL:${reason}] ${JSON.stringify(evidence)}`);
    this.name = 'GuardAbort';
  }
}

export interface UsageSnapshot {
  /** Cumulative `SUM(task_usage.est_cost_usd)` (0 when no rows yet). */
  costUsd: number;
  /** Cumulative `SUM(task_usage.model_calls)`. */
  modelCalls: number;
  tasks: number;
  /** Tasks that made model calls but whose cost is NULL (unpriceable model). */
  unpricedTasks: number;
  /** Largest single stored message byte-length across all message-bearing tables. */
  maxMsgBytes: number;
}

export interface GuardConfig {
  dbPath: string;
  maxTurns: number;
  maxCostUsd: number;
  maxMsgBytes: number;
  pollMs: number;
  /** Configured proxy, or undefined. When unset, unpriceable cost is fatal. */
  proxy: string | undefined;
  /** Human-readable model label used in evidence. */
  modelLabel: string;
}

/**
 * Read the child's real telemetry store (read-only, separate connection).
 * Returns `null` when the DB does not exist yet or is momentarily locked (a
 * skipped tick, never a crash).
 */
export function readUsageSnapshot(dbPath: string): UsageSnapshot | null {
  if (!existsSync(dbPath)) return null;
  let raw: InstanceType<typeof Database> | null = null;
  try {
    raw = new Database(dbPath, { readonly: true, fileMustExist: true });
    raw.pragma('busy_timeout = 500');
    const usage = raw
      .prepare(
        `SELECT
           COALESCE(SUM(est_cost_usd), 0) AS costUsd,
           COALESCE(SUM(model_calls), 0) AS modelCalls,
           COUNT(*) AS tasks,
           COALESCE(SUM(CASE WHEN est_cost_usd IS NULL THEN 1 ELSE 0 END), 0) AS unpricedTasks
         FROM task_usage`
      )
      .get() as {
      costUsd: number;
      modelCalls: number;
      tasks: number;
      unpricedTasks: number;
    };
    // `LENGTH(CAST(x AS BLOB))` is byte-accurate; plain LENGTH() would count
    // characters and under-report multi-byte content.
    const size = raw
      .prepare(
        `SELECT MAX(len) AS maxMsgBytes FROM (
           SELECT MAX(LENGTH(CAST(content AS BLOB))) AS len FROM messages
           UNION ALL SELECT MAX(LENGTH(CAST(tool_calls AS BLOB))) FROM messages
           UNION ALL SELECT MAX(LENGTH(CAST(tool_results AS BLOB))) FROM messages
           UNION ALL SELECT MAX(LENGTH(CAST(prompt AS BLOB))) FROM tasks
           UNION ALL SELECT MAX(LENGTH(CAST(result AS BLOB))) FROM tasks
           UNION ALL SELECT MAX(LENGTH(CAST(payload AS BLOB))) FROM task_events
         )`
      )
      .get() as { maxMsgBytes: number | null };
    return {
      costUsd: usage.costUsd,
      modelCalls: usage.modelCalls,
      tasks: usage.tasks,
      unpricedTasks: usage.unpricedTasks,
      maxMsgBytes: size.maxMsgBytes ?? 0,
    };
  } catch {
    return null;
  } finally {
    raw?.close();
  }
}

/**
 * Continuous monitor: polls the child store on a bounded interval, prints the
 * running cost each poll, and trips a {@link GuardAbort} the instant a cap is
 * exceeded. On breach it stops itself and invokes `onKill` exactly once, which
 * the caller wires to `runner.close()` (aborting the spawned agent-mcp) plus a
 * rejection that wins the `Promise.race` around `orchestrateCycle`.
 */
export class RunMonitor {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private last: UsageSnapshot | null = null;

  constructor(
    private readonly cfg: GuardConfig,
    private readonly onKill: (err: GuardAbort) => void
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      void this.tick();
    }, this.cfg.pollMs);
    // Never keep the process alive on its own; the run holds the event loop.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get snapshot(): UsageSnapshot | null {
    return this.last;
  }

  /** Visible for tests: run one poll synchronously against the store. */
  tickNow(): void {
    if (this.stopped) return;
    const snap = readUsageSnapshot(this.cfg.dbPath);
    if (!snap) return;
    this.last = snap;
    this.evaluate(snap);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const snap = readUsageSnapshot(this.cfg.dbPath);
    if (!snap) return;
    this.last = snap;

    console.log(
      `[guard] cost=$${snap.costUsd.toFixed(6)} (cap $${this.cfg.maxCostUsd}) | ` +
        `modelCalls=${snap.modelCalls} (cap ${this.cfg.maxTurns}) | tasks=${snap.tasks} | ` +
        `maxMsgBytes=${snap.maxMsgBytes} (cap ${this.cfg.maxMsgBytes})`
    );
    this.evaluate(snap);
  }

  private evaluate(snap: UsageSnapshot): void {
    if (snap.costUsd > this.cfg.maxCostUsd) {
      this.breach('cost-exceeded', {
        costUsd: snap.costUsd,
        maxCostUsd: this.cfg.maxCostUsd,
      });
      return;
    }
    if (snap.unpricedTasks > 0 && snap.modelCalls > 0 && !this.cfg.proxy) {
      this.breach('cost-telemetry-unavailable', {
        unpricedTasks: snap.unpricedTasks,
        modelCalls: snap.modelCalls,
        model: this.cfg.modelLabel,
        hint:
          'est_cost_usd is NULL (the model has no rate-card entry), so cumulative ' +
          'spend cannot be metered. Refusing to run unbounded. Set DISPATCH_E2E_MODEL ' +
          'to a priced model, or set DISPATCH_E2E_PROXY so the proxy meters spend.',
      });
      return;
    }
    if (snap.maxMsgBytes > this.cfg.maxMsgBytes) {
      this.breach('message-size-exceeded', {
        maxMsgBytes: snap.maxMsgBytes,
        maxMsgBytesCap: this.cfg.maxMsgBytes,
      });
    }
  }

  private breach(reason: string, evidence: Record<string, unknown>): void {
    if (this.stopped) return;
    this.stop();
    this.onKill(new GuardAbort(reason, { ...evidence, snapshot: this.last }));
  }
}

/** Post-run final enforcement — the safety net if the run finished between ticks. */
export function enforcePostRun(snapshot: UsageSnapshot | null, cfg: GuardConfig): void {
  if (!snapshot) {
    throw new GuardAbort('telemetry-store-missing', {
      dbPath: cfg.dbPath,
      hint: 'the spawned agent-mcp never wrote a task_usage row; refusing to report success',
    });
  }
  if (snapshot.modelCalls > cfg.maxTurns) {
    throw new GuardAbort('turn-count-exceeded', {
      modelCalls: snapshot.modelCalls,
      maxTurns: cfg.maxTurns,
    });
  }
  if (snapshot.costUsd > cfg.maxCostUsd) {
    throw new GuardAbort('cost-exceeded', {
      costUsd: snapshot.costUsd,
      maxCostUsd: cfg.maxCostUsd,
    });
  }
  if (snapshot.unpricedTasks > 0 && snapshot.modelCalls > 0 && !cfg.proxy) {
    throw new GuardAbort('cost-telemetry-unavailable', {
      unpricedTasks: snapshot.unpricedTasks,
      modelCalls: snapshot.modelCalls,
      model: cfg.modelLabel,
    });
  }
  if (snapshot.maxMsgBytes > cfg.maxMsgBytes) {
    throw new GuardAbort('message-size-exceeded', {
      maxMsgBytes: snapshot.maxMsgBytes,
      maxMsgBytesCap: cfg.maxMsgBytes,
    });
  }
}
