/**
 * The file-system port the file storage runs on, and an in-memory
 * implementation of it with inspection, failure injection and a
 * deterministic interleaving scheduler.
 *
 * The port is deliberately tiny: exactly the operations the tripwire
 * protocol needs (exclusive create, atomic append, hard link, rename,
 * unlink, read, stat, readdir, mkdir, chmod). Every operation of the
 * memory implementation is atomic and can be held by the scheduler, so a
 * test can run several tripwire instances "concurrently" and choose the
 * exact order their file-system operations land in.
 */

/** An open file handle (only sequential writes are needed). */
export interface FsFileHandle {
  write(data: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** The subset of `stat` the protocol reads. */
export interface FsStat {
  size: number;
  mtimeMs: number;
  mode: number;
}

/**
 * The file-system operations the file storage uses. Errors are thrown as
 * `Error` objects carrying a Node-style `code` (`ENOENT`, `EEXIST`, ...).
 */
export interface FsPort {
  /** Recursive mkdir; `mode` applies to every directory it creates. */
  mkdir(path: string, mode: number): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  /** Exclusive create (`wx`): fails with EEXIST when the path exists. */
  openExclusive(path: string, mode: number): Promise<FsFileHandle>;
  /**
   * O_APPEND write of `data` as one operation. `exclusive` adds O_EXCL
   * (`ax`): the call fails with EEXIST when the path already exists.
   */
  appendFile(
    path: string,
    data: Uint8Array,
    mode: number,
    exclusive?: boolean,
  ): Promise<void>;
  /** Hard link; EEXIST when `newPath` exists. */
  link(existingPath: string, newPath: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  stat(path: string): Promise<FsStat>;
  readdir(path: string): Promise<string[]>;
}

/** Names of the port operations (used by the scheduler and the op log). */
export type FsOpName =
  | 'mkdir'
  | 'chmod'
  | 'openExclusive'
  | 'write'
  | 'sync'
  | 'close'
  | 'appendFile'
  | 'link'
  | 'rename'
  | 'unlink'
  | 'readFile'
  | 'stat'
  | 'readdir';

/** Operations that change the file system. */
export const MUTATING_FS_OPS: readonly FsOpName[] = [
  'mkdir',
  'chmod',
  'openExclusive',
  'write',
  'appendFile',
  'link',
  'rename',
  'unlink',
];

/** One executed operation. `path2` is the destination of link/rename. */
export interface FsOpRecord {
  op: FsOpName;
  path: string;
  path2?: string;
}

/** A failure injection rule: matching operations throw `code`. */
export interface FsFailureRule {
  op?: FsOpName | readonly FsOpName[];
  path?: string | RegExp;
  code: string;
  /** How many matching calls fail; absent = every matching call. */
  times?: number;
}

/**
 * Picks which held operation runs next. `pending` lists the held
 * operations in arrival order; the return value is an index into it.
 */
export type SchedulePicker = (
  pending: readonly FsOpRecord[],
  step: number,
) => number;

/** Options of {@link createMemoryFs}. */
export interface MemoryFsOptions {
  clock?: () => number;
  /** When false, `link` fails with EPERM (hard links unsupported). */
  linkSupported?: boolean;
}

/** The memory fs: an `FsPort` plus inspection and interleaving hooks. */
export interface MemoryFs extends FsPort {
  /** Every attempted operation (failed ones too), in execution order. */
  readonly ops: FsOpRecord[];
  /** File content as UTF-8, or undefined when absent. */
  readText(path: string): string | undefined;
  /** File content as bytes, or undefined when absent. */
  readBytes(path: string): Uint8Array | undefined;
  /** Synchronously create a file (and its parent directories). */
  writeText(path: string, text: string, mode?: number): void;
  /** Synchronously create a directory (and its parents). */
  makeDir(path: string, mode?: number): void;
  exists(path: string): boolean;
  /** Permission bits of a file or directory, or undefined when absent. */
  modeOf(path: string): number | undefined;
  /** Every file path, sorted. */
  files(): string[];
  /** Add a failure injection rule. */
  failOn(rule: FsFailureRule): void;
  /** Called synchronously after every executed operation. */
  observe(fn: ((rec: FsOpRecord) => void) | undefined): void;
  /**
   * Run `tasks` concurrently with every fs operation held until `pick`
   * releases it, so the execution order of the operations is exactly the
   * sequence of picks. Resolves with every task's settled result.
   */
  schedule<T>(
    tasks: ReadonlyArray<() => Promise<T>>,
    pick: SchedulePicker,
  ): Promise<PromiseSettledResult<T>[]>;
}

interface Inode {
  data: Uint8Array;
  mode: number;
  mtimeMs: number;
}

interface Held {
  rec: FsOpRecord;
  release: () => void;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function fsError(code: string, op: string, path: string): Error {
  const e = new Error(`${code}: ${op} '${path}'`) as Error & {
    code: string;
  };
  e.code = code;
  return e;
}

function norm(p: string): string {
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return '/' + out.join('/');
}

function parentOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

const macrotask = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof setImmediate === 'function') setImmediate(resolve);
    else setTimeout(resolve, 0);
  });

/** Create an empty in-memory file system rooted at `/`. */
export function createMemoryFs(opts: MemoryFsOptions = {}): MemoryFs {
  const clock = opts.clock ?? (() => Date.now());
  const linkSupported = opts.linkSupported !== false;
  const files = new Map<string, Inode>();
  const dirs = new Map<string, { mode: number }>([['/', { mode: 0o755 }]]);
  const ops: FsOpRecord[] = [];
  const rules: FsFailureRule[] = [];
  let observer: ((rec: FsOpRecord) => void) | undefined;
  let held: Held[] | undefined;

  const matches = (rule: FsFailureRule, rec: FsOpRecord): boolean => {
    const opsOf = rule.op === undefined ? undefined : [rule.op].flat();
    if (opsOf && !opsOf.includes(rec.op)) return false;
    if (rule.path === undefined) return true;
    if (typeof rule.path === 'string') return rule.path === rec.path;
    return rule.path.test(rec.path);
  };

  /** Hold (when scheduling), log the op, then apply failure rules. */
  const enter = async (
    op: FsOpName,
    rawPath: string,
    rawPath2?: string,
  ): Promise<FsOpRecord> => {
    const rec: FsOpRecord = { op, path: norm(rawPath) };
    if (rawPath2 !== undefined) rec.path2 = norm(rawPath2);
    if (held) {
      const queue = held;
      await new Promise<void>((release) => queue.push({ rec, release }));
    }
    ops.push(rec);
    const rule = rules.find((r) => matches(r, rec));
    if (rule) {
      if (rule.times !== undefined) {
        rule.times -= 1;
        if (rule.times <= 0) rules.splice(rules.indexOf(rule), 1);
      }
      observer?.(rec);
      throw fsError(rule.code, op, rec.path);
    }
    return rec;
  };

  const done = (rec: FsOpRecord): void => {
    observer?.(rec);
  };

  const requireParent = (p: string, op: string): void => {
    if (!dirs.has(parentOf(p))) throw fsError('ENOENT', op, p);
  };

  const mkdirSync = (p: string, mode: number): void => {
    const chain: string[] = [];
    for (let cur = p; !dirs.has(cur); cur = parentOf(cur)) {
      if (files.has(cur)) throw fsError('ENOTDIR', 'mkdir', cur);
      chain.unshift(cur);
    }
    for (const d of chain) dirs.set(d, { mode });
  };

  const handle = (path: string, inode: Inode): FsFileHandle => ({
    write: async (data) => {
      const rec = await enter('write', path);
      inode.data = concat(inode.data, data);
      inode.mtimeMs = clock();
      done(rec);
    },
    sync: async () => done(await enter('sync', path)),
    close: async () => done(await enter('close', path)),
  });

  const mfs: MemoryFs = {
    ops,
    async mkdir(path, mode) {
      const rec = await enter('mkdir', path);
      mkdirSync(rec.path, mode);
      done(rec);
    },
    async chmod(path, mode) {
      const rec = await enter('chmod', path);
      const node = files.get(rec.path) ?? dirs.get(rec.path);
      if (!node) throw fsError('ENOENT', 'chmod', rec.path);
      node.mode = mode;
      done(rec);
    },
    async openExclusive(path, mode) {
      const rec = await enter('openExclusive', path);
      const p = rec.path;
      if (files.has(p) || dirs.has(p)) {
        throw fsError('EEXIST', 'open', p);
      }
      requireParent(p, 'open');
      const inode: Inode = {
        data: new Uint8Array(0),
        mode,
        mtimeMs: clock(),
      };
      files.set(p, inode);
      done(rec);
      return handle(p, inode);
    },
    async appendFile(path, data, mode, exclusive) {
      const rec = await enter('appendFile', path);
      const p = rec.path;
      const cur = files.get(p);
      if (cur && exclusive) throw fsError('EEXIST', 'appendFile', p);
      if (dirs.has(p)) throw fsError('EISDIR', 'appendFile', p);
      if (cur) {
        cur.data = concat(cur.data, data);
        cur.mtimeMs = clock();
      } else {
        requireParent(p, 'appendFile');
        files.set(p, {
          data: data.slice(),
          mode,
          mtimeMs: clock(),
        });
      }
      done(rec);
    },
    async link(existingPath, newPath) {
      const rec = await enter('link', existingPath, newPath);
      const to = rec.path2 as string;
      if (!linkSupported) throw fsError('EPERM', 'link', to);
      const inode = files.get(rec.path);
      if (!inode) throw fsError('ENOENT', 'link', rec.path);
      if (files.has(to) || dirs.has(to)) throw fsError('EEXIST', 'link', to);
      requireParent(to, 'link');
      files.set(to, inode);
      done(rec);
    },
    async rename(from, to) {
      const rec = await enter('rename', from, to);
      const dst = rec.path2 as string;
      const inode = files.get(rec.path);
      if (!inode) throw fsError('ENOENT', 'rename', rec.path);
      requireParent(dst, 'rename');
      files.delete(rec.path);
      files.set(dst, inode);
      done(rec);
    },
    async unlink(path) {
      const rec = await enter('unlink', path);
      if (!files.delete(rec.path)) throw fsError('ENOENT', 'unlink', rec.path);
      done(rec);
    },
    async readFile(path) {
      const rec = await enter('readFile', path);
      const inode = files.get(rec.path);
      if (!inode) {
        throw fsError(dirs.has(rec.path) ? 'EISDIR' : 'ENOENT', 'read', path);
      }
      done(rec);
      return inode.data.slice();
    },
    async stat(path) {
      const rec = await enter('stat', path);
      const inode = files.get(rec.path);
      const dir = dirs.get(rec.path);
      if (!inode && !dir) throw fsError('ENOENT', 'stat', rec.path);
      done(rec);
      return inode ?
        {
          size: inode.data.length,
          mtimeMs: inode.mtimeMs,
          mode: inode.mode,
        } :
        {
          size: 0,
          mtimeMs: 0,
          mode: (dir as { mode: number }).mode,
        };
    },
    async readdir(path) {
      const rec = await enter('readdir', path);
      const p = rec.path;
      if (!dirs.has(p)) throw fsError('ENOENT', 'readdir', p);
      const prefix = p === '/' ? '/' : p + '/';
      const names = new Set<string>();
      for (const k of [...files.keys(), ...dirs.keys()]) {
        if (k !== p && k.startsWith(prefix)) {
          names.add(k.slice(prefix.length).split('/')[0]);
        }
      }
      done(rec);
      return [...names].sort();
    },
    readText(path) {
      const inode = files.get(norm(path));
      return inode ? dec.decode(inode.data) : undefined;
    },
    readBytes(path) {
      return files.get(norm(path))?.data.slice();
    },
    writeText(path, text, mode = 0o644) {
      const p = norm(path);
      mkdirSync(parentOf(p), 0o755);
      files.set(p, {
        data: enc.encode(text),
        mode,
        mtimeMs: clock(),
      });
    },
    makeDir(path, mode = 0o755) {
      mkdirSync(norm(path), mode);
    },
    exists(path) {
      const p = norm(path);
      return files.has(p) || dirs.has(p);
    },
    modeOf(path) {
      const p = norm(path);
      return (files.get(p) ?? dirs.get(p))?.mode;
    },
    files() {
      return [...files.keys()].sort();
    },
    failOn(rule) {
      rules.push({ ...rule });
    },
    observe(fn) {
      observer = fn;
    },
    async schedule(tasks, pick) {
      if (held) throw new Error('memory fs: schedule() is not reentrant');
      const queue: Held[] = [];
      held = queue;
      let settled = 0;
      const results = tasks.map((task) =>
        Promise.resolve()
          .then(task)
          .finally(() => {
            settled += 1;
          }),
      );
      const all = Promise.allSettled(results);
      try {
        let idle = 0;
        for (let step = 0; ; step += 1) {
          // Let every running task reach its next fs operation (or finish):
          // between two operations a task only does microtask work.
          await macrotask();
          await macrotask();
          if (queue.length === 0) {
            if (settled === tasks.length) break;
            idle += 1;
            if (idle > 1000) {
              throw new Error('memory fs: a scheduled task never settles');
            }
            continue;
          }
          idle = 0;
          const raw = pick(
            queue.map((h) => h.rec),
            step,
          );
          const index = Math.max(0, Math.min(queue.length - 1, raw));
          const [next] = queue.splice(index, 1);
          next.release();
        }
      } finally {
        held = undefined;
        for (const h of queue.splice(0)) h.release();
      }
      return all;
    },
  };
  return mfs;
}
