/**
 * Ticket 8468f7b1 - typed errors: a stable `code` from the closed registry
 * and the brand Symbol.for('adhd.tripwire.error') on every error class, so
 * isTripwireError / isTripwireTrippedError recognise an error thrown by a
 * duplicate copy of the package (where `instanceof` fails); and
 * TripwireTrippedError.fromRecord carries typed, memory-only responseStatus
 * and responseBody that are never serialized, written to the lock or
 * audited.
 * Criteria: [tripwire-core.26] TW32, [tripwire-core.27] TW33.
 */
import {
  createTripwire,
  isTripwireError,
  isTripwireTrippedError,
  TripwireAbortedError,
  TripwireConfirmError,
  TripwireError,
  TripwireIoError,
  TripwireKeyError,
  TripwireTrippedError,
  type TripwireErrorCode,
  type TripwireRecord,
} from '../../index';
import {
  TRIPWIRE_ERROR_BRAND,
  TRIPWIRE_ERROR_CODES,
} from '../../lib/errors';
import { makeEnv, rejectionOf } from '../support/harness';

/** The brand, spelled independently of this module's copy. */
const BRAND = Symbol.for('adhd.tripwire.error');

const REGISTRY: readonly TripwireErrorCode[] = [
  'TRIPWIRE_TRIPPED',
  'TRIPWIRE_CONFIRM_REQUIRED',
  'TRIPWIRE_ABORTED',
  'TRIPWIRE_INVALID_KEY',
  'TRIPWIRE_IO',
];

const RECORD: TripwireRecord = {
  schema: 1,
  key: 'tinder',
  namespace: 'request-builder',
  reason: 'http-4xx',
  trippedAt: '2026-10-12T00:00:00.000Z',
  trippedBy: { pid: 42 },
  blockedCount: 0,
  context: {
    lastStatus: 401,
    lastOperationId: 'getMe',
  },
};

/**
 * Structural stand-in for an error created by a DUPLICATE module copy: a
 * plain Error (not an instance of this copy's classes) carrying the
 * registry brand and code exactly as the other copy would set them.
 */
function foreignError(code: string, extra: Record<string, unknown> = {}) {
  const e = Object.assign(new Error('from another copy'), {
    code,
    ...extra,
  }) as unknown as Error & Record<PropertyKey, unknown>;
  e[BRAND] = true;
  return e;
}

describe('[tripwire-core.26] TW32 stable code and brand on every error', () => {
  const instances: Array<[string, TripwireError, TripwireErrorCode]> = [
    ['TripwireTrippedError', TripwireTrippedError.fromRecord(RECORD),
      'TRIPWIRE_TRIPPED'],
    ['TripwireConfirmError', new TripwireConfirmError('k'),
      'TRIPWIRE_CONFIRM_REQUIRED'],
    ['TripwireKeyError', new TripwireKeyError('../x'), 'TRIPWIRE_INVALID_KEY'],
    ['TripwireIoError', new TripwireIoError('trip.persist', new Error('EIO')),
      'TRIPWIRE_IO'],
    ['TripwireAbortedError', new TripwireAbortedError(), 'TRIPWIRE_ABORTED'],
  ];

  it('the registry is exactly the five codes', () => {
    expect([...TRIPWIRE_ERROR_CODES].sort()).toEqual([...REGISTRY].sort());
    expect(TRIPWIRE_ERROR_BRAND).toBe(BRAND);
  });

  it.each(instances)('%s has a registry code, the brand and its name',
    (name, err, code) => {
      expect(err.code).toBe(code);
      expect(REGISTRY).toContain(err.code);
      expect((err as unknown as Record<symbol, unknown>)[BRAND]).toBe(true);
      expect(err.name).toBe(name);
      expect(err).toBeInstanceOf(TripwireError);
      expect(err).toBeInstanceOf(Error);
      expect(isTripwireError(err)).toBe(true);
      expect(isTripwireTrippedError(err)).toBe(code === 'TRIPWIRE_TRIPPED');
    });

  it('isTripwireTrippedError is true for a structural clone from a '
    + 'duplicate module copy (brand + code, no instanceof)', () => {
    const clone = foreignError('TRIPWIRE_TRIPPED', {
      key: 'tinder',
      reason: 'http-4xx',
    });
    expect(clone).not.toBeInstanceOf(TripwireTrippedError);
    expect(clone).not.toBeInstanceOf(TripwireError);
    expect(isTripwireError(clone)).toBe(true);
    expect(isTripwireTrippedError(clone)).toBe(true);
    // every registry code is recognised the same way
    for (const code of REGISTRY) {
      expect(isTripwireError(foreignError(code))).toBe(true);
      expect(isTripwireTrippedError(foreignError(code)))
        .toBe(code === 'TRIPWIRE_TRIPPED');
    }
  });

  it('rejects look-alikes: brand with an unknown code, code without the '
    + 'brand, a plain Error with .code, non-objects', () => {
    expect(isTripwireError(foreignError('TRIPWIRE_NOPE'))).toBe(false);
    expect(isTripwireTrippedError(foreignError('ENOENT'))).toBe(false);
    const unbranded = Object.assign(new Error('x'), {
      code: 'TRIPWIRE_TRIPPED',
    });
    expect(isTripwireError(unbranded)).toBe(false);
    expect(isTripwireTrippedError(unbranded)).toBe(false);
    const wrongBrand = foreignError('TRIPWIRE_TRIPPED');
    wrongBrand[BRAND] = 'yes';
    expect(isTripwireTrippedError(wrongBrand)).toBe(false);
    for (const v of [null, undefined, 'TRIPWIRE_TRIPPED', 42, {}]) {
      expect(isTripwireError(v)).toBe(false);
      expect(isTripwireTrippedError(v)).toBe(false);
    }
  });

  it('errors thrown by the latch carry their codes', async () => {
    const env = makeEnv();
    const keyErr = await rejectionOf(env.tw.read('../escape'));
    expect(isTripwireError(keyErr)).toBe(true);
    expect((keyErr as TripwireError).code).toBe('TRIPWIRE_INVALID_KEY');
    await env.tw.trip('k', {
      reason: 'captcha',
      context: {},
    });
    const confirm = await rejectionOf(env.tw.clear('k', {
      method: 'programmatic-confirm',
      confirm: 'wrong',
    }));
    expect((confirm as TripwireError).code).toBe('TRIPWIRE_CONFIRM_REQUIRED');
    const tripped = await rejectionOf(env.tw.assertOpen('k'));
    expect(isTripwireTrippedError(tripped)).toBe(true);
    env.mfs.failOn({
      op: 'rename',
      path: env.lockPath('k'),
      code: 'EACCES',
    });
    const io = await rejectionOf(env.tw.clear('k', {
      method: 'programmatic-confirm',
      confirm: 'I-UNDERSTAND-THE-RISK',
    }));
    expect((io as TripwireIoError).code).toBe('TRIPWIRE_IO');
    expect(((io as TripwireIoError).cause as { code: string }).code)
      .toBe('EACCES');
  });
});

describe('[tripwire-core.27] TW33 fromRecord responseStatus / responseBody',
  () => {
    const SENTINEL = 'SENTINEL-BODY-7f3a';

    it('exposes typed fields and the record', () => {
      const err = TripwireTrippedError.fromRecord(RECORD, {
        responseStatus: 401,
        responseBody: {
          error: SENTINEL,
        },
      });
      const status: number | undefined = err.responseStatus;
      const body: unknown = err.responseBody;
      expect(status).toBe(401);
      expect(body).toEqual({ error: SENTINEL });
      expect(err.key).toBe('tinder');
      expect(err.reason).toBe('http-4xx');
      expect(err.trippedAt).toBeInstanceOf(Date);
      expect(err.trippedAt.toISOString()).toBe(RECORD.trippedAt);
      expect(err.record).toBe(RECORD);
      expect(typeof err.recoveryHint).toBe('string');
      expect(err.code).toBe('TRIPWIRE_TRIPPED');
    });

    it('responseBody is non-enumerable and never serialized', () => {
      const err = TripwireTrippedError.fromRecord(RECORD, {
        responseStatus: 403,
        responseBody: SENTINEL,
      });
      expect(Object.keys(err)).not.toContain('responseBody');
      const json = JSON.stringify(err);
      expect(json).not.toContain(SENTINEL);
      expect(json).not.toContain('responseBody');
      expect(JSON.parse(json)).toMatchObject({
        code: 'TRIPWIRE_TRIPPED',
        responseStatus: 403,
      });
      // the record's context is not part of the JSON form either
      expect(json).not.toContain('getMe');
      const plain = TripwireTrippedError.fromRecord(RECORD);
      expect(plain.responseStatus).toBeUndefined();
      expect(plain.responseBody).toBeUndefined();
    });

    it('trip never writes responseStatus or responseBody to the lock or the '
      + 'audit', async () => {
      const env = makeEnv();
      const tw = createTripwire({
        namespace: 'request-builder',
        stateDir: '/state',
        fs: env.mfs,
        clock: env.clock.fn,
        actor: 'tester',
      });
      // a consumer that (wrongly) puts the body into the context
      const r = await tw.trip('tinder', {
        reason: 'http-4xx',
        context: {
          lastStatus: 401,
          lastOperationId: 'getMe',
          responseBody: SENTINEL,
        },
      });
      const err = TripwireTrippedError.fromRecord(r.record, {
        responseStatus: 401,
        responseBody: SENTINEL,
      });
      expect(err.responseBody).toBe(SENTINEL);
      await tw.gate('tinder');
      await rejectionOf(tw.assertOpen('tinder'));
      const lock = env.mfs.readText(env.lockPath('tinder')) as string;
      const audit = env.auditText();
      for (const text of [lock, audit]) {
        expect(text).not.toContain(SENTINEL);
        expect(text).not.toContain('responseStatus');
      }
      expect(JSON.parse(lock).context).not.toHaveProperty('responseBody');
    });
  });
