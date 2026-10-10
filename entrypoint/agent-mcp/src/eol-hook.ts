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
 *  - Process-local state only (a callId map). Concurrent writers to one file are
 *    safe: the fix-up is an idempotent whole-file normalization to the pre-call
 *    class, so repeated or interleaved fix-ups converge on the same bytes
 *    (parallel-process enabled, ADR-0012).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import type { IHookRegistry } from '@adhd/agent-base-types';
import { classifyEol, restoreLineEndings } from '@adhd/agent-core-native-tooling';

const FS_WRITE_TOOLS = new Set(['fs__edit_file', 'fs__write_file']);

function targetPath(toolInput: unknown, cwd: string | undefined): string | undefined {
  if (toolInput === null || typeof toolInput !== 'object') return undefined;
  const raw = (toolInput as { path?: unknown }).path;
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  return isAbsolute(raw) ? raw : resolve(cwd ?? process.cwd(), raw);
}

/** Register the CRLF-preserving pre/post tool-call hooks on `hooks`. */
export function registerEolPreserve(hooks: IHookRegistry): void {
  const crlfTargets = new Map<string, string>();

  hooks.register('pre:tool_call', async (p) => {
    try {
      if (!FS_WRITE_TOOLS.has(p.toolName)) return;
      const path = targetPath(p.toolInput, p.executionContext.cwd);
      if (path === undefined) return;
      const before = await readFile(path, 'utf8');
      if (classifyEol(before) === 'crlf') crlfTargets.set(p.callId, path);
    } catch {
      // missing file (a new write), unreadable, etc. -> nothing to preserve (fail-open)
    }
  });

  hooks.register('post:tool_call', async (p) => {
    const path = crlfTargets.get(p.callId);
    if (path === undefined) return;
    crlfTargets.delete(p.callId);
    try {
      if (p.isError) return;
      const after = await readFile(path, 'utf8');
      const restored = restoreLineEndings('\r\n', after);
      if (restored !== after) await writeFile(path, restored, 'utf8');
    } catch {
      // fail-open: never turn a successful tool result into an error
    }
  });
}
