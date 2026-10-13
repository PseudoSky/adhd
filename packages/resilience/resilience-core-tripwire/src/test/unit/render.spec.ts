/**
 * Ticket 8468f7b1 - the pure status renderers: renderStatusText gives the
 * per-key block (reason, trippedAt, blockedCount, query, pageUrl, and
 * reverifiedAt / resolvedAt only when present) or `No tripwires
 * tripped.`; statusJsonLine is exactly {"type":"tripwireStatus",
 * "status":{...}} on one line, is the last line of the status output, and
 * the map is sparse with plain string keys.
 * Criteria: [tripwire-interactive.5] TW28.
 */
import {
  renderStatusText,
  statusJsonLine,
  type TripwireRecord,
} from '../../index';
import { makeEnv } from '../support/harness';

function rec(
  key: string,
  over: Partial<TripwireRecord> = {},
): TripwireRecord {
  return {
    schema: 1,
    key,
    namespace: 'agent-search',
    reason: 'captcha',
    trippedAt: '2026-10-12T00:00:00.000Z',
    trippedBy: { pid: 1 },
    blockedCount: 2,
    context: { query: 'q one', pageUrl: 'https://example.com/sorry' },
    ...over,
  };
}

/** What a status command prints: the text, then the JSON line. */
function statusOutput(map: Record<string, TripwireRecord>): string[] {
  return `${renderStatusText(map)}\n${statusJsonLine(map)}`.split('\n');
}

describe('[tripwire-interactive.5] TW28 renderStatusText', () => {
  it('an empty map renders `No tripwires tripped.`', () => {
    expect(renderStatusText({})).toBe('No tripwires tripped.');
    expect(renderStatusText({ google: undefined, bing: null }))
      .toBe('No tripwires tripped.');
  });

  it('one block per key, in map order, with the legacy layout', () => {
    const text = renderStatusText({
      google: rec('google'),
      bing: rec('bing', {
        reason: 'banned',
        blockedCount: 0,
        context: {},
      }),
    });
    expect(text.split('\n')).toEqual([
      'google: ⛔ TRIPPED',
      '  reason:       captcha',
      '  trippedAt:    2026-10-12T00:00:00.000Z',
      '  blockedCount: 2',
      '  query:        q one',
      '  pageUrl:      https://example.com/sorry',
      'bing: ⛔ TRIPPED',
      '  reason:       banned',
      '  trippedAt:    2026-10-12T00:00:00.000Z',
      '  blockedCount: 0',
      '  query:        (none)',
      '  pageUrl:      (none)',
    ]);
    expect(text.endsWith('\n')).toBe(false);
  });

  it('reverifiedAt and resolvedAt appear only when present', () => {
    const text = renderStatusText({
      google: rec('google', {
        context: {
          query: 'q',
          pageUrl: 'https://example.com/',
          reverifiedAt: '2026-10-12T01:00:00.000Z',
          resolvedAt: '2026-10-12T02:00:00.000Z',
        },
      }),
    });
    expect(text).toContain('  reverifiedAt: 2026-10-12T01:00:00.000Z');
    expect(text).toContain('  resolvedAt:   2026-10-12T02:00:00.000Z');
    expect(renderStatusText({ google: rec('google') }))
      .not.toMatch(/reverifiedAt|resolvedAt/);
  });

  it('renders the records of a live tw.status() (legacy fields included)',
    async () => {
      const env = makeEnv({ clearPolicy: 'open' });
      await env.tw.trip('duckduckgo', {
        reason: 'rate_limited',
        context: { query: 'abc', pageUrl: 'https://duckduckgo.com/' },
      });
      await env.tw.gate('duckduckgo');
      env.mfs.writeText(env.lockPath('google'), JSON.stringify({
        reason: 'captcha',
        provider: 'google',
        query: 'legacy',
        pageUrl: 'https://www.google.com/sorry',
        trippedAt: '2026-10-11T00:00:00.000Z',
        reverifiedAt: '2026-10-11T00:05:00.000Z',
        blockedCount: 4,
      }), 0o600);
      const text = renderStatusText(await env.tw.status());
      expect(text).toContain('duckduckgo: ⛔ TRIPPED');
      expect(text).toContain('  blockedCount: 1');
      expect(text).toContain('google: ⛔ TRIPPED');
      expect(text).toContain('  query:        legacy');
      expect(text).toContain('  blockedCount: 4');
      expect(text).toContain('  reverifiedAt: 2026-10-11T00:05:00.000Z');
    });
});

describe('[tripwire-interactive.5] TW28 statusJsonLine', () => {
  it('is exactly {"type":"tripwireStatus","status":{...}}', () => {
    expect(statusJsonLine({})).toBe('{"type":"tripwireStatus","status":{}}');
    const g = rec('google');
    const line = statusJsonLine({ google: g });
    expect(line).toBe(
      `{"type":"tripwireStatus","status":{"google":${JSON.stringify(g)}}}`,
    );
    expect(JSON.parse(line)).toEqual({
      type: 'tripwireStatus',
      status: { google: g },
    });
  });

  it('is a single line even when values carry newlines', () => {
    const line = statusJsonLine({
      google: rec('google', { context: { query: 'a\nb' } }),
    });
    expect(line.includes('\n')).toBe(false);
  });

  it('is the last line of the status output, for empty and full maps',
    () => {
      const maps: Array<Record<string, TripwireRecord>> = [
        {},
        { google: rec('google') },
      ];
      for (const map of maps) {
        const lines = statusOutput(map);
        const last = lines[lines.length - 1] as string;
        expect(JSON.parse(last)).toMatchObject({ type: 'tripwireStatus' });
        expect(lines.slice(0, -1).some((l) => l.includes('tripwireStatus')))
          .toBe(false);
      }
      expect(statusOutput({})[0]).toBe('No tripwires tripped.');
    });

  it('the map is sparse with plain string keys', async () => {
    const line = statusJsonLine({
      google: rec('google'),
      bing: undefined,
      yandex: null,
    });
    const parsed = JSON.parse(line) as {
      status: Record<string, unknown>;
    };
    expect(Object.keys(parsed.status)).toEqual(['google']);
    // a null-prototype input is serialised as a plain object
    const bare = Object.create(null) as Record<string, TripwireRecord>;
    bare['google'] = rec('google');
    expect(statusJsonLine(bare)).toBe(statusJsonLine({ google: bare['google'] }));
    // the live status map: only tripped keys, keyed by the plain key
    const env = makeEnv({ clearPolicy: 'open' });
    await env.tw.trip('google', { reason: 'captcha', context: {} });
    await env.tw.trip('bing', { reason: 'banned', context: {} });
    await env.tw.clear('bing', { method: 'mcp-clear' });
    const live = JSON.parse(statusJsonLine(await env.tw.status())) as {
      status: Record<string, TripwireRecord>;
    };
    expect(Object.keys(live.status)).toEqual(['google']);
    expect(live.status['google']?.key).toBe('google');
    expect(Object.getPrototypeOf(live.status)).toBe(Object.prototype);
  });
});
