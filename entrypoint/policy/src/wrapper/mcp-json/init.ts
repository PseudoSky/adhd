import { ApiError } from '@adhd/apigen-base-errors';
import { backupPath, nodeMcpJsonFs } from './io';
import type { IMcpJsonFs } from './io';

/** Options for {@link initMcpJson}. */
export interface IInitOptions {
  readonly file: string;
  readonly specFile: string;
  readonly only?: readonly string[];
  readonly fs?: IMcpJsonFs;
  /** The wrapper command written into each entry. Default `adhd-policy`. */
  readonly bin?: string;
}

/** What {@link initMcpJson} did. */
export interface IInitResult {
  readonly changed: boolean;
  readonly wrapped: readonly string[];
  readonly skipped: readonly { name: string; reason: 'already-wrapped' | 'remote-entry' | 'not-selected' }[];
  readonly backup: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Rebuilds `entry` with `command`/`args` replaced, keeping every other key (and key order) as it was. */
function wrapEntry(entry: Record<string, unknown>, bin: string, specFile: string): Record<string, unknown> {
  const command = entry['command'] as string;
  const args = Array.isArray(entry['args']) ? (entry['args'] as unknown[]) : [];
  const wrapped = ['serve', `bin:${command}`, '--spec', specFile, '--', ...args];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key === 'command') {
      out[key] = bin;
      if (!('args' in entry)) out['args'] = wrapped;
    } else if (key === 'args') {
      out[key] = wrapped;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * D-10. For each stdio entry `{command, args, env}` of `mcpServers` (filtered by
 * `only`) the entry becomes `{command: bin, args: ['serve', 'bin:<command>',
 * '--spec', specFile, '--', ...args], env}`; `env` and every other key are
 * unchanged. An entry whose command already equals `bin` is `already-wrapped`;
 * a `url` / command-less entry is `remote-entry`. The original file is copied
 * byte for byte to `<file>.adhd-policy.bak` before the first write, and the
 * copy is refreshed only when no entry is wrapped yet (a fresh `init` after an
 * `--undo`); a repeated `init` never overwrites the original's backup. The
 * output keeps key order and 2-space indent. When nothing changes the file is
 * left untouched (`changed: false`).
 */
export async function initMcpJson(options: IInitOptions): Promise<IInitResult> {
  const fs = options.fs ?? nodeMcpJsonFs;
  const bin = options.bin ?? 'adhd-policy';
  const backup = backupPath(options.file);
  const original = await fs.read(options.file);
  if (original === undefined) {
    throw new ApiError('not_found', `${options.file} does not exist`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(original);
  } catch (error) {
    throw new ApiError('invalid_argument', `${options.file} is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!isRecord(parsed) || !isRecord(parsed['mcpServers'])) {
    throw new ApiError('invalid_argument', `${options.file} has no "mcpServers" object`);
  }
  const servers = parsed['mcpServers'];
  const wrapped: string[] = [];
  const skipped: { name: string; reason: 'already-wrapped' | 'remote-entry' | 'not-selected' }[] = [];
  const next: Record<string, unknown> = {};
  let anyAlreadyWrapped = false;
  for (const [name, entry] of Object.entries(servers)) {
    if (!isRecord(entry) || typeof entry['command'] !== 'string') {
      skipped.push({ name, reason: 'remote-entry' });
      next[name] = entry;
    } else if (entry['command'] === bin) {
      anyAlreadyWrapped = true;
      skipped.push({ name, reason: 'already-wrapped' });
      next[name] = entry;
    } else if (options.only !== undefined && options.only.length > 0 && !options.only.includes(name)) {
      skipped.push({ name, reason: 'not-selected' });
      next[name] = entry;
    } else {
      wrapped.push(name);
      next[name] = wrapEntry(entry, bin, options.specFile);
    }
  }
  if (wrapped.length === 0) return { changed: false, wrapped, skipped, backup };
  if (!(await fs.exists(backup)) || !anyAlreadyWrapped) await fs.write(backup, original);
  const output = { ...parsed, mcpServers: next };
  await fs.write(options.file, `${JSON.stringify(output, null, 2)}${original.endsWith('\n') ? '\n' : ''}`);
  return { changed: true, wrapped, skipped, backup };
}
