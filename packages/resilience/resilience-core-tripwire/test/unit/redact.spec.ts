/**
 * guards: a credential or secret URL parameter reaches the lock or the audit in clear text
 * tier: S
 * cites: ticket 8468f7b1; [tripwire-core.7] TW7 (and the TW33 persistence half of [tripwire-core.27]).
 * Ticket 8468f7b1 - redaction: the default redactor drops credential
 * keys (authorization, cookie, set-cookie, token, secret, password,
 * x-auth), strips secret URL query params and credentials, truncates long
 * strings; a custom redactor runs after it; responseBody is never written
 * to the lock or the audit; the audit never carries the query text.
 * Criteria: [tripwire-core.7] TW7 (and the TW33 persistence half of
 * [tripwire-core.27]).
 */
import { defaultRedactor, TripwireTrippedError } from '../../src/index';
import { makeEnv } from '../helpers/harness';

describe('[tripwire-core.7] TW7 default redactor', () => {
  const redact = defaultRedactor();

  it('drops authorization, cookie and token keys at any depth', () => {
    const out = redact({
      authorization: 'Bearer abc',
      Cookie: 'sid=1',
      'set-cookie': 'x=y',
      accessToken: 't',
      clientSecret: 's',
      password: 'p',
      'x-auth-token': 'z',
      headers: {
        Authorization: 'Basic q',
        accept: 'application/json',
      },
      list: [{ token: 'a', ok: 1 }],
      keep: 'yes',
    });
    expect(out).toEqual({
      headers: { accept: 'application/json' },
      list: [{ ok: 1 }],
      keep: 'yes',
    });
  });

  it('strips secret-looking URL query params and URL credentials', () => {
    const out = redact({
      pageUrl: 'https://api.example.com/v1/me?access_token=abc&q=shoes&sig=9',
      other: 'https://u:pw@example.com/path?api_key=k&page=2',
      plain: 'not a url ?token=1',
    });
    expect(out['pageUrl']).toBe('https://api.example.com/v1/me?q=shoes');
    expect(out['other']).toBe('https://example.com/path?page=2');
    expect(out['plain']).toBe('not a url ?token=1');
  });

  it('truncates strings over 2048 characters', () => {
    const out = redact({ big: 'x'.repeat(5000) });
    const big = out['big'] as string;
    expect(big.startsWith('x'.repeat(2048))).toBe(true);
    expect(big).toContain('[truncated 2952 chars]');
    expect(big.length).toBeLessThan(2100);
  });

  it('drops responseBody and non-JSON values', () => {
    const out = redact({
      responseBody: { secret: 1 },
      responseStatus: 401,
      nan: Number.NaN,
      fn: (() => 1) as unknown as string,
      ok: true,
    });
    expect(out).toEqual({
      nan: null,
      ok: true,
    });
  });
});

describe('[tripwire-core.7] TW7 redaction applied by trip', () => {
  it('a custom redactor is composed after the default', async () => {
    const seen: unknown[] = [];
    const env = makeEnv({
      redact: (ctx) => {
        seen.push(ctx);
        const { email: _drop, ...rest } = ctx;
        return {
          ...rest,
          responseBody: 'sneaky',
          authorization: 'again',
        };
      },
    });
    await env.tw.trip('k', {
      reason: 'x',
      context: {
        email: 'a@b.c',
        authorization: 'Bearer t',
        lastStatus: 401,
      },
    });
    // the custom redactor saw already-redacted input
    expect(seen).toEqual([{
      email: 'a@b.c',
      lastStatus: 401,
    }]);
    const lock = env.mfs.readText(env.lockPath('k')) as string;
    expect(JSON.parse(lock).context).toEqual({ lastStatus: 401 });
    expect(lock).not.toContain('sneaky');
    expect(lock).not.toContain('Bearer');
  });

  it('responseBody is never written to the lock or the audit', async () => {
    const env = makeEnv();
    const body = { error: 'RESPONSE-BODY-MARKER' };
    const r = await env.tw.trip('k', {
      reason: 'http-4xx',
      context: {
        lastStatus: 401,
        responseBody: body,
      },
    });
    const err = TripwireTrippedError.fromRecord(r.record, {
      responseStatus: 401,
      responseBody: body,
    });
    expect(err.responseBody).toBe(body);
    await env.tw.gate('k');
    await env.tw.trip('k', {
      reason: 'again',
      context: { responseBody: body },
    });
    expect(env.mfs.readText(env.lockPath('k'))).not.toContain(
      'RESPONSE-BODY-MARKER',
    );
    expect(env.auditText()).not.toContain('RESPONSE-BODY-MARKER');
    expect(JSON.stringify(err)).not.toContain('RESPONSE-BODY-MARKER');
  });

  it('the audit never contains the query text', async () => {
    const env = makeEnv({ clearPolicy: 'open' });
    await env.tw.trip('google', {
      reason: 'captcha',
      context: {
        query: 'very private words',
        pageUrl:
          'https://www.google.com/search?q=very+private+words#frag',
      },
    });
    await env.tw.gate('google');
    await env.tw.resolve('google');
    const audit = env.auditText();
    expect(audit).not.toMatch(/private/);
    expect(audit).toContain('"pageUrl":"https://www.google.com/search"');
    // the lock keeps the forensic query
    await env.tw.trip('google', {
      reason: 'captcha',
      context: { query: 'very private words' },
    });
    expect(env.mfs.readText(env.lockPath('google'))).toContain(
      'very private words',
    );
  });
});
