/**
 * guards: the audit line written when a tripped entry's ttl passes names the tripped reason instead of ttl-expired
 * tier: S
 * cites: 8468f7b1 [fix-tripwire.1]
 * Backlog 84e1f7a2 - a lock whose ttl has passed is removed lazily by the next
 * gate and exactly one `tripwire-expired` audit line is appended. The line's
 * reason is `ttl-expired`, so a reader of the audit log can tell an expiry
 * from the original trip reason. Simulated end to end over the memory fs:
 * trip, let the ttl pass, gate, read the written audit line back.
 */
import { EXPIRY_AUDIT_REASON } from '../../src/lib/audit';
import { eventsOf, makeEnv } from '../helpers/harness';

const TTL_MS = 7_200_000;

describe('[fix-tripwire.1] 84e1f7a2 audit line of an expired entry', () => {
  it('writes reason ttl-expired on the audit line when a tripped entry expires', async () => {
    const env = makeEnv({ expiry: { ttlMs: TTL_MS } });
    await env.tw.trip('google', { reason: 'captcha', context: {} });
    env.clock.advance(TTL_MS + 1);
    expect((await env.tw.gate('google')).open).toBe(true);

    const written = env
      .auditText()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { event: string; reason?: string });
    const expired = written.filter((e) => e.event === 'tripwire-expired');
    expect(expired).toHaveLength(1);
    expect(expired[0].reason).toBe('ttl-expired');
    expect(EXPIRY_AUDIT_REASON).toBe('ttl-expired');
  });

  it('keeps ttl-expired on the audit line whatever the original trip reason was', async () => {
    const env = makeEnv({ expiry: { ttlMs: TTL_MS } });
    await env.tw.trip('k', { reason: 'rate_limited', context: {} });
    env.clock.advance(TTL_MS + 1);
    await env.tw.gate('k');
    expect(eventsOf(env, 'tripwire-expired')).toEqual([
      expect.objectContaining({
        key: 'k',
        reason: 'ttl-expired',
        method: 'expired',
        blockedCount: 0,
      }),
    ]);
  });
});
