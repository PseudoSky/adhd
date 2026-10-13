/**
 * Test harness for the tripwire unit lane (ticket 8468f7b1): a memory fs,
 * a controllable clock, warning capture, audit parsing and "process views"
 * (distinct FsPort objects over one memory fs, so two tripwire instances
 * behave like two OS processes sharing a disk: they do not share the
 * in-memory latch).
 */
import {
  createMemoryFs,
  createTripwire,
  type AuditEvent,
  type FsPort,
  type MemoryFs,
  type TripContext,
  type Tripwire,
  type TripwireOptions,
  type TripwireWarning,
} from '../../index';
import { MUTATING_FS_OPS, type FsOpRecord } from '../../lib/memory-fs';

export const STATE_DIR = '/state';
export const T0 = Date.parse('2026-10-12T00:00:00.000Z');

/** A distinct FsPort object over `mfs` (simulates another process). */
export function processView(mfs: MemoryFs): FsPort {
  return {
    mkdir: (p, m) => mfs.mkdir(p, m),
    chmod: (p, m) => mfs.chmod(p, m),
    openExclusive: (p, m) => mfs.openExclusive(p, m),
    appendFile: (p, d, m, x) => mfs.appendFile(p, d, m, x),
    link: (a, b) => mfs.link(a, b),
    rename: (a, b) => mfs.rename(a, b),
    unlink: (p) => mfs.unlink(p),
    readFile: (p) => mfs.readFile(p),
    stat: (p) => mfs.stat(p),
    readdir: (p) => mfs.readdir(p),
  };
}

export interface Clock {
  now: number;
  advance(ms: number): void;
  fn: () => number;
}

export function makeClock(start = T0): Clock {
  const c: Clock = {
    now: start,
    advance(ms) {
      c.now += ms;
    },
    fn: () => c.now,
  };
  return c;
}

export type EnvOptions = Partial<TripwireOptions> & {
  linkSupported?: boolean;
};

export interface Env<C extends TripContext = TripContext> {
  mfs: MemoryFs;
  clock: Clock;
  warnings: TripwireWarning[];
  /** The main instance (same process as `sameProcess`). */
  tw: Tripwire<C>;
  /** Another instance in the same process (shares the latch). */
  sameProcess(over?: EnvOptions): Tripwire<C>;
  /** An instance in a simulated other process (own latch). */
  otherProcess(over?: EnvOptions): Tripwire<C>;
  lockPath(key: string): string;
  blockedPath(key: string): string;
  markerPath(key: string): string;
  auditPath: string;
  /** Parsed audit lines. */
  audit(): AuditEvent[];
  /** Raw audit text ('' when absent). */
  auditText(): string;
  /** Mutating fs ops executed so far. */
  writes(): FsOpRecord[];
}

export function makeEnv<C extends TripContext = TripContext>(
  over: EnvOptions = {},
): Env<C> {
  const clock = makeClock();
  const mfs = createMemoryFs({
    clock: clock.fn,
    linkSupported: over.linkSupported,
  });
  const warnings: TripwireWarning[] = [];
  const auditPath = over.auditPath ?? `${STATE_DIR}/audit.log`;
  const base = (fs: FsPort, o: EnvOptions): Tripwire<C> => {
    const {
      linkSupported: _ignored,
      fs: explicitFs,
      ...rest
    } = { ...over, ...o };
    return createTripwire<C>({
      namespace: 'test-ns',
      stateDir: STATE_DIR,
      actor: 'tester',
      clock: clock.fn,
      onWarning: (w) => warnings.push(w),
      ...rest,
      // an explicit `fs` (e.g. a tagged view) wins over the process view
      fs: explicitFs ?? fs,
    });
  };
  const sharedFs = processView(mfs);
  const env: Env<C> = {
    mfs,
    clock,
    warnings,
    tw: base(sharedFs, {}),
    sameProcess: (o = {}) => base(sharedFs, o),
    otherProcess: (o = {}) => base(processView(mfs), o),
    lockPath: (k) => `${STATE_DIR}/tripwire/${k}.lock`,
    blockedPath: (k) => `${STATE_DIR}/tripwire/${k}.blocked`,
    markerPath: (k) => `${STATE_DIR}/tripwire/${k}.cleared`,
    auditPath,
    auditText: () => mfs.readText(auditPath) ?? '',
    audit: () =>
      (mfs.readText(auditPath) ?? '')
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l) as AuditEvent),
    writes: () => mfs.ops.filter((r) => MUTATING_FS_OPS.includes(r.op)),
  };
  return env;
}

/** Events of a given name in the audit. */
export function eventsOf(env: Env, name: AuditEvent['event']): AuditEvent[] {
  return env.audit().filter((e) => e.event === name);
}

/** Await a promise expected to reject; returns the rejection reason. */
export async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected the promise to reject');
}
