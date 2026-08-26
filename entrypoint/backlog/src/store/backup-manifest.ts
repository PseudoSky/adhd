/**
 * backup-manifest.ts — P4 ("No general point-in-time backup/snapshot/restore
 * mechanism exists for the live backlog SQLite store"). Pure fs + JSON, no
 * store/env imports (mirrors markdown.ts's own layering rule) — `store-
 * backup.ts` is the only caller, and `admin.ts` composes the two.
 *
 * A backup file with no manifest is unusable by `restore` (deliberately —
 * `restoreStore` refuses to trust a bare `.db` file with no recorded
 * sha256/size, since a truncated or bit-rotted copy is otherwise
 * indistinguishable from a good one until SQLite itself trips over it, which
 * is exactly the failure mode a backup exists to protect against).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Version 1 of the manifest shape. Bumped only on a breaking format change — `restoreStore` refuses an unknown version outright rather than guessing. */
export const BACKUP_MANIFEST_VERSION = 1 as const;

/** Sidecar JSON recorded next to every backup file `store-backup.ts` produces. */
export interface IBackupManifest {
  version: typeof BACKUP_MANIFEST_VERSION;
  /** ISO timestamp the backup was taken. */
  createdAt: string;
  /** The live store's db path at backup time — provenance, not used for restore validation. */
  sourceDbPath: string;
  /** Absolute path of the backup `.db` file this manifest describes. */
  backupPath: string;
  sizeBytes: number;
  /** SHA-256 of the backup file's bytes at the moment it was written — `restoreStore`'s integrity check. */
  sha256: string;
}

/** The manifest always lives beside its backup file, suffixed `.manifest.json` — never a separate directory a caller could lose track of. */
export function manifestPathFor(backupPath: string): string {
  return `${backupPath}.manifest.json`;
}

export function writeBackupManifest(manifest: IBackupManifest): void {
  const path = manifestPathFor(manifest.backupPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/** Thrown by {@link readBackupManifest} for every "this is not a usable manifest" case — never a silent `null`, since a caller (restore) must not proceed on an absent/corrupt manifest without knowing why. */
export class BackupManifestError extends Error {
  constructor(
    public readonly backupPath: string,
    message: string
  ) {
    super(message);
    this.name = 'BackupManifestError';
  }
}

export function readBackupManifest(backupPath: string): IBackupManifest {
  const manifestPath = manifestPathFor(backupPath);
  if (!existsSync(manifestPath)) {
    throw new BackupManifestError(backupPath, `backup manifest not found: ${manifestPath} — a backup taken by an older/foreign tool cannot be restored without one`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new BackupManifestError(backupPath, `backup manifest ${manifestPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new BackupManifestError(backupPath, `backup manifest ${manifestPath} did not parse to an object`);
  }
  const m = parsed as Partial<IBackupManifest>;
  if (m.version !== BACKUP_MANIFEST_VERSION) {
    throw new BackupManifestError(backupPath, `backup manifest ${manifestPath} has unknown version ${JSON.stringify(m.version)} (expected ${BACKUP_MANIFEST_VERSION})`);
  }
  if (typeof m.sha256 !== 'string' || m.sha256.length === 0 || typeof m.sizeBytes !== 'number' || typeof m.backupPath !== 'string' || typeof m.createdAt !== 'string' || typeof m.sourceDbPath !== 'string') {
    throw new BackupManifestError(backupPath, `backup manifest ${manifestPath} is missing required field(s)`);
  }
  return {
    version: BACKUP_MANIFEST_VERSION,
    createdAt: m.createdAt,
    sourceDbPath: m.sourceDbPath,
    backupPath: m.backupPath,
    sizeBytes: m.sizeBytes,
    sha256: m.sha256,
  };
}
