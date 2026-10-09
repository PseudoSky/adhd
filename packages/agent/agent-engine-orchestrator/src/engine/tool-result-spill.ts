/**
 * `tool-result-spill.ts` — OPTIONAL spill-to-file mode for tool results that
 * exceed the model-visible cap (backlog 3ad735bb / BK9; plan 9ed453c1).
 *
 * The `claude` CLI never feeds the model more than ~50k chars of an MCP result:
 * it writes the full result to disk and shows a short stub naming the file. The
 * API path's default is the head+tail cap ({@link capToolResult}); this module
 * adds the CLI-style recoverable alternative, DEFAULT OFF.
 *
 * Semantics:
 * - Disabled (the default) or under the cap: {@link capOrSpillToolResult}
 *   returns exactly what {@link capToolResult} returns (byte-identical).
 * - Enabled and the cap would truncate: the FULL serialized result is written
 *   to `<dir>/<taskId>/<callId>.txt` and the model sees a short stub (path,
 *   size, a head preview, and how to read a range with the shell tool).
 * - Any spill failure (unwritable dir, symlinked dir, I/O error) NEVER throws:
 *   the head+tail cap outcome is returned and `onSpillError` is told why.
 * - Hardening: dirs are created `0700` and verified to be real directories
 *   owned by this user (a symlinked dir is refused, never followed); files are
 *   created `0600` with `O_EXCL | O_NOFOLLOW` (a planted entry at the target
 *   name is unlinked — the link, never its target — and the create retried).
 * - Cleanup: {@link sweepToolResultSpill} removes task dirs older than the TTL
 *   (run once per process per dir on the first spill); {@link removeTaskSpill}
 *   removes one task's dir.
 *
 * Telemetry is unaffected: callers keep measuring the FULL result.
 */
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';

import {
  capToolResult,
  ERROR_RESULT_FLOOR_CHARS,
  serializeToolResult,
  type ToolResultCapOutcome,
} from './tool-result-cap.js';

/** Config key (Environment cascade) that enables the spill mode. */
export const TOOL_RESULT_SPILL_ENABLED_KEY = 'agent.toolResult.spill.enabled';
/** Env var that enables the spill mode. */
export const TOOL_RESULT_SPILL_ENABLED_ENV = 'ADHD_AGENT_TOOL_RESULT_SPILL_ENABLED';
/** Config key that overrides the spill directory (absolute). */
export const TOOL_RESULT_SPILL_DIR_KEY = 'agent.toolResult.spill.dir';
/** Env var that overrides the spill directory (absolute). */
export const TOOL_RESULT_SPILL_DIR_ENV = 'ADHD_AGENT_TOOL_RESULT_SPILL_DIR';
/** Config key for the age after which a task's spill dir is swept. */
export const TOOL_RESULT_SPILL_TTL_HOURS_KEY = 'agent.toolResult.spill.ttlHours';
/** Env var for the spill TTL in hours. */
export const TOOL_RESULT_SPILL_TTL_HOURS_ENV = 'ADHD_AGENT_TOOL_RESULT_SPILL_TTL_HOURS';

/** Default TTL: a spill dir untouched for this long is swept. */
export const DEFAULT_TOOL_RESULT_SPILL_TTL_HOURS = 24;

/** Chars of the result shown inline in the stub. */
export const SPILL_PREVIEW_CHARS = 2_000;

/** Resolved spill settings handed to the engine (`EngineConfig.toolResult.spill`). */
export interface ToolResultSpillConfig {
  /** Master switch; `false` (default) keeps the cap behaviour byte-identical. */
  readonly enabled: boolean;
  /** Absolute base directory; per-task subdirectories are created beneath it. */
  readonly dir: string;
  /** Age (ms) after which a task subdirectory is swept. */
  readonly ttlMs: number;
}

/** Outcome of {@link capOrSpillToolResult}: the cap outcome plus spill facts. */
export interface ToolResultSpillOutcome extends ToolResultCapOutcome {
  /** True iff the full result was written to a file and replaced by a stub. */
  readonly spilled?: true;
  /** Absolute path of the spill file (set iff `spilled`). */
  readonly spillPath?: string;
}

/**
 * Validates a configured spill directory. Fails loud (throws) on anything that
 * is not a plain absolute path, so a typo cannot silently relocate the spill.
 *
 * @param value - the raw configured directory
 * @returns the validated absolute directory
 * @throws {RangeError} if `value` is not a non-empty absolute path free of NUL bytes and `..` segments
 */
export function validateToolResultSpillDir(value: unknown): string {
  const why = (reason: string): RangeError =>
    new RangeError(
      `${TOOL_RESULT_SPILL_DIR_KEY} (${TOOL_RESULT_SPILL_DIR_ENV}) ${reason}; got ${JSON.stringify(value)}`
    );
  if (typeof value !== 'string' || value.trim() === '') throw why('must be a non-empty absolute path');
  if (value.includes('\0')) throw why('must not contain NUL bytes');
  if (!isAbsolute(value)) throw why('must be an absolute path (relative paths are never resolved against the cwd)');
  if (value.split(/[\\/]/).includes('..')) throw why("must not contain '..' segments");
  return value;
}

/**
 * Strictly parses the spill TTL (hours) from text or number.
 *
 * @throws {RangeError} on anything that is not a positive safe integer
 */
export function parseToolResultSpillTtlHours(raw: unknown): number {
  const n = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) {
    throw new RangeError(
      `${TOOL_RESULT_SPILL_TTL_HOURS_KEY} (${TOOL_RESULT_SPILL_TTL_HOURS_ENV}) must be a positive integer; got ${String(raw)}`
    );
  }
  return n;
}

/** A path-segment-safe form of an id (never `.`/`..`, never a separator). */
function safeSegment(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+$/, '_');
  return cleaned === '' ? '_' : cleaned.slice(0, 128);
}

const O_NOFOLLOW: number = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

/** Create `dir` (0700) if missing and prove it is a real, user-owned, private directory. */
function ensurePrivateDir(dir: string, recursive: boolean): void {
  try {
    mkdirSync(dir, { recursive, mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`spill dir ${dir} is not a real directory (symlinks are never followed)`);
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (uid !== undefined && st.uid !== uid) throw new Error(`spill dir ${dir} is not owned by this user`);
  if ((st.mode & 0o077) !== 0) {
    // Tighten rather than trust: a pre-existing dir may have been created with a wider mode.
    tightenDirMode(dir);
  }
}

function tightenDirMode(dir: string): void {
  // chmod via an fd on the verified directory path; failure here means we cannot guarantee privacy.
  const fd = openSync(dir, constants.O_RDONLY | O_NOFOLLOW);
  try {
    fchmodSync(fd, 0o700);
  } finally {
    closeSync(fd);
  }
}

/**
 * Writes `text` to `<dir>/<taskId>/<callId>.txt` (dir 0700, file 0600, O_EXCL, no symlink following).
 *
 * @returns the absolute path of the written file
 * @throws on any I/O or safety failure (callers fall back to the cap)
 */
export function writeToolResultSpillFile(dir: string, taskId: string, callId: string, text: string): string {
  ensurePrivateDir(dir, true);
  const taskDir = join(dir, safeSegment(taskId));
  ensurePrivateDir(taskDir, false);
  const file = join(taskDir, `${safeSegment(callId)}.txt`);
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW;
  let fd: number | undefined;
  for (let attempt = 0; fd === undefined; attempt++) {
    try {
      fd = openSync(file, flags, 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0) throw err;
      unlinkSync(file); // removes a planted symlink/file itself, never what a link points at
    }
  }
  try {
    const buf = Buffer.from(text, 'utf8');
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    fchmodSync(fd, 0o600);
    if (!fstatSync(fd).isFile()) throw new Error('spill target is not a regular file');
  } catch (err) {
    try {
      unlinkSync(file);
    } catch {
      /* best effort */
    }
    throw err;
  } finally {
    closeSync(fd);
  }
  return file;
}

/** Removes one task's spill directory. Never throws. */
export function removeTaskSpill(dir: string, taskId: string): void {
  try {
    const taskDir = join(dir, safeSegment(taskId));
    if (lstatSync(taskDir).isDirectory()) rmSync(taskDir, { recursive: true, force: true });
  } catch {
    /* absent or unreadable: nothing to clean */
  }
}

/**
 * Removes task directories directly under `dir` whose mtime is older than
 * `ttlMs`. Only real directories that are direct children are removed; a
 * symlink child is unlinked (never followed). Never throws.
 *
 * @returns the number of entries removed
 */
export function sweepToolResultSpill(dir: string, ttlMs: number, now: number = Date.now()): number {
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (name === '' || name === '.' || name === '..' || name.includes(sep)) continue;
    const child = join(dir, name);
    try {
      const st = lstatSync(child);
      if (now - st.mtimeMs <= ttlMs) continue;
      if (st.isSymbolicLink()) unlinkSync(child);
      else if (st.isDirectory()) rmSync(child, { recursive: true, force: true });
      else continue;
      removed++;
    } catch {
      /* raced with another process (ADR-0012: parallel processes share the dir) */
    }
  }
  return removed;
}

const sweptDirs = new Set<string>();

/**
 * The text written to the spill file. An MCP content array made ONLY of `{type:'text', text}` blocks is
 * written as the blocks' text joined by newlines — real lines, so `sed -n 'A,Bp'` works. Serializing
 * it as one JSON line would make every range read return the whole file. Anything else is written
 * as its JSON serialization (what the model would otherwise have been shown).
 */
function spillFileText(result: unknown, serialized: string): string {
  if (
    Array.isArray(result) &&
    result.length > 0 &&
    result.every(
      (b) =>
        b !== null &&
        typeof b === 'object' &&
        Object.keys(b).length === 2 &&
        (b as { type?: unknown }).type === 'text' &&
        typeof (b as { text?: unknown }).text === 'string'
    )
  ) {
    return (result as { text: string }[]).map((b) => b.text).join('\n');
  }
  return serialized;
}

function surrogateSafePreview(text: string, n: number): string {
  let end = Math.min(n, text.length);
  const last = end > 0 ? text.charCodeAt(end - 1) : 0;
  if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/** The model-visible stub for a spilled result. */
export function renderSpillStub(totalChars: number, path: string, preview: string): string {
  const quoted = `'${path.replace(/'/g, `'\\''`)}'`;
  return (
    `[tool result too large: ${totalChars} chars; full output saved to ${path}. ` +
    `Read a range with the shell tool, e.g. sed -n 'A,Bp' ${quoted} | head -c N]\n` +
    `Preview (first ${preview.length} chars):\n${preview}`
  );
}

/**
 * Normalizes `EngineConfig.toolResult.spill`: `undefined` when absent or
 * disabled, otherwise the config with its directory validated (fails loud).
 */
export function resolveToolResultSpill(cfg: ToolResultSpillConfig | undefined): ToolResultSpillConfig | undefined {
  if (!cfg?.enabled) return undefined;
  return { ...cfg, dir: validateToolResultSpillDir(cfg.dir) };
}

/** Inputs to {@link capOrSpillToolResult}. */
export interface CapOrSpillParams {
  readonly result: unknown;
  readonly isError: boolean;
  readonly maxChars: number;
  readonly spill: ToolResultSpillConfig | undefined;
  readonly taskId: string;
  readonly callId: string;
  /** Told why a spill failed and the head+tail cap was used instead. */
  readonly onSpillError?: (err: unknown) => void;
}

/**
 * Caps a tool result for the model-visible history, spilling the full result to
 * a file instead of truncating it when spill mode is enabled.
 *
 * @returns the cap outcome (identical to {@link capToolResult} unless spilled)
 */
export function capOrSpillToolResult(p: CapOrSpillParams): ToolResultSpillOutcome {
  const capped = capToolResult(p.result, p.isError, p.maxChars);
  if (!p.spill?.enabled || !capped.truncated) return capped;
  try {
    const serialized = serializeToolResult(p.result);
    if (serialized === undefined) return capped;
    const text = spillFileText(p.result, serialized);
    if (!sweptDirs.has(p.spill.dir)) {
      sweptDirs.add(p.spill.dir);
      sweepToolResultSpill(p.spill.dir, p.spill.ttlMs);
    }
    const effectiveCap = p.isError ? Math.max(p.maxChars, ERROR_RESULT_FLOOR_CHARS) : p.maxChars;
    const path = writeToolResultSpillFile(p.spill.dir, p.taskId, p.callId, text);
    const preview = surrogateSafePreview(text, Math.min(SPILL_PREVIEW_CHARS, effectiveCap));
    return {
      result: renderSpillStub(text.length, path, preview),
      truncated: true,
      originalChars: serialized.length,
      spilled: true,
      spillPath: path,
    };
  } catch (err) {
    try {
      p.onSpillError?.(err);
    } catch {
      /* a failing reporter must not break the fallback */
    }
    return capped;
  }
}
