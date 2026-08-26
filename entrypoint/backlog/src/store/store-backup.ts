/**
 * store-backup.ts — P4 point-in-time backup/restore for the live backlog
 * SQLite store, via `VACUUM INTO` (backup) + a manifest-verified file copy
 * (restore). No general mechanism existed at all before this — a corrupted
 * or accidentally-pruned live store had no recovery path.
 *
 * `VACUUM INTO ?` (bound parameter, not string interpolation) writes a
 * consistent, defragmented, WAL-independent SNAPSHOT of the live store to a
 * fresh file — safe to run against an OPEN store with concurrent readers
 * (unlike a raw file copy, which can capture a torn WAL-mid-checkpoint
 * state). It refuses if the target file already exists (SQLite's own
 * behaviour, not reimplemented here) — the caller decides overwrite policy
 * BEFORE calling this (see `admin.ts`'s `backup` action), never silently.
 *
 * Restore is deliberately NOT "swap the live store's file out from under its
 * open connection" — that is unsafe (open handles, WAL/shm sidecars, a
 * concurrent writer) and this package has no primitive to close/reopen a
 * caller's `ctx.store` mid-call. Restore instead materialises a verified
 * backup into a TARGET path (which may be a fresh path, or a currently
 * un-opened store file) — see `admin.ts`'s `restore` action doc comment for
 * the full safety contract, including the serve-lock check.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { GraphBacklogStore } from './graph-backlog-store.js';
import { manifestPathFor, readBackupManifest, writeBackupManifest, type IBackupManifest } from './backup-manifest.js';

function sha256Of(path: string): { sha256: string; sizeBytes: number } {
  const buf = readFileSync(path);
  return { sha256: createHash('sha256').update(buf).digest('hex'), sizeBytes: buf.length };
}

export interface IBackupResult {
  destPath: string;
  manifestPath: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  sourceDbPath: string;
}

/** Thrown when the backup destination already exists and the caller did not opt into overwriting it. */
export class BackupDestinationExistsError extends Error {
  constructor(public readonly destPath: string) {
    super(`backup destination already exists: ${destPath} — pass overwrite:true to replace it`);
    this.name = 'BackupDestinationExistsError';
  }
}

/**
 * Snapshots `store` to `destPath` via `VACUUM INTO`, then writes a
 * sha256+size manifest beside it (`backup-manifest.ts`). `sourceDbPath` is
 * recorded for provenance only — the manifest's `sha256` is what `restore`
 * actually trusts.
 */
export async function backupStore(store: GraphBacklogStore, sourceDbPath: string, destPath: string, opts: { overwrite?: boolean } = {}): Promise<IBackupResult> {
  const abs = resolve(destPath);
  if (existsSync(abs)) {
    if (!opts.overwrite) throw new BackupDestinationExistsError(abs);
    rmSync(abs); // VACUUM INTO refuses to write over an existing file — the caller opted in, so clear it first.
  }
  mkdirSync(dirname(abs), { recursive: true });
  // `VACUUM INTO` does not accept a bound `?` parameter for its target path
  // on the turso/libsql substrate (`Parse error: VACUUM INTO requires a
  // string literal path`, verified against the real adapter) — SQLite's own
  // grammar requires a string-literal expression here. Single-quote
  // escaping (doubling embedded `'`) is the correct and sufficient escape
  // for a SQL string literal; no other character is special inside one.
  await store.adapter.exec(`VACUUM INTO '${abs.replace(/'/g, "''")}'`);

  const { sha256, sizeBytes } = sha256Of(abs);
  const createdAt = new Date().toISOString();
  const manifest: IBackupManifest = { version: 1, createdAt, sourceDbPath, backupPath: abs, sizeBytes, sha256 };
  writeBackupManifest(manifest);
  return { destPath: abs, manifestPath: manifestPathFor(abs), sizeBytes, sha256, createdAt, sourceDbPath };
}

export interface IRestoreResult {
  backupPath: string;
  manifest: IBackupManifest;
  destDbPath: string;
  /** Whether `destDbPath` already had a file before this call (dry run: informational; confirmed: it was overwritten). */
  destExisted: boolean;
  /** `false` on a dry run (nothing written); `true` once the copy actually happened. */
  restored: boolean;
}

/** Thrown when the backup file's live sha256 does not match its manifest — a truncated/corrupted/tampered backup, never silently restored. */
export class BackupIntegrityError extends Error {
  constructor(
    public readonly backupPath: string,
    public readonly expectedSha256: string,
    public readonly actualSha256: string
  ) {
    super(`backup integrity check failed for ${backupPath}: expected sha256 ${expectedSha256}, got ${actualSha256} — the file is truncated, corrupted, or was modified after the backup was taken`);
    this.name = 'BackupIntegrityError';
  }
}

/**
 * Verifies `backupPath` against its manifest (existence, JSON shape, sha256
 * — {@link BackupIntegrityError}/`BackupManifestError`), then — only when
 * `opts.confirm` — copies it onto `destDbPath`, clearing any `-wal`/`-shm`
 * sidecars beside the destination first so a stale WAL can never shadow the
 * freshly-restored file. Without `confirm` this is a dry run: the backup is
 * still fully verified (a caller learns about a corrupt backup even on the
 * preview), but nothing is written.
 */
export async function restoreStore(backupPath: string, destDbPath: string, opts: { confirm: boolean }): Promise<IRestoreResult> {
  const absBackup = resolve(backupPath);
  if (!existsSync(absBackup)) {
    throw new Error(`backup file not found: ${absBackup}`);
  }
  const manifest = readBackupManifest(absBackup);
  const { sha256: actualSha256 } = sha256Of(absBackup);
  if (actualSha256 !== manifest.sha256) {
    throw new BackupIntegrityError(absBackup, manifest.sha256, actualSha256);
  }

  const absDest = resolve(destDbPath);
  const destExisted = existsSync(absDest);
  if (!opts.confirm) {
    return { backupPath: absBackup, manifest, destDbPath: absDest, destExisted, restored: false };
  }

  mkdirSync(dirname(absDest), { recursive: true });
  for (const suffix of ['-wal', '-shm']) {
    try {
      rmSync(`${absDest}${suffix}`);
    } catch {
      // No sidecar to clear — the common case for a fresh/never-opened destination.
    }
  }
  copyFileSync(absBackup, absDest);
  return { backupPath: absBackup, manifest, destDbPath: absDest, destExisted, restored: true };
}
