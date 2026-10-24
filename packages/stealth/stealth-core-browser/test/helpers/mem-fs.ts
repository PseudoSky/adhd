/**
 * In-memory filesystem for the unit lane.
 * Ticket 8468f7b1 · criterion [cdp-test-harness.5]
 *
 * `MemFs` implements `FsLike`, the synchronous subset of node:fs the
 * runner needs: exclusive create (`wx` fails with EEXIST on an existing file,
 * the O_EXCL primitive launch locking relies on), atomic rename (the
 * destination is replaced in one step, a failed rename leaves both sides
 * untouched), readdir, file mode and owner uid. Errors carry Node-style `code`s.
 */

export interface MemStat {
  mode: number
  uid: number
  size: number
  mtimeMs: number
  isFile(): boolean
  isDirectory(): boolean
}

export interface FsLike {
  existsSync(path: string): boolean
  readFileSync(path: string, encoding?: 'utf8'): string
  writeFileSync(path: string, data: string, opts?: { flag?: string; mode?: number }): void
  openSync(path: string, flags: string, mode?: number): number
  writeSync(fd: number, data: string): number
  closeSync(fd: number): void
  unlinkSync(path: string): void
  renameSync(from: string, to: string): void
  readdirSync(path: string): string[]
  mkdirSync(path: string, opts?: { recursive?: boolean; mode?: number }): void
  statSync(path: string): MemStat
  chmodSync(path: string, mode: number): void
}

interface Entry {
  kind: 'file' | 'dir'
  data: string
  mode: number
  uid: number
  mtimeMs: number
}

function fsError(code: string, syscall: string, path: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: ${syscall} '${path}'`) as NodeJS.ErrnoException
  err.code = code
  err.syscall = syscall
  err.path = path
  return err
}

function norm(p: string): string {
  const parts: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return '/' + parts.join('/')
}

function parentOf(p: string): string {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

export class MemFs implements FsLike {
  private entries = new Map<string, Entry>([['/', { kind: 'dir', data: '', mode: 0o755, uid: 0, mtimeMs: 0 }]])
  private fds = new Map<number, string>()
  private nextFd = 3

  /**
   * @param uid owner uid stamped on every entry this instance creates
   * @param now clock for mtime (inject a fake clock to control age checks)
   */
  constructor(
    public uid = 501,
    private now: () => number = () => Date.now(),
  ) {}

  /** Test helper: change the owner of an entry (simulates a foreign-owned file). */
  setUid(path: string, uid: number): void {
    this.mustGet(norm(path), 'chown').uid = uid
  }

  /** Test helper: set mtime. */
  setMtime(path: string, mtimeMs: number): void {
    this.mustGet(norm(path), 'utimes').mtimeMs = mtimeMs
  }

  existsSync(path: string): boolean {
    return this.entries.has(norm(path))
  }

  readFileSync(path: string): string {
    const e = this.mustGet(norm(path), 'open')
    if (e.kind === 'dir') throw fsError('EISDIR', 'read', path)
    return e.data
  }

  writeFileSync(path: string, data: string, opts: { flag?: string; mode?: number } = {}): void {
    const fd = this.openSync(path, opts.flag ?? 'w', opts.mode)
    this.writeSync(fd, data)
    this.closeSync(fd)
  }

  openSync(path: string, flags: string, mode = 0o644): number {
    const p = norm(path)
    const existing = this.entries.get(p)
    const exclusive = flags.includes('x')
    if (existing && exclusive) throw fsError('EEXIST', 'open', path)
    if (existing?.kind === 'dir') throw fsError('EISDIR', 'open', path)
    if (!existing) {
      if (flags.startsWith('r')) throw fsError('ENOENT', 'open', path)
      this.requireDir(parentOf(p), 'open', path)
      this.entries.set(p, { kind: 'file', data: '', mode, uid: this.uid, mtimeMs: this.now() })
    } else if (flags.startsWith('w')) {
      existing.data = ''
      existing.mtimeMs = this.now()
    }
    const fd = this.nextFd++
    this.fds.set(fd, p)
    return fd
  }

  writeSync(fd: number, data: string): number {
    const p = this.fds.get(fd)
    if (!p) throw fsError('EBADF', 'write', String(fd))
    const e = this.mustGet(p, 'write')
    e.data += data
    e.mtimeMs = this.now()
    return data.length
  }

  closeSync(fd: number): void {
    if (!this.fds.delete(fd)) throw fsError('EBADF', 'close', String(fd))
  }

  unlinkSync(path: string): void {
    const p = norm(path)
    const e = this.mustGet(p, 'unlink')
    if (e.kind === 'dir') throw fsError('EISDIR', 'unlink', path)
    this.entries.delete(p)
  }

  /** Atomic: validates everything first, then swaps in one step; the destination is replaced, never half-written. */
  renameSync(from: string, to: string): void {
    const src = norm(from)
    const dst = norm(to)
    const e = this.mustGet(src, 'rename')
    this.requireDir(parentOf(dst), 'rename', to)
    const target = this.entries.get(dst)
    if (target?.kind === 'dir' && e.kind === 'file') throw fsError('EISDIR', 'rename', to)
    if (src === dst) return
    this.entries.delete(src)
    this.entries.set(dst, e)
    if (e.kind === 'dir') {
      for (const [k, v] of [...this.entries]) {
        if (k.startsWith(src + '/')) {
          this.entries.delete(k)
          this.entries.set(dst + k.slice(src.length), v)
        }
      }
    }
    for (const [fd, p] of this.fds) if (p === src) this.fds.set(fd, dst)
  }

  readdirSync(path: string): string[] {
    const p = norm(path)
    const e = this.mustGet(p, 'scandir')
    if (e.kind !== 'dir') throw fsError('ENOTDIR', 'scandir', path)
    const prefix = p === '/' ? '/' : p + '/'
    const names = new Set<string>()
    for (const k of this.entries.keys()) {
      if (k !== p && k.startsWith(prefix)) names.add(k.slice(prefix.length).split('/')[0])
    }
    return [...names].sort()
  }

  mkdirSync(path: string, opts: { recursive?: boolean; mode?: number } = {}): void {
    const p = norm(path)
    if (this.entries.has(p)) {
      if (opts.recursive && this.entries.get(p)?.kind === 'dir') return
      throw fsError('EEXIST', 'mkdir', path)
    }
    const parent = parentOf(p)
    if (!this.entries.has(parent)) {
      if (!opts.recursive) throw fsError('ENOENT', 'mkdir', path)
      this.mkdirSync(parent, opts)
    }
    this.requireDir(parent, 'mkdir', path)
    this.entries.set(p, { kind: 'dir', data: '', mode: opts.mode ?? 0o755, uid: this.uid, mtimeMs: this.now() })
  }

  statSync(path: string): MemStat {
    const e = this.mustGet(norm(path), 'stat')
    return {
      mode: e.mode,
      uid: e.uid,
      size: e.data.length,
      mtimeMs: e.mtimeMs,
      isFile: () => e.kind === 'file',
      isDirectory: () => e.kind === 'dir',
    }
  }

  chmodSync(path: string, mode: number): void {
    this.mustGet(norm(path), 'chmod').mode = mode
  }

  private mustGet(p: string, syscall: string): Entry {
    const e = this.entries.get(p)
    if (!e) throw fsError('ENOENT', syscall, p)
    return e
  }

  private requireDir(p: string, syscall: string, orig: string): void {
    const e = this.entries.get(p)
    if (!e) throw fsError('ENOENT', syscall, orig)
    if (e.kind !== 'dir') throw fsError('ENOTDIR', syscall, orig)
  }
}
