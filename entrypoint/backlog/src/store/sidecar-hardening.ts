/**
 * Confused-deputy hardening for the backlog store's sidecar files (backlog 515a2b50 / BK7, security
 * review SEC-F2).
 *
 * An srt-sandboxed shell is allowed to write the store's DATA directory so it can take the store lease
 * and open the database. A prompt-injected agent can therefore plant `<db>-wal`, `<db>-shm`, `<db>-journal`,
 * `<db>.sox-lease.d`, `<db>-tshm*` as SYMLINKS (or hard links) to a file outside the sandbox; the next
 * UNSANDBOXED `adhd-backlog` would open/truncate/delete through them. Measured: a planted `-wal`
 * symlink to a 7-byte victim file leaves that file at 0 bytes after a plain `adhd-backlog query`.
 *
 * {@link quarantineUnsafeSidecars} runs before the store is opened and unlinks (the link itself, never
 * its target) any sidecar that is a symlink or a multiply-linked regular file. The main DB file is left
 * alone — a user may legitimately symlink it — and an in-flight replacement between this check and the
 * open is a residual TOCTOU window, documented in the agent-mcp AGENTS.md sandbox section.
 */
import { lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Fixed sidecar suffixes appended to the DB file name. */
const SIDECAR_SUFFIXES: readonly string[] = [
  '-wal',
  '-shm',
  '-journal',
  '-tshm',
  '.sox-lease.d',
  '.sidecar-sweep-marker',
];

/** Prefix of the rotated multiprocess-shm files (`<db>-tshm.stale-<stamp>`). */
const STALE_SHM_INFIX = '-tshm.stale-';

/** One sidecar removed by {@link quarantineUnsafeSidecars}. */
export interface IQuarantinedSidecar {
  readonly path: string;
  readonly reason: 'symlink' | 'hardlink';
}

/**
 * Remove planted symlink / hard-link sidecars next to `dbPath`. Never follows a link and never removes
 * a real file or directory. No-op for `:memory:` or a missing directory.
 *
 * @param dbPath the the database engine DB path about to be opened.
 * @returns the entries it removed (callers may log them).
 */
export function quarantineUnsafeSidecars(dbPath: string): IQuarantinedSidecar[] {
  if (dbPath === ':memory:') return [];
  const dir = dirname(dbPath);
  const base = basename(dbPath);
  const candidates = new Set(SIDECAR_SUFFIXES.map((suffix) => join(dir, `${base}${suffix}`)));
  try {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(`${base}${STALE_SHM_INFIX}`)) candidates.add(join(dir, name));
    }
  } catch {
    return [];
  }
  const removed: IQuarantinedSidecar[] = [];
  for (const path of candidates) {
    let st;
    try {
      st = lstatSync(path);
    } catch {
      continue; // absent: the normal case
    }
    let reason: IQuarantinedSidecar['reason'];
    if (st.isSymbolicLink()) reason = 'symlink';
    else if (st.isFile() && st.nlink > 1) reason = 'hardlink';
    else continue;
    try {
      unlinkSync(path); // unlinks the link itself, never what it points at
      removed.push({ path, reason });
    } catch {
      /* best effort: the open that follows fails loudly if the entry is still hostile */
    }
  }
  return removed;
}
