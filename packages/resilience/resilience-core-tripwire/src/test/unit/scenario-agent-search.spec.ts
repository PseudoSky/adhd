/**
 * Ticket 8468f7b1 - scenario: the agent-search consumer, end to end on the
 * memory fs, with its real configuration (clearPolicy 'open', expiry
 * ttlMs 2 h, namespace agent-search). A miniature search mirrors the
 * MCP and CLI flows: the tripwire gate runs before Chrome is touched; a
 * captcha trips the provider key; later searches get a locked `hitl`
 * response without touching Chrome; the CLI HITL loop (interactiveGate)
 * offers retry, clear and abort; confirmSolved handles the post-trip
 * prompt; the TTL expiry removes the lock lazily with an audit line; a
 * successful search resolves a still-tripped key; the MCP clear needs no
 * token.
 * Criteria: [tripwire-interactive.7] (TW13, TW15, TW18, TW24, TW26).
 */
import {
  TripwireAbortedError,
  confirmSolved,
  interactiveGate,
  renderStatusText,
  statusJsonLine,
  type TripwireIo,
  type TripwireRecord,
} from '../../index';
import { eventsOf, makeEnv, rejectionOf, type Env } from '../support/harness';
import { fakeIo } from '../support/io';

const TWO_HOURS = 7_200_000;
const PAGE = 'https://www.google.com/sorry/index';

type Outcome = 'ok' | 'captcha';

interface SearchResponse {
  outcome: 'ok' | 'hitl';
  locked?: boolean;
  record?: TripwireRecord | null;
  hitl?: { reason: string; pageUrl: string; strategy: string };
}

function agentSearchEnv(): Env {
  return makeEnv({
    namespace: 'agent-search',
    clearPolicy: 'open',
    expiry: { ttlMs: TWO_HOURS },
    sessionId: () => 'search-session-1',
  });
}

/** The agent-search consumer in miniature. */
function agentSearch(env: Env, outcomes: Outcome[]) {
  const tw = env.tw;
  const chrome = { ready: 0 };
  const script = [...outcomes];

  /** The MCP path: a locked key answers `hitl` without touching Chrome. */
  async function search(provider: string, query: string):
  Promise<SearchResponse> {
    const g = await tw.gate(provider);
    if (!g.open) {
      return { outcome: 'hitl', locked: true, record: g.snapshot.record };
    }
    return run(provider, query);
  }

  async function run(provider: string, query: string):
  Promise<SearchResponse> {
    chrome.ready += 1;
    const outcome = script.shift() ?? 'ok';
    if (outcome === 'captcha') {
      await tw.trip(provider, {
        reason: 'captcha',
        context: {
          query,
          pageUrl: PAGE,
          strategy: 'serp',
          browserSessionId: 'target-1',
        },
      });
      return {
        outcome: 'hitl',
        hitl: { reason: 'captcha', pageUrl: PAGE, strategy: 'serp' },
      };
    }
    // a later success resolves a tripwire that is still tripped
    if ((await tw.read(provider)).status !== 'clear') {
      await tw.resolve(provider);
    }
    return { outcome: 'ok' };
  }

  /** The CLI path: HITL gate loop, then the post-trip prompt. */
  async function cliSearch(
    provider: string,
    query: string,
    io: TripwireIo,
  ): Promise<SearchResponse> {
    await interactiveGate(tw, provider, io, { keyLabel: 'Provider' });
    for (;;) {
      const r = await run(provider, query);
      if (r.outcome !== 'hitl' || !r.hitl) return r;
      await confirmSolved(tw, provider, {
        ...r.hitl,
        query,
        sessionId: 'search-session-1',
      }, io, { keyLabel: 'Provider' });
    }
  }

  /** The part of a search after its gate passed (an in-flight search). */
  const afterGate = run;

  return { chrome, search, cliSearch, afterGate };
}

describe('[tripwire-interactive.7] agent-search: captcha trips, later ' +
  'searches are locked', () => {
  it('a captcha trips the provider key with the forensic context',
    async () => {
      const env = agentSearchEnv();
      const s = agentSearch(env, ['captcha']);
      const r = await s.search('google', 'tripwire latch');
      expect(r.outcome).toBe('hitl');
      const snap = await env.tw.read('google');
      expect(snap.status).toBe('tripped');
      expect(snap.record).toMatchObject({
        namespace: 'agent-search',
        reason: 'captcha',
        trippedBy: { sessionId: 'search-session-1' },
        context: {
          query: 'tripwire latch',
          pageUrl: PAGE,
          strategy: 'serp',
          browserSessionId: 'target-1',
        },
      });
      // the query text is never audited
      expect(env.auditText()).not.toContain('tripwire latch');
    });

  it('later searches get a locked hitl response without touching Chrome',
    async () => {
      const env = agentSearchEnv();
      const s = agentSearch(env, ['captcha']);
      await s.search('google', 'q');
      expect(s.chrome.ready).toBe(1);
      for (let i = 1; i <= 3; i++) {
        const r = await s.search('google', `q${i}`);
        expect(r).toMatchObject({ outcome: 'hitl', locked: true });
        expect(r.record?.reason).toBe('captcha');
        expect(r.record?.blockedCount).toBe(i);
      }
      expect(s.chrome.ready).toBe(1);
      // other providers still search
      expect((await s.search('bing', 'q')).outcome).toBe('ok');
      // status: one sparse entry, rendered with the JSON line last
      const map = await env.tw.status();
      expect(Object.keys(map)).toEqual(['google']);
      expect(renderStatusText(map)).toContain('  blockedCount: 3');
      expect(JSON.parse(statusJsonLine(map)).status.google.reason)
        .toBe('captcha');
    });
});

describe('[tripwire-interactive.7] agent-search: the HITL loop offers ' +
  'retry, clear and abort', () => {
  async function trippedSearch(): Promise<{
    env: Env;
    s: ReturnType<typeof agentSearch>;
  }> {
    const env = agentSearchEnv();
    const s = agentSearch(env, ['captcha', 'ok']);
    await s.search('google', 'q');
    return { env, s };
  }

  it('retry: reverified + clear, then the search runs', async () => {
    const { env, s } = await trippedSearch();
    const io = fakeIo(['retry']);
    expect((await s.cliSearch('google', 'q', io)).outcome).toBe('ok');
    expect(io.errText()).toContain('  Provider:    google');
    expect(eventsOf(env, 'tripwire-cleared')).toEqual([
      expect.objectContaining({ method: 'hitl-retry', reverified: true }),
    ]);
    expect(s.chrome.ready).toBe(2);
  });

  it('clear: force-clear (hitl-clear), then the search runs', async () => {
    const { env, s } = await trippedSearch();
    expect((await s.cliSearch('google', 'q', fakeIo(['clear']))).outcome)
      .toBe('ok');
    expect(eventsOf(env, 'tripwire-cleared')).toEqual([
      expect.objectContaining({ method: 'hitl-clear', reverified: false }),
    ]);
  });

  it('abort: TripwireAbortedError, Chrome untouched, lock kept', async () => {
    const { env, s } = await trippedSearch();
    const err = await rejectionOf(s.cliSearch('google', 'q', fakeIo(['abort'])));
    expect(err).toBeInstanceOf(TripwireAbortedError);
    expect(s.chrome.ready).toBe(1);
    expect((await env.tw.read('google')).status).toBe('tripped');
  });

  it('closed stdin aborts instead of hanging; the lock is kept', async () => {
    const { env, s } = await trippedSearch();
    const err = await rejectionOf(s.cliSearch('google', 'q', fakeIo([null])));
    expect(err).toBeInstanceOf(TripwireAbortedError);
    expect((await env.tw.read('google')).status).toBe('tripped');
  });

  it('a captcha during a CLI search: Enter after solving clears and ' +
    'retries; abort keeps the lock for the next invocation', async () => {
    const env = agentSearchEnv();
    const s = agentSearch(env, ['captcha', 'ok', 'captcha']);
    const io = fakeIo(['']);
    expect((await s.cliSearch('google', 'q', io)).outcome).toBe('ok');
    expect(io.errText()).toContain('HUMAN-IN-THE-LOOP INTERRUPT');
    expect(io.errText()).toContain('  Session:      search-session-1');
    expect(eventsOf(env, 'tripwire-cleared')).toEqual([
      expect.objectContaining({ method: 'hitl-retry', reverified: true }),
    ]);
    const err = await rejectionOf(s.cliSearch('google', 'q', fakeIo(['abort'])));
    expect((err as Error).message).toBe('HITL aborted by user');
    const next = await s.search('google', 'q');
    expect(next).toMatchObject({ outcome: 'hitl', locked: true });
  });

  it('the MCP clear (policy open) needs no token', async () => {
    const { env, s } = await trippedSearch();
    expect(await env.tw.clear('google', { method: 'mcp-clear' }))
      .toEqual({ cleared: true });
    expect((await s.search('google', 'q')).outcome).toBe('ok');
    expect(eventsOf(env, 'tripwire-cleared')[0]?.method).toBe('mcp-clear');
  });
});

describe('[tripwire-interactive.7] agent-search: TTL expiry (2 h) and ' +
  'resolve on success', () => {
  it('the lock expires lazily after ttlMs, with one audit line', async () => {
    const env = agentSearchEnv();
    const s = agentSearch(env, ['captcha', 'ok']);
    await s.search('google', 'q');
    env.clock.advance(TWO_HOURS);
    expect((await s.search('google', 'q')).locked).toBe(true);
    env.clock.advance(1);
    // hidden from status before anyone gates it, but still on disk
    expect(await env.tw.status()).toEqual({});
    expect(Object.keys(await env.tw.status({ includeExpired: true })))
      .toEqual(['google']);
    expect(env.mfs.exists(env.lockPath('google'))).toBe(true);
    expect(eventsOf(env, 'tripwire-expired')).toHaveLength(0);
    // the next search removes it lazily and proceeds
    expect((await s.search('google', 'q')).outcome).toBe('ok');
    expect(env.mfs.exists(env.lockPath('google'))).toBe(false);
    expect(eventsOf(env, 'tripwire-expired')).toEqual([
      expect.objectContaining({
        key: 'google',
        reason: 'captcha',
        method: 'expired',
        blockedCount: 1,
      }),
    ]);
    // a successful search on a clear key resolves nothing
    expect(eventsOf(env, 'tripwire-resolved')).toHaveLength(0);
  });

  it('a successful search resolves a still-tripped key', async () => {
    const env = agentSearchEnv();
    const s = agentSearch(env, ['captcha', 'ok']);
    // search A passes the gate; search B then hits a captcha and trips
    expect((await env.tw.gate('google')).open).toBe(true);
    await s.search('google', 'b');
    expect((await env.tw.read('google')).status).toBe('tripped');
    env.clock.advance(60_000);
    // search A succeeds afterwards: the provider is fine, resolve
    expect((await s.afterGate('google', 'a')).outcome).toBe('ok');
    expect(eventsOf(env, 'tripwire-resolved')).toEqual([
      expect.objectContaining({
        key: 'google',
        reason: 'captcha',
        durationMs: 60_000,
        blockedCount: 0,
      }),
    ]);
    expect(eventsOf(env, 'tripwire-cleared')).toEqual([
      expect.objectContaining({ method: 'resolved' }),
    ]);
    expect(env.mfs.exists(env.lockPath('google'))).toBe(false);
    expect((await s.search('google', 'c')).outcome).toBe('ok');
    // the resolve is recorded for the next trip
    await agentSearch(env, ['captcha']).search('google', 'd');
    expect((await env.tw.read('google')).record?.priorClear?.method)
      .toBe('resolved');
  });
});
