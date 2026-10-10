/**
 * live-cache-smoke.ts — pure helpers for `live-cache-smoke.e2e.test.ts`
 * (backlog 8ecaa160 AC1, formerly ebfe7421 AC1; closes gap ee3381d8).
 *
 * Two concerns, both pure and exercised OFFLINE by the always-running half of the test file:
 *
 *  1. {@link assertCacheEngaged} — the AC1 assertion: across the per-turn usage rows of one task, at
 *     least one turn recorded `cache_creation_tokens > 0` or `cache_read_tokens > 0`.
 *  2. {@link readWindowState} / {@link evaluateWindowGuard} — the fail-closed 5-hour-window guard. The
 *     live leg may only spend model calls while the Anthropic unified 5h rate-limit window is
 *     `allowed` and under {@link MAX_5H_UTILIZATION}; if the state cannot be read the guard REFUSES.
 *
 * No server internals are imported; the guard reads only the JSONL the server itself writes
 * (`http.response` header values and the `claude` stream's `rate_limit_event`). It never reads a
 * credential file or an env value.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Refuse to run live at or above this 5h-window utilization (owner directive 2026-10-10). */
export const MAX_5H_UTILIZATION = 0.6;
/** A window reading older than this is not evidence of the CURRENT state: refuse. */
export const MAX_READING_AGE_MS = 60 * 60 * 1000;
/** The 5h window lasts five hours; log files untouched for longer cannot hold a live reading. */
const SCAN_HORIZON_MS = 6 * 60 * 60 * 1000;
/** Haiku 4.5 minimum cacheable prefix (Anthropic docs; mirrors `minCacheableTokens`). */
export const HAIKU_MIN_CACHEABLE_TOKENS = 4096;

/** One model call's usage as the product's `usage_query` (`grain: 'turn'`) reports it. */
export interface ITurnUsage {
  call_index: number | null;
  input_tokens: number;
  uncached_input_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  output_tokens: number;
}

/** Render the per-turn usage as a compact table for test output. */
export function formatTurns(turns: readonly ITurnUsage[]): string {
  const rows = turns.map(
    (t) =>
      `  turn ${String(t.call_index ?? '?')}: input=${t.input_tokens} uncached=${t.uncached_input_tokens} ` +
      `cache_creation=${t.cache_creation_tokens} cache_read=${t.cache_read_tokens} output=${t.output_tokens}`
  );
  return rows.length > 0 ? rows.join('\n') : '  (no turns recorded)';
}

/**
 * 8ecaa160 AC1 / ebfe7421 AC1: "with web_search and web_fetch advertised, a shell-only Anthropic
 * turn records cache_creation or cache_read tokens greater than zero on the parent run".
 *
 * Throws unless at least one turn has `cache_creation_tokens > 0` or `cache_read_tokens > 0`.
 * The message distinguishes "the run never reached the model minimum" (inconclusive prefix) from
 * "the prefix was cacheable but nothing was cached" (the AC1 regression).
 */
export function assertCacheEngaged(turns: readonly ITurnUsage[]): void {
  if (turns.length === 0) {
    throw new Error('8ecaa160 AC1: no per-turn usage rows were recorded for the task');
  }
  const engaged = turns.some((t) => t.cache_creation_tokens > 0 || t.cache_read_tokens > 0);
  if (engaged) return;
  const peak = Math.max(...turns.map((t) => t.input_tokens));
  const why =
    peak < HAIKU_MIN_CACHEABLE_TOKENS
      ? `peak prefix ${peak} < ${HAIKU_MIN_CACHEABLE_TOKENS}: below the model's cacheable minimum, the run is inconclusive and the fixture must grow`
      : `peak prefix ${peak} >= ${HAIKU_MIN_CACHEABLE_TOKENS} yet cache_creation=0 and cache_read=0: no cache breakpoint was honoured (AC1 regression)`;
  throw new Error(`8ecaa160 AC1: neither cache_creation nor cache_read tokens > 0 on any turn (${why})\n${formatTurns(turns)}`);
}

export interface IWindowReading {
  source: 'http-header' | 'rate_limit_event';
  /** ISO timestamp of the log line. */
  ts: string;
  tsMs: number;
  /** 5h-window utilization, 0..1. */
  utilization: number;
  /** `allowed` or anything else (`allowed_warning`, `rejected`, ...). */
  status: string;
  /** Epoch seconds at which this 5h window resets. */
  resetsAtSec: number;
  file: string;
}

/** Every `<root>/<namespace>/logs/api` dir under `~/.adhd/agent-mcp` (the server's default log tree). */
export function defaultApiLogDirs(home: string = os.homedir()): string[] {
  const root = path.join(home, '.adhd', 'agent-mcp');
  let namespaces: string[];
  try {
    namespaces = fs.readdirSync(root);
  } catch {
    return [];
  }
  return namespaces
    .map((ns) => path.join(root, ns, 'logs', 'api'))
    .filter((d) => fs.existsSync(d));
}

const num = (s: string | undefined): number => (s === undefined ? Number.NaN : Number(s));

/** Parse one JSONL line into zero or more 5h-window readings. */
export function readingsFromLine(line: string, file: string): IWindowReading[] {
  const out: IWindowReading[] = [];
  const hasHeader = line.includes('anthropic-ratelimit-unified-5h-utilization');
  const hasEvent = line.includes('rate_limit_event');
  if (!hasHeader && !hasEvent) return out;
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return out; // a torn trailing line is not a reading
  }
  const ts = typeof rec['ts'] === 'string' ? rec['ts'] : '';
  const tsMs = Date.parse(ts);
  if (Number.isNaN(tsMs)) return out;

  if (hasHeader && rec['event'] === 'http.response') {
    const h = (rec['headers'] ?? {}) as Record<string, unknown>;
    const util = num(String(h['anthropic-ratelimit-unified-5h-utilization']));
    const reset = num(String(h['anthropic-ratelimit-unified-5h-reset']));
    const s5h = String(h['anthropic-ratelimit-unified-5h-status'] ?? '');
    const sUni = String(h['anthropic-ratelimit-unified-status'] ?? s5h);
    // The stricter of the two statuses wins: anything but `allowed` is a refusal.
    const status = s5h !== 'allowed' ? s5h : sUni;
    if (!Number.isNaN(util) && !Number.isNaN(reset)) {
      out.push({ source: 'http-header', ts, tsMs, utilization: util, status, resetsAtSec: reset, file });
    }
  }

  if (hasEvent) {
    // The `claude` stream line is JSON embedded (escaped) in a `spawn.stdout` record: match the
    // raw text rather than relying on which field carries it.
    const info = /rate_limit_info\\*":\{\\*"status\\*":\\*"([A-Za-z_]+)\\*"/.exec(line);
    const win = /five_hour\\*":\{\\*"utilization\\*":([0-9.]+),\\*"resetsAt\\*":(\d+)/.exec(line);
    if (win) {
      out.push({
        source: 'rate_limit_event',
        ts,
        tsMs,
        utilization: num(win[1]),
        // The raw stream status is kept as-is (fail-closed): `allowed_warning` on ANY claim, including
        // a `seven_day` representative claim, is "status is not allowed" and refuses. The 5h
        // utilization is still parsed from `unifiedWindows.five_hour` and still guarded.
        status: info?.[1] ?? 'unknown',
        resetsAtSec: num(win[2]),
        file,
      });
    }
  }
  return out;
}

/** Collect 5h-window readings from the recently-modified `*.jsonl` files in `dirs`. */
export function readWindowState(dirs: readonly string[], nowMs: number = Date.now()): IWindowReading[] {
  const readings: IWindowReading[] = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      try {
        if (nowMs - fs.statSync(file).mtimeMs > SCAN_HORIZON_MS) continue;
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
          if (line) readings.push(...readingsFromLine(line, file));
        }
      } catch {
        /* unreadable file == no reading from it */
      }
    }
  }
  return readings;
}

export type WindowVerdict =
  | { ok: true; newest: IWindowReading; considered: number }
  | { ok: false; reason: string };

/**
 * Fail-closed decision. A reading only counts when its window has not reset yet and it is fresh
 * ({@link MAX_READING_AGE_MS}). With no such reading the verdict is a refusal ("cannot read").
 * Every counted reading must be `allowed` and under {@link MAX_5H_UTILIZATION}; utilization is
 * monotonic inside one window, so a single over-threshold reading refuses.
 */
export function evaluateWindowGuard(readings: readonly IWindowReading[], nowMs: number = Date.now()): WindowVerdict {
  const live = readings.filter((r) => r.resetsAtSec * 1000 > nowMs && nowMs - r.tsMs <= MAX_READING_AGE_MS);
  if (live.length === 0) {
    return {
      ok: false,
      reason:
        'cannot read the current 5h-window state (no http.response anthropic-ratelimit-unified-5h-* header or ' +
        `rate_limit_event within the last ${MAX_READING_AGE_MS / 60000} min for an unreset window): REFUSING to run live. ` +
        'Make any cheap agent-mcp Anthropic call, or wait, then re-run.',
    };
  }
  const newest = live.reduce((a, b) => (b.tsMs > a.tsMs ? b : a));
  const bad = live.find((r) => r.status !== 'allowed' || !(r.utilization < MAX_5H_UTILIZATION));
  if (bad) {
    return {
      ok: false,
      reason:
        `5h window not clear: ${bad.source} at ${bad.ts} reports status=${bad.status} utilization=${bad.utilization} ` +
        `(required: status=allowed and utilization < ${MAX_5H_UTILIZATION}): REFUSING to run live.`,
    };
  }
  return { ok: true, newest, considered: live.length };
}

/** One-line rendering for the before/after record. */
export function describeReading(r: IWindowReading): string {
  return `${r.source} ts=${r.ts} 5h-utilization=${r.utilization} status=${r.status} resetsAt=${r.resetsAtSec}`;
}

export interface IWireUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

/**
 * Raw per-call usage straight off the Anthropic SSE bodies the server logged (`http.response`
 * `body`: `message_start` carries input/cache, `message_delta` the final output). Log-only
 * evidence next to the product's own accounting; a truncated body yields no entry rather than a guess.
 */
export function wireUsageFromApiLog(apiDir: string): IWireUsage[] {
  const calls: IWireUsage[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(apiDir).filter((n) => n.endsWith('.jsonl')).sort();
  } catch {
    return calls;
  }
  for (const name of names) {
    for (const line of fs.readFileSync(path.join(apiDir, name), 'utf8').split('\n')) {
      if (!line.includes('"http.response"')) continue;
      let rec: { event?: string; body?: string };
      try {
        rec = JSON.parse(line) as typeof rec;
      } catch {
        continue;
      }
      if (rec.event !== 'http.response' || typeof rec.body !== 'string') continue;
      const start = /"message_start"[\s\S]*?"usage":(\{[^}]*\})/.exec(rec.body);
      const delta = /"message_delta"[\s\S]*"usage":(\{[^}]*\})/.exec(rec.body);
      try {
        const u: IWireUsage = {
          ...(start?.[1] ? (JSON.parse(start[1]) as IWireUsage) : {}),
          ...(delta?.[1] ? (JSON.parse(delta[1]) as IWireUsage) : {}),
        };
        if (Object.keys(u).length > 0) calls.push(u);
      } catch {
        /* truncated body: no entry */
      }
    }
  }
  return calls;
}
