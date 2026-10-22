import { CLI_EXIT_CODE, isApiError } from '@adhd/apigen-base-errors';
import type { IVerbDeps } from './deps';

/**
 * Writes the failure's message to stderr and returns the exit code:
 * `ApiError` -> `CLI_EXIT_CODE[code]` (permission_denied 3, invalid_argument 2,
 * not_found 4, ...); anything else -> 1. Source resolution, spawn and handshake
 * failures from the gateway are `ApiError`s (`invalid_argument` for an invalid
 * source, `internal` with `details.gatewayCode: 'unavailable'` for an upstream
 * that cannot start), so they take the same table. A `serve` upstream that exits
 * and exhausts its restart budget fails with `internal` and exits 1 the same way.
 *
 * @param error The thrown value.
 * @param deps Only the stderr writer is used.
 * @returns The process exit code.
 */
export function reportFailure(error: unknown, deps: Pick<IVerbDeps, 'stderr'>): number {
  const message = error instanceof Error ? error.message : String(error);
  deps.stderr(`${message}\n`);
  if (isApiError(error)) return CLI_EXIT_CODE[error.code] ?? 1;
  return 1;
}
