/**
 * live-cache-smoke.e2e.test.ts — backlog 8ecaa160 AC1 (formerly ebfe7421 AC1); closes gap ee3381d8.
 *
 * AC1: "with web_search and web_fetch advertised, a shell-only Anthropic turn records
 * cache_creation or cache_read tokens greater than zero on the parent run".
 *
 * ── ENV-GATED (paid third-party model) — APPROVED ───────────────────────────
 * Gate: ADHD_AGENT_LIVE_CACHE=1. Qualifying reason (AGENTS.md §7, the ONLY one): the live leg
 * calls a REAL paid model (Anthropic claude-haiku-4-5, credential resolved by the product's own
 * path: `provider.env.secret = ADHD_AGENT_ANTHROPIC_SECRET`, from the environment or
 * `~/.adhd/.env` — this file never reads or prints either). One task, ~3 model calls, no retries.
 * Owner / approver: pseudosky (repo owner). Approved 2026-10-10 for paid real-model use, with the
 * standing constraint "i don't care about the budget but do not burn the 5h window".
 * The same record is in this package's README.md ("Live tests") and AGENTS.md ("Live tests").
 * Unset, the live test is reported as SKIPPED with a reason naming the gate and the owner.
 *
 * 5-HOUR WINDOW GUARD (fail-closed, in this file as well as in the run procedure): before the one
 * live call the test reads the newest `anthropic-ratelimit-unified-5h-*` response headers and
 * `rate_limit_event` records from the server's own API logs under `~/.adhd/agent-mcp/`, and REFUSES
 * (the test goes red, no model call is made) when the window is not `allowed`, utilization is
 * >= 0.60, or the state cannot be read (no fresh reading for an unreset window). The reading after
 * the run comes from the run's own isolated API log.
 *
 * What the live leg does (real components, no mocks, no server internals imported):
 *  - starts the REAL BUILT agent-mcp (`dist/src/index.js`) over stdio with a REAL MCP client, on an
 *    isolated store (DB, registry DB and log tree under `tmp/agent-mcp/live-cache-*`, never the
 *    production store; cwd outside the repo's `src`; HOME left real so the product can resolve its
 *    own credential — the one deliberate departure from ADR-0008:32's fake HOME, because the model
 *    is the thing under test);
 *  - creates one anthropic claude-haiku-4-5 agent with the shell tool and the native web tools
 *    (default-on `nativeWebTools`), fs/dispatch off — the measured shape (turn 1 3130 real tokens,
 *    turn 2 ~4404, turn 3 ~4714) — and runs one task that forces >= 2 shell turns while the prefix
 *    grows past the 4096-token Haiku 4.5 minimum;
 *  - asserts the web tools were advertised on the wire, then reads usage via `usage_query`
 *    (`grain: 'turn'`) and asserts cache_creation > 0 OR cache_read > 0 (the raw per-turn usage and
 *    the raw wire usage are printed);
 *  - deletes the agent, stops the server and removes the scratch store in `finally`.
 *
 * The OFFLINE half of this file (always runs, no network, no model) gives the assertion and the
 * guard teeth: recorded usage with creation = read = 0 must FAIL the assertion (negative control,
 * using the three real logged turns' prefix sizes from the cacheguard fixtures), and the guard must
 * refuse unreadable / stale / hot / non-allowed windows.
 *
 * Prerequisites (built dist, `uvx`, `srt`, the credential) FAIL LOUDLY when the gate is on.
 *
 * Run (from the repo root; build first: `npx nx run agent-mcp:dist-manifest`):
 *   ADHD_AGENT_LIVE_CACHE=1 npx vitest run --config entrypoint/agent-mcp/vitest.e2e.config.ts live-cache-smoke
 * Do NOT gate through `nx run agent-mcp:e2e`: nx's cache key is blind to this env var, so it can
 * replay a cached SKIPPED result. (`vitest.setup.mjs` deliberately preserves this one
 * `ADHD_AGENT_*` variable; every other inherited `ADHD_AGENT_*` is dropped.)
 * ────────────────────────────────────────────────────────────────────────────
 */
import fs from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  HAIKU_MIN_CACHEABLE_TOKENS,
  MAX_5H_UTILIZATION,
  assertCacheEngaged,
  defaultApiLogDirs,
  describeReading,
  evaluateWindowGuard,
  formatTurns,
  readWindowState,
  readingsFromLine,
  wireUsageFromApiLog,
  type ITurnUsage,
  type IWindowReading,
} from './live-cache-smoke.js';
import { REPO_ROOT, startPortabilityHost, type PortabilityHost } from './portability-host.js';

const GATE = 'ADHD_AGENT_LIVE_CACHE';
const LIVE = process.env[GATE] === '1';
const OWNER = 'pseudosky';
const SKIP_REASON = `SKIPPED: paid third-party model, gate ${GATE}=1, owner ${OWNER} (approved 2026-10-10)`;
const liveIt = LIVE ? it : it.skip;

const SCRATCH_PARENT = path.join(REPO_ROOT, 'tmp', 'agent-mcp');
const FIXTURE_DIR = path.join(
  REPO_ROOT,
  'packages',
  'agent',
  'agent-engine-orchestrator',
  'src',
  '__tests__',
  'fixtures',
  'cacheguard'
);

// ---------------------------------------------------------------------------
// OFFLINE: the assertion and the guard have teeth (always run; no model call)
// ---------------------------------------------------------------------------

const turn = (i: number, input: number, creation: number, read: number): ITurnUsage => ({
  call_index: i,
  input_tokens: input,
  uncached_input_tokens: input - read - creation,
  cache_read_tokens: read,
  cache_creation_tokens: creation,
  output_tokens: 40,
});

/** The three real logged turns' prefix sizes, as recorded in the ebfe7421 cacheguard fixtures. */
function loggedPrefixSizes(): number[] {
  return [1, 2, 3].map(
    (n) =>
      (
        JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `haiku45-turn${n}.json`), 'utf8')) as {
          realInputTokens: number;
        }
      ).realInputTokens
  );
}

describe('8ecaa160 AC1 / ebfe7421 AC1 — offline controls (assertion + window guard have teeth)', () => {
  it('8ecaa160 AC1 / ebfe7421 AC1 negative control: the three logged turns with creation=read=0 FAIL the assertion', () => {
    const sizes = loggedPrefixSizes();
    expect(sizes).toEqual([3130, 4404, 4714]);
    const turns = sizes.map((s, i) => turn(i + 1, s, 0, 0));
    expect(() => assertCacheEngaged(turns)).toThrow(/neither cache_creation nor cache_read/);
    // turns 2 and 3 are above the model minimum, so this is the AC1 regression, not an inconclusive run
    expect(() => assertCacheEngaged(turns)).toThrow(/no cache breakpoint was honoured/);
  });

  it('8ecaa160 AC1 negative control: a sub-minimum prefix with zero cache tokens fails as inconclusive', () => {
    expect(() => assertCacheEngaged([turn(1, 3130, 0, 0)])).toThrow(/below the model's cacheable minimum/);
    expect(3130).toBeLessThan(HAIKU_MIN_CACHEABLE_TOKENS);
  });

  it('8ecaa160 AC1 positive control: a creation on turn 2 and a read on turn 3 (or either alone) pass', () => {
    expect(() => assertCacheEngaged([turn(1, 3130, 0, 0), turn(2, 4404, 4404, 0), turn(3, 4714, 0, 4404)])).not.toThrow();
    expect(() => assertCacheEngaged([turn(1, 3130, 0, 0), turn(2, 4404, 4404, 0)])).not.toThrow();
    expect(() => assertCacheEngaged([turn(1, 3130, 0, 0), turn(2, 4404, 0, 1)])).not.toThrow();
    expect(() => assertCacheEngaged([])).toThrow(/no per-turn usage rows/);
  });

  describe('window guard (fail-closed)', () => {
    const NOW = Date.parse('2026-10-10T12:00:00.000Z');
    const reading = (over: Partial<IWindowReading> = {}): IWindowReading => ({
      source: 'http-header',
      ts: new Date(NOW - 5 * 60_000).toISOString(),
      tsMs: NOW - 5 * 60_000,
      utilization: 0.08,
      status: 'allowed',
      resetsAtSec: Math.floor(NOW / 1000) + 3 * 3600,
      file: 'synthetic',
      ...over,
    });

    it('allows a fresh, allowed, low-utilization reading', () => {
      expect(evaluateWindowGuard([reading()], NOW)).toMatchObject({ ok: true, considered: 1 });
    });
    it('refuses when no reading can be read at all', () => {
      const v = evaluateWindowGuard([], NOW);
      expect(v.ok).toBe(false);
      expect(v.ok === false && v.reason).toMatch(/cannot read the current 5h-window state/);
    });
    it('refuses a stale reading (older than the freshness bound)', () => {
      const old = NOW - 3 * 3600_000;
      expect(evaluateWindowGuard([reading({ tsMs: old, ts: new Date(old).toISOString() })], NOW).ok).toBe(false);
    });
    it('refuses a reading from a window that has already reset (state unknown)', () => {
      expect(evaluateWindowGuard([reading({ resetsAtSec: Math.floor(NOW / 1000) - 60 })], NOW).ok).toBe(false);
    });
    it('refuses at utilization >= 0.60 (boundary) and allows just below', () => {
      expect(evaluateWindowGuard([reading({ utilization: MAX_5H_UTILIZATION })], NOW).ok).toBe(false);
      expect(evaluateWindowGuard([reading({ utilization: 0.61 })], NOW).ok).toBe(false);
      expect(evaluateWindowGuard([reading({ utilization: 0.59 })], NOW).ok).toBe(true);
    });
    it('refuses when status is not allowed, and when any one live reading is hot', () => {
      expect(evaluateWindowGuard([reading({ status: 'allowed_warning' })], NOW).ok).toBe(false);
      expect(evaluateWindowGuard([reading(), reading({ source: 'rate_limit_event', utilization: 0.7 })], NOW).ok).toBe(false);
    });
    it('parses the real log shapes: http.response headers and the claude rate_limit_event stream line', () => {
      const header = JSON.stringify({
        ts: '2026-10-10T11:58:00.000Z',
        event: 'http.response',
        headers: {
          'anthropic-ratelimit-unified-5h-reset': '1791615000',
          'anthropic-ratelimit-unified-5h-status': 'allowed',
          'anthropic-ratelimit-unified-5h-utilization': '0.08',
          'anthropic-ratelimit-unified-status': 'allowed',
        },
      });
      const stdout = JSON.stringify({
        ts: '2026-10-10T11:59:00.000Z',
        event: 'spawn.stdout',
        line:
          '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1791595200,"rateLimitType":"five_hour",' +
          '"unifiedWindows":{"five_hour":{"utilization":0.44,"resetsAt":1791595200},"seven_day":{"utilization":0.45,"resetsAt":1792047600}}}}',
      });
      expect(readingsFromLine(header, 'f')).toMatchObject([{ source: 'http-header', utilization: 0.08, status: 'allowed', resetsAtSec: 1791615000 }]);
      expect(readingsFromLine(stdout, 'f')).toMatchObject([{ source: 'rate_limit_event', utilization: 0.44, status: 'allowed', resetsAtSec: 1791595200 }]);
      expect(readingsFromLine('{"ts":"2026-10-10T11:59:00.000Z","event":"mcp.send"}', 'f')).toEqual([]);
      // a seven_day-claim `allowed_warning` carries the 5h utilization AND the non-allowed status: refuse (fail-closed)
      const sevenDay = JSON.stringify({
        ts: '2026-10-10T11:59:30.000Z',
        event: 'spawn.stdout',
        line:
          '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1792047600,"rateLimitType":"seven_day","utilization":0.52,' +
          '"unifiedWindows":{"five_hour":{"utilization":0.13,"resetsAt":1791633000},"seven_day":{"utilization":0.52,"resetsAt":1792047600}}}}',
      });
      expect(readingsFromLine(sevenDay, 'f')).toMatchObject([{ source: 'rate_limit_event', utilization: 0.13, status: 'allowed_warning', resetsAtSec: 1791633000 }]);
      expect(evaluateWindowGuard(readingsFromLine(sevenDay, 'f'), Date.parse('2026-10-10T12:00:00.000Z')).ok).toBe(false);
      // ...and so is a five_hour warning
      const fiveHourWarn = JSON.stringify({
        ts: '2026-10-10T11:59:40.000Z',
        event: 'spawn.stdout',
        line:
          '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1791633000,"rateLimitType":"five_hour",' +
          '"unifiedWindows":{"five_hour":{"utilization":0.13,"resetsAt":1791633000}}}}',
      });
      expect(readingsFromLine(fiveHourWarn, 'f')).toMatchObject([{ status: 'allowed_warning' }]);
      expect(evaluateWindowGuard(readingsFromLine(fiveHourWarn, 'f'), Date.parse('2026-10-10T12:00:00.000Z')).ok).toBe(false);
    });
    it('reads readings from a log dir and ignores files outside the scan horizon', () => {
      fs.mkdirSync(SCRATCH_PARENT, { recursive: true });
      const dir = fs.mkdtempSync(path.join(SCRATCH_PARENT, 'guard-unit-'));
      try {
        const line = JSON.stringify({
          ts: new Date().toISOString(),
          event: 'http.response',
          headers: {
            'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 3600),
            'anthropic-ratelimit-unified-5h-status': 'allowed',
            'anthropic-ratelimit-unified-5h-utilization': '0.12',
          },
        });
        fs.writeFileSync(path.join(dir, 'fresh.jsonl'), line + '\n');
        const stale = path.join(dir, 'stale.jsonl');
        fs.writeFileSync(stale, line + '\n');
        const old = new Date(Date.now() - 24 * 3600_000);
        fs.utimesSync(stale, old, old);
        const rs = readWindowState([dir]);
        expect(rs).toHaveLength(1);
        expect(rs[0]?.file).toContain('fresh.jsonl');
        expect(evaluateWindowGuard(rs).ok).toBe(true);
        expect(readWindowState([path.join(dir, 'does-not-exist')])).toEqual([]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

// ---------------------------------------------------------------------------
// LIVE (gated): one task, ~3 model calls, no retries
// ---------------------------------------------------------------------------

/** Deterministic records; ~32 gpt-tokens per line, so 60 lines ≈ 1.9k tokens. */
const records = (from: number, n: number): string =>
  Array.from(
    { length: n },
    (_, i) =>
      `record ${String(from + i).padStart(4, '0')} | key=${(((from + i) * 2654435761) >>> 0).toString(16).padStart(8, '0')} | ` +
      `owner=team-${(from + i) % 7} | state=calibrated | note=routine sample ${from + i}`
  ).join('\n');

describe('8ecaa160 AC1 / ebfe7421 AC1 — live: a shell-only Anthropic turn with web tools advertised records cache tokens', () => {
  let scratch = '';
  let host: PortabilityHost | undefined;
  let agentName = '';

  beforeAll(() => {
    if (!LIVE) return;
    fs.mkdirSync(SCRATCH_PARENT, { recursive: true });
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH_PARENT, 'live-cache-')));
  });

  afterAll(async () => {
    try {
      if (host && agentName) await host.callJson('agent_delete', { name: agentName, force: true });
    } catch {
      /* the isolated store is removed below regardless */
    }
    await host?.close();
    if (scratch && scratch.startsWith(SCRATCH_PARENT + path.sep)) {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  liveIt(
    `8ecaa160 AC1 / ebfe7421 AC1: cache_creation or cache_read > 0 on the parent run [${LIVE ? 'LIVE' : SKIP_REASON}]`,
    async () => {
      // ── 5h-window guard, BEFORE (fail-closed; no model call is made on refusal) ──
      const before = evaluateWindowGuard(readWindowState(defaultApiLogDirs()));
      if (!before.ok) throw new Error(`[live-cache] ${before.reason}`);
      console.info(`[live-cache] 5h window BEFORE: ${describeReading(before.newest)} (readings considered: ${before.considered})`);

      // ── isolated store + fixtures ──
      const serverCwd = path.join(scratch, 'server-cwd');
      const work = path.join(scratch, 'work');
      fs.mkdirSync(serverCwd);
      fs.mkdirSync(work);
      const fileA = path.join(work, 'notes-a.txt');
      const fileB = path.join(work, 'notes-b.txt');
      fs.writeFileSync(fileA, records(1, 60) + '\n');
      fs.writeFileSync(fileB, records(61, 8) + '\nCODEWORD=marmalade-47\n');
      const logDir = path.join(scratch, 'logs');

      host = await startPortabilityHost({
        serverCwd,
        scratch,
        keepAmbientAgentEnv: true,
        env: {
          ADHD_AGENT_SKIP_LEGACY_MIGRATION: 'true',
          ADHD_AGENT_LOGGING_DIR: logDir,
          ADHD_AGENT_TRACING_LOG_DIR: path.join(scratch, 'trace'),
          ADHD_AGENT_BUDGET_MAX_CALLS: '6', // hard ceiling on spend if the model loops
        },
      });

      agentName = `live-cache-${Date.now()}`;
      const created = await host.callJson('agent_create', {
        name: agentName,
        provider: {
          type: 'anthropic',
          model: 'claude-haiku-4-5',
          env: { secret: 'ADHD_AGENT_ANTHROPIC_SECRET' },
          maxTokens: 256,
        },
        systemPrompt: 'You are a concise assistant. Use your tools to answer.',
        // shell tool only (the measured shape); web_search/web_fetch come from the default-on nativeWebTools
        nativeTooling: { fs: false, shell: { allowCommands: ['cat', 'echo'] }, dispatch: false },
      });
      expect(created['_isError'], JSON.stringify(created)).toBeUndefined();

      // ── the one live task (no retries) ──
      const out = await host.callJson('task', {
        agent_name: agentName,
        cwd: work,
        prompt:
          `Use the shell tool, one call per turn, never batching calls. First run ["cat","${fileA}"]. ` +
          `Only after you have seen that output, run ["cat","${fileB}"]. ` +
          'Then reply with exactly one line: FINAL=<the value of the CODEWORD field in the second file>. Do not use web tools.',
      });
      expect(out['status'], JSON.stringify(out)).toBe('completed');
      const taskId = String(out['task_id']);

      // ── raw per-turn usage via the product's own accounting ──
      const usage = await host.callJson('usage_query', { task_id: taskId, grain: 'turn', include_incomplete: true });
      expect(usage['_isError'], JSON.stringify(usage)).toBeUndefined();
      const turns = (usage['rows'] as ITurnUsage[]).slice().sort((a, b) => (a.call_index ?? 0) - (b.call_index ?? 0));
      console.info(`[live-cache] raw per-turn usage (usage_query grain=turn, task ${taskId}):\n${formatTurns(turns)}`);
      console.info(`[live-cache] raw per-turn usage JSON: ${JSON.stringify(turns)}`);
      console.info(`[live-cache] task result usage.direct: ${JSON.stringify((out['usage'] as { direct?: unknown } | undefined)?.direct)}`);

      // ── raw wire usage (log-only evidence) ──
      const apiDir = path.join(logDir, 'api');
      console.info(`[live-cache] raw wire usage (api log message_start/message_delta): ${JSON.stringify(wireUsageFromApiLog(apiDir))}`);

      // ── 5h-window reading AFTER, from this run's own response headers ──
      const afterReadings = readWindowState([apiDir]);
      const afterNewest = afterReadings.reduce<IWindowReading | undefined>((a, b) => (!a || b.tsMs > a.tsMs ? b : a), undefined);
      console.info(`[live-cache] 5h window AFTER: ${afterNewest ? describeReading(afterNewest) : 'no reading in this run\'s api log'}`);

      // ── the AC1 verdict first (one paid run must always yield it), then the supporting checks ──
      let ac1: unknown;
      try {
        assertCacheEngaged(turns);
      } catch (e) {
        ac1 = e;
      }
      const direct = (out['usage'] as { direct?: { cacheReadTokens?: number; cacheCreationTokens?: number } } | undefined)?.direct;
      expect.soft((direct?.cacheReadTokens ?? 0) + (direct?.cacheCreationTokens ?? 0), 'task rollup agrees').toBeGreaterThan(0);
      expect.soft(turns.length, 'the task must make >= 3 model calls (2 shell turns + the answer)').toBeGreaterThanOrEqual(3);

      // web_search + web_fetch advertised on the wire: the first Anthropic /v1/messages request
      // (the tools array is identical on every turn; a non-model request such as a pricing pull is not one).
      const messageRequests = fs
        .readdirSync(apiDir)
        .filter((n) => n.endsWith('.jsonl'))
        .sort()
        .flatMap((n) => fs.readFileSync(path.join(apiDir, n), 'utf8').split('\n'))
        .filter((l) => l.includes('"http.request"') && l.includes('/v1/messages') && !l.includes('"truncated":true'));
      expect.soft(messageRequests.length, 'the run made at least one complete Anthropic /v1/messages request').toBeGreaterThan(0);
      expect.soft(messageRequests[0] ?? '', 'web_search advertised on the wire').toContain('web_search_20250305');
      expect.soft(messageRequests[0] ?? '', 'web_fetch advertised on the wire').toContain('web_fetch_20250910');

      if (ac1) throw ac1;
    },
    300_000
  );
});
