/**
 * The storage seam and its two implementations.
 *
 * File layout under `<stateDir>/tripwire/`:
 * - `<key>.lock`    presence = tripped; JSON forensic record inside.
 * - `<key>.blocked.<generation>` O_APPEND sidecar of the lock whose record
 *   carries that `generation` (a random hex id minted per trip), one byte
 *   per counted block (its size is the count), so counting can never
 *   create or modify the lock and a count can never leak from one trip of
 *   a key into the next. A lock without a generation (legacy, unreadable)
 *   uses `<key>.blocked`.
 * - `<key>.cleared` marker left by a clear, consumed by the trip that
 *   creates the next lock.
 *
 * Every write goes through a unique tmp name (`<path>.<pid>.<random>.tmp`)
 * that is fsynced before it is linked or renamed into place. Files are
 * 0600, directories 0700 (pre-existing directories are chmodded).
 */
import { randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import { join } from 'node:path';
import { createAuditLog, errCode } from './audit.js';
import { TripwireKeyError } from './errors.js';
import type { FsFileHandle, FsPort } from './memory-fs.js';

/**
 * Persistence used by `createTripwire`. Keys are pre-validated.
 *
 * Block counts are scoped to a lock GENERATION: the `generation` field of
 * the record (see {@link lockGeneration}); `undefined` is the generation
 * of a lock that has none (legacy or unreadable).
 */
export interface TripwireStorage {
  /** The raw lock, `'absent'` (ENOENT only) or the read error. */
  readLock(
    key: string,
  ): Promise<{ raw: string; mtimeMs: number } | 'absent' | { error: Error }>;
  /**
   * Write the lock only when none exists; true = this call created it.
   * Never touches a block count (a new generation starts at zero).
   */
  createLockIfAbsent(key: string, raw: string): Promise<boolean>;
  /**
   * Remove the lock and the block count of ITS generation; null tombstone
   * = was absent.
   */
  removeLock(key: string): Promise<{ tombstone: string | null }>;
  /**
   * Count one block for `generation` without touching the lock. A count
   * whose generation is not the live lock's (the lock was removed or
   * replaced meanwhile) is discarded, never left for a later lock.
   */
  incrementBlocked(key: string, generation?: string): Promise<void>;
  /** The block count of `generation` and the time of its latest block. */
  blocked(
    key: string,
    generation?: string,
  ): Promise<{ count: number; lastAt?: number }>;
  writeClearedMarker(key: string, raw: string): Promise<void>;
  /** The marker content without consuming it (null when absent). */
  peekClearedMarker(key: string): Promise<string | null>;
  /**
   * Read and remove the marker atomically (consumed exactly once). With
   * `expected`, the marker is consumed only when its content equals it (a
   * newer marker is left in place) and null is returned otherwise.
   */
  takeClearedMarker(key: string, expected?: string): Promise<string | null>;
  /** Keys that have a lock. */
  listKeys(): Promise<string[]>;
  /** Append one audit line. */
  appendAudit(line: string): Promise<void>;
}

/** Valid keys: no path separators, no leading dot, at most 64 chars. */
export const TRIPWIRE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Throws {@link TripwireKeyError} unless `key` is valid. */
export function assertValidKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || !TRIPWIRE_KEY_PATTERN.test(key)) {
    throw new TripwireKeyError(key);
  }
}

/** A lock generation: 24 lowercase hex characters (96 random bits). */
export const GENERATION_PATTERN = /^[0-9a-f]{24}$/;

/**
 * The generation of a raw lock: its `generation` field when it is a valid
 * generation, else undefined (legacy, unreadable or tampered content).
 * Lock content is untrusted; nothing else of it is interpreted here.
 */
export function lockGeneration(raw: string): string | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return undefined;
  }
  const g = (doc as Record<string, unknown>)['generation'];
  return typeof g === 'string' && GENERATION_PATTERN.test(g) ? g : undefined;
}

/** Subdirectory of `stateDir` holding the locks. */
export const LOCK_DIR_NAME = 'tripwire';

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const LINK_UNSUPPORTED = new Set([
  'EPERM',
  'ENOTSUP',
  'EOPNOTSUPP',
  'ENOSYS',
  'EXDEV',
  'EMLINK',
]);
const enc = new TextEncoder();
const dec = new TextDecoder();

/** Default unique suffix: pid plus 48 random bits. */
export function defaultUniqueSuffix(): string {
  return `${process.pid}.${randomBytes(6).toString('hex')}`;
}

/** The {@link FsPort} over `node:fs/promises`. */
export function createNodeFs(): FsPort {
  const wrap = (h: nodeFs.FileHandle): FsFileHandle => ({
    write: async (data) => {
      let off = 0;
      while (off < data.length) {
        const { bytesWritten } = await h.write(data, off, data.length - off);
        off += bytesWritten;
      }
    },
    sync: () => h.sync(),
    close: () => h.close(),
  });
  return {
    mkdir: async (path, mode) => {
      await nodeFs.mkdir(path, {
        recursive: true,
        mode,
      });
    },
    chmod: (path, mode) => nodeFs.chmod(path, mode),
    openExclusive: async (path, mode) =>
      wrap(await nodeFs.open(path, 'wx', mode)),
    appendFile: (path, data, mode, exclusive) =>
      nodeFs.appendFile(path, data, {
        mode,
        flag: exclusive ? 'ax' : 'a',
      }),
    link: (a, b) => nodeFs.link(a, b),
    rename: (a, b) => nodeFs.rename(a, b),
    unlink: (p) => nodeFs.unlink(p),
    readFile: async (p) => new Uint8Array(await nodeFs.readFile(p)),
    stat: async (p) => {
      const s = await nodeFs.stat(p);
      return {
        size: s.size,
        mtimeMs: s.mtimeMs,
        mode: s.mode,
      };
    },
    readdir: (p) => nodeFs.readdir(p),
  };
}

let sharedNodeFs: FsPort | undefined;

/** One Node fs port per process (the in-memory latch is keyed by it). */
export function defaultNodeFs(): FsPort {
  sharedNodeFs ??= createNodeFs();
  return sharedNodeFs;
}

export interface FileStorageOptions {
  stateDir: string;
  auditPath: string;
  maxAuditBytes: number;
  fs: FsPort;
  clock: () => number;
  /** Unique suffix for tmp names; default pid plus random. */
  uniqueSuffix?: () => string;
}

/** The lock-file storage over an injected {@link FsPort}. */
export function createFileStorage(o: FileStorageOptions): TripwireStorage {
  const { fs } = o;
  const sfx = o.uniqueSuffix ?? defaultUniqueSuffix;
  const lockDir = join(o.stateDir, LOCK_DIR_NAME);
  const audit = createAuditLog({
    path: o.auditPath,
    maxAuditBytes: o.maxAuditBytes,
    fs,
    uniqueSuffix: sfx,
  });
  const lockPath = (k: string): string => join(lockDir, `${k}.lock`);
  const blockedPath = (k: string, gen?: string): string =>
    join(lockDir, gen === undefined ? `${k}.blocked` : `${k}.blocked.${gen}`);
  const markerPath = (k: string): string => join(lockDir, `${k}.cleared`);
  let dirReady = false;

  const ignore = async (p: Promise<unknown>): Promise<void> => {
    try {
      await p;
    } catch {
      // best-effort
    }
  };

  const ensureDir = async (): Promise<void> => {
    if (dirReady) return;
    await fs.mkdir(lockDir, DIR_MODE);
    await ignore(fs.chmod(o.stateDir, DIR_MODE));
    await ignore(fs.chmod(lockDir, DIR_MODE));
    dirReady = true;
  };

  const bytesOf = (data: string | Uint8Array): Uint8Array =>
    typeof data === 'string' ? enc.encode(data) : data;

  const writeTmp = async (
    target: string,
    data: string | Uint8Array,
  ): Promise<string> => {
    const tmp = `${target}.${sfx()}.tmp`;
    const h = await fs.openExclusive(tmp, FILE_MODE);
    try {
      await h.write(bytesOf(data));
      await h.sync();
    } finally {
      await h.close();
    }
    return tmp;
  };

  const exists = async (p: string): Promise<boolean> => {
    try {
      await fs.stat(p);
      return true;
    } catch (e) {
      if (errCode(e) === 'ENOENT') return false;
      throw e;
    }
  };

  const createDirect = async (
    p: string,
    data: string | Uint8Array,
  ): Promise<boolean> => {
    let h: FsFileHandle;
    try {
      h = await fs.openExclusive(p, FILE_MODE);
    } catch (e) {
      if (errCode(e) === 'EEXIST') return false;
      throw e;
    }
    try {
      await h.write(bytesOf(data));
      await h.sync();
    } finally {
      await h.close();
    }
    return true;
  };

  /**
   * Whether `generation` is the live lock's: false only when the lock is
   * absent (ENOENT) or carries another generation; an unreadable lock
   * keeps the count (it still blocks, so its blocks are real).
   */
  const isLiveGeneration = async (
    key: string,
    generation: string | undefined,
  ): Promise<boolean> => {
    let bytes: Uint8Array;
    try {
      bytes = await fs.readFile(lockPath(key));
    } catch (e) {
      return errCode(e) !== 'ENOENT';
    }
    return lockGeneration(dec.decode(bytes)) === generation;
  };

  /** Create-if-absent of `p` (unique tmp + fsync + link, wx fallback). */
  const createIfAbsent = async (
    p: string,
    data: string | Uint8Array,
  ): Promise<boolean> => {
    const tmp = await writeTmp(p, data);
    try {
      await fs.link(tmp, p);
      return true;
    } catch (e) {
      const code = errCode(e);
      if (code === 'EEXIST') return false;
      if (!code || !LINK_UNSUPPORTED.has(code)) throw e;
      return await createDirect(p, data);
    } finally {
      await ignore(fs.unlink(tmp));
    }
  };

  return {
    async readLock(key) {
      assertValidKey(key);
      const p = lockPath(key);
      let bytes: Uint8Array;
      try {
        bytes = await fs.readFile(p);
      } catch (e) {
        if (errCode(e) === 'ENOENT') return 'absent';
        return { error: e instanceof Error ? e : new Error(String(e)) };
      }
      let mtimeMs = 0;
      try {
        mtimeMs = (await fs.stat(p)).mtimeMs;
      } catch {
        // removed after the read: the content read is still the record
      }
      return {
        raw: dec.decode(bytes),
        mtimeMs,
      };
    },

    async createLockIfAbsent(key, raw) {
      assertValidKey(key);
      await ensureDir();
      const p = lockPath(key);
      if (await exists(p)) return false;
      return createIfAbsent(p, raw);
    },

    async removeLock(key) {
      assertValidKey(key);
      const tomb = `${lockPath(key)}.${sfx()}.tomb`;
      try {
        await fs.rename(lockPath(key), tomb);
      } catch (e) {
        if (errCode(e) === 'ENOENT') return { tombstone: null };
        throw e;
      }
      // The tombstone is ours alone: its generation names the dead count.
      let gen: string | undefined;
      try {
        gen = lockGeneration(dec.decode(await fs.readFile(tomb)));
      } catch {
        gen = undefined;
      }
      await ignore(fs.unlink(blockedPath(key, gen)));
      await ignore(fs.unlink(tomb));
      return { tombstone: tomb };
    },

    async incrementBlocked(key, generation) {
      assertValidKey(key);
      await ensureDir();
      const p = blockedPath(key, generation);
      await fs.appendFile(p, Uint8Array.of(0x31), FILE_MODE);
      // A block that raced the removal of its lock landed after the
      // removal cleaned the count up: drop the dead generation's sidecar
      // so it can never be mistaken for a count of a later lock.
      if (!(await isLiveGeneration(key, generation))) {
        await ignore(fs.unlink(p));
      }
    },

    async blocked(key, generation) {
      assertValidKey(key);
      try {
        const st = await fs.stat(blockedPath(key, generation));
        return {
          count: st.size,
          lastAt: st.mtimeMs,
        };
      } catch (e) {
        if (errCode(e) === 'ENOENT') return { count: 0 };
        throw e;
      }
    },

    async writeClearedMarker(key, raw) {
      assertValidKey(key);
      await ensureDir();
      const p = markerPath(key);
      const tmp = await writeTmp(p, raw);
      try {
        await fs.rename(tmp, p);
      } catch (e) {
        await ignore(fs.unlink(tmp));
        throw e;
      }
    },

    async peekClearedMarker(key) {
      assertValidKey(key);
      try {
        return dec.decode(await fs.readFile(markerPath(key)));
      } catch (e) {
        if (errCode(e) === 'ENOENT') return null;
        throw e;
      }
    },

    async takeClearedMarker(key, expected) {
      assertValidKey(key);
      const taken = `${markerPath(key)}.${sfx()}.taken`;
      try {
        await fs.rename(markerPath(key), taken);
      } catch (e) {
        if (errCode(e) === 'ENOENT') return null;
        throw e;
      }
      try {
        const bytes = await fs.readFile(taken);
        const raw = dec.decode(bytes);
        if (expected === undefined || raw === expected) return raw;
        // A newer marker than the expected one: put it back, unless an
        // even newer marker was written meanwhile (which then wins).
        await ignore(createIfAbsent(markerPath(key), bytes));
        return null;
      } finally {
        await ignore(fs.unlink(taken));
      }
    },

    async listKeys() {
      let names: string[];
      try {
        names = await fs.readdir(lockDir);
      } catch (e) {
        if (errCode(e) === 'ENOENT') return [];
        throw e;
      }
      return names
        .filter((n) => n.endsWith('.lock'))
        .map((n) => n.slice(0, -'.lock'.length))
        .filter((k) => TRIPWIRE_KEY_PATTERN.test(k))
        .sort();
    },

    appendAudit(line) {
      return audit.append(line);
    },
  };
}

/** The memory storage, with its audit lines exposed for inspection. */
export interface MemoryTripwireStorage extends TripwireStorage {
  /** Audit lines appended so far (without newlines). */
  readonly auditLines: string[];
}

/**
 * The reference implementation of the {@link TripwireStorage} contract:
 * every operation is atomic, nothing touches a file system.
 */
export function createMemoryStorage(
  opts: { clock?: () => number } = {},
): MemoryTripwireStorage {
  const clock = opts.clock ?? (() => Date.now());
  const locks = new Map<string, { raw: string; mtimeMs: number }>();
  const blocked = new Map<string, { count: number; lastAt: number }>();
  const markers = new Map<string, string>();
  const auditLines: string[] = [];
  const countKey = (key: string, gen?: string): string =>
    `${key}\u0000${gen ?? ''}`;
  let tombs = 0;
  return {
    auditLines,
    async readLock(key) {
      assertValidKey(key);
      const l = locks.get(key);
      return l ? { ...l } : 'absent';
    },
    async createLockIfAbsent(key, raw) {
      assertValidKey(key);
      if (locks.has(key)) return false;
      locks.set(key, {
        raw,
        mtimeMs: clock(),
      });
      return true;
    },
    async removeLock(key) {
      assertValidKey(key);
      const l = locks.get(key);
      if (!l) return { tombstone: null };
      locks.delete(key);
      blocked.delete(countKey(key, lockGeneration(l.raw)));
      tombs += 1;
      return { tombstone: `memory:${key}.${tombs}.tomb` };
    },
    async incrementBlocked(key, generation) {
      assertValidKey(key);
      const l = locks.get(key);
      // only the live lock's generation is counted (atomic here)
      if (!l || lockGeneration(l.raw) !== generation) return;
      const ck = countKey(key, generation);
      const cur = blocked.get(ck);
      blocked.set(ck, {
        count: (cur?.count ?? 0) + 1,
        lastAt: clock(),
      });
    },
    async blocked(key, generation) {
      assertValidKey(key);
      const cur = blocked.get(countKey(key, generation));
      return cur ? { ...cur } : { count: 0 };
    },
    async writeClearedMarker(key, raw) {
      assertValidKey(key);
      markers.set(key, raw);
    },
    async peekClearedMarker(key) {
      assertValidKey(key);
      return markers.get(key) ?? null;
    },
    async takeClearedMarker(key, expected) {
      assertValidKey(key);
      const raw = markers.get(key);
      if (raw === undefined) return null;
      if (expected !== undefined && raw !== expected) return null;
      markers.delete(key);
      return raw;
    },
    async listKeys() {
      return [...locks.keys()].sort();
    },
    async appendAudit(line) {
      auditLines.push(line.replace(/\n$/, ''));
    },
  };
}
