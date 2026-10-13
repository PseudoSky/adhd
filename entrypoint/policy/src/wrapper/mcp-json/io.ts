import { createHash } from 'node:crypto';
import { access, chmod, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';

/** How {@link IMcpJsonFs.write} creates the file. */
export interface IMcpJsonWriteOptions {
  /** Permission bits for the written file. Omitted: the existing file's mode, else `0o644`. */
  readonly mode?: number;
}

/** File access port for `.mcp.json` handling; the only place these verbs touch the disk. */
export interface IMcpJsonFs {
  /** Resolves `undefined` when the file does not exist. */
  read(path: string): Promise<string | undefined>;
  /** Writes `text` atomically: a temporary file in the same directory, then a rename over `path`. */
  write(path: string, text: string, options?: IMcpJsonWriteOptions): Promise<void>;
  exists(path: string): Promise<boolean>;
}

/** The mode of backups and the integrity record: they hold a copy of a file that may carry secrets in `env`. */
export const PRIVATE_FILE_MODE = 0o600;

const DEFAULT_FILE_MODE = 0o644;

/**
 * The real filesystem. Text is read and written as UTF-8 with no
 * normalisation, so a copy is byte-exact. A write goes to a temporary file in
 * the target's directory and is renamed over it, so a crash never leaves a
 * half-written `.mcp.json`; a symlinked target is written through to its real
 * file; an existing file's permission bits are kept unless `mode` says otherwise.
 */
export const nodeMcpJsonFs: IMcpJsonFs = {
  async read(path) {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return undefined;
      throw error;
    }
  },
  async write(path, text, options = {}) {
    let target = path;
    let mode = options.mode;
    try {
      target = await realpath(path);
      mode ??= (await stat(target)).mode & 0o777;
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
    }
    mode ??= DEFAULT_FILE_MODE;
    const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.tmp`);
    try {
      await writeFile(temporary, text, { encoding: 'utf8', mode, flag: 'w' });
      await chmod(temporary, mode);
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  },
  async exists(path) {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },
};

/** Where `init` keeps the original. */
export function backupPath(file: string): string {
  return `${file}.adhd-policy.bak`;
}

/** Where `init` records the digest of what it wrote, so `--undo` can tell the file was edited since. */
export function integrityPath(file: string): string {
  return `${file}.adhd-policy.json`;
}

/** Hex SHA-256 of `text` as UTF-8. */
export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The integrity record `init` writes beside the backup. */
export interface IIntegrityRecord {
  readonly formatVersion: 1;
  /** SHA-256 of the file as `init` last wrote it. */
  readonly sha256: string;
}

/** Parses an integrity record; `undefined` when absent, unparseable or the wrong shape. */
export function parseIntegrityRecord(text: string | undefined): IIntegrityRecord | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as Partial<IIntegrityRecord>;
    return parsed.formatVersion === 1 && typeof parsed.sha256 === 'string' ? (parsed as IIntegrityRecord) : undefined;
  } catch {
    return undefined;
  }
}
