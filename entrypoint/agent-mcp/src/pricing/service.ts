/**
 * 37f6c511 — host-side pricing service: owns the `PriceHistoryStore`, seeds the bundled snapshot,
 * runs the daily scheduler and serves the `pricing_refresh` / `pricing_history` tools.
 *
 * The `UsagePlugin` and the `usage_query` read path price through `createPriceSource(db)` over the
 * SAME database, so rows this service appends are what they resolve as-of the turn.
 */
import type { LogChannel } from '@adhd/agent-plugin-tracing';
import { parseBundledSnapshot } from '@adhd/agent-core-provider';
import { createPriceSource, PriceHistoryStore } from '@adhd/agent-store-runtime';

import { tracedFetch } from '../wire/traced-fetch.js';
import type { OpsSource } from './ops.js';
import { runPricePull, toPriceRow, type IPullDeps, type IPullLogger, type IPullResult } from './pull.js';
import { startPriceScheduler, type IPriceScheduler, type ISchedulerOptions } from './scheduler.js';

export interface IPricingServiceOptions {
  /** Drizzle better-sqlite3 handle over the runtime DB (migrations already applied). */
  db: ConstructorParameters<typeof PriceHistoryStore>[0];
  logger: IPullLogger;
  /** Package version for the feed `User-Agent`. */
  version: string;
  fetchImpl?: typeof fetch;
  now?: () => string;
  sleep?: IPullDeps['sleep'];
  url?: string;
  /** Shrink-gate baseline when no successful pull exists yet (default: bundled snapshot model count). */
  baselineModelCount?: number;
  scheduler?: ISchedulerOptions;
  /**
   * c536ce29 TRC-AC7: channels the service logs to. `ops` receives the `pricing.*` records and
   * `api` the raw feed exchange. Default: the process-wide channels (resolved per call, inert
   * when none is installed).
   */
  channels?: { ops?: OpsSource; api?: LogChannel | (() => LogChannel) };
}

export interface IPricingService {
  store: PriceHistoryStore;
  /** Structural `IPriceSource` for `UsagePlugin` / usage tools. */
  priceSource: ReturnType<typeof createPriceSource>;
  /** Seed the bundled snapshot (idempotent) and arm the scheduler. Safe to call once. */
  start(): void;
  /** Stop the scheduler and abort an in-flight pull. Idempotent. */
  stop(): void;
  /** Forced pull (bypasses the 24h gate). `accept` releases held anomalies. */
  refresh(accept?: string[]): Promise<IPullResult>;
  /** Next scheduled pull, or null. */
  nextScheduled(): string | null;
  now(): string;
}

export function createPricingService(options: IPricingServiceOptions): IPricingService {
  const store = new PriceHistoryStore(options.db);
  const now = options.now ?? ((): string => new Date().toISOString());
  const pullDeps: IPullDeps = {
    store,
    fetchImpl: options.fetchImpl ?? tracedFetch(options.channels?.api),
    now,
    sleep: options.sleep,
    logger: options.logger,
    version: options.version,
    url: options.url,
    baselineModelCount: options.baselineModelCount,
    ops: options.channels?.ops,
  };
  let scheduler: IPriceScheduler | undefined;
  let stopped = false;
  const inFlight = new AbortController();

  return {
    store,
    priceSource: createPriceSource(options.db),
    now,
    start(): void {
      if (scheduler || stopped) return;
      const bundled = parseBundledSnapshot();
      try {
        const inserted = store.seedBundled(bundled.models.map(toPriceRow), bundled.fetchedAt);
        if (inserted > 0) {
          options.logger.info({ inserted, fetchedAt: bundled.fetchedAt }, 'pricing: seeded bundled price snapshot');
        }
      } catch (err) {
        options.logger.error({ err }, 'pricing: could not seed the bundled price snapshot');
      }
      try {
        if (!store.lastLedger(now()).lastOk) {
          options.logger.warn(
            { bundledFetchedAt: bundled.fetchedAt },
            'pricing: no successful live price pull yet; costs use the bundled OpenRouter snapshot until the first pull succeeds'
          );
        }
      } catch (err) {
        options.logger.error({ err }, 'pricing: could not read the pull ledger');
      }
      scheduler = startPriceScheduler({ ...pullDeps, signal: undefined }, options.scheduler);
    },
    stop(): void {
      stopped = true;
      inFlight.abort();
      scheduler?.stop();
    },
    refresh: (accept) =>
      runPricePull({ ...pullDeps, signal: inFlight.signal }, { force: true, accept }),
    nextScheduled: () => scheduler?.nextRunAt() ?? null,
  };
}
