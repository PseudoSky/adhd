import { CLI_EXIT_CODE, isApiError } from '@adhd/apigen-base-errors';
import type { IVerbDeps } from './deps';

/**
 * Writes the failure's message to stderr and returns the exit code:
 * `ApiError` -> `CLI_EXIT_CODE[code]` (permission_denied 3, invalid_argument 2,
 * not_found 4, ...); a gateway `SourceError` -> 2 for `invalid-spec`, else 1;
 * anything else -> 1. Matches the gateway error structurally so the verbs that
 * never touch the gateway do not load it.
 */
export function reportFailure(error: unknown, deps: Pick<IVerbDeps, 'stderr'>): number {
  const message = error instanceof Error ? error.message : String(error);
  deps.stderr(`${message}\n`);
  if (isApiError(error)) return CLI_EXIT_CODE[error.code] ?? 1;
  if (error instanceof Error && error.name === 'SourceError') {
    return (error as Error & { code?: string }).code === 'invalid-spec' ? 2 : 1;
  }
  return 1;
}
