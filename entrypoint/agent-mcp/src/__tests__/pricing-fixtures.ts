/**
 * Shared fixtures for the live-price-pull tests (37f6c511). Real better-sqlite3 + the REAL
 * migration set + the real PriceHistoryStore; only `fetch`, the clock and the timers are faked.
 * Not a test file (no `.test.`), so vitest does not collect it.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import { runMigrationsOn } from '../db/migrate-runner.js';
import type { IPullLogger } from '../pricing/pull.js';
import type { ITimers } from '../pricing/scheduler.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRATCH_ROOT = resolve(HERE, '../../../../tmp/agent-mcp');

export const T0 = '2026-10-10T00:00:00.000Z';
export const HOUR = 3_600_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyDb = any;

export interface ITestDb {
  sqlite: Database.Database;
  db: AnyDb;
}

/** Open a migrated DB. `file` opens that path (shareable between connections); default in-memory. */
export function openDb(file?: string): ITestDb {
  const sqlite = new Database(file ?? ':memory:');
  if (file) sqlite.pragma('journal_mode = WAL');
  const db = drizzle(sqlite);
  runMigrationsOn(sqlite, db);
  return { sqlite, db };
}

/** A scratch dir under repo `tmp/agent-mcp/` (gitignored); `dispose()` removes exactly what this call created. */
export function scratchDir(): { dir: string; dispose(): void } {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const dir = mkdtempSync(join(SCRATCH_ROOT, 'pricing-'));
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Injected clock. */
export function makeClock(start: string = T0): { now: () => string; advance(ms: number): void; set(iso: string): void } {
  let t = Date.parse(start);
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms) => {
      t += ms;
    },
    set: (iso) => {
      t = Date.parse(iso);
    },
  };
}

export interface IRecordedLogger extends IPullLogger {
  infos: Array<{ obj: Record<string, unknown>; msg: string }>;
  warns: Array<{ obj: Record<string, unknown>; msg: string }>;
  errors: Array<{ obj: Record<string, unknown>; msg: string }>;
}

export function makeLogger(): IRecordedLogger {
  const l: IRecordedLogger = {
    infos: [],
    warns: [],
    errors: [],
    info: (obj, msg) => void l.infos.push({ obj, msg }),
    warn: (obj, msg) => void l.warns.push({ obj, msg }),
    error: (obj, msg) => void l.errors.push({ obj, msg }),
  };
  return l;
}

export interface IFeedModel {
  prompt: string;
  completion: string;
  cacheRead?: string;
  overrides?: unknown[];
}

/** Build a feed body in the live endpoint's `{data:[{id,pricing}]}` shape. */
export function feedOf(models: Record<string, IFeedModel>): string {
  return JSON.stringify({
    data: Object.entries(models).map(([id, m]) => ({
      id,
      name: id,
      pricing: {
        prompt: m.prompt,
        completion: m.completion,
        ...(m.cacheRead !== undefined ? { input_cache_read: m.cacheRead } : {}),
        ...(m.overrides !== undefined ? { overrides: m.overrides } : {}),
      },
    })),
  });
}

/** `n` distinct valid models `m0..m{n-1}` at a fixed price. */
export function bulkFeed(n: number, extra: Record<string, IFeedModel> = {}): Record<string, IFeedModel> {
  const out: Record<string, IFeedModel> = {};
  for (let i = 0; i < n; i += 1) out[`vendor/m${i}`] = { prompt: '0.000001', completion: '0.000002' };
  return { ...out, ...extra };
}

export type FetchStep =
  | { body: string; status?: number; headers?: Record<string, string> }
  | { reject: Error }
  | { truncated: true }
  | { gate: Promise<void>; then: FetchStep };

export interface IFakeFetch {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
}

/** Scripted fetch: step N serves call N; the last step repeats. Honours `init.signal` while gated. */
export function fakeFetch(...steps: FetchStep[]): IFakeFetch {
  const calls: IFakeFetch['calls'] = [];
  const serve = async (step: FetchStep, signal?: AbortSignal | null): Promise<Response> => {
    if ('gate' in step) {
      await new Promise<void>((resolveGate, rejectGate) => {
        const onAbort = (): void => rejectGate(new Error('The operation was aborted'));
        if (signal?.aborted) return onAbort();
        signal?.addEventListener('abort', onAbort, { once: true });
        void step.gate.then(resolveGate);
      });
      return serve(step.then, signal);
    }
    if ('reject' in step) throw step.reject;
    if ('truncated' in step) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: () => Promise.reject(new Error('terminated: body truncated')),
      } as unknown as Response;
    }
    return new Response(step.body, { status: step.status ?? 200, headers: step.headers });
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const i = calls.length;
    calls.push({ url: String(input), init: init ?? {} });
    return serve(steps[Math.min(i, steps.length - 1)] as FetchStep, init?.signal);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** A latch: `open()` releases every `gate` waiter. */
export function latch(): { gate: Promise<void>; open(): void } {
  let open!: () => void;
  const gate = new Promise<void>((r) => {
    open = r;
  });
  return { gate, open };
}

export interface IFakeTimers extends ITimers {
  /** Currently armed (not cleared, not fired) timers. */
  pending: Array<{ id: number; ms: number; fn: () => void; unrefCalled: boolean }>;
  /** Fire the oldest armed timer. */
  fireNext(): void;
}

/** Injected timers: records handles, `unref` calls and delays; fires on demand (no wall clock). */
export function fakeTimers(): IFakeTimers {
  let seq = 0;
  const t: IFakeTimers = {
    pending: [],
    setTimeout(fn, ms) {
      const entry = { id: (seq += 1), ms, fn, unrefCalled: false };
      t.pending.push(entry);
      return {
        id: entry.id,
        unref: () => {
          entry.unrefCalled = true;
        },
      };
    },
    clearTimeout(handle) {
      const id = (handle as { id: number }).id;
      t.pending = t.pending.filter((p) => p.id !== id);
    },
    fireNext() {
      const next = t.pending.shift();
      if (!next) throw new Error('no armed timer to fire');
      next.fn();
    },
  };
  return t;
}

/** Assert a fetch init carries no credential material (FS2-AC13). Throws otherwise. */
export function assertNoCredentials(init: RequestInit): void {
  const headers = new Headers(init.headers as HeadersInit | undefined);
  for (const name of ['authorization', 'cookie', 'proxy-authorization', 'x-api-key']) {
    if (headers.has(name)) throw new Error(`request carries a credential header: ${name}`);
  }
  if (init.credentials === 'include') throw new Error('request includes credentials');
}
