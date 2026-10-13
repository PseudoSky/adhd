/**
 * Ticket 8468f7b1 - the NDJSON audit: one line per event for all six
 * events, every line under 4 KB; the byte-accurate maxAuditBytes cap with
 * multibyte lines and an atomic replace; the audit directory follows
 * auditPath; audit failures go to onWarning and never throw.
 * Criteria: [tripwire-core.19] TW19, [tripwire-core.20] TW20,
 * [tripwire-core.21] TW21, [tripwire-core.22] TW22.
 */
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONFIRM_TOKEN,
  createMemoryFs,
  createTripwire,
  type MemoryFs,
} from '../../index';
import {
  AUDIT_LINE_MAX_BYTES,
  clampAuditBytes,
  createAuditLog,
  formatAuditLine,
  keepNewest,
  MIN_AUDIT_BYTES,
} from '../../lib/audit';
import { makeEnv, processView, STATE_DIR } from '../support/harness';

const enc = new TextEncoder();
const strict = new TextDecoder('utf-8', { fatal: true });
const AUDIT = '/logs/audit.log';
const CAP = MIN_AUDIT_BYTES;

let seq = 0;
const suffix = (): string => `t.${(seq += 1)}`;

/** A multibyte NDJSON line of roughly `size` bytes numbered `n`. */
function line(n: number, size = 900): string {
  const pad = '€😀ü'.repeat(Math.ceil(size / 9));
  return JSON.stringify({
    n,
    pad: pad.slice(0, Math.floor(size / 3)),
  }) + '\n';
}

/**
 * Pre-fill `mfs` at AUDIT with whole multibyte lines 1..last, stopping when
 * the next line would take the file above CAP (so the next append rotates).
 */
function fillToCap(mfs: MemoryFs): number {
  let size = 0;
  let n = 0;
  let text = '';
  while (size + enc.encode(line(n + 1)).length <= CAP) {
    n += 1;
    text += line(n);
    size += enc.encode(line(n)).length;
  }
  mfs.writeText(AUDIT, text, 0o600);
  return n;
}

describe('[tripwire-core.19] TW19 one NDJSON line per event', () => {
  it('emits all six events with ts, event, key and namespace', async () => {
    const env = makeEnv({
      expiry: { ttlMs: 1000 },
      sessionId: () => 's-1',
    });
    await env.tw.trip('a', {
      reason: 'captcha',
      context: {},
    });
    await env.tw.trip('a', {
      reason: 'captcha',
      context: {},
    });
    await env.tw.gate('a');
    await env.tw.clear('a', {
      method: 'programmatic-confirm',
      confirm: CONFIRM_TOKEN,
    });
    await env.tw.trip('b', {
      reason: 'banned',
      context: {},
    });
    await env.tw.resolve('b');
    await env.tw.trip('c', {
      reason: 'rate_limited',
      context: {},
    });
    env.clock.advance(1001);
    await env.tw.gate('c');
    const text = env.auditText();
    const lines = text.split('\n').filter(Boolean);
    const events = lines.map((l) => JSON.parse(l));
    expect(events.map((e) => e.event)).toEqual([
      'tripwire-fired',
      'tripwire-retripped',
      'tripwire-gate-blocked',
      'tripwire-cleared',
      'tripwire-fired',
      'tripwire-resolved',
      'tripwire-cleared',
      'tripwire-fired',
      'tripwire-expired',
    ]);
    for (const e of events) {
      expect(typeof e.ts).toBe('string');
      expect(Number.isNaN(Date.parse(e.ts))).toBe(false);
      expect(typeof e.key).toBe('string');
      expect(e.namespace).toBe('test-ns');
      expect(e.sessionId).toBe('s-1');
      expect(e).not.toHaveProperty('context');
    }
    for (const l of lines) {
      expect(enc.encode(l + '\n').length).toBeLessThan(AUDIT_LINE_MAX_BYTES);
    }
  });

  it('every line stays under 4 KB even with huge fields', async () => {
    const huge = 'r'.repeat(20_000);
    const env = makeEnv({
      namespace: 'n'.repeat(10_000),
      sessionId: () => 's'.repeat(10_000),
    });
    await env.tw.trip('k', {
      reason: huge,
      context: { pageUrl: `https://example.com/${'p'.repeat(5000)}` },
    });
    await env.tw.gate('k');
    const lines = env.auditText().split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      expect(enc.encode(l + '\n').length).toBeLessThan(AUDIT_LINE_MAX_BYTES);
      const e = JSON.parse(l);
      expect(e.truncated).toBe(true);
      expect(e.key).toBe('k');
    }
    const minimal = formatAuditLine({
      ts: 't',
      event: 'tripwire-fired',
      key: 'k',
      namespace: 'n',
      priorClear: {
        clearedAt: 'x',
        method: 'mcp-clear',
        actor: 'a'.repeat(9000),
      },
    });
    expect(enc.encode(minimal).length).toBeLessThan(AUDIT_LINE_MAX_BYTES);
  });
});

describe('[tripwire-core.20] TW20 maxAuditBytes cap', () => {
  it('clamps maxAuditBytes to the 100000-byte minimum, default 5 MiB', () => {
    expect(clampAuditBytes(10)).toBe(MIN_AUDIT_BYTES);
    expect(clampAuditBytes(undefined)).toBe(5 * 1024 * 1024);
    expect(clampAuditBytes(250_000.7)).toBe(250_000);
  });

  it('keepNewest cuts at a line boundary, byte-accurate (multibyte)', () => {
    const text = line(1, 300) + line(2, 300) + line(3, 300);
    const bytes = enc.encode(text);
    const budget = bytes.length - enc.encode(line(1, 300)).length + 5;
    const kept = strict.decode(keepNewest(bytes, budget));
    expect(kept).toBe(line(2, 300) + line(3, 300));
    expect(strict.decode(keepNewest(bytes, bytes.length))).toBe(text);
    expect(keepNewest(enc.encode('partial'), 100)).toEqual(
      enc.encode('partial\n'),
    );
  });

  it('drops the oldest half; never above the cap after an append',
    async () => {
      const mfs = createMemoryFs();
      const log = createAuditLog({
        path: AUDIT,
        maxAuditBytes: CAP,
        fs: mfs,
        uniqueSuffix: suffix,
      });
      let rotations = 0;
      let prevSize = 0;
      for (let n = 1; n <= 400; n += 1) {
        await log.append(line(n));
        const bytes = mfs.readBytes(AUDIT) as Uint8Array;
        expect(bytes.length).toBeLessThanOrEqual(CAP);
        if (bytes.length < prevSize) {
          rotations += 1;
          // the newest half is kept: at most cap/2 plus the new line
          expect(bytes.length).toBeLessThanOrEqual(
            CAP / 2 + enc.encode(line(n)).length,
          );
          expect(bytes.length).toBeGreaterThan(CAP / 2 - 2000);
        }
        prevSize = bytes.length;
        // byte-accurate: never a split multibyte character or line
        const text = strict.decode(bytes);
        expect(text.endsWith('\n')).toBe(true);
        const ns = text.split('\n').filter(Boolean)
          .map((l) => JSON.parse(l).n as number);
        // the newest lines are kept, contiguous, ending with this one
        expect(ns[ns.length - 1]).toBe(n);
        for (let i = 1; i < ns.length; i += 1) {
          expect(ns[i]).toBe(ns[i - 1] + 1);
        }
      }
      expect(rotations).toBeGreaterThanOrEqual(3);
      expect(mfs.files()).toEqual([AUDIT]);
    });

  it('the replace is atomic: the log is never observed partial', async () => {
    const mfs = createMemoryFs();
    const last = fillToCap(mfs);
    expect((mfs.readBytes(AUDIT) as Uint8Array).length).toBeGreaterThan(
      CAP - 1000,
    );
    const observed: string[] = [];
    mfs.observe(() => {
      const b = mfs.readBytes(AUDIT);
      if (b === undefined) return;
      const t = strict.decode(b);
      if (t !== '' && !t.endsWith('\n')) observed.push(t.slice(-40));
    });
    const log = createAuditLog({
      path: AUDIT,
      maxAuditBytes: CAP,
      fs: mfs,
      uniqueSuffix: suffix,
    });
    await log.append(line(last + 1));
    await log.append(line(last + 2));
    mfs.observe(undefined);
    expect(observed).toEqual([]);
    const installs = mfs.ops.filter((o) => o.op === 'link' &&
      o.path2 === AUDIT);
    expect(installs).toHaveLength(1);
    const ns = (mfs.readText(AUDIT) as string).split('\n').filter(Boolean)
      .map((l) => JSON.parse(l).n);
    expect(ns.slice(-2)).toEqual([last + 1, last + 2]);
    // the oldest half was dropped, the newest half kept contiguous
    expect(ns[0]).toBeGreaterThan(Math.floor(last / 3));
    for (let i = 1; i < ns.length; i += 1) expect(ns[i]).toBe(ns[i - 1] + 1);
  });

  it('an append interleaved with rotation loses no complete line',
    async () => {
      const mfs = createMemoryFs();
      const last = fillToCap(mfs);
      const a = createAuditLog({
        path: AUDIT,
        maxAuditBytes: CAP,
        fs: processView(mfs),
        uniqueSuffix: suffix,
      });
      const b = createAuditLog({
        path: AUDIT,
        maxAuditBytes: CAP,
        fs: processView(mfs),
        uniqueSuffix: suffix,
      });
      // b appends while a rotates: each b op lands between a's ops
      const pending: Array<Promise<void>> = [];
      let fired = 0;
      mfs.observe((rec) => {
        if (rec.path.startsWith(AUDIT) && rec.op !== 'stat' && fired < 6) {
          fired += 1;
          pending.push(b.append(line(1000 + fired, 200)));
        }
      });
      await a.append(line(last + 1));
      await Promise.all(pending);
      mfs.observe(undefined);
      const ns = (mfs.readText(AUDIT) as string).split('\n').filter(Boolean)
        .map((l) => JSON.parse(l).n as number);
      expect(fired).toBe(6);
      for (const want of [last + 1, 1001, 1002, 1003, 1004, 1005, 1006]) {
        expect(ns.filter((x) => x === want)).toHaveLength(1);
      }
      const old = ns.filter((x) => x <= last);
      expect(old[old.length - 1]).toBe(last);
      expect(old[0]).toBeGreaterThan(Math.floor(last / 3));
      for (let i = 1; i < old.length; i += 1) {
        expect(old[i]).toBe(old[i - 1] + 1);
      }
      expect(mfs.files()).toEqual([AUDIT]);
    });
});

describe('[tripwire-core.21] TW21 the audit directory follows auditPath', () => {
  it('defaults to <stateDir>/audit.log', async () => {
    const env = makeEnv();
    await env.tw.trip('k', {
      reason: 'x',
      context: {},
    });
    expect(env.mfs.exists(`${STATE_DIR}/audit.log`)).toBe(true);
  });

  it('an auditPath outside stateDir works and nothing else is written',
    async () => {
      const env = makeEnv({ auditPath: '/elsewhere/deep/a.log' });
      await env.tw.trip('k', {
        reason: 'x',
        context: {},
      });
      await env.tw.gate('k');
      expect(env.mfs.readText('/elsewhere/deep/a.log')).toContain(
        'tripwire-gate-blocked',
      );
      expect(env.mfs.exists(`${STATE_DIR}/audit.log`)).toBe(false);
      const home = homedir();
      for (const op of env.mfs.ops) {
        expect(op.path.startsWith(home)).toBe(false);
        expect(op.path.startsWith(STATE_DIR) ||
          op.path.startsWith('/elsewhere/deep')).toBe(true);
      }
    });

  it('constructing with the default Node fs performs no IO', () => {
    const stateDir = join(tmpdir(), `tripwire-never-${process.pid}-${seq}`);
    createTripwire({
      namespace: 'n',
      stateDir,
    });
    expect(existsSync(stateDir)).toBe(false);
  });
});

describe('[tripwire-core.22] TW22 audit failures go to onWarning', () => {
  it('gate, trip and clear never throw on an audit write failure',
    async () => {
      const env = makeEnv({ clearPolicy: 'open' });
      env.mfs.failOn({
        op: ['appendFile', 'mkdir'],
        path: /audit\.log$|^\/state$/,
        code: 'ENOSPC',
      });
      const r = await env.tw.trip('k', {
        reason: 'x',
        context: {},
      });
      expect(r.persisted).toBe(true);
      expect((await env.tw.gate('k')).open).toBe(false);
      expect(await env.tw.clear('k', { method: 'mcp-clear' }))
        .toEqual({ cleared: true });
      await env.tw.resolve('k');
      const ops = env.warnings.map((w) => w.operation);
      expect(ops.filter((o) => o === 'audit.append').length)
        .toBeGreaterThanOrEqual(3);
      for (const w of env.warnings) {
        expect(w.code).toBe('TRIPWIRE_IO');
        expect(w.key).toBe('k');
      }
    });

  it('a throwing onWarning sink is contained', async () => {
    const env = makeEnv({
      onWarning: () => {
        throw new Error('sink');
      },
    });
    env.mfs.failOn({
      op: 'appendFile',
      path: /audit\.log$/,
      code: 'EIO',
    });
    await expect(env.tw.trip('k', {
      reason: 'x',
      context: {},
    })).resolves.toMatchObject({ persisted: true });
    await expect(env.tw.gate('k')).resolves.toMatchObject({ open: false });
  });
});
