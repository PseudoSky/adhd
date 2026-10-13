/**
 * The storage seam and its two implementations.
 *
 * File layout under `<stateDir>/tripwire/`:
 * - `<key>.lock`    presence = tripped; JSON forensic record inside.
 * - `<key>.blocked` O_APPEND sidecar, one byte per counted block (its size
 *   is the count), so counting can never create or modify the lock.
 * - `<key>.cleared` marker left by a clear, consumed by the next trip.
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

/** Persistence used by `createTripwire`. Keys are pre-validated. */
export interface TripwireStorage {
  /** The raw lock, `'absent'` (ENOENT only) or the read error. */
  readLock(
    key: string,
  ): Promise<{ raw: string; mtimeMs: number } | 'absent' | { error: Error }>;
  /** Write the lock only when none exists; true = this call created it. */
  createLockIfAbsent(key: string, raw: string): Promise<boolean>;
  /** Remove the lock and its block count; null tombstone = was absent. */
  removeLock(key: string): Promise<{ tombstone: string | null }>;
  /** Count one block without touching the lock. */
  incrementBlocked(key: string): Promise<void>;
  /** The block count and the time of the latest block. */
  blocked(key: string): Promise<{ count: number; lastAt?: number }>;
  writeClearedMarker(key: string, raw: string): Promise<void>;
  /** Read and remove the marker atomically (consumed exactly once). */
  takeClearedMarker(key: string): Promise<string | null>;
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
  const blockedPath = (k: string): string => join(lockDir, `${k}.blocked`);
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

  const writeTmp = async (target: string, raw: string): Promise<string> => {
    const tmp = `${target}.${sfx()}.tmp`;
    const h = await fs.openExclusive(tmp, FILE_MODE);
    try {
      await h.write(enc.encode(raw));
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

  const createDirect = async (p: string, raw: string): Promise<boolean> => {
    let h: FsFileHandle;
    try {
      h = await fs.openExclusive(p, FILE_MODE);
    } catch (e) {
      if (errCode(e) === 'EEXIST') return false;
      throw e;
    }
    try {
      await h.write(enc.encode(raw));
      await h.sync();
    } finally {
      await h.close();
    }
    return true;
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
      // A gate that raced the previous clear may have left a count behind.
      await ignore(fs.unlink(blockedPath(key)));
      const tmp = await writeTmp(p, raw);
      try {
        await fs.link(tmp, p);
        return true;
      } catch (e) {
        const code = errCode(e);
        if (code === 'EEXIST') return false;
        if (!code || !LINK_UNSUPPORTED.has(code)) throw e;
        return await createDirect(p, raw);
      } finally {
        await ignore(fs.unlink(tmp));
      }
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
      await ignore(fs.unlink(blockedPath(key)));
      await ignore(fs.unlink(tomb));
      return { tombstone: tomb };
    },

    async incrementBlocked(key) {
      assertValidKey(key);
      await ensureDir();
      await fs.appendFile(blockedPath(key), Uint8Array.of(0x31), FILE_MODE);
    },

    async blocked(key) {
      assertValidKey(key);
      try {
        const st = await fs.stat(blockedPath(key));
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

    async takeClearedMarker(key) {
      assertValidKey(key);
      const taken = `${markerPath(key)}.${sfx()}.taken`;
      try {
        await fs.rename(markerPath(key), taken);
      } catch (e) {
        if (errCode(e) === 'ENOENT') return null;
        throw e;
      }
      try {
        return dec.decode(await fs.readFile(taken));
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
      blocked.delete(key);
      locks.set(key, {
        raw,
        mtimeMs: clock(),
      });
      return true;
    },
    async removeLock(key) {
      assertValidKey(key);
      if (!locks.delete(key)) return { tombstone: null };
      blocked.delete(key);
      tombs += 1;
      return { tombstone: `memory:${key}.${tombs}.tomb` };
    },
    async incrementBlocked(key) {
      assertValidKey(key);
      const cur = blocked.get(key);
      blocked.set(key, {
        count: (cur?.count ?? 0) + 1,
        lastAt: clock(),
      });
    },
    async blocked(key) {
      assertValidKey(key);
      const cur = blocked.get(key);
      return cur ? { ...cur } : { count: 0 };
    },
    async writeClearedMarker(key, raw) {
      assertValidKey(key);
      markers.set(key, raw);
    },
    async takeClearedMarker(key) {
      assertValidKey(key);
      const raw = markers.get(key);
      markers.delete(key);
      return raw ?? null;
    },
    async listKeys() {
      return [...locks.keys()].sort();
    },
    async appendAudit(line) {
      auditLines.push(line.replace(/\n$/, ''));
    },
  };
}
