import { ApiError } from '@adhd/apigen-base-errors';
import { backupPath, nodeMcpJsonFs } from './io';
import type { IMcpJsonFs } from './io';

/**
 * Restores `<file>` from `<file>.adhd-policy.bak` byte for byte and leaves the
 * backup in place. No backup is `ApiError('not_found')` (exit 4).
 */
export async function undoMcpJson(options: { file: string; fs?: IMcpJsonFs }): Promise<{ restored: boolean }> {
  const fs = options.fs ?? nodeMcpJsonFs;
  const backup = await fs.read(backupPath(options.file));
  if (backup === undefined) {
    throw new ApiError('not_found', `no backup found for ${options.file} (expected ${backupPath(options.file)}); nothing to restore`);
  }
  await fs.write(options.file, backup);
  return { restored: true };
}
