import { ApiError } from '@adhd/apigen-base-errors';
import { backupPath, integrityPath, nodeMcpJsonFs, PRIVATE_FILE_MODE, sha256Text } from './io';
import type { IIntegrityRecord, IMcpJsonFs } from './io';

/** Options for {@link initMcpJson}. */
export interface IInitOptions {
  readonly file: string;
  /** The spec path to write into each wrapped entry, exactly as it should appear. */
  readonly specFile: string;
  readonly only?: readonly string[];
  /** Rewrite the `--spec` of entries already wrapped under a different spec. */
  readonly replace?: boolean;
  readonly fs?: IMcpJsonFs;
  /** The wrapper command written into each entry. Default `adhd-policy`. */
  readonly bin?: string;
}

/** Why an entry was left alone. */
export interface IInitSkip {
  readonly name: string;
  readonly reason: 'already-wrapped' | 'remote-entry' | 'not-selected';
  /** `already-wrapped` only: the spec(s) the entry is wrapped under when it differs from the requested one. */
  readonly spec?: readonly string[];
}

/** What {@link initMcpJson} did. */
export interface IInitResult {
  readonly changed: boolean;
  /** Entries newly wrapped. */
  readonly wrapped: readonly string[];
  /** Entries already wrapped whose spec was rewritten (`replace`). */
  readonly replaced: readonly string[];
  readonly skipped: readonly IInitSkip[];
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

/** The `--spec` values of an already-wrapped entry: those between `serve` and the first `--`. */
function wrappedSpecs(entry: Record<string, unknown>): string[] {
  const args = Array.isArray(entry['args']) ? (entry['args'] as unknown[]) : [];
  const end = args.indexOf('--');
  const head = end < 0 ? args : args.slice(0, end);
  const specs: string[] = [];
  for (let index = 0; index < head.length; index += 1) {
    const token = head[index];
    if (token === '--spec' && typeof head[index + 1] === 'string') {
      specs.push(head[index + 1] as string);
      index += 1;
    } else if (typeof token === 'string' && token.startsWith('--spec=')) {
      specs.push(token.slice('--spec='.length));
    }
  }
  return specs;
}

/** Rewrites every `--spec` of a wrapped entry to the single `specFile`, keeping every other argument and key in place. */
function replaceSpec(entry: Record<string, unknown>, specFile: string): Record<string, unknown> {
  const args = Array.isArray(entry['args']) ? (entry['args'] as unknown[]) : [];
  const end = args.indexOf('--');
  const head = end < 0 ? args : args.slice(0, end);
  const tail = end < 0 ? [] : args.slice(end);
  const rebuilt: unknown[] = [];
  let placed = false;
  for (let index = 0; index < head.length; index += 1) {
    const token = head[index];
    const isFlag = token === '--spec';
    const isInline = typeof token === 'string' && token.startsWith('--spec=');
    if (!isFlag && !isInline) {
      rebuilt.push(token);
      continue;
    }
    if (isFlag) index += 1;
    if (!placed) {
      rebuilt.push('--spec', specFile);
      placed = true;
    }
  }
  if (!placed) rebuilt.push('--spec', specFile);
  return { ...entry, args: [...rebuilt, ...tail] };
}

/**
 * D-10. For each stdio entry `{command, args, env}` of `mcpServers` (filtered by
 * `only`) the entry becomes `{command: bin, args: ['serve', 'bin:<command>',
 * '--spec', specFile, '--', ...args], env}`; `env` and every other key are
 * unchanged. An `only` name that matches no entry is `ApiError('invalid_argument')`
 * (exit 2) and nothing is written. An entry whose command already equals `bin` is
 * `already-wrapped`, and when it is wrapped under a different spec the result
 * lists that old spec; `replace` rewrites it to `specFile`. A `url` /
 * command-less entry is `remote-entry`.
 *
 * Writes (each atomic, backup and integrity record `0600`, the file keeps its own
 * mode): the original copied byte for byte to `<file>.adhd-policy.bak` (refreshed
 * only when no entry was wrapped yet, i.e. a fresh `init` after an `--undo`; a
 * repeated `init` never overwrites the original's backup), then the SHA-256 of
 * the new content to `<file>.adhd-policy.json`, then the file. The output keeps
 * key order and 2-space indent. When nothing changes nothing is written
 * (`changed: false`).
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
  const only = options.only ?? [];
  const unmatched = only.filter((name) => !Object.prototype.hasOwnProperty.call(servers, name));
  if (unmatched.length > 0) {
    throw new ApiError(
      'invalid_argument',
      `--only names no entry of ${options.file}: ${unmatched.join(', ')} (entries: ${Object.keys(servers).join(', ') || 'none'})`
    );
  }
  const wrapped: string[] = [];
  const replaced: string[] = [];
  const skipped: IInitSkip[] = [];
  const next: Record<string, unknown> = {};
  let anyAlreadyWrapped = false;
  for (const [name, entry] of Object.entries(servers)) {
    if (!isRecord(entry) || typeof entry['command'] !== 'string') {
      skipped.push({ name, reason: 'remote-entry' });
      next[name] = entry;
    } else if (entry['command'] === bin) {
      anyAlreadyWrapped = true;
      const specs = wrappedSpecs(entry);
      const differs = specs.length !== 1 || specs[0] !== options.specFile;
      const selected = only.length === 0 || only.includes(name);
      if (differs && selected && options.replace === true) {
        replaced.push(name);
        next[name] = replaceSpec(entry, options.specFile);
      } else {
        skipped.push({ name, reason: 'already-wrapped', ...(differs && selected ? { spec: specs } : {}) });
        next[name] = entry;
      }
    } else if (only.length > 0 && !only.includes(name)) {
      skipped.push({ name, reason: 'not-selected' });
      next[name] = entry;
    } else {
      wrapped.push(name);
      next[name] = wrapEntry(entry, bin, options.specFile);
    }
  }
  if (wrapped.length === 0 && replaced.length === 0) return { changed: false, wrapped, replaced, skipped, backup };
  const output = `${JSON.stringify({ ...parsed, mcpServers: next }, null, 2)}${original.endsWith('\n') ? '\n' : ''}`;
  if (!(await fs.exists(backup)) || !anyAlreadyWrapped) await fs.write(backup, original, { mode: PRIVATE_FILE_MODE });
  const record: IIntegrityRecord = { formatVersion: 1, sha256: sha256Text(output) };
  await fs.write(integrityPath(options.file), `${JSON.stringify(record)}\n`, { mode: PRIVATE_FILE_MODE });
  await fs.write(options.file, output);
  return { changed: true, wrapped, replaced, skipped, backup };
}
