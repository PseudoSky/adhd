/**
 * eol-hook.ts — preserve CRLF line endings across the adopted fs server's
 * `edit_file` / `write_file` (backlog 8dd148cf, R3-EOL).
 *
 * `@modelcontextprotocol/server-filesystem` normalizes every file it writes to bare
 * LF, so a CRLF file comes back converted. This host-side hook snapshots the
 * line-ending class of the target on `pre:tool_call` (keyed by `callId`) and, on a
 * successful `post:tool_call`, rewrites the file to CRLF only if it now has bare LF.
 *
 * Properties:
 *  - Default on, no flag: native-Claude-CLI parity, not an option.
 *  - Fail-open: any error here is swallowed and never alters the tool result.
 *  - Scope: only the builtin `fs` server's `edit_file` / `write_file`; the server's
 *    own root scoping decides whether the call succeeded, and the fix-up only runs
 *    for a call it accepted. A path outside the roots is therefore never rewritten.
 *  - Process-local state only (a bounded, TTL-expiring callId map: at most
 *    `maxPending` entries, each dropped after `ttlMs`, so a call that never reaches
 *    `post:tool_call` cannot leak). Concurrent writers to one file are safe
 *    (parallel-process enabled, ADR-0012): the fix-up is an idempotent whole-file
 *    normalization to the pre-call class, it is committed by temp-file + rename
 *    (readers never see a torn file; the original mode is preserved), and it is
 *    skipped with a warning if the file changed between the hook's read and its
 *    commit, so a competing write is never overwritten (19354419 AC1/AC2/AC3).
 *    The remaining read-recheck-rename window is the width of one stat+read+rename.
 *  - Size cap: nothing larger than `maxBytes` (default 8 MiB) is ever read or
 *    rewritten, by either hook (19354419 AC4).
 */
import { randomUUID } from 'node:crypto';
import { chmod, chown, open, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import type { IHookRegistry } from '@adhd/agent-base-types';
import { classifyEol, restoreLineEndings } from '@adhd/agent-core-native-tooling';

const FS_WRITE_TOOLS = new Set(['fs__edit_file', 'fs__write_file']);

/** Default read/rewrite size cap: 8 MiB. Larger targets are left untouched. */
export const EOL_MAX_BYTES = 8 * 1024 * 1024;
/** Default cap on in-flight (pre seen, post not yet seen) calls. */
export const EOL_MAX_PENDING = 1024;
/** Default lifetime of a pending entry whose post hook never arrives: 10 minutes. */
export const EOL_PENDING_TTL_MS = 10 * 60 * 1000;

/** Tunables and test seams for {@link registerEolPreserve}. All optional. */
export interface IEolPreserveOptions {
  /** Max bytes the hooks will read/rewrite (default {@link EOL_MAX_BYTES}). */
  maxBytes?: number;
  /** Max pending callId entries (default {@link EOL_MAX_PENDING}); oldest evicted first. */
  maxPending?: number;
  /** Pending-entry TTL in ms (default {@link EOL_PENDING_TTL_MS}). */
  ttlMs?: number;
  /** Clock, ms. Default `Date.now`. */
  now?: () => number;
  /** Sink for skip warnings. Default: one line on stderr (stdout is the MCP wire). */
  warn?: (message: string) => void;
  /** @internal Test seam: awaited after the temp file is written, before the re-check + rename. */
  beforeCommit?: (path: string) => Promise<void>;
}

/** Handle returned by {@link registerEolPreserve}. */
export interface IEolPreserveHandle {
  /** Number of calls currently tracked (pre seen, post not yet seen, not expired). */
  pending(): number;
}

function targetPath(toolInput: unknown, cwd: string | undefined): string | undefined {
  if (toolInput === null || typeof toolInput !== 'object') return undefined;
  const raw = (toolInput as { path?: unknown }).path;
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  return isAbsolute(raw) ? raw : resolve(cwd ?? process.cwd(), raw);
}

/**
 * Read `path` as utf8 unless it is larger than `cap` bytes (then `undefined`, having
 * read nothing). Never reads more than `cap + 1` bytes even if the file grows mid-read.
 */
async function readCapped(path: string, cap: number): Promise<string | undefined> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    if (size > cap) return undefined;
    const buf = Buffer.allocUnsafe(Math.min(size, cap) + 1);
    let filled = 0;
    while (filled < buf.length) {
      const { bytesRead } = await fh.read(buf, filled, buf.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled > cap) return undefined; // grew past the cap while reading
    return buf.toString('utf8', 0, filled);
  } finally {
    await fh.close();
  }
}

/** Register the CRLF-preserving pre/post tool-call hooks on `hooks`. */
export function registerEolPreserve(
  hooks: IHookRegistry,
  options: IEolPreserveOptions = {}
): IEolPreserveHandle {
  const maxBytes = options.maxBytes ?? EOL_MAX_BYTES;
  const maxPending = Math.max(1, options.maxPending ?? EOL_MAX_PENDING);
  const ttlMs = options.ttlMs ?? EOL_PENDING_TTL_MS;
  const now = options.now ?? Date.now;
  const warn =
    options.warn ?? ((m: string) => void process.stderr.write(`[agent-mcp eol-hook] ${m}\n`));

  /** callId -> target; Map iteration is insertion (= time) order, so the oldest is first. */
  const crlfTargets = new Map<string, { path: string; at: number }>();

  const prune = (): void => {
    const cutoff = now() - ttlMs;
    for (const [id, e] of crlfTargets) {
      if (e.at > cutoff) break;
      crlfTargets.delete(id);
    }
  };

  hooks.register('pre:tool_call', async (p) => {
    try {
      if (!FS_WRITE_TOOLS.has(p.toolName)) return;
      const path = targetPath(p.toolInput, p.executionContext.cwd);
      if (path === undefined) return;
      const before = await readCapped(path, maxBytes);
      if (before === undefined || classifyEol(before) !== 'crlf') return;
      prune();
      crlfTargets.delete(p.callId);
      while (crlfTargets.size >= maxPending) {
        const oldest = crlfTargets.keys().next();
        if (oldest.done) break;
        crlfTargets.delete(oldest.value);
      }
      crlfTargets.set(p.callId, { path, at: now() });
    } catch {
      // missing file (a new write), unreadable, etc. -> nothing to preserve (fail-open)
    }
  });

  hooks.register('post:tool_call', async (p) => {
    const entry = crlfTargets.get(p.callId);
    if (entry === undefined) return;
    crlfTargets.delete(p.callId);
    let tmp: string | undefined;
    try {
      if (p.isError) return;
      prune();
      // Resolve symlinks so the rename replaces the real file, not the link.
      const path = await realpath(entry.path);
      const st1 = await stat(path);
      const after = await readCapped(path, maxBytes);
      if (after === undefined) return;
      const restored = restoreLineEndings('\r\n', after);
      if (restored === after) return;

      tmp = join(dirname(path), `.${basename(path)}.eol-${process.pid}-${randomUUID()}.tmp`);
      await writeFile(tmp, restored, { encoding: 'utf8', flag: 'wx', mode: st1.mode & 0o7777 });
      await chmod(tmp, st1.mode & 0o7777); // umask-proof: keep the exact original mode
      await chown(tmp, st1.uid, st1.gid).catch(() => undefined); // best effort (needs privilege)

      await options.beforeCommit?.(path);

      // Re-check: a competing write between our read and now must not be overwritten.
      const st2 = await stat(path);
      const again = await readCapped(path, maxBytes);
      if (
        again !== after ||
        st2.mtimeMs !== st1.mtimeMs ||
        st2.size !== st1.size ||
        st2.ino !== st1.ino
      ) {
        warn(`skipped CRLF restore for ${path}: file changed while the hook was rewriting it`);
        return;
      }
      await rename(tmp, path);
      tmp = undefined;
    } catch {
      // fail-open: never turn a successful tool result into an error
    } finally {
      if (tmp !== undefined) await unlink(tmp).catch(() => undefined);
    }
  });

  return {
    pending: () => {
      prune();
      return crlfTargets.size;
    },
  };
}
