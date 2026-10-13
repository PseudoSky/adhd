import { ApiError } from '@adhd/apigen-base-errors';
import { backupPath, integrityPath, nodeMcpJsonFs, parseIntegrityRecord, sha256Text } from './io';
import type { IMcpJsonFs } from './io';

/**
 * Restores `<file>` from `<file>.adhd-policy.bak` byte for byte and leaves the
 * backup in place. No backup is `ApiError('not_found')` (exit 4). A file that
 * already equals the backup is left as it is.
 *
 * Unless `force`, the restore happens only when the file still holds exactly
 * what `init` last wrote (its SHA-256 matches `<file>.adhd-policy.json`): a file
 * edited since, or with no integrity record, is `ApiError('invalid_argument')`
 * (exit 2) and is left untouched, so the user's later edits are never silently
 * discarded. `force` restores the backup anyway.
 */
export async function undoMcpJson(options: { file: string; force?: boolean; fs?: IMcpJsonFs }): Promise<{ restored: boolean }> {
  const fs = options.fs ?? nodeMcpJsonFs;
  const backup = await fs.read(backupPath(options.file));
  if (backup === undefined) {
    throw new ApiError('not_found', `no backup found for ${options.file} (expected ${backupPath(options.file)}); nothing to restore`);
  }
  const current = await fs.read(options.file);
  if (current === backup) return { restored: true };
  if (current !== undefined && options.force !== true) {
    const record = parseIntegrityRecord(await fs.read(integrityPath(options.file)));
    if (record === undefined) {
      throw new ApiError(
        'invalid_argument',
        `${options.file} cannot be verified: ${integrityPath(options.file)} is missing or unreadable, so there is no record of what init wrote. ` +
          'Restoring would discard any edits made since; re-run with --undo --force to restore the backup anyway.'
      );
    }
    if (sha256Text(current) !== record.sha256) {
      throw new ApiError(
        'invalid_argument',
        `${options.file} changed since adhd-policy mcp-json init wrote it (expected sha256 ${record.sha256}, found ${sha256Text(current)}). ` +
          'Restoring would discard those changes; re-run with --undo --force to restore the backup anyway.'
      );
    }
  }
  await fs.write(options.file, backup);
  return { restored: true };
}
