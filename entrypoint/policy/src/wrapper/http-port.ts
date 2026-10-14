import { ApiError } from '@adhd/apigen-base-errors';

/** The environment variable that names the loopback HTTP port. */
export const HTTP_PORT_ENV_VAR = 'ADHD_POLICY_HTTP_PORT';

/**
 * Parses the HTTP port strictly: absent or empty is `0` (the OS picks an
 * ephemeral port); anything else must be plain decimal digits in `0..65535`.
 * `abc`, `-1`, `1e3`, `80.5`, `0x50`, ` 80` and `70000` are
 * `ApiError('invalid_argument')` (exit 2) instead of `NaN` or a silent coercion.
 */
export function parseHttpPort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 0;
  if (!/^\d+$/.test(raw)) {
    throw new ApiError('invalid_argument', `${HTTP_PORT_ENV_VAR} must be a whole number from 0 to 65535, got "${raw}"`);
  }
  const port = Number(raw);
  if (port > 65535) {
    throw new ApiError('invalid_argument', `${HTTP_PORT_ENV_VAR} must be a whole number from 0 to 65535, got "${raw}"`);
  }
  return port;
}
