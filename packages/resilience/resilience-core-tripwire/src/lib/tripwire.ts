/**
 * `createTripwire`: the persistent latch over a {@link TripwireStorage}.
 *
 * Rules (normative, see the package README):
 * - every key is validated before any IO;
 * - only an absent lock (ENOENT) is clear; any unreadable, empty, corrupt
 *   or unknown-schema lock counts as tripped (`unreadable`, fail closed);
 * - the first trip wins: a second trip keeps the first record;
 * - `trip` never throws on IO: the in-memory latch blocks this process
 *   even when the lock could not be written;
 * - audit writes are best-effort and reported through `onWarning`.
 */
import { randomBytes } from 'node:crypto';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { clampAuditBytes, formatAuditLine } from './audit.js';
import {
  TripwireConfirmError,
  TripwireIoError,
  TripwireTrippedError,
} from './errors.js';
import { composeRedactor, urlWithoutQuery } from './redact.js';
import {
  assertValidKey,
  createFileStorage,
  defaultNodeFs,
  GENERATION_PATTERN,
  lockGeneration,
  type TripwireStorage,
} from './storage.js';
import {
  CLEAR_METHODS,
  CONFIRM_TOKEN,
  type AuditEvent,
  type ClearMethod,
  type ClearOptions,
  type JsonValue,
  type PriorClear,
  type TripContext,
  type Tripwire,
  type TripwireOptions,
  type TripwireRecord,
  type TripwireSnapshot,
  type TripwireStatus,
  type TripwireWarning,
} from './types.js';

/** Fields of a legacy flat lock that are not moved into `context`. */
const LEGACY_CORE_FIELDS = new Set([
  'reason',
  'trippedAt',
  'blockedCount',
  'generation',
]);

/** Internal snapshot: the public one plus count bookkeeping. */
interface Snap extends TripwireSnapshot {
  /** The record comes from this process's latch, not from disk. */
  fromLatch: boolean;
  /** The in-record (legacy) part of `blockedCount`. */
  legacyCount: number;
  /** Generation of the lock on disk (scopes its block count). */
  gen?: string;
}

interface LatchEntry {
  record: TripwireRecord;
  /** Blocks counted in memory while the lock is not on disk. */
  blocked: number;
}

/**
 * The in-memory latch, shared by every instance over the same fs port (or
 * storage) and state dir, so a process stays blocked across instances
 * while a trip is in flight or after its persist failed.
 */
const latches = new WeakMap<object, Map<string, LatchEntry>>();

function latchFor(owner: object): Map<string, LatchEntry> {
  let m = latches.get(owner);
  if (!m) {
    m = new Map();
    latches.set(owner, m);
  }
  return m;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isJson(v: unknown, depth = 0): v is JsonValue {
  if (depth > 16) return false;
  if (v === null) return true;
  switch (typeof v) {
  case 'string':
  case 'boolean':
    return true;
  case 'number':
    return Number.isFinite(v);
  case 'object':
    return Array.isArray(v) ?
      v.every((x) => isJson(x, depth + 1)) :
      Object.values(v as object).every((x) => isJson(x, depth + 1));
  default:
    return false;
  }
}

function validIso(v: unknown): v is string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

function parsePriorClear(v: unknown): PriorClear | undefined {
  if (!isPlainObject(v)) return undefined;
  const method = v['method'];
  if (
    !validIso(v['clearedAt']) ||
    typeof method !== 'string' ||
    !(CLEAR_METHODS as readonly string[]).includes(method)
  ) {
    return undefined;
  }
  const out: PriorClear = {
    clearedAt: v['clearedAt'],
    method: method as ClearMethod,
  };
  if (typeof v['actor'] === 'string') out.actor = v['actor'];
  return out;
}

/** Parse a lock; null = unreadable (corrupt, empty, wrong shape). */
export function parseLockRecord(
  raw: string,
  key: string,
  namespace: string,
): TripwireRecord | null {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(doc)) return null;
  if (typeof doc['reason'] !== 'string' || !validIso(doc['trippedAt'])) {
    return null;
  }
  if ('schema' in doc) {
    if (doc['schema'] !== 1) return null;
    const by = doc['trippedBy'];
    const ctx = doc['context'];
    if (
      typeof doc['namespace'] !== 'string' ||
      !isPlainObject(by) ||
      typeof by['pid'] !== 'number' ||
      !isPlainObject(ctx) ||
      !isJson(ctx)
    ) {
      return null;
    }
    const rec: TripwireRecord = {
      schema: 1,
      key,
      namespace: doc['namespace'],
      reason: doc['reason'],
      trippedAt: doc['trippedAt'] as string,
      trippedBy: { pid: by['pid'] },
      blockedCount:
        typeof doc['blockedCount'] === 'number' &&
        Number.isFinite(doc['blockedCount']) ?
          doc['blockedCount'] :
          0,
      context: ctx as TripContext,
    };
    if (typeof by['sessionId'] === 'string') {
      rec.trippedBy.sessionId = by['sessionId'];
    }
    if (typeof by['actor'] === 'string') rec.trippedBy.actor = by['actor'];
    const prior = parsePriorClear(doc['priorClear']);
    if (prior) rec.priorClear = prior;
    if (typeof doc['recoveryHint'] === 'string') {
      rec.recoveryHint = doc['recoveryHint'];
    }
    const gen = doc['generation'];
    if (typeof gen === 'string' && GENERATION_PATTERN.test(gen)) {
      rec.generation = gen;
    }
    return rec;
  }
  // Legacy flat shape (reverse request-builder or agent-search): every
  // field other than reason/trippedAt/blockedCount moves into context.
  const context: TripContext = {};
  for (const [k, v] of Object.entries(doc)) {
    if (!LEGACY_CORE_FIELDS.has(k) && isJson(v)) context[k] = v;
  }
  const legacyCount = doc['blockedCount'];
  return {
    schema: 1,
    key,
    namespace,
    reason: doc['reason'],
    trippedAt: doc['trippedAt'] as string,
    trippedBy: { pid: 0 },
    blockedCount:
      typeof legacyCount === 'number' && Number.isFinite(legacyCount) ?
        Math.max(0, Math.floor(legacyCount)) :
        0,
    context,
  };
}

function osUser(): string | undefined {
  try {
    return userInfo().username || undefined;
  } catch {
    return undefined;
  }
}

/** Default recovery hint for an instance policy. */
export function defaultRecoveryHint(
  key: string,
  policy: 'confirm-token' | 'open',
): string {
  if (policy === 'open') {
    return (
      `Resolve the cause, then clear "${key}" (policy open: ` +
      `clear(key, { method: 'mcp-clear' }) needs no confirm token).`
    );
  }
  return (
    `Investigate, then clear "${key}" with clear(key, { method: ` +
    `'programmatic-confirm', confirm: '${CONFIRM_TOKEN}' }) or the ` +
    `unlock tool (policy confirm-token); break-glass: delete the lock file.`
  );
}

/** Create a tripwire instance. Construction performs no IO. */
export function createTripwire<C extends TripContext = TripContext>(
  o: TripwireOptions,
): Tripwire<C> {
  const namespace = String(o.namespace);
  const clock = o.clock ?? (() => Date.now());
  const policy = o.clearPolicy ?? 'confirm-token';
  const fs = o.fs ?? defaultNodeFs();
  const auditPath = o.auditPath ?? join(o.stateDir, 'audit.log');
  const storage: TripwireStorage =
    o.storage ??
    createFileStorage({
      stateDir: o.stateDir,
      auditPath,
      maxAuditBytes: clampAuditBytes(o.maxAuditBytes),
      fs,
      clock,
    });
  const latch = latchFor(o.storage ?? fs);
  const latchKey = (key: string): string => `${o.stateDir}\u0000${key}`;
  const redact = composeRedactor(o.redact);
  const ttlMs = o.expiry ? o.expiry.ttlMs : undefined;
  let defaultActor: string | undefined | null = o.actor ?? null;

  const actorOf = (explicit?: string): string | undefined => {
    if (explicit !== undefined) return explicit;
    if (defaultActor === null) defaultActor = osUser();
    return defaultActor;
  };

  const session = (): string | undefined => {
    try {
      const s = o.sessionId?.();
      return typeof s === 'string' && s !== '' ? s : undefined;
    } catch {
      return undefined;
    }
  };

  const warn = (
    operation: string,
    cause: unknown,
    key?: string,
  ): void => {
    const w: TripwireWarning = {
      code: 'TRIPWIRE_IO',
      operation,
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    };
    if (key !== undefined) w.key = key;
    try {
      o.onWarning?.(w);
    } catch {
      // a throwing warning sink must not break the latch
    }
  };

  const audit = async (
    ev: Omit<AuditEvent, 'ts' | 'namespace'>,
  ): Promise<void> => {
    const full: AuditEvent = {
      ts: new Date(clock()).toISOString(),
      event: ev.event,
      key: ev.key,
      namespace,
    };
    const sid = session();
    if (sid !== undefined) full.sessionId = sid;
    for (const [k, v] of Object.entries(ev)) {
      if (v !== undefined && !(k in full)) {
        (full as unknown as Record<string, unknown>)[k] = v;
      }
    }
    try {
      await storage.appendAudit(formatAuditLine(full));
    } catch (e) {
      warn('audit.append', e, ev.key);
    }
  };

  const expiredRecord = (r: TripwireRecord): boolean =>
    ttlMs !== undefined && clock() - Date.parse(r.trippedAt) > ttlMs;

  const unreadableRecord = (
    key: string,
    mtimeMs: number,
    detail: string,
  ): TripwireRecord => ({
    schema: 1,
    key,
    namespace,
    reason: 'unreadable-lock',
    trippedAt: new Date(mtimeMs > 0 ? mtimeMs : clock()).toISOString(),
    trippedBy: { pid: 0 },
    blockedCount: 0,
    recoveryHint:
      'The lock file exists but cannot be read or parsed; it blocks until ' +
      'it is cleared or removed by an operator.',
    context: { error: detail },
  });

  /** Snapshot from disk only (no latch), without side effects. */
  const readDisk = async (key: string): Promise<Snap> => {
    let lock: Awaited<ReturnType<TripwireStorage['readLock']>>;
    try {
      lock = await storage.readLock(key);
    } catch (e) {
      lock = { error: e instanceof Error ? e : new Error(String(e)) };
    }
    if (lock === 'absent') {
      return {
        status: 'clear',
        record: null,
        expired: false,
        fromLatch: false,
        legacyCount: 0,
      };
    }
    // The block count belongs to the generation of the lock on disk.
    const gen = 'error' in lock ? undefined : lockGeneration(lock.raw);
    let count = 0;
    let lastAt: number | undefined;
    try {
      const b = await storage.blocked(key, gen);
      count = b.count;
      lastAt = b.lastAt;
    } catch {
      // the count is forensic only
    }
    const done = (
      status: TripwireStatus,
      r: TripwireRecord,
      expired: boolean,
    ): Snap => {
      const legacyCount = r.blockedCount;
      r.blockedCount += count;
      if (count > 0 && lastAt !== undefined) {
        r.lastBlockedAt = new Date(lastAt).toISOString();
      }
      const snap: Snap = {
        status,
        record: r,
        expired,
        fromLatch: false,
        legacyCount,
      };
      if (gen !== undefined) snap.gen = gen;
      return snap;
    };
    if ('error' in lock) {
      const code = (lock.error as { code?: unknown }).code;
      const detail = typeof code === 'string' ? code : lock.error.message;
      return done('unreadable', unreadableRecord(key, 0, detail), false);
    }
    const blank = lock.raw.trim() === '';
    const parsed = blank ? null : parseLockRecord(lock.raw, key, namespace);
    if (!parsed) {
      const detail = blank ? 'empty' : 'corrupt';
      return done(
        'unreadable',
        unreadableRecord(key, lock.mtimeMs, detail),
        false,
      );
    }
    const expired = expiredRecord(parsed);
    return done(expired ? 'expired' : 'tripped', parsed, expired);
  };

  /** Disk snapshot overlaid with this process's latch. */
  const snapshot = async (key: string): Promise<Snap> => {
    const disk = await readDisk(key);
    const held = latch.get(latchKey(key));
    if (disk.status !== 'clear' || !held) return disk;
    const record: TripwireRecord = {
      ...held.record,
      trippedBy: { ...held.record.trippedBy },
      blockedCount: held.record.blockedCount + held.blocked,
    };
    return {
      status: 'tripped',
      record,
      expired: false,
      fromLatch: true,
      legacyCount: 0,
    };
  };

  /** The public snapshot (internal bookkeeping stripped). */
  const pub = (s: Snap): TripwireSnapshot<C> => ({
    status: s.status,
    record: s.record as TripwireRecord<C> | null,
    expired: s.expired,
  });

  /** Remove an expired lock; true when this call removed it (audited). */
  const expire = async (key: string, r: TripwireRecord): Promise<void> => {
    let removed = false;
    try {
      removed = (await storage.removeLock(key)).tombstone !== null;
    } catch (e) {
      warn('expire.remove', e, key);
      return;
    }
    if (removed) {
      await audit({
        event: 'tripwire-expired',
        key,
        reason: r.reason,
        trippedAt: r.trippedAt,
        blockedCount: r.blockedCount,
        method: 'expired',
      });
    }
  };

  const gate = async (key: string): Promise<{
    open: boolean;
    snapshot: Snap;
  }> => {
    assertValidKey(key);
    const snap = await snapshot(key);
    if (snap.status === 'clear') {
      return {
        open: true,
        snapshot: snap,
      };
    }
    const record = snap.record as TripwireRecord;
    if (snap.status === 'expired') {
      await expire(key, record);
      return {
        open: true,
        snapshot: snap,
      };
    }
    let count = record.blockedCount + 1;
    const held = latch.get(latchKey(key));
    if (snap.fromLatch && held) {
      held.blocked += 1;
    } else {
      try {
        await storage.incrementBlocked(key, snap.gen);
        const after = await storage.blocked(key, snap.gen);
        count = snap.legacyCount + after.count;
        if (after.lastAt !== undefined) {
          record.lastBlockedAt = new Date(after.lastAt).toISOString();
        }
      } catch (e) {
        warn('gate.count', e, key);
      }
    }
    record.blockedCount = count;
    await audit({
      event: 'tripwire-gate-blocked',
      key,
      reason: record.reason,
      blockedCount: count,
      pageUrl: urlWithoutQuery(record.context['pageUrl']),
    });
    return {
      open: false,
      snapshot: snap,
    };
  };

  /**
   * The cleared marker, read WITHOUT consuming it: only the trip whose
   * create wins consumes it (see `trip`), so a losing concurrent trip can
   * never take the annotation away from the lock that is actually written.
   */
  const peekMarker = async (key: string): Promise<{
    prior?: PriorClear;
    raw: string | null;
  }> => {
    try {
      const raw = await storage.peekClearedMarker(key);
      if (raw === null) return { raw };
      let doc: unknown;
      try {
        doc = JSON.parse(raw);
      } catch {
        return { raw };
      }
      return {
        prior: parsePriorClear(doc),
        raw,
      };
    } catch (e) {
      warn('trip.marker', e, key);
      return { raw: null };
    }
  };

  const trip = async (
    key: string,
    input: { reason: string; context: TripContext; recoveryHint?: string },
  ): Promise<{ record: TripwireRecord; created: boolean;
    persisted: boolean; }> => {
    assertValidKey(key);
    const now = clock();
    const sid = session();
    const reason =
      typeof input.reason === 'string' && input.reason !== '' ?
        input.reason :
        'unspecified';
    const record: TripwireRecord = {
      schema: 1,
      key,
      namespace,
      reason,
      trippedAt: new Date(now).toISOString(),
      trippedBy: { pid: process.pid },
      blockedCount: 0,
      generation: randomBytes(12).toString('hex'),
      context: redact(isPlainObject(input.context) ? input.context : {}),
    };
    if (sid !== undefined) record.trippedBy.sessionId = sid;
    const actor = actorOf();
    if (actor !== undefined) record.trippedBy.actor = actor;
    if (typeof input.recoveryHint === 'string') {
      record.recoveryHint = input.recoveryHint;
    }
    // In-memory latch FIRST: this process is blocked from here on.
    const lk = latchKey(key);
    const entry: LatchEntry = {
      record,
      blocked: 0,
    };
    if (!latch.has(lk)) latch.set(lk, entry);
    // Once the disk is authoritative the latch must go, so a break-glass
    // removal of the lock file un-trips this process too.
    const release = (): void => {
      latch.delete(lk);
    };
    const retripped = async (
      existing: TripwireRecord,
    ): Promise<{ record: TripwireRecord; created: boolean;
      persisted: boolean; }> => {
      release();
      await audit({
        event: 'tripwire-retripped',
        key,
        reason,
        trippedAt: existing.trippedAt,
      });
      return {
        record: existing,
        created: false,
        persisted: true,
      };
    };
    let marker: { prior?: PriorClear; raw: string | null } = { raw: null };
    try {
      const current = await readDisk(key);
      if (current.status === 'expired' && current.record) {
        await expire(key, current.record);
      } else if (current.record) {
        return await retripped(current.record);
      }
      marker = await peekMarker(key);
      if (marker.prior) record.priorClear = marker.prior;
      const created = await storage.createLockIfAbsent(
        key,
        JSON.stringify(record, null, 2) + '\n',
      );
      if (!created) {
        delete record.priorClear;
        const winner = await readDisk(key);
        return await retripped(winner.record ?? record);
      }
    } catch (e) {
      // Not persisted: the latch keeps this process blocked. The marker
      // was only read, so it is still there for the trip that persists.
      warn('trip.persist', e, key);
      await audit({
        event: 'tripwire-fired',
        key,
        reason,
        actor: record.trippedBy.actor,
        pageUrl: urlWithoutQuery(record.context['pageUrl']),
        priorClear: record.priorClear,
      });
      return {
        record,
        created: true,
        persisted: false,
      };
    }
    // This trip's lock carries the marker: consume exactly that marker (a
    // newer one, written by a clear that raced in, is left in place).
    if (marker.raw !== null) {
      try {
        await storage.takeClearedMarker(key, marker.raw);
      } catch (e) {
        warn('trip.marker', e, key);
      }
    }
    release();
    await audit({
      event: 'tripwire-fired',
      key,
      reason,
      actor: record.trippedBy.actor,
      pageUrl: urlWithoutQuery(record.context['pageUrl']),
      priorClear: record.priorClear,
    });
    return {
      record,
      created: true,
      persisted: true,
    };
  };

  const clearNow = async (
    key: string,
    opts: ClearOptions,
  ): Promise<{ cleared: boolean }> => {
    const lk = latchKey(key);
    const held = latch.get(lk);
    const before = await readDisk(key);
    let removed = false;
    if (before.status !== 'clear') {
      try {
        removed = (await storage.removeLock(key)).tombstone !== null;
      } catch (e) {
        throw new TripwireIoError('clear', e);
      }
    }
    if (held) latch.delete(lk);
    if (!removed && !held) return { cleared: false };
    const record = before.record ?? held?.record;
    const actor = actorOf(opts.actor);
    const marker: PriorClear = {
      clearedAt: new Date(clock()).toISOString(),
      method: opts.method,
    };
    if (actor !== undefined) marker.actor = actor;
    try {
      await storage.writeClearedMarker(key, JSON.stringify(marker) + '\n');
    } catch (e) {
      warn('clear.marker', e, key);
    }
    await audit({
      event: 'tripwire-cleared',
      key,
      method: opts.method,
      actor,
      reason: record?.reason,
      blockedCount: record?.blockedCount,
      reverified: opts.reverified === true,
    });
    return { cleared: true };
  };

  const clear = async (
    key: string,
    opts: ClearOptions,
  ): Promise<{ cleared: boolean }> => {
    assertValidKey(key);
    if (policy === 'confirm-token' && opts?.confirm !== CONFIRM_TOKEN) {
      throw new TripwireConfirmError(
        key,
        `Clearing tripwire "${key}" requires confirm: '${CONFIRM_TOKEN}' ` +
          `(policy confirm-token); nothing was changed.`,
      );
    }
    return clearNow(key, opts);
  };

  const resolve = async (
    key: string,
    opts: { actor?: string } = {},
  ): Promise<void> => {
    assertValidKey(key);
    const snap = await snapshot(key);
    if (snap.status === 'clear' || !snap.record) return;
    const r = snap.record;
    const started = Date.parse(r.trippedAt);
    await audit({
      event: 'tripwire-resolved',
      key,
      reason: r.reason,
      trippedAt: r.trippedAt,
      durationMs: Number.isNaN(started) ? undefined : clock() - started,
      blockedCount: r.blockedCount,
      actor: actorOf(opts.actor),
    });
    await clearNow(key, {
      method: 'resolved',
      actor: opts.actor,
    });
  };

  const status = async (
    opts: { keys?: readonly string[]; includeExpired?: boolean } = {},
  ): Promise<Record<string, TripwireRecord>> => {
    let keys: string[];
    if (opts.keys) {
      for (const k of opts.keys) assertValidKey(k);
      keys = [...opts.keys];
    } else {
      keys = await storage.listKeys();
      const prefix = `${o.stateDir}\u0000`;
      for (const lk of latch.keys()) {
        if (lk.startsWith(prefix)) keys.push(lk.slice(prefix.length));
      }
    }
    const out: Record<string, TripwireRecord> = {};
    for (const k of [...new Set(keys)].sort()) {
      const s = await snapshot(k);
      if (!s.record || s.status === 'clear') continue;
      if (s.expired && !opts.includeExpired) continue;
      out[k] = s.record;
    }
    return out;
  };

  const tw: Tripwire<C> = {
    read: async (key) => {
      assertValidKey(key);
      return pub(await snapshot(key));
    },
    gate: async (key) => {
      const g = await gate(key);
      return {
        open: g.open,
        snapshot: pub(g.snapshot),
      };
    },
    assertOpen: async (key) => {
      const g = await gate(key);
      if (g.open) return;
      const record = g.snapshot.record as TripwireRecord;
      throw TripwireTrippedError.fromRecord(record, {
        recoveryHint: record.recoveryHint ?? defaultRecoveryHint(key, policy),
      });
    },
    trip: async (key, input) =>
      (await trip(key, input)) as Awaited<ReturnType<Tripwire<C>['trip']>>,
    clear,
    resolve,
    status: async (opts) =>
      (await status(opts)) as Record<string, TripwireRecord<C>>,
  };
  return tw;
}
