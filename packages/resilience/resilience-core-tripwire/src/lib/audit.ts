/**
 * The capped NDJSON audit log.
 *
 * - One JSON object per line, every line under {@link AUDIT_LINE_MAX_BYTES}.
 * - Cap: when an append would take the file above `maxAuditBytes`, the
 *   oldest half is dropped at a line boundary (byte-accurate, so multibyte
 *   text is never split) and the newest half plus the new line is
 *   installed atomically (unique tmp, fsync, create-if-absent `link`).
 * - Rotation never loses a concurrent append: the live file is renamed
 *   away before it is read, and the install fails with EEXIST when another
 *   writer created a new live file meanwhile, whose lines are then merged
 *   and the install retried.
 */
import { dirname } from 'node:path';
import type { FsPort } from './memory-fs.js';
import type { AuditEvent } from './types.js';

/** Default audit-log cap in bytes (5 MiB). */
export const DEFAULT_MAX_AUDIT_BYTES = 5 * 1024 * 1024;
/** Smallest audit cap `maxAuditBytes` is clamped to, in bytes. */
export const MIN_AUDIT_BYTES = 100_000;
/** Audit `reason` of the `tripwire-expired` line: the entry's ttl passed. */
export const EXPIRY_AUDIT_REASON = 'ttl-expired';
/** Every audit line (including its newline) is shorter than this. */
export const AUDIT_LINE_MAX_BYTES = 4096;

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const NL = 0x0a;
const INSTALL_ATTEMPTS = 8;
const LINK_UNSUPPORTED = new Set([
  'EPERM',
  'ENOTSUP',
  'EOPNOTSUPP',
  'ENOSYS',
  'EXDEV',
  'EMLINK',
]);

const enc = new TextEncoder();

/** The effective cap: default 5 MiB, never below {@link MIN_AUDIT_BYTES}. */
export function clampAuditBytes(n?: number): number {
  if (n === undefined || !Number.isFinite(n)) return DEFAULT_MAX_AUDIT_BYTES;
  return Math.max(MIN_AUDIT_BYTES, Math.floor(n));
}

/** Node-style error code of `e`, if any. */
export function errCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function clip(s: string | undefined, n: number): string | undefined {
  return s === undefined || s.length <= n ? s : s.slice(0, n);
}

/**
 * Serialise one event as an NDJSON line (with its newline), always under
 * {@link AUDIT_LINE_MAX_BYTES}: oversized optional fields are clipped,
 * then dropped, and the line is marked `truncated`.
 */
export function formatAuditLine(ev: AuditEvent): string {
  const fits = (s: string): boolean =>
    enc.encode(s).length < AUDIT_LINE_MAX_BYTES;
  let line = JSON.stringify(ev) + '\n';
  if (fits(line)) return line;
  const small: AuditEvent = {
    ...ev,
    namespace: clip(ev.namespace, 128) as string,
    sessionId: clip(ev.sessionId, 128),
    actor: clip(ev.actor, 128),
    reason: clip(ev.reason, 256),
    pageUrl: clip(ev.pageUrl, 256),
    truncated: true,
  };
  line = JSON.stringify(small) + '\n';
  if (fits(line)) return line;
  const minimal: AuditEvent = {
    ts: ev.ts,
    event: ev.event,
    key: ev.key,
    namespace: clip(ev.namespace, 128) as string,
    truncated: true,
  };
  return JSON.stringify(minimal) + '\n';
}

/**
 * The newest complete lines of `bytes` fitting in `budget` bytes (cut at
 * a line boundary; byte-accurate, so a multibyte character is never cut).
 */
export function keepNewest(bytes: Uint8Array, budget: number): Uint8Array {
  let out = bytes;
  if (bytes.length > budget) {
    let start = bytes.length - budget;
    if (bytes[start - 1] !== NL) {
      const nl = bytes.indexOf(NL, start);
      start = nl === -1 ? bytes.length : nl + 1;
    }
    out = bytes.subarray(start);
  }
  if (out.length > 0 && out[out.length - 1] !== NL) {
    out = concat(out, Uint8Array.of(NL));
  }
  return out;
}

/** An append-only audit sink. */
export interface AuditLog {
  /** Append one line (a trailing newline is added when missing). */
  append(line: string): Promise<void>;
}

/** Options of {@link createAuditLog}: log path, byte cap, filesystem port and unique-suffix source. */
export interface AuditLogOptions {
  path: string;
  maxAuditBytes: number;
  fs: FsPort;
  /** Unique suffix for tmp and rotation names (pid plus random). */
  uniqueSuffix: () => string;
}

/** Create the capped audit log writer for `path`. */
export function createAuditLog(o: AuditLogOptions): AuditLog {
  const { fs, path } = o;
  const cap = clampAuditBytes(o.maxAuditBytes);
  let dirReady = false;
  let fileChecked = false;
  let linkWorks = true;
  let chain: Promise<void> = Promise.resolve();

  const ignore = async (p: Promise<unknown>): Promise<void> => {
    try {
      await p;
    } catch {
      // best-effort cleanup
    }
  };

  const ensureDir = async (): Promise<void> => {
    if (dirReady) return;
    const dir = dirname(path);
    await fs.mkdir(dir, DIR_MODE);
    await ignore(fs.chmod(dir, DIR_MODE));
    dirReady = true;
  };

  const size = async (): Promise<number> => {
    try {
      const st = await fs.stat(path);
      if (!fileChecked && (st.mode & 0o777) !== FILE_MODE) {
        await ignore(fs.chmod(path, FILE_MODE));
      }
      fileChecked = true;
      return st.size;
    } catch (e) {
      if (errCode(e) === 'ENOENT') return 0;
      throw e;
    }
  };

  const writeTmp = async (data: Uint8Array): Promise<string> => {
    const tmp = `${path}.${o.uniqueSuffix()}.tmp`;
    const h = await fs.openExclusive(tmp, FILE_MODE);
    try {
      await h.write(data);
      await h.sync();
    } finally {
      await h.close();
    }
    return tmp;
  };

  /** Create-if-absent install of `data` as the live file. */
  const install = async (data: Uint8Array): Promise<boolean> => {
    if (linkWorks) {
      const tmp = await writeTmp(data);
      try {
        await fs.link(tmp, path);
        return true;
      } catch (e) {
        const code = errCode(e);
        if (code === 'EEXIST') return false;
        if (!code || !LINK_UNSUPPORTED.has(code)) throw e;
        linkWorks = false;
      } finally {
        await ignore(fs.unlink(tmp));
      }
    }
    try {
      await fs.appendFile(path, data, FILE_MODE, true);
      return true;
    } catch (e) {
      if (errCode(e) === 'EEXIST') return false;
      throw e;
    }
  };

  /** Move the live file aside and return its bytes (null when absent). */
  const takeLive = async (): Promise<Uint8Array | null> => {
    const aside = `${path}.${o.uniqueSuffix()}.rot`;
    try {
      await fs.rename(path, aside);
    } catch (e) {
      if (errCode(e) === 'ENOENT') return null;
      throw e;
    }
    try {
      return await fs.readFile(aside);
    } finally {
      await ignore(fs.unlink(aside));
    }
  };

  const rotate = async (data: Uint8Array): Promise<void> => {
    const old = await takeLive();
    if (old === null) {
      await fs.appendFile(path, data, FILE_MODE);
      return;
    }
    let buf = concat(keepNewest(old, Math.floor(cap / 2)), data);
    for (let i = 0; i < INSTALL_ATTEMPTS; i += 1) {
      if (await install(buf)) return;
      const extra = await takeLive();
      if (extra !== null) buf = concat(buf, keepNewest(extra, extra.length));
    }
    // Contended past every attempt: append (lossless, possibly over cap).
    await fs.appendFile(path, buf, FILE_MODE);
  };

  const appendNow = async (line: string): Promise<void> => {
    await ensureDir();
    const data = enc.encode(line.endsWith('\n') ? line : line + '\n');
    const current = await size();
    if (current + data.length <= cap) {
      await fs.appendFile(path, data, FILE_MODE);
      return;
    }
    await rotate(data);
  };

  const appendRetrying = async (line: string): Promise<void> => {
    try {
      await appendNow(line);
    } catch (e) {
      if (errCode(e) !== 'ENOENT' || !dirReady) throw e;
      dirReady = false; // the directory vanished: recreate it once
      await appendNow(line);
    }
  };

  return {
    append(line) {
      const run = chain.then(() => appendRetrying(line));
      chain = run.catch(() => undefined);
      return run;
    },
  };
}
